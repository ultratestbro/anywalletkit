// Quote.gasEstimate in the router (2026-11-28): with `useGasEstimate` (off by default) routes compare on the gas their
// source transaction is expected to use, not on the venue's gas limit with its headroom; without it, exactly as before.
// The new fields pass through every view, and the approval options reach the engine through the router (`using()`
// included). The 2026-11-27 Fynd 294.50 / CoW 294.49 case is checked against Fynd's own recording of that evening: the
// estimate does not decide it (a tie to a hundredth of a cent), and the gas the route used puts CoW ahead.
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
// Synthetic, for the mechanism only: at 0.016 gwei and $3000 ETH the headroom of a 150k-gas route is worth more than a
// one-cent lead and its estimate less. Not the 2026-11-27 figures (see RECORDED below).
const GAS_PRICE = `0x${(16_000_000).toString(16)}`;
const rpcAt = (price: string) => async (_chain: string, method: string) => {
  if (method === "eth_gasPrice") return price;
  if (method === "eth_call") return "0x0";
  throw new Error(method);
};
const rpc = rpcAt(GAS_PRICE);
const ESTIMATE = {useGasEstimate: true} as const;

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
  it("by default the estimate is not read: the limit, or the route's default, exactly as before", () => {
    expect(swapGasUnits(fynd(true), PARAMS)).toBe(FYND_LIMIT);
    expect(swapGasUnits(fynd(true), PARAMS, {})).toBe(FYND_LIMIT);
    expect(swapGasUnits(fynd(true), PARAMS, {useGasEstimate: false})).toBe(FYND_LIMIT);
    // A quote without a transaction (a dry KyberSwap quote, a 0x price) is a plain transfer, as before.
    const dry = quote("kyberswap", "1", {gasEstimate: "330498", gasEstimateSource: "venue"});
    expect(swapGasUnits(dry, PARAMS)).toBe(SOURCE_GAS_UNITS.tokenTransfer);
    expect(swapGasUnits(dry, PARAMS, ESTIMATE)).toBe(330_498n);
  });

  it("with useGasEstimate the estimate counts instead of the limit; without one, the limit as before", () => {
    expect(swapGasUnits(fynd(true), PARAMS, ESTIMATE)).toBe(FYND_ESTIMATE);
    expect(swapGasUnits(fynd(false), PARAMS, ESTIMATE)).toBe(FYND_LIMIT);
    expect(swapGasUnits(cow(), PARAMS, ESTIMATE)).toBe(0n);
    // A deposit-address route that states its gas.
    expect(swapGasUnits(quote("d", "1", {depositAddress: SENDER, gasEstimate: "52000", gasEstimateSource: "model"}), PARAMS, ESTIMATE)).toBe(52_000n);
  });

  it("bounded: never below the intrinsic 21 000, never above the cap; an unusable value is passed over", () => {
    expect(swapGasUnits(quote("a", "1", {txRequest: fyndTx, gasEstimate: "1", gasEstimateSource: "venue"}), PARAMS, ESTIMATE)).toBe(SOURCE_GAS_UNITS.estimateFloor);
    expect(swapGasUnits(quote("a", "1", {gasEstimate: "9000000000", gasEstimateSource: "venue"}), PARAMS, ESTIMATE)).toBe(SOURCE_GAS_UNITS.callCap);
    for (const bad of ["0", "0150000", "1.5e5", "", "-5"]) {
      expect(swapGasUnits(quote("a", "1", {txRequest: fyndTx, gasEstimate: bad, gasEstimateSource: "venue"}), PARAMS, ESTIMATE), bad).toBe(FYND_LIMIT);
    }
  });

  it("evmSourceGas prices the estimate only when asked to, and adds the approval either way", async () => {
    const usd = (units: bigint) => (Number(units) * 16_000_000 * 3000) / 1e18;
    const honest = evmSourceGas({prices: PRICES, rpc, useGasEstimate: true});
    expect(await honest(fynd(true), PARAMS)).toBeCloseTo(usd(FYND_ESTIMATE + SOURCE_GAS_UNITS.approve), 12);
    expect(await honest(fynd(false), PARAMS)).toBeCloseTo(usd(FYND_LIMIT + SOURCE_GAS_UNITS.approve), 12);
    expect(await honest(cow(), PARAMS)).toBeCloseTo(usd(SOURCE_GAS_UNITS.approve), 12);
    const plain = evmSourceGas({prices: PRICES, rpc});
    expect(await plain(fynd(true), PARAMS)).toBeCloseTo(usd(FYND_LIMIT + SOURCE_GAS_UNITS.approve), 12);
    expect(await plain(cow(), PARAMS)).toBeCloseTo(usd(SOURCE_GAS_UNITS.approve), 12);
  });
});

// Fynd's recording of 2026-11-27 21:45 UTC (protocol-swap2-fynd fixtures/quotes/ethereum-usdt-usdc.json): 300 USDT →
// USDC through Ekubo at block 26,509,322 — gas_estimate 136,311 (gasLimit 136,311 × 1.3 + 80,000 = 257,204), gas_price
// 43,918,108 wei, amount_out − amount_out_net_gas = 9,965 USDC base units ($0.009965, which fixes ETH's price), and
// 210,131 gas used when the transaction was simulated right after.
const RECORDED = {estimate: 136_311n, limit: 257_204n, used: 210_131n, gasPriceWei: 43_918_108, netGasUsd: 0.009965};
const RECORDED_ETH_USD = RECORDED.netGasUsd / ((Number(RECORDED.estimate) * RECORDED.gasPriceWei) / 1e18);

describe("the auction ranks on the estimate when asked to", () => {
  const router = (estimate: boolean, useGasEstimate = true) => new CrossChainRouter([provider("fynd", () => fynd(estimate)), provider("cow", cow)], {
    valueUsd: usdValue(PRICES), sourceGasUsd: evmSourceGas({prices: PRICES, rpc, useGasEstimate}), tieBand: 0,
  });

  it("synthetic: where the headroom is worth more than the lead, the limit puts Fynd second and its estimate first", async () => {
    const padded = (await router(false).getQuotes(PARAMS))!;
    expect(padded.best.provider).toBe("cow");
    const honest = (await router(true).getQuotes(PARAMS))!;
    expect(honest.best.provider).toBe("fynd");
    const f = honest.quotes.find((q) => q.provider === "fynd")!;
    const c = honest.quotes.find((q) => q.provider === "cow")!;
    expect(f.netValueUsd! - c.netValueUsd!).toBeGreaterThan(0);
    expect(f.gasUsd).toBeLessThan(padded.quotes.find((q) => q.provider === "fynd")!.gasUsd!);
    expect(c.gasUsd).toBeCloseTo(padded.quotes.find((q) => q.provider === "cow")!.gasUsd!, 12);
    // Without the option, a quote's estimate changes nothing: the same ranking as with no estimate at all.
    const unchanged = (await router(true, false).getQuotes(PARAMS))!;
    expect(unchanged.best.provider).toBe("cow");
    expect(unchanged.quotes.map((q) => [q.provider, q.gasUsd])).toEqual(padded.quotes.map((q) => [q.provider, q.gasUsd]));
  });

  it("2026-11-27 at that evening's recorded gas price: the estimate makes the one-cent race a tie, the gas used makes it CoW's", async () => {
    const prices = {...PRICES, ETH: RECORDED_ETH_USD};
    const at = (fyndGas: bigint, useGasEstimate: boolean) => new CrossChainRouter([
      provider("fynd", () => quote("fynd", "294500000", {txRequest: {...fyndTx, gasLimit: RECORDED.limit.toString()}, gasEstimate: fyndGas.toString(), gasEstimateSource: "venue"})),
      provider("cow", cow),
    ], {valueUsd: usdValue(prices), sourceGasUsd: evmSourceGas({prices, rpc: rpcAt(`0x${RECORDED.gasPriceWei.toString(16)}`), useGasEstimate}), tieBand: 0}).getQuotes(PARAMS);
    const net = (set: Awaited<ReturnType<typeof at>>, name: string) => set!.quotes.find((q) => q.provider === name)!.netValueUsd!;
    // Fynd's swap gas priced as Fynd priced it: $0.009965, against a $0.01 lead.
    const onEstimate = await at(RECORDED.estimate, true);
    const fyndSwapGas = onEstimate!.quotes.find((q) => q.provider === "fynd")!.gasUsd! - onEstimate!.quotes.find((q) => q.provider === "cow")!.gasUsd!;
    expect(fyndSwapGas).toBeCloseTo(RECORDED.netGasUsd, 9);
    expect(Math.abs(net(onEstimate, "fynd") - net(onEstimate, "cow"))).toBeLessThan(0.0001);
    // On the gas the recorded route used, CoW is ahead; on the limit (the default), further ahead.
    expect((await at(RECORDED.used, true))!.best.provider).toBe("cow");
    const onLimit = await at(RECORDED.estimate, false);
    expect(onLimit!.best.provider).toBe("cow");
    expect(net(onLimit, "cow") - net(onLimit, "fynd")).toBeGreaterThan(net(await at(RECORDED.used, true), "cow") - net(await at(RECORDED.used, true), "fynd"));
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
    const api = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [provider("fynd", () => fynd(true)), provider("cow", cow)], valueUsd: usdValue(PRICES), sourceGasUsd: evmSourceGas({prices: PRICES, rpc, useGasEstimate: true}), tieBand: 0});
    const routes = await api.quoteSwap2Routes({fromToken: "USDC", toToken: USDT, toChain: 1, fromTokenAmount: 294_700_000n});
    expect(routes.map((r) => [r.provider, r.gasEstimate, r.gasEstimateSource, r.tags])).toEqual([["fynd", "150000", "venue", ["best", "fastest"]], ["cow", "0", "model", []]]);
  });
});

describe("approval options through the router", () => {
  function run(config: Record<string, unknown>, execution?: Record<string, unknown>, failPreflight = false, exactAllowanceOnly?: (chain: string) => boolean) {
    const log: string[] = [];
    const p: CrossChainProvider = {
      ...provider("fynd", () => fynd(true)),
      ...(failPreflight ? {preflightDeposit: async () => { throw new Error("halted"); }} : {}),
      ...(exactAllowanceOnly ? {exactAllowanceOnly} : {}),
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

  it("a provider's exactAllowanceOnly survives the router's snapshot: its routes keep the defaults, using() included", async () => {
    const chains: string[] = [];
    const held = run({allowanceReuse: "sufficient", revokeUnspentApproval: false}, undefined, true, (chain) => { chains.push(chain); return true; });
    const error = await held.swap().catch((e: unknown) => e);
    expect(held.log).toEqual(["approve", "revoke"]); // exact, and revoked when unspent
    expect(leftAllowanceOf(error)).toBeUndefined();
    expect(chains).toEqual(["eip155:1"]);
    const picked = run({}, {allowanceReuse: "sufficient"}, false, () => true);
    await picked.using();
    expect(picked.log).toEqual(["approve", "deposit"]);
    // A provider that answers false is not held.
    const free = run({allowanceReuse: "sufficient"}, undefined, false, () => false);
    await free.swap();
    expect(free.log).toEqual(["deposit"]);
  });
});
