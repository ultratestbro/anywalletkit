// suggestTwoStep: two dry auctions through a hub token when there is no direct route — which hubs are tried, how
// the second leg is priced (on the first leg's guaranteed minimum), the gas flag, the gas-safe preference, and whose
// address the hub lands on.
import {describe, expect, it, vi} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "../src/router.js";
import {defaultHubs, suggestTwoStep} from "../src/twostep.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const TRON = "tron:728126428", BASE = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const AERO = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";
const ME_TRON = "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm";
const ME_BASE = "0x3333333333333333333333333333333333333333";
const SOMEONE = "0x4444444444444444444444444444444444444444";

const params: QuoteParams = {sourceChain: TRON, sourceToken: "USDT", destChain: BASE, destToken: AERO, amountIn: "120000000", destAddress: ME_BASE, refundAddress: ME_TRON};

function quote(provider: string, p: QuoteParams, out: bigint, min: bigint, extra: Partial<Quote> = {}): Quote {
  return {provider, intentId: `${provider}-${p.destToken}`, depositAddress: "", depositMemo: null, sourceAmount: p.amountIn, destAmount: out.toString(), minDestAmount: min.toString(), feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000, ...extra};
}

/** Tron → Base only, into ETH or USDC: 120 USDT gives 0.0400 ETH (min 0.0396) or 119 USDC (min 118). */
function bridge(seen: QuoteParams[] = []): CrossChainProvider {
  return {
    name: "bridge", enabled: () => true,
    supportsRoute: (a, b) => a.chain === TRON && b.chain === BASE && [ZERO, USDC_BASE.toLowerCase()].includes(b.token.toLowerCase()),
    getQuote: async (p) => {
      seen.push(p);
      return /^0x0+$/.test(p.destToken) ? quote("bridge", p, 40_000_000_000_000_000n, 39_600_000_000_000_000n) : quote("bridge", p, 119_000_000n, 118_000_000n);
    },
    buildDeposit: async () => { throw new Error("dry"); }, trackIntent: async () => ({state: "pending"}),
  };
}

/** Same-chain on Base into AERO: from ETH at 3,560 AERO/ETH, from USDC at `usdcRate` AERO/USDC. */
function dex(o: {usdcRate?: number; gaslessUsdc?: boolean; seen?: QuoteParams[]} = {}): CrossChainProvider {
  return {
    name: "dex", enabled: () => true, supportsSameChain: true,
    supportsRoute: (a, b) => a.chain === BASE && b.chain === BASE && ["ETH", "USDC"].includes(a.token) && b.token.toLowerCase() === AERO.toLowerCase(),
    getQuote: async (p) => {
      o.seen?.push(p);
      const amount = BigInt(p.amountIn);
      const out = p.sourceToken === "ETH" ? (amount * 3_560n) / 10n ** 18n * 10n ** 18n / 1n : (amount * BigInt(Math.round((o.usdcRate ?? 1.18) * 1000))) / 1000n * 10n ** 12n;
      return quote("dex", p, out, (out * 99n) / 100n, {etaSeconds: 15, ...(p.sourceToken === "USDC" && o.gaslessUsdc ? {gasless: true} : {})});
    },
    buildDeposit: async () => { throw new Error("dry"); }, trackIntent: async () => ({state: "pending"}),
  };
}

describe("defaultHubs", () => {
  it("is the chain's native coin and its first listed stablecoin", () => {
    expect(defaultHubs(BASE).map((h) => [h.symbol, h.native])).toEqual([["ETH", true], ["USDC", false]]);
    expect(defaultHubs(TRON).map((h) => h.symbol)).toEqual(["TRX", "USDT"]);
    expect(defaultHubs("eip155:999999")).toEqual([]);
  });
});

describe("suggestTwoStep", () => {
  it("finds both destination hubs, prices step 2 on step 1's minimum, and never tries the source token as a hub", async () => {
    const seen: QuoteParams[] = [], seen2: QuoteParams[] = [];
    const router = new CrossChainRouter([bridge(seen), dex({seen: seen2})]);
    expect(await router.getQuotes(params)).toBeNull();
    const plans = await router.suggestTwoStep(params, {maxPlans: 4});
    expect(plans.map((p) => `${p.shape}:${p.hub.symbol}`).sort()).toEqual(["destination-hub:ETH", "destination-hub:USDC"]);
    const eth = plans.find((p) => p.hub.symbol === "ETH")!;
    // Step 2 starts from the guaranteed 0.0396 ETH, not the expected 0.0400.
    expect(eth.secondParams.amountIn).toBe("39600000000000000");
    expect(eth.secondParams).toMatchObject({sourceChain: BASE, sourceToken: "ETH", destChain: BASE, destToken: AERO, destAddress: ME_BASE, refundAddress: ME_BASE, dry: true});
    expect(eth.firstParams).toMatchObject({destChain: BASE, destToken: ZERO, destAddress: ME_BASE, refundAddress: ME_TRON, dry: true});
    expect(eth.etaSeconds).toBe(75);
    expect(eth.gasOnHubChain).toBe("from-hub");
    // Guaranteed = step 2's min on step 1's min; expected scales step 2 up to step 1's expected output.
    expect(BigInt(eth.estimatedOut)).toBeGreaterThan(BigInt(eth.guaranteedOut));
    // TRX on Tron was tried (no venue: skipped); USDT on Tron is the source itself and never asked.
    expect(seen.some((p) => p.destChain === TRON && p.destToken !== ZERO)).toBe(false);
  });

  it("flags a stablecoin hub whose second swap needs native gas, and a gasless second swap as needing none", async () => {
    const plans = await suggestTwoStep(new CrossChainRouter([bridge(), dex()]), params, {maxPlans: 4});
    expect(plans.find((p) => p.hub.symbol === "USDC")!.gasOnHubChain).toBe("needed");
    const gasless = await suggestTwoStep(new CrossChainRouter([bridge(), dex({gaslessUsdc: true})]), params, {maxPlans: 4});
    expect(gasless.find((p) => p.hub.symbol === "USDC")!.gasOnHubChain).toBe("none");
  });

  it("prefers the gas-free plan within the band when the user lacks gas, and the better one otherwise", async () => {
    // USDC → AERO at 1.19 makes the USDC plan ~0.2 % better than the ETH plan.
    const router = new CrossChainRouter([bridge(), dex({usdcRate: 1.19})]);
    const raw = await suggestTwoStep(router, params, {lacksGas: () => false});
    expect(raw[0]!.hub.symbol).toBe("USDC");
    const safe = await suggestTwoStep(router, params, {lacksGas: (c) => c === BASE});
    expect(safe[0]!.hub.symbol).toBe("ETH");
    // Outside the band the better plan stays first even without gas.
    const far = await suggestTwoStep(new CrossChainRouter([bridge(), dex({usdcRate: 1.4})]), params, {lacksGas: () => true});
    expect(far[0]!.hub.symbol).toBe("USDC");
  });

  it("lands the hub on the user's own address when the final recipient is someone else", async () => {
    const seen: QuoteParams[] = [];
    const other = {...params, destAddress: SOMEONE};
    const plans = await suggestTwoStep(new CrossChainRouter([bridge(seen), dex()]), other, {ownAddress: (c) => (c === BASE ? ME_BASE : c === TRON ? ME_TRON : undefined)});
    expect(plans.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.destAddress === ME_BASE)).toBe(true);
    for (const p of plans) expect(p.secondParams.destAddress).toBe(SOMEONE);
    // No own address on the hub chain: no plan through it.
    expect(await suggestTwoStep(new CrossChainRouter([bridge(), dex()]), other, {ownAddress: () => undefined})).toEqual([]);
  });

  it("drops plans under the caller's floor, strips the floor and route id from the legs, and returns nothing without a path", async () => {
    const seen: QuoteParams[] = [];
    const plans = await suggestTwoStep(new CrossChainRouter([bridge(seen), dex()]), {...params, minAmountOut: "1", routeId: "x"});
    expect(plans.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.minAmountOut === undefined && p.routeId === undefined)).toBe(true);
    expect(await suggestTwoStep(new CrossChainRouter([bridge(), dex()]), {...params, minAmountOut: (10n ** 30n).toString()})).toEqual([]);
    expect(await suggestTwoStep(new CrossChainRouter([bridge()]), params)).toEqual([]);
    expect(await suggestTwoStep(new CrossChainRouter([dex()]), params)).toEqual([]);
  });

  it("asks nothing it does not need: a failing first leg skips its hub's second leg", async () => {
    const second = vi.fn();
    const failing: CrossChainProvider = {...bridge(), getQuote: async () => null};
    const d = dex();
    const spy: CrossChainProvider = {...d, getQuote: async (p, s) => { second(); return d.getQuote(p, s); }};
    expect(await suggestTwoStep(new CrossChainRouter([failing, spy]), params)).toEqual([]);
    expect(second).not.toHaveBeenCalled();
  });
});
