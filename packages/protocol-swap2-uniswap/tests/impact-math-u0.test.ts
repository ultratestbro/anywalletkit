// U0 (0.4.12): the arithmetic behind maxPriceImpactBps, apart from the chain — and the AC that, with the option unset,
// every probe failure P1–P9 still returns the quote without the figure (P9: measured, clamped to "0").
import {describe, expect, it} from "vitest";
import {encodePacked, getAddress} from "viem";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {hopsOf, impactRefusalText, probeImpactBps, spotValueLossBps, validMaxImpactBps} from "../src/impact.js";
import {uniswapProvider} from "../src/provider.js";
import {SCENARIOS, run} from "./unset-scenarios.js";

const LO = getAddress("0x1000000000000000000000000000000000000001");
const MID = getAddress("0x5000000000000000000000000000000000000005");
const HI = getAddress("0x9000000000000000000000000000000000000009");
const Q96 = 2n ** 96n;

describe("spot value loss (fees included)", () => {
  it("prices token1 per token0 and inverts for a hop that sells token1", () => {
    // mid 4 token1 per token0: 1 LO (token0) is worth 4 HI; 1 HI is worth 0.25 LO.
    const p = 2n * Q96;
    expect(spotValueLossBps([{tokenIn: LO, tokenOut: HI, fee: 500}], [p], 1_000_000n, 3_000_000n)).toBe(2500); // 25% lost
    expect(spotValueLossBps([{tokenIn: HI, tokenOut: LO, fee: 500}], [p], 1_000_000n, 200_000n)).toBe(2000); // 20% lost
    expect(spotValueLossBps([{tokenIn: HI, tokenOut: LO, fee: 500}], [p], 1_000_000n, 250_000n)).toBe(0); // at the mid
  });

  it("chains two hops as a product; the exact shortfall, rounded down to a whole bp", () => {
    const hops = [{tokenIn: LO, tokenOut: MID, fee: 100}, {tokenIn: MID, tokenOut: HI, fee: 100}];
    expect(spotValueLossBps(hops, [2n * Q96, 2n * Q96], 1_000_000n, 1_000_000n)).toBe(9375); // mid 16: 93.75%
    expect(spotValueLossBps(hops, [Q96, Q96], 1_000_000n, 999_998n)).toBe(0); // 0.0002% short of the mid: under 1 bp
    expect(spotValueLossBps(hops, [Q96, Q96], 1_000_000n, 999_000n)).toBe(10); // 0.1%
    expect(spotValueLossBps(hops, [Q96, Q96], 1_000_000n, 999_899n)).toBe(1); // 1.01 bp
  });

  it("U0-R2-SEC-5: floor rounding counts as loss — a dust output is not read as a fair trade", () => {
    // 3 raw units in, 2 out at a mid of 1: the recipient gets a third less. With `out + hops` taken as the output this
    // read 0, and a 0–2-decimal token's dust trade passed any limit with no probe to catch it.
    const h = [{tokenIn: LO, tokenOut: HI, fee: 500}];
    expect(spotValueLossBps(h, [Q96], 3n, 2n)).toBe(3333);
    expect(spotValueLossBps(h, [Q96], 3n, 3n)).toBe(0);
    expect(spotValueLossBps(h, [Q96], 999n, 998n)).toBe(10);
    // Two hops: the intermediate hop's rounding is in the output the recipient gets, so it counts too.
    expect(spotValueLossBps([{tokenIn: LO, tokenOut: MID, fee: 100}, {tokenIn: MID, tokenOut: HI, fee: 100}], [Q96, Q96], 5n, 3n)).toBe(4000);
  });

  it("is undefined for a price outside (0, 2^160) or mismatched lengths; above the mid is 0", () => {
    const h = [{tokenIn: LO, tokenOut: HI, fee: 500}];
    expect(spotValueLossBps(h, [0n], 1n, 1n)).toBeUndefined();
    expect(spotValueLossBps(h, [2n ** 160n], 1n, 1n)).toBeUndefined();
    expect(spotValueLossBps(h, [], 1n, 1n)).toBeUndefined();
    expect(spotValueLossBps(h, [Q96], 0n, 1n)).toBeUndefined();
    expect(spotValueLossBps(h, [Q96], 1_000n, 2_000n)).toBe(0);
  });

  it("the probe figure is 0.4.11's formula", () => {
    expect(probeImpactBps(1_000_000n, 570_000n, 1_000n, 1_000n)).toBe(4300);
    expect(probeImpactBps(1_000_000n, 1_000_000n, 1_000n, 900n)).toBe(0); // P9: clamped
  });
});

describe("route hops, limits and the refusal text", () => {
  it("reads an exactInput path hop by hop, in swap order", () => {
    const path = encodePacked(["address", "uint24", "address", "uint24", "address"], [HI, 3000, MID, 100, LO]);
    expect(hopsOf(HI, LO, undefined, path)).toEqual([{tokenIn: HI, tokenOut: MID, fee: 3000}, {tokenIn: MID, tokenOut: LO, fee: 100}]);
    expect(hopsOf(HI, LO, {fee: 500}, undefined)).toEqual([{tokenIn: HI, tokenOut: LO, fee: 500}]);
  });

  it("formats the loss to one decimal (never 100%) and the limit as given", () => {
    expect(impactRefusalText(9981, 500, "via USDC 0.3% → 0.01%")).toBe("loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)");
    expect(impactRefusalText(10_000, 500, "x")).toMatch(/^loses 99\.9% /);
    expect(impactRefusalText(9995, 500, "x")).toMatch(/^loses 99\.9% /);
    expect(impactRefusalText(500, 500, "x")).toMatch(/^loses 5\.0% .*\(limit 5%; best route x\)$/);
    expect(impactRefusalText(2053, 250, "x")).toMatch(/^loses 20\.5% .*\(limit 2\.5%;/);
    expect(impactRefusalText(1, 1, "x")).toMatch(/^loses 0\.0% .*\(limit 0\.01%;/);
  });

  it("accepts integer limits 1..10000 only", () => {
    expect([1, 500, 10_000].every(validMaxImpactBps)).toBe(true);
    expect([0, -1, 1.5, 10_001, Number.NaN, "500", null, undefined].some(validMaxImpactBps)).toBe(false);
  });
});

describe("maxPriceImpactBps unset: P1–P9 return the quote without the figure", () => {
  for (const s of SCENARIOS.filter((x) => /^P[1-9]/.test(x.name))) {
    it(s.name, async () => {
      const r = await run(uniswapProvider as never, s, refusalOf);
      expect(r.refusals).toEqual([]);
      expect(r.quote).not.toBeNull();
      expect(r.quote!.providerData!.priceImpactBps).toBe(s.name.startsWith("P9") ? "0" : undefined);
      expect(r.quote!.providerData!.valueLossBps).toBeUndefined();
    });
  }
});
