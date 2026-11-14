import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {Swap2QuoteError, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {acrossProvider, acrossServesRoute} from "../src/provider.js";
import {acrossRemoteProvider} from "../src/remote.js";
import {AcrossSwap2Protocol} from "../src/protocol.js";
import {acrossQuoteOf} from "../src/build.js";
import {acrossPins} from "../src/verify.js";
import {ARB_USDC, ARB_WETH, BASE, NOW_MS, OTHER, USER, ZERO, merged, refused, usdcQuote, usdcRequest, type Loose} from "./fixtures.js";
import {RPC_URLS, TEST_KEY, loadRecorded, replay, type Seen} from "./recorded.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"], now: NOW_MS}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function params(over: Loose<QuoteParams> = {}): QuoteParams & {reasons: [string, Swap2RefusalInfo | undefined][]} {
  const reasons: [string, Swap2RefusalInfo | undefined][] = [];
  return merged<QuoteParams & {reasons: [string, Swap2RefusalInfo | undefined][]}>({
    sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000",
    destAddress: USER, refundAddress: USER, sender: USER, dry: false, onRefusal: (r, i) => reasons.push([r, i]), reasons,
  }, over);
}

/** A fetch that records every call and answers nothing useful. */
function watchFetch(): {fetchImpl: typeof fetch; calls: unknown[]} {
  const calls: unknown[] = [];
  return {calls, fetchImpl: (async (...a: unknown[]) => { calls.push(a); return new Response("{}"); }) as typeof fetch};
}

describe("discovery", () => {
  it("disabled without a key (it still builds, verifies and tracks); enabled with one, unless its dark flag says otherwise", () => {
    expect(acrossProvider().enabled()).toBe(false);
    expect(acrossProvider({apiKey: " "}).enabled()).toBe(false);
    expect(acrossProvider({apiKey: () => { throw new Error("vault down"); }}).enabled()).toBe(false);
    expect(acrossProvider({apiKey: TEST_KEY}).enabled()).toBe(true);
    expect(acrossProvider({apiKey: () => TEST_KEY}).enabled()).toBe(true);
    expect(acrossProvider({apiKey: TEST_KEY, enabled: false}).enabled()).toBe(false);
  });

  it("says which routes it serves: pinned chains and tokens, the same asset, not Ethereum as the destination", () => {
    const p = acrossProvider({apiKey: TEST_KEY});
    expect(p.name).toBe("across");
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
    expect(p.supportsRoute({chain: "eip155:137", token: "POL"}, {chain: "eip155:42161", token: ZERO})).toBe(false);
    // Ethereum as the destination is not priced.
    expect(p.supportsRoute({chain: "eip155:8453", token: "ETH"}, {chain: "eip155:1", token: ZERO})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:1", token: "ETH"}, {chain: "eip155:8453", token: ZERO})).toBe(true);
    // The remote stub answers alike.
    const app = acrossRemoteProvider({baseUrl: "https://backend.example/api/swap2"});
    for (const [from, to] of [[{chain: "eip155:8453", token: "USDC"}, {chain: "eip155:42161", token: ARB_USDC}], [{chain: "eip155:8453", token: "ETH"}, {chain: "eip155:1", token: ZERO}]] as const) {
      expect(app.supportsRoute(from, to)).toBe(acrossServesRoute(from, to));
    }
  });

  it("config is validated (plain errors, no reason)", () => {
    expect(() => acrossProvider({maxFeeBps: 5001})).toThrow(/maxFeeBps/);
    expect(() => acrossProvider({maxFeeBps: 1.5})).toThrow(/maxFeeBps/);
    expect(() => acrossProvider({rpcUrls: {"eip155:1": "file:///x"}})).toThrow(/http or https/);
    expect(() => acrossProvider({baseUrl: "http://api.across.to"})).toThrow(/baseUrl must be an https/);
    expect(() => acrossProvider({baseUrl: "https://user@api.across.to"})).toThrow(/baseUrl/);
    expect(() => acrossProvider({suggestedFeesUrl: "ftp://x"})).toThrow(/suggestedFeesUrl/);
    expect(() => acrossProvider({quoteTtlMs: 300_001})).toThrow(/quoteTtlMs/);
    expect(() => acrossProvider({timeoutMs: 0})).toThrow(/timeoutMs/);
    expect(() => acrossProvider({baseUrl: "http://localhost:8787", suggestedFeesUrl: null})).not.toThrow();
  });
});

describe("the key stays on a server", () => {
  it("under React Native (navigator.product) or Hermes (HermesInternal) a provider with a key is refused, pointing to the remote mode", () => {
    for (const [name, value] of [["navigator", {product: "ReactNative"}], ["HermesInternal", {}]] as const) {
      vi.stubGlobal(name, value);
      for (const apiKey of [() => TEST_KEY, TEST_KEY]) {
        expect(() => acrossProvider({apiKey})).toThrow(/the Across API key belongs on a server .*acrossRemoteProvider\(\{baseUrl\}\) in the app/);
        expect(() => new AcrossSwap2Protocol(undefined, {fromChain: "eip155:8453", apiKey})).toThrow(/belongs on a server/);
      }
      // Without a key it builds (status, verification); the remote provider is what an app quotes through.
      expect(acrossProvider({rpcUrls: {}}).enabled()).toBe(false);
      expect(acrossRemoteProvider({baseUrl: "https://backend.example/api"}).supportsChain!("eip155:8453")).toBe(true);
      vi.unstubAllGlobals();
    }
  });

  it("the key is sent only as the bearer header to the V5 origin — never in a URL, a refusal or a quote", async () => {
    const f = loadRecorded("usdc-base-arb-25");
    vi.setSystemTime(f.nowMs);
    const seen: Seen[] = [];
    const ps = params({...f.params});
    const q = await acrossProvider({apiKey: () => TEST_KEY, fetchImpl: replay(f, seen)}).getQuote(ps);
    expect(q).not.toBeNull();
    for (const s of seen) {
      expect(s.url).not.toContain(TEST_KEY);
      expect(s.headers.authorization === `Bearer ${TEST_KEY}`).toBe(s.url.startsWith("https://api.across.to/"));
    }
    expect(JSON.stringify(q)).not.toContain(TEST_KEY);
    // A refusal carries no key either.
    const failing = params({...f.params});
    await acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f, [], (c) => (c.kind === "v5" ? {status: 401, body: {code: "unauthenticated", message: "AUTH_INVALID"}} : undefined))}).getQuote(failing);
    expect(failing.reasons).toEqual([["across: Across API V5 answered HTTP 401 unauthenticated [api-error]", {reason: "key_rejected"}]]);
  });
});

describe("getQuote", () => {
  it("without a key: refused (key_rejected) and nothing is asked of the network", async () => {
    const {fetchImpl, calls} = watchFetch();
    const p = acrossProvider({fetchImpl});
    const ps = params();
    expect(await p.getQuote(ps)).toBeNull();
    expect(ps.reasons).toEqual([["across: no Across API key is configured — give the server's acrossProvider an apiKey, and run acrossRemoteProvider in the app [quote-unavailable]", {reason: "key_rejected"}]]);
    expect(calls).toEqual([]);
  });

  it("an unserved request says why first, and asks nothing", async () => {
    const {fetchImpl, calls} = watchFetch();
    const p = acrossProvider({apiKey: TEST_KEY, fetchImpl});
    const cases: [Loose<QuoteParams>, string, string | undefined][] = [
      [{destChain: "eip155:56"}, "chain-unsupported", "unsupported_pair"],
      [{destToken: ARB_WETH}, "wrapped-native-destination", "unsupported_pair"],
      [{destToken: ZERO}, "pair-unsupported", "unsupported_pair"],
      [{flex: true}, "request-invalid", "unsupported_pair"],
      [{destAddress: ""}, "request-invalid", undefined],
      [{sender: undefined}, "request-invalid", undefined],
      [{refundAddress: OTHER}, "request-invalid", "recipient_mismatch"],
      [{destChain: "eip155:1", destToken: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"}, "route-unpriced", "unsupported_pair"],
    ];
    for (const [over, code, reason] of cases) {
      const ps = params(over);
      expect(await p.getQuote(ps)).toBeNull();
      expect(ps.reasons[0]![0]).toMatch(new RegExp(`\\[${code}\\]$`));
      expect(ps.reasons[0]![1]?.reason).toBe(reason);
    }
    expect(calls).toEqual([]);
  });

  describe("when an API fails", () => {
    const f = loadRecorded("usdc-base-arb-25");
    beforeEach(() => { vi.setSystemTime(f.nowMs); });
    const quoteWith = async (edit: Parameters<typeof replay>[2], extra: Parameters<typeof acrossProvider>[0] = {}) => {
      const ps = params({...f.params});
      const q = await acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f, [], edit), ...extra}).getQuote(ps);
      return {q, reasons: ps.reasons};
    };

    it("V5 refuses: its classification, the bound it names", async () => {
      const {q, reasons} = await quoteWith((c) => (c.kind === "v5" ? {status: 400, body: {error: {type: "policy", code: "policy.amount_out_of_range", message: "quote value loss exceeds the allowance of 5000 bps plus $0; raise the amount above 30000000 base units", details: {amountLimits: {side: "min", amount: "30000000"}}}}} : undefined));
      expect(q).toBeNull();
      expect(reasons).toEqual([["across: Across API V5 answered HTTP 400 policy.amount_out_of_range (the amount must be at least 30000000 base units) [api-error]", {reason: "amount_too_small"}]]);
      expect((await quoteWith((c) => (c.kind === "v5" ? {status: 503, body: {error: {type: "system", code: "system.unavailable"}}} : undefined))).reasons[0]![1]).toEqual({reason: "upstream_unavailable"});
      expect((await quoteWith((c) => (c.kind === "v5" ? {status: 429, body: {code: "rate_limited"}} : undefined))).reasons[0]![1]).toEqual({reason: "rate_limited"});
    });

    it("an answer that came through a redirect is refused (the key must not follow it)", async () => {
      const {q, reasons} = await quoteWith((c) => (c.kind === "v5" ? {url: "https://evil.example/v1/quotes"} : undefined));
      expect(q).toBeNull();
      expect(reasons).toEqual([[expect.stringMatching(/Across API V5 answered through a redirect or from another origin/), {reason: "policy_refused"}]]);
    });

    it("V5's answer is held to the request: another amount is refused", async () => {
      const {reasons} = await quoteWith((c) => (c.kind === "v5" ? {body: {...c.response, origin: {...c.response.origin, amount: "1"}}} : undefined));
      expect(reasons).toEqual([["across: the V5 quote sends 1, the request 25000000 [api-answer]", {reason: "policy_refused"}]]);
    });

    it("/suggested-fees says relayers will not take it: refused with its reason", async () => {
      const {reasons} = await quoteWith((c) => (c.kind === "suggested-fees" ? {status: 400, body: {type: "AcrossApiError", code: "ROUTE_NOT_ENABLED", status: 400, message: "Route is not enabled."}} : undefined));
      expect(reasons).toEqual([["across: Across's relayer fee quote says this route is not enabled for relayers [relayer-price]", {reason: "unsupported_pair"}]]);
      const moved = await quoteWith((c) => (c.kind === "suggested-fees" ? {body: {...c.response, spokePoolAddress: OTHER}} : undefined));
      expect(moved.reasons[0]![1]).toEqual({reason: "vault_mismatch"});
    });

    it("/suggested-fees down and no RPC for the quote time: refused (upstream_unavailable), never priced on V5 alone", async () => {
      const {q, reasons} = await quoteWith((c) => (c.kind === "suggested-fees" ? {status: 502, body: "bad gateway"} : undefined));
      expect(q).toBeNull();
      expect(reasons).toEqual([["across: Across's relayer fee quote did not answer, and the quote time then needs rpcUrls for Ethereum and the source chain [relayer-price]", {reason: "upstream_unavailable"}]]);
    });

    it("/suggested-fees down, RPCs that do not answer: refused", async () => {
      const floor = loadRecorded("usdc-arb-base-100-floor");
      vi.setSystemTime(floor.nowMs);
      const ps = params({...floor.params});
      const q = await acrossProvider({apiKey: TEST_KEY, suggestedFeesUrl: null, rpcUrls: RPC_URLS, fetchImpl: replay(floor, [], (c) => (c.kind === "rpc" ? {body: {result: null}} : undefined))}).getQuote(ps);
      expect(q).toBeNull();
      expect(ps.reasons[0]![1]).toEqual({reason: "upstream_unavailable"});
    });

    it("a fee over the caller's cap: refused by the verifier before anything is offered", async () => {
      const {q, reasons} = await quoteWith(undefined, {maxFeeBps: 1});
      expect(q).toBeNull();
      expect(reasons[0]![0]).toMatch(/over the 1 bps cap \[tx-fee\]$/);
      expect(reasons[0]![1]).toEqual({reason: "price_check_failed"});
    });

    it("the caller's own abort is not the venue failing", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ps = params({...f.params});
      const q = await acrossProvider({apiKey: TEST_KEY, fetchImpl: (async () => { throw new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch}).getQuote(ps, ctrl.signal);
      expect(q).toBeNull();
      expect(ps.reasons[0]![1]).toBeUndefined();
    });
  });

  it("through the standalone class without a key: no route, classified policy_refused (the engine's dark flag)", async () => {
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

describe("build and preflight", () => {
  const quote = () => acrossQuoteOf(usdcRequest({minAmountOut: undefined}), usdcQuote());
  const txOfQuote = (q: ReturnType<typeof quote>): UnsignedTx => ({chain: "eip155:8453", to: q.txRequest!.to!, data: q.txRequest!.data!, value: "0", chainId: 8453, approvalAddress: BASE.spokePool});

  it("buildDeposit returns the quote's own verified transaction; preflight passes it", async () => {
    const p = acrossProvider();
    const q = quote();
    const tx = await p.buildDeposit(q);
    expect(tx).toEqual(txOfQuote(q));
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("refuses a quote that no longer says what it was built for, a dry quote, a tampered transaction", async () => {
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
    expect(q.validUntilMs).toBeLessThan(NOW_MS + 3300 * 1000);
  });

  it("the fee cap of the provider applies to builds", async () => {
    const strict = acrossProvider({maxFeeBps: 1});
    refused(() => acrossQuoteOf(usdcRequest({minAmountOut: undefined, maxFeeBps: 1}), usdcQuote()), "tx-fee", "price_check_failed");
    await expect(strict.buildDeposit(quote())).rejects.toThrow(/\[tx-fee\]/);
  });
});

describe("router", () => {
  it("the dispatch snapshot forwards every Across method and invents none; without a key the router sits it out", async () => {
    const router = new CrossChainRouter([acrossProvider()]);
    const p = router.getProvider("across")!;
    for (const m of ["getQuote", "buildDeposit", "preflightDeposit", "trackIntent", "describeActivity", "supportsChain", "supportsChainPair", "supportsRoute"]) {
      expect(typeof (p as unknown as Record<string, unknown>)[m], m).toBe("function");
    }
    expect((p as unknown as Record<string, unknown>).buildClaim).toBeUndefined();
    expect(router.supportsChainPair("eip155:8453", "eip155:42161")).toBe(false);
    expect(await router.getBestQuote(params())).toBeNull();
  });

  it("with a key the router quotes through it", async () => {
    const f = loadRecorded("usdc-base-arb-25");
    vi.setSystemTime(f.nowMs);
    const router = new CrossChainRouter([acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f)})]);
    expect(router.supportsChainPair("eip155:8453", "eip155:42161")).toBe(true);
    const best = await router.getBestQuote({...f.params});
    expect(best?.provider).toBe("across");
  });

  it("the remote pins are what a remoteProvider stub needs", () => {
    expect(typeof acrossPins.verifyQuote).toBe("function");
    expect(typeof acrossPins.verifyBuild).toBe("function");
    expect(acrossPins.depositAddressRoutes).toBeUndefined();
  });
});
