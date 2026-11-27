// Quote.gasEstimate in the router (2026-11-28): routes compare on the gas their source transaction is expected to use,
// not on the venue's gas limit with its headroom. 2026-11-27 on Ethereum: Fynd delivered 294.50 USDC and ranked below
// CoW's 294.49 because its "gas" was its limit (estimate × 1.3 + 80 000). The new fields pass through every view, and
// the approval options reach the engine through the router (`using()` included).
import {describe, expect, it} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {leftAllowanceOf} from "@anywalletkit/protocol-swap2-core/swap2/base";
import {CrossChainRouter} from "../src/router.js";
import {SOURCE_GAS_UNITS, evmSourceGas, swapGasUnits} from "../src/gas.js";
import {RouterSwap2Protocol} from "../src/swap2/router.js";
import {usdValue} from "../src/value.js";

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const FYND_ROUTER = "0xe41cda5a5e6e3a2d8c1b5f4ebe0e6c1b2c3d5126"; // a stand-in for the pinned Fynd router
const COW_RELAYER = "0xC92E8bdf79f0507f65a392b0ab4667716BFE0110";
const SENDER = "0x5555555555555555555555555555555555555555";
const PRICES = {ETH: 3000, USDC: 1, USDT: 1};
const PARAMS: QuoteParams = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:1", destToken: USDT, amountIn: "294700000", destAddress: SENDER};
// 0.016 gwei: low enough that the honest figure and the padded limit fall on either side of a one-cent gap.
const GAS_PRICE = `0x${(16_000_000).toString(16)}`;
const rpc = async (_chain: string, method: string) => {
  if (method === "eth_gasPrice") return GAS_PRICE;
  if (method === "eth_call") return "0x0";
  throw new Error(method);
};

const FYND_ESTIMATE = 150_000n;
const FYND_LIMIT = (FYND_ESTIMATE * 13n) / 10n + 80_000n; // what Fynd's txRequest.gasLimit is: 275 000
const quote = (name: string, out: string, extra: Partial<Quote> = {}): Quote => ({
  provider: name, intentId: `${name}-1`, depositAddress: "", depositMemo: null, sourceAmount: PARAMS.amountIn, destAmount: out, minDestAmount: out,
  feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000, ...extra,
});
const provider = (name: string, make: () => Quote): CrossChainProvider => ({
  name, enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
  getQuote: async () => make(),
  buildDeposit: async (q) => ({chain: "eip155:1", to: q.txRequest!.to!, value: "0", data: q.txRequest!.data!, chainId: 1, gasLimit: q.txRequest!.gasLimit!, approvalAddress: q.txRequest!.approvalAddress!}),
  trackIntent: async () => ({state: "pending"}),
});
const fyndTx = {to: FYND_ROUTER, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: FYND_LIMIT.toString(), approvalAddress: FYND_ROUTER};
const fynd = (estimate: boolean) => quote("fynd", "294500000", {txRequest: fyndTx, ...(estimate ? {gasEstimate: FYND_ESTIMATE.toString(), gasEstimateSource: "venue" as const} : {})});
const cow = () => quote("cow", "294490000", {gasless: true, gasEstimate: "0", gasEstimateSource: "model", providerData: {approvalAddress: COW_RELAYER}});

describe("swapGasUnits / evmSourceGas with gasEstimate", () => {
  it("the estimate counts instead of the limit; without one, the limit as before", () => {
    expect(swapGasUnits(fynd(true), PARAMS)).toBe(FYND_ESTIMATE);
    expect(swapGasUnits(fynd(false), PARAMS)).toBe(FYND_LIMIT);
    expect(swapGasUnits(cow(), PARAMS)).toBe(0n);
    // A deposit-address route that states its gas.
    expect(swapGasUnits(quote("d", "1", {depositAddress: SENDER, gasEstimate: "52000", gasEstimateSource: "model"}), PARAMS)).toBe(52_000n);
  });

  it("bounded: never below the intrinsic 21 000, never above the cap; an unusable value is passed over", () => {
    expect(swapGasUnits(quote("a", "1", {txRequest: fyndTx, gasEstimate: "1", gasEstimateSource: "venue"}), PARAMS)).toBe(SOURCE_GAS_UNITS.estimateFloor);
    expect(swapGasUnits(quote("a", "1", {gasEstimate: "9000000000", gasEstimateSource: "venue"}), PARAMS)).toBe(SOURCE_GAS_UNITS.callCap);
    for (const bad of ["0", "0150000", "1.5e5", "", "-5"]) {
      expect(swapGasUnits(quote("a", "1", {txRequest: fyndTx, gasEstimate: bad, gasEstimateSource: "venue"}), PARAMS), bad).toBe(FYND_LIMIT);
    }
  });

  it("evmSourceGas prices the estimate and still adds the approval", async () => {
    const gas = evmSourceGas({prices: PRICES, rpc});
    const usd = (units: bigint) => (Number(units) * 16_000_000 * 3000) / 1e18;
    expect(await gas(fynd(true), PARAMS)).toBeCloseTo(usd(FYND_ESTIMATE + SOURCE_GAS_UNITS.approve), 12);
    expect(await gas(fynd(false), PARAMS)).toBeCloseTo(usd(FYND_LIMIT + SOURCE_GAS_UNITS.approve), 12);
    expect(await gas(cow(), PARAMS)).toBeCloseTo(usd(SOURCE_GAS_UNITS.approve), 12);
  });
});

describe("the auction ranks on the estimate", () => {
  const router = (estimate: boolean) => new CrossChainRouter([provider("fynd", () => fynd(estimate)), provider("cow", cow)], {
    valueUsd: usdValue(PRICES), sourceGasUsd: evmSourceGas({prices: PRICES, rpc}), tieBand: 0,
  });

  it("2026-11-27: Fynd 294.50 against CoW 294.49 — the padded limit put Fynd second, its estimate puts it first", async () => {
    const padded = (await router(false).getQuotes(PARAMS))!;
    expect(padded.best.provider).toBe("cow");
    const honest = (await router(true).getQuotes(PARAMS))!;
    expect(honest.best.provider).toBe("fynd");
    const f = honest.quotes.find((q) => q.provider === "fynd")!;
    const c = honest.quotes.find((q) => q.provider === "cow")!;
    expect(f.netValueUsd! - c.netValueUsd!).toBeGreaterThan(0);
    expect(f.gasUsd).toBeLessThan(padded.quotes.find((q) => q.provider === "fynd")!.gasUsd!);
    expect(c.gasUsd).toBeCloseTo(padded.quotes.find((q) => q.provider === "cow")!.gasUsd!, 12);
  });

  it("the fields pass through the route set, the pick and its candidates untouched", async () => {
    const set = (await router(true).getQuotes(PARAMS))!;
    expect(set.quotes.find((q) => q.provider === "fynd")).toMatchObject({gasEstimate: "150000", gasEstimateSource: "venue", txRequest: {gasLimit: "275000"}});
    expect(set.quotes.find((q) => q.provider === "cow")).toMatchObject({gasEstimate: "0", gasEstimateSource: "model"});
    const best = (await router(true).getBestQuote(PARAMS))!;
    expect(best).toMatchObject({provider: "fynd", gasEstimate: "150000", gasEstimateSource: "venue"});
  });

  it("a quote whose estimate breaks the contract sits out, and the refusal names the rule", async () => {
    const r = new CrossChainRouter([provider("fynd", () => quote("fynd", "294500000", {txRequest: fyndTx, gasEstimate: "300000", gasEstimateSource: "venue"})), provider("cow", cow)]);
    const set = (await r.getQuotes(PARAMS))!;
    expect(set.quotes.map((q) => q.provider)).toEqual(["cow"]);
    expect(r.lastRefusals).toEqual([{reason: "upstream_unavailable", provider: "fynd", message: "fynd: rejected by validation (gasEstimate 300000 is above txRequest.gasLimit 275000)"}]);
  });

  it("RouterSwap2Protocol's route list carries the estimate next to gasUsd", async () => {
    const api = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [provider("fynd", () => fynd(true)), provider("cow", cow)], valueUsd: usdValue(PRICES), sourceGasUsd: evmSourceGas({prices: PRICES, rpc}), tieBand: 0});
    const routes = await api.quoteSwap2Routes({fromToken: "USDC", toToken: USDT, toChain: 1, fromTokenAmount: 294_700_000n});
    expect(routes.map((r) => [r.provider, r.gasEstimate, r.gasEstimateSource, r.tags])).toEqual([["fynd", "150000", "venue", ["best", "fastest"]], ["cow", "0", "model", []]]);
  });
});

describe("approval options through the router", () => {
  function run(config: Record<string, unknown>, execution?: Record<string, unknown>, failPreflight = false) {
    const log: string[] = [];
    const p: CrossChainProvider = {
      ...provider("fynd", () => fynd(true)),
      ...(failPreflight ? {preflightDeposit: async () => { throw new Error("halted"); }} : {}),
    };
    const account = {
      getAddress: async () => SENDER, getChainId: async () => 1, waitForTransaction: async () => {},
      getAllowance: async () => 500_000_000_000n, // far above the input
      sendTransaction: async (tx: {data?: string}) => { log.push(tx.data?.startsWith("0x095ea7b3") ? (tx.data.endsWith("0".repeat(64)) ? "revoke" : "approve") : "deposit"); return {hash: `0x${log.length}`}; },
    };
    const api = new RouterSwap2Protocol(account as never, {fromChain: "eip155:1", providers: [p], ...config});
    const options = {fromToken: "USDC", toToken: USDT, toChain: 1, fromTokenAmount: 294_700_000n, minAmountOut: 294_000_000n};
    return {log, swap: () => api.swap2(options, execution as never), using: () => api.using("fynd").swap2(options, execution as never)};
  }

  it("allowanceReuse on the router's config reaches the engine, and survives using()", async () => {
    const plain = run({});
    await plain.swap();
    expect(plain.log).toEqual(["approve", "deposit"]);
    const reuse = run({allowanceReuse: "sufficient"});
    const result = await reuse.swap();
    expect(reuse.log).toEqual(["deposit"]);
    expect(result.reusedAllowance).toMatchObject({spender: FYND_ROUTER, amount: 500_000_000_000n});
    const picked = run({allowanceReuse: "sufficient"});
    await picked.using();
    expect(picked.log).toEqual(["deposit"]);
  });

  it("the per-execution options pass through swap2() and using().swap2()", async () => {
    const r = run({}, {allowanceReuse: "sufficient"});
    await r.using();
    expect(r.log).toEqual(["deposit"]);
    const keep = run({revokeUnspentApproval: false}, undefined, true);
    const error = await keep.using().catch((e: unknown) => e);
    expect(keep.log).toEqual(["approve"]);
    expect(leftAllowanceOf(error)).toMatchObject({spender: FYND_ROUTER, amount: 294_700_000n});
  });
});
