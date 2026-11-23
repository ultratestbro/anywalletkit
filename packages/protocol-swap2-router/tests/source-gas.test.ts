// SDK-291: the source gas a route costs the user comes off its net value, so a route whose swap a third party pays
// for (quote.gasless: CoW, Omniston orders) and a route the user sends are compared on what the user gets.
import {describe, expect, it} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "../src/router.js";
import {usdValue} from "../src/value.js";
import {SOURCE_GAS_UNITS, evmSourceGas, swapGasUnits} from "../src/gas.js";

const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const SPENDER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const SENDER = "0x5555555555555555555555555555555555555555";
const PRICES = {ETH: 3000, USDC: 1};
const PARAMS: QuoteParams = {sourceChain: "eip155:8453", sourceToken: USDC_BASE, destChain: "eip155:42161", destToken: USDC_ARB, amountIn: "100000000", destAddress: SENDER};
const GWEI = "0x3b9aca00";

const quote = (name: string, out: string, extra: Partial<Quote> = {}): Quote => ({
  provider: name, intentId: `${name}-1`, depositAddress: "", depositMemo: null, sourceAmount: PARAMS.amountIn, destAmount: out, minDestAmount: out,
  feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000, ...extra,
});
const provider = (name: string, out: string, extra: Partial<Quote> = {}): CrossChainProvider => ({
  name, enabled: () => true, supportsRoute: () => true,
  getQuote: async () => quote(name, out, extra),
  buildDeposit: async () => ({chain: PARAMS.sourceChain, to: SENDER, value: "0"}),
  trackIntent: async () => ({state: "pending"}),
});
// calldata route: venue gas 200k + approval 50k; deposit route: an ERC-20 transfer (65k); gasless: nothing.
const CALL = {txRequest: {to: SPENDER, data: "0xdeadbeef", value: "0", chainId: 8453, gasLimit: "200000", approvalAddress: SPENDER}};
const DEPOSIT = {depositAddress: SENDER};
const GASLESS = {gasless: true};

function rpc(answers: {allowance?: string; gasPrice?: string | Error} = {}) {
  const calls: string[] = [];
  const fn = async (_chain: string, method: string) => {
    calls.push(method);
    if (method === "eth_gasPrice") { if (answers.gasPrice instanceof Error) throw answers.gasPrice; return answers.gasPrice ?? GWEI; }
    if (method === "eth_call") return answers.allowance ?? "0x0";
    throw new Error(method);
  };
  return {fn, calls};
}

describe("SDK-291 source gas in the router's net value", () => {
  it("swapGasUnits: the venue's limit (capped), a transfer for a deposit route, nothing for a gasless quote", () => {
    expect(swapGasUnits(quote("a", "1", CALL), PARAMS)).toBe(200_000n);
    expect(swapGasUnits(quote("a", "1", {txRequest: (({gasLimit: _g, ...rest}) => rest)(CALL.txRequest)}), PARAMS)).toBe(SOURCE_GAS_UNITS.call);
    expect(swapGasUnits(quote("a", "1", {txRequest: {...CALL.txRequest, gasLimit: "900000000"}}), PARAMS)).toBe(SOURCE_GAS_UNITS.callCap);
    expect(swapGasUnits(quote("a", "1", DEPOSIT), PARAMS)).toBe(SOURCE_GAS_UNITS.tokenTransfer);
    expect(swapGasUnits(quote("a", "1", DEPOSIT), {...PARAMS, sourceToken: ""})).toBe(SOURCE_GAS_UNITS.nativeTransfer);
    expect(swapGasUnits(quote("a", "1", GASLESS), PARAMS)).toBe(0n);
  });

  it("reads the source token as the engine sends it: a catalog symbol, or an unlisted token's contract", async () => {
    const gas = evmSourceGas({prices: PRICES, rpc: rpc().fn});
    const bySymbol = {...PARAMS, sourceToken: "USDC"};
    expect(await gas(quote("a", "1", CALL), bySymbol)).toBeCloseTo(0.75, 9); // approval counted for the catalog's USDC
    expect(swapGasUnits(quote("a", "1", DEPOSIT), bySymbol)).toBe(SOURCE_GAS_UNITS.tokenTransfer);
    expect(swapGasUnits(quote("a", "1", DEPOSIT), {...PARAMS, sourceToken: "ETH"})).toBe(SOURCE_GAS_UNITS.nativeTransfer);
    // The native coin needs no approval, whatever the quote names.
    expect(await gas(quote("a", "1", CALL), {...PARAMS, sourceToken: "ETH"})).toBeCloseTo(0.6, 9);
    // The allowance is read on the catalog's contract.
    const seen: unknown[] = [];
    const reads = evmSourceGas({prices: PRICES, rpc: async (_c, m, p) => { if (m === "eth_call") { seen.push((p[0] as {to: string}).to); return "0x0"; } return GWEI; }});
    await reads(quote("a", "1", CALL), {...bySymbol, sender: SENDER});
    expect(seen).toEqual([USDC_BASE]);
  });

  it("evmSourceGas: units × eth_gasPrice × the native price, an approval unless the allowance covers it", async () => {
    const {fn} = rpc();
    const gas = evmSourceGas({prices: PRICES, rpc: fn});
    const covered = evmSourceGas({prices: PRICES, rpc: rpc({allowance: "0x" + "f".repeat(64)}).fn});
    expect(await gas(quote("a", "1", CALL), PARAMS)).toBeCloseTo(0.75, 9); // 250k × 1 gwei × $3000
    expect(await gas(quote("a", "1", DEPOSIT), PARAMS)).toBeCloseTo(0.195, 9);
    expect(await gas(quote("a", "1", GASLESS), PARAMS)).toBe(0);
    // A gasless order still needs its approval when it names the spender (Omniston EVM → TON: the order protocol).
    expect(await gas(quote("a", "1", {...GASLESS, providerData: {approvalAddress: SPENDER}}), PARAMS)).toBeCloseTo(0.15, 9);
    expect(await covered(quote("a", "1", {...GASLESS, providerData: {approvalAddress: SPENDER}}), {...PARAMS, sender: SENDER})).toBe(0);
    // The sender's allowance already covers the amount: no approval.
    expect(await covered(quote("a", "1", CALL), {...PARAMS, sender: SENDER})).toBeCloseTo(0.6, 9);
    // Not enough allowance, or no sender to read it for: the approval counts.
    const short = evmSourceGas({prices: PRICES, rpc: rpc({allowance: "0x01"}).fn});
    expect(await short(quote("a", "1", CALL), {...PARAMS, sender: SENDER})).toBeCloseTo(0.75, 9);
    // A non-EVM source: 0. No native price or no gas price: null.
    expect(await gas(quote("a", "1", DEPOSIT), {...PARAMS, sourceChain: "ton:-239", sourceToken: ""})).toBe(0);
    expect(await evmSourceGas({prices: {USDC: 1}, rpc: fn})(quote("a", "1", CALL), PARAMS)).toBeNull();
    expect(await evmSourceGas({prices: PRICES, rpc: rpc({gasPrice: new Error("down")}).fn})(quote("a", "1", CALL), PARAMS)).toBeNull();
    expect(await evmSourceGas({prices: PRICES, rpcUrl: () => undefined})(quote("a", "1", CALL), PARAMS)).toBeNull();
  });

  it("caches a chain's gas price; a failed read is asked again", async () => {
    const ok = rpc();
    const gas = evmSourceGas({prices: PRICES, rpc: ok.fn});
    await gas(quote("a", "1", DEPOSIT), PARAMS);
    await gas(quote("b", "1", DEPOSIT), PARAMS);
    expect(ok.calls.filter((m) => m === "eth_gasPrice")).toHaveLength(1);
    let fail = true;
    const calls: string[] = [];
    const flaky = evmSourceGas({prices: PRICES, rpc: async (_c, m) => { calls.push(m); if (fail) throw new Error("down"); return GWEI; }});
    expect(await flaky(quote("a", "1", DEPOSIT), PARAMS)).toBeNull();
    await Promise.resolve();
    fail = false;
    expect(await flaky(quote("a", "1", DEPOSIT), PARAMS)).toBeCloseTo(0.195, 9);
    expect(calls).toEqual(["eth_gasPrice", "eth_gasPrice"]);
  });

  it("the auction subtracts gas: a gasless route that delivers less can be the best", async () => {
    const providers = [provider("call", "100000000", CALL), provider("deposit", "99600000", DEPOSIT), provider("gasless", "99500000", GASLESS)];
    const without = (await new CrossChainRouter(providers, {valueUsd: usdValue(PRICES)}).getQuotes(PARAMS))!;
    expect(without.best.provider).toBe("call");
    expect(without.best.gasUsd).toBeNull();
    const set = (await new CrossChainRouter(providers, {valueUsd: usdValue(PRICES), sourceGasUsd: evmSourceGas({prices: PRICES, rpc: rpc().fn})}).getQuotes(PARAMS))!;
    expect(set.best.provider).toBe("gasless");
    const by = Object.fromEntries(set.quotes.map((q) => [q.provider, q]));
    expect(by.call!.gasUsd).toBeCloseTo(0.75, 9);
    expect(by.call!.netValueUsd).toBeCloseTo(99.25, 9);
    expect(by.deposit!.netValueUsd).toBeCloseTo(99.405, 9);
    expect(by.gasless!.gasUsd).toBe(0);
    expect(by.gasless!.netValueUsd).toBeCloseTo(99.5, 9);
    expect(set.quotes.map((q) => q.provider)).toEqual(["gasless", "deposit", "call"]);
    // getBestQuote's candidates carry the net value with gas.
    const best = await new CrossChainRouter(providers, {valueUsd: usdValue(PRICES), sourceGasUsd: evmSourceGas({prices: PRICES, rpc: rpc().fn})}).getBestQuote(PARAMS);
    expect(best?.provider).toBe("gasless");
    expect(best).not.toHaveProperty("gasUsd");
  });

  it("gas comes off every quote or none: one quote without an answer leaves the whole auction without gas", async () => {
    const providers = [provider("call", "100000000", CALL), provider("gasless", "99500000", GASLESS)];
    for (const sourceGasUsd of [
      async (q: Quote) => (q.provider === "call" ? null : 0),
      async (q: Quote) => { if (q.provider === "call") throw new Error("rpc down"); return 0; },
      async (q: Quote) => (q.provider === "call" ? Number.NaN : 0),
      async (q: Quote) => (q.provider === "call" ? -1 : 0),
    ]) {
      const set = (await new CrossChainRouter(providers, {valueUsd: usdValue(PRICES), sourceGasUsd}).getQuotes(PARAMS))!;
      expect(set.best.provider).toBe("call");
      expect(set.quotes.every((q) => q.gasUsd === null)).toBe(true);
      expect(set.best.netValueUsd).toBeCloseTo(100, 9);
    }
  });

  it("a gas estimate that hangs is cut off and leaves the auction without gas", async () => {
    const providers = [provider("call", "100000000", CALL), provider("gasless", "99500000", GASLESS)];
    const started = Date.now();
    const set = (await new CrossChainRouter(providers, {
      valueUsd: usdValue(PRICES),
      sourceGasUsd: (q) => (q.provider === "call" ? new Promise<number>(() => {}) : Promise.resolve(0)),
    }).getQuotes(PARAMS))!;
    expect(Date.now() - started).toBeLessThan(6000);
    expect(set.best.provider).toBe("call");
    expect(set.best.gasUsd).toBeNull();
  }, 10_000);

  it("without prices for every quote the auction compares outputs, gas or not", async () => {
    const providers = [provider("call", "100000000", CALL), provider("gasless", "99500000", GASLESS)];
    const set = (await new CrossChainRouter(providers, {sourceGasUsd: evmSourceGas({prices: PRICES, rpc: rpc().fn})}).getQuotes(PARAMS))!;
    expect(set.best.provider).toBe("call");
    expect(set.best.netValueUsd).toBeNull();
    expect(set.best.gasUsd).toBeNull();
  });

  it("the estimate sees a copy: it cannot change the quote that is ranked", async () => {
    const providers = [provider("call", "100000000", CALL), provider("gasless", "99500000", GASLESS)];
    const set = (await new CrossChainRouter(providers, {
      valueUsd: usdValue(PRICES),
      sourceGasUsd: async (q) => { q.minDestAmount = "1"; if (q.txRequest) q.txRequest.to = SENDER; return 0; },
    }).getQuotes(PARAMS))!;
    expect(set.quotes.find((q) => q.provider === "call")!.minDestAmount).toBe("100000000");
    expect(set.quotes.find((q) => q.provider === "call")!.txRequest!.to).toBe(SPENDER);
  });
});
