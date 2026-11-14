import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {Swap2QuoteError, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {acrossProvider} from "../src/provider.js";
import {AcrossSwap2Protocol} from "../src/protocol.js";
import {acrossQuoteOf} from "../src/build.js";
import {acrossPins} from "../src/verify.js";
import {ARB_USDC, ARB_WETH, BASE, NOW_MS, OTHER, USER, ZERO, merged, refused, usdcQuote, usdcRequest, type Loose} from "./fixtures.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"], now: NOW_MS}); });
afterEach(() => { vi.useRealTimers(); });

function params(over: Loose<QuoteParams> = {}): QuoteParams & {reasons: [string, Swap2RefusalInfo | undefined][]} {
  const reasons: [string, Swap2RefusalInfo | undefined][] = [];
  return merged<QuoteParams & {reasons: [string, Swap2RefusalInfo | undefined][]}>({
    sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000",
    destAddress: USER, refundAddress: USER, sender: USER, dry: false, onRefusal: (r, i) => reasons.push([r, i]), reasons,
  }, over);
}

/** A fetch that records every call: nothing in this build may make one while quoting. */
function watchFetch(): {fetchImpl: typeof fetch; calls: unknown[]} {
  const calls: unknown[] = [];
  return {calls, fetchImpl: (async (...a: unknown[]) => { calls.push(a); return new Response("{}"); }) as typeof fetch};
}

describe("discovery", () => {
  const p = acrossProvider();
  it("is disabled until the quoting layer exists, and says which routes it would serve", () => {
    expect(p.name).toBe("across");
    expect(p.enabled()).toBe(false);
    expect(p.supportsSameChain).toBeUndefined();
    expect(p.supportsChain!("eip155:8453")).toBe(true);
    expect(p.supportsChain!("eip155:56")).toBe(false);
    expect(p.supportsChainPair!("eip155:8453", "eip155:42161")).toBe(true);
    expect(p.supportsChainPair!("eip155:8453", "eip155:8453")).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: ARB_USDC})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:42161", token: ZERO})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "WETH"}, {chain: "eip155:42161", token: ZERO})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:42161", token: ARB_WETH})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: ZERO})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "DAI"}, {chain: "eip155:42161", token: ARB_USDC})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:8453", token: "NOPE"}, {chain: "eip155:42161", token: ARB_USDC})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:137", token: "POL"}, {chain: "eip155:42161", token: ZERO})).toBe(false);
  });

  it("config is validated (plain errors, no reason)", () => {
    expect(() => acrossProvider({maxFeeBps: 5001})).toThrow(/maxFeeBps/);
    expect(() => acrossProvider({maxFeeBps: 1.5})).toThrow(/maxFeeBps/);
    expect(() => acrossProvider({rpcUrls: {"eip155:1": "file:///x"}})).toThrow(/http or https/);
  });
});

describe("getQuote", () => {
  it("refuses with a classified reason and asks nothing of the network", async () => {
    const {fetchImpl, calls} = watchFetch();
    const p = acrossProvider({fetchImpl});
    const ps = params();
    expect(await p.getQuote(ps)).toBeNull();
    expect(ps.reasons).toEqual([["across: quoting arrives with the Across API V5 layer — this build has no quote source [quote-unavailable]", {reason: "policy_refused"}]]);
    const dry = params({dry: true, destAddress: "", refundAddress: undefined, sender: undefined});
    expect(await p.getQuote(dry)).toBeNull();
    expect(dry.reasons[0]![0]).toMatch(/\[quote-unavailable\]$/);
    expect(calls).toEqual([]);
  });

  it("an unserved request says why first", async () => {
    const p = acrossProvider();
    const cases: [Loose<QuoteParams>, string, string | undefined][] = [
      [{destChain: "eip155:56"}, "chain-unsupported", "unsupported_pair"],
      [{destToken: ARB_WETH}, "wrapped-native-destination", "unsupported_pair"],
      [{destToken: ZERO}, "pair-unsupported", "unsupported_pair"],
      [{flex: true}, "request-invalid", "unsupported_pair"],
      [{destAddress: ""}, "request-invalid", undefined],
    ];
    for (const [over, code, reason] of cases) {
      const ps = params(over);
      expect(await p.getQuote(ps)).toBeNull();
      expect(ps.reasons[0]![0]).toMatch(new RegExp(`\\[${code}\\]$`));
      expect(ps.reasons[0]![1]?.reason).toBe(reason);
    }
  });

  it("through the standalone class: no route, classified policy_refused (the engine's dark flag)", async () => {
    const protocol = new AcrossSwap2Protocol(undefined, {fromChain: "eip155:8453"});
    let err: unknown;
    try {
      await protocol.quoteSwap2({fromToken: "USDC", toToken: ARB_USDC, toChain: 42161, recipient: USER, fromTokenAmount: 25_000_000n});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Swap2QuoteError);
    expect((err as Swap2QuoteError).refusals).toEqual([{provider: "across", message: "across: disabled", reason: "policy_refused"}]);
  });
});

describe("build and preflight (for a quote the coming V5 layer will make)", () => {
  const quote = () => acrossQuoteOf(usdcRequest({minAmountOut: undefined}), usdcQuote());
  const txOfQuote = (q: ReturnType<typeof quote>): UnsignedTx => ({chain: "eip155:8453", to: q.txRequest!.to!, data: q.txRequest!.data!, value: "0", chainId: 8453, approvalAddress: BASE.spokePool});

  it("buildDeposit returns the quote's own verified transaction; preflight passes it", async () => {
    const p = acrossProvider();
    const q = quote();
    const tx = await p.buildDeposit(q);
    expect(tx).toEqual(txOfQuote(q));
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("refuses a quote that no longer says what it was built for, a placeholder quote, a tampered transaction", async () => {
    const p = acrossProvider();
    const q = quote();
    await expect(p.buildDeposit({...q, providerData: {...q.providerData!, recipient: OTHER}})).rejects.toThrow(/\[tx-recipient\]/);
    await expect(p.buildDeposit({...q, providerData: {...q.providerData!, placeholder: "1"}})).rejects.toThrow(/\[request-invalid\]/);
    await expect(p.buildDeposit({...q, intentId: "relay:x"})).rejects.toThrow(/no transaction request/);
    await expect(p.buildDeposit({...q, txRequest: undefined} as never)).rejects.toThrow(/no transaction request/);
    const tx = txOfQuote(q);
    await expect(p.preflightDeposit!(q, {...tx, chain: "eip155:1"})).rejects.toThrow(/\[tx-chain\]/);
    await expect(p.preflightDeposit!(q, {...tx, to: OTHER})).rejects.toThrow(/\[tx-target\]/);
    await expect(p.preflightDeposit!(q, {...tx, value: "1"})).rejects.toThrow(/\[tx-value\]/);
    await expect(p.preflightDeposit!(q, {...tx, approvalAddress: OTHER})).rejects.toThrow(/\[tx-approval\]/);
    await expect(p.preflightDeposit!(q, {...tx, serializedTx: "AA"})).rejects.toThrow(/\[tx-shape\]/);
    await expect(p.preflightDeposit!(q, {...tx, typedData: JSON.stringify({primaryType: "UpdateDepositDetails"})})).rejects.toThrow(/\[speed-up\]/);
  });

  it("a quote that aged past its quote time is refused right before signing", async () => {
    const p = acrossProvider();
    const q = quote();
    vi.setSystemTime(NOW_MS + 3300 * 1000);
    await expect(p.preflightDeposit!(q, txOfQuote(q))).rejects.toThrow(/\[tx-quote-time\]/);
    // The quote's own life is shorter still: the engine refuses it on expiry before that.
    expect(q.validUntilMs).toBeLessThan(NOW_MS + 3300 * 1000);
  });

  it("the fee cap of the provider applies to builds", async () => {
    const strict = acrossProvider({maxFeeBps: 1});
    refused(() => acrossQuoteOf(usdcRequest({minAmountOut: undefined, maxFeeBps: 1}), usdcQuote()), "tx-fee", "price_check_failed");
    await expect(strict.buildDeposit(quote())).rejects.toThrow(/\[tx-fee\]/);
  });
});

describe("router", () => {
  it("the dispatch snapshot forwards every Across method and invents none; the router sits it out while disabled", async () => {
    const router = new CrossChainRouter([acrossProvider()]);
    const p = router.getProvider("across")!;
    for (const m of ["getQuote", "buildDeposit", "preflightDeposit", "trackIntent", "describeActivity", "supportsChain", "supportsChainPair", "supportsRoute"]) {
      expect(typeof (p as unknown as Record<string, unknown>)[m], m).toBe("function");
    }
    expect((p as unknown as Record<string, unknown>).buildClaim).toBeUndefined();
    expect(router.supportsChainPair("eip155:8453", "eip155:42161")).toBe(false);
    expect(await router.getBestQuote(params())).toBeNull();
  });

  it("the remote pins are what a remoteProvider stub needs", () => {
    expect(typeof acrossPins.verifyQuote).toBe("function");
    expect(typeof acrossPins.verifyBuild).toBe("function");
    expect(acrossPins.depositAddressRoutes).toBeUndefined();
  });
});
