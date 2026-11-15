import {describe, expect, it} from "vitest";
import {acrossRouteOf, type AcrossRoute} from "../src/config.js";
import {
  ACROSS_ETH_L2_CURVE, ACROSS_ETH_L2_FLOOR_MAX_USD, ACROSS_FLOOR_CBPS, acrossCbpsOf, acrossFloorCbps, acrossFloorFee, acrossPlainFee, acrossQuoteTimeOf, acrossRouteUnpriced,
} from "../src/pricing.js";
import {ACROSS_MIN_FEE_PPM, acrossMinFeePpm} from "../src/verify.js";
import {ARB_USDC, ARB_USDT0, BASE_USDC, ETH_USDT, ZERO, refused} from "./fixtures.js";

const route = (from: string, token: string, to: string, out: string) => acrossRouteOf(from, token, to, out) as AcrossRoute;
const ETH_L2 = route("eip155:8453", ZERO, "eip155:42161", ZERO);
const ETH_L1 = route("eip155:1", ZERO, "eip155:8453", ZERO);
const USDC = route("eip155:8453", BASE_USDC, "eip155:42161", ARB_USDC);
const USDT = route("eip155:1", ETH_USDT, "eip155:42161", ARB_USDT0);
const WBTC = route("eip155:1", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599", "eip155:42161", "0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f");

describe("the floor without /suggested-fees", () => {
  it("by asset and origin, in hundredths of a bp", () => {
    expect(acrossFloorCbps(USDC, 100)).toBe(ACROSS_FLOOR_CBPS.stable);
    expect(acrossFloorCbps(USDT, 100)).toBe(100);
    expect(acrossFloorCbps(WBTC, 100)).toBe(310);
    expect(acrossFloorCbps(ETH_L1, 100)).toBe(100);
  });

  it("ETH from an L2: the size curve, linear between points, rounded up; refused above $36 000", () => {
    expect(acrossFloorCbps(ETH_L2, 0)).toBe(477);
    expect(acrossFloorCbps(ETH_L2, 1000)).toBe(515);
    expect(acrossFloorCbps(ETH_L2, 1500)).toBe(528); // 527.5 up
    expect(acrossFloorCbps(ETH_L2, 2000)).toBe(540);
    expect(acrossFloorCbps(ETH_L2, 36_000)).toBe(920);
    expect(acrossFloorCbps(ETH_L2, 36_001)).toMatch(/up to \$36000/);
    expect(acrossFloorCbps(ETH_L2, undefined)).toMatch(/size in dollars/);
    expect(ACROSS_ETH_L2_CURVE.every(([, y], i, c) => i === 0 || y > c[i - 1]![1])).toBe(true);
    expect(ACROSS_ETH_L2_FLOOR_MAX_USD).toBe(ACROSS_ETH_L2_CURVE[ACROSS_ETH_L2_CURVE.length - 1]![0]);
  });

  it("only on the studied chains: Ethereum, Optimism, Base, Arbitrum to Optimism, Base, Arbitrum", () => {
    expect(acrossFloorCbps(route("eip155:59144", "0x176211869ca2b568f2a7d4ee941e073a821ee1ff", "eip155:8453", BASE_USDC), 100)).toMatch(/no relayer price for Linea → Base/);
    expect(acrossFloorCbps(route("eip155:8453", BASE_USDC, "eip155:137", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"), 100)).toMatch(/Base → Polygon/);
  });

  it("acrossFloorFee: floor + 1.5 × the destination gas, rounded up; its refusals", () => {
    expect(acrossFloorFee(USDC, 100_000_000n, 100, 8_450n)).toBe(10_000n + 12_675n);
    expect(acrossFloorFee(USDC, 100_000_001n, 100, 1n)).toBe(10_001n + 2n);
    expect(acrossCbpsOf(1n, 1)).toBe(1n);
    refused(() => acrossFloorFee(ETH_L2, 10n ** 19n, 40_000, 0n), "relayer-price", "amount_too_large");
    refused(() => acrossFloorFee(USDC, 100_000_000n, 100, null), "relayer-price", "upstream_unavailable");
    refused(() => acrossFloorFee(route("eip155:59144", ZERO, "eip155:8453", ZERO), 10n ** 16n, 20, 0n), "relayer-price", "upstream_unavailable");
  });
});

describe("max(F5, the relayer need)", () => {
  it("F5 is V5's fee net of its origin step; the larger of the two is the fee", () => {
    expect(acrossPlainFee(1_000_000n, {totalFee: 500n, originGas: 100n}, 300n)).toEqual({fee: 400n, f5: 400n, need: 300n});
    expect(acrossPlainFee(1_000_000n, {totalFee: 500n, originGas: 400n}, 300n)).toEqual({fee: 300n, f5: 100n, need: 300n});
    // An add-back larger than the fee cannot make F5 negative.
    expect(acrossPlainFee(1_000_000n, {totalFee: 500n, originGas: 900n}, 0n)).toEqual({fee: 0n, f5: 0n, need: 0n});
    expect(refused(() => acrossPlainFee(100n, {totalFee: 50n, originGas: 0n}, 100n), "relayer-price", "amount_too_small")).toMatch(/keep all/);
  });

  it("the quote time without /suggested-fees: Ethereum's latest block − 60 s, never after the source chain's", () => {
    expect(acrossQuoteTimeOf(1_000, 2_000)).toBe(940);
    expect(acrossQuoteTimeOf(1_000, 900)).toBe(900);
  });
});

describe("routes not priced", () => {
  it("Ethereum as the destination (small plain deposits there went unfilled in the study, cause unknown)", () => {
    expect(acrossRouteUnpriced(route("eip155:8453", BASE_USDC, "eip155:1", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"))).toMatch(/to Ethereum are not priced/);
    expect(acrossRouteUnpriced(USDC)).toBeNull();
    expect(acrossRouteUnpriced(ETH_L1)).toBeNull();
  });
});

describe("the device's own fee floor", () => {
  it("by asset and origin: what relayers take, so a server cannot name a deposit nobody fills", () => {
    expect(ACROSS_MIN_FEE_PPM).toEqual({stable: 100, ethFromEthereum: 70, ethFromL2: 450, ethFromOtherL2: 70, wbtc: 250});
    expect(acrossMinFeePpm(USDC)).toBe(100);
    expect(acrossMinFeePpm(USDT)).toBe(100);
    expect(acrossMinFeePpm(ETH_L1)).toBe(70);
    expect(acrossMinFeePpm(ETH_L2)).toBe(450);
    expect(acrossMinFeePpm(WBTC)).toBe(250);
    // Each sits at or under the server's own floor (a hundredth of a bp is a millionth), so an honest price passes it.
    expect(acrossMinFeePpm(USDC)).toBeLessThanOrEqual(ACROSS_FLOOR_CBPS.stable);
    expect(acrossMinFeePpm(WBTC)).toBeLessThan(ACROSS_FLOOR_CBPS.wbtc);
    expect(acrossMinFeePpm(ETH_L1)).toBeLessThan(ACROSS_FLOOR_CBPS.ethFromEthereum);
    expect(acrossMinFeePpm(ETH_L2)).toBeLessThan(ACROSS_ETH_L2_CURVE[0]![1]);
  });
});
