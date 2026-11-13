// CS-13: refusal reasons. Every refusal keeps its text; `reason` classifies it. Mocked provider,
// account and backend only — no network, no keys.
import {describe, expect, it} from "vitest";
import {
  SWAP2_REFUSAL_REASONS,
  Swap2Error,
  Swap2FeeLimitError,
  Swap2QuoteError,
  combinedRefusal,
  httpRefusal,
  isSwap2RefusalReason,
  parseRetryAfter,
  refusal,
  refusalInfo,
  refusalNotes,
  refusalOf,
  Swap2MaybeSentError,
  withReason,
  type Swap2Refusal,
} from "../src/errors.js";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler, Swap2HandlerError} from "../src/server.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, Quote, QuoteParams, RemotePins, UnsignedTx} from "../src/types.js";

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

describe("the reasons", () => {
  it("are the 17 the apps switch on, frozen, and nothing else passes as one", () => {
    expect(SWAP2_REFUSAL_REASONS).toEqual([
      "no_route", "unsupported_pair", "amount_too_small", "amount_too_large", "insufficient_liquidity",
      "rate_limited", "key_rejected", "upstream_unavailable", "chain_halted", "recipient_unverifiable",
      "recipient_mismatch", "vault_mismatch", "stale_node", "quote_expired", "price_check_failed",
      "simulation_failed", "policy_refused",
    ]);
    expect(Object.isFrozen(SWAP2_REFUSAL_REASONS)).toBe(true);
    for (const r of SWAP2_REFUSAL_REASONS) expect(isSwap2RefusalReason(r)).toBe(true);
    for (const v of ["NO_ROUTE", "no-route", "", "QUOTE", 1, null, undefined, {reason: "no_route"}]) expect(isSwap2RefusalReason(v)).toBe(false);
  });
});

describe("refusal() and withReason()", () => {
  it("refusal() is a plain Error with the same text and a reason", () => {
    const e = refusal("amount_too_small", "lifi: below the minimum");
    expect(e).toBeInstanceOf(Error);
    expect(e.constructor).toBe(Error);
    expect(e.name).toBe("Error");
    expect(e.message).toBe("lifi: below the minimum");
    expect(String(e)).toBe("Error: lifi: below the minimum");
    expect(refusalOf(e)).toEqual({reason: "amount_too_small"});
  });

  it("keeps a valid wait and status, drops invalid ones, keeps the cause", () => {
    const cause = new Error("inner");
    const e = refusal("rate_limited", "x: slow down", {retryAfterMs: 1500, httpStatus: 429, cause});
    expect(refusalOf(e)).toEqual({reason: "rate_limited", retryAfterMs: 1500, httpStatus: 429});
    expect(e.cause).toBe(cause);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refusalOf(refusal("rate_limited", "x", {retryAfterMs: bad}))).toEqual({reason: "rate_limited"});
    }
    expect(refusalOf(refusal("rate_limited", "x", {retryAfterMs: 10 * 86_400_000}))?.retryAfterMs).toBe(86_400_000);
    for (const bad of [99, 600, 404.5]) {
      expect(refusalOf(refusal("upstream_unavailable", "x", {httpStatus: bad}))).toEqual({reason: "upstream_unavailable"});
    }
  });

  it("withReason() returns the same error, untouched when the value is not a reason", () => {
    const e = new TypeError("Network request failed");
    expect(withReason(e, "upstream_unavailable")).toBe(e);
    expect(e).toBeInstanceOf(TypeError);
    expect(e.message).toBe("Network request failed");
    expect(refusalOf(e)).toEqual({reason: "upstream_unavailable"});
    const f = new Error("f");
    withReason(f, "NO_ROUTE" as never);
    expect(refusalOf(f)).toBeUndefined();
    expect("reason" in f).toBe(false);
  });

  it("the first classification stands, and a field of another meaning is never overwritten", () => {
    const e = refusal("rate_limited", "x: 429", {retryAfterMs: 2000});
    withReason(e, "upstream_unavailable");
    expect(refusalOf(e)).toEqual({reason: "rate_limited", retryAfterMs: 2000});
    // A wallet's SimulationError carries its revert text in `reason`.
    class SimulationError extends Error { constructor(readonly reason: string) { super(`simulation failed: ${reason}`); } }
    const sim = new SimulationError("ERC20: transfer amount exceeds balance");
    withReason(sim, "simulation_failed");
    expect(sim.reason).toBe("ERC20: transfer amount exceeds balance");
    expect(refusalOf(sim)).toBeUndefined();
  });
});

describe("refusalOf()", () => {
  it("reads the error's own reason, else the first one down the cause chain (six deep)", () => {
    const inner = refusal("chain_halted", "thorchain: ETH is halted");
    const outer = new Error("swap failed", {cause: new Error("middle", {cause: inner})});
    expect(refusalOf(outer)).toEqual({reason: "chain_halted"});
    let deep: Error = refusal("stale_node", "deep");
    for (let i = 0; i < 6; i++) deep = new Error(`wrap ${i}`, {cause: deep});
    expect(refusalOf(deep)).toBeUndefined();
  });

  it("ignores anything that is not a known reason, and non-objects", () => {
    expect(refusalOf({reason: "nope"})).toBeUndefined();
    expect(refusalOf({reason: "ERC20: transfer amount exceeds balance"})).toBeUndefined();
    for (const v of [null, undefined, "no_route", 42]) expect(refusalOf(v)).toBeUndefined();
  });

  it("reads only reasons this module stamped: a contract's revert text that spells a reason is not one", () => {
    // wallet-evm's SimulationError and viem's ContractFunctionRevertedError carry the revert string in `reason`.
    class SimulationError extends Error { constructor(readonly reason: string) { super(`simulation failed: ${reason}`); } }
    const revert = new SimulationError("quote_expired");
    withReason(revert, "simulation_failed");
    expect(refusalOf(revert)).toBeUndefined();
    expect(refusalOf(new Error("wrapped", {cause: revert}))).toBeUndefined();
    expect(refusalOf(Object.assign(new Error("x"), {reason: "rate_limited", retryAfterMs: 1}))).toBeUndefined();
    expect(refusalOf({reason: "no_route"})).toBeUndefined();
    // a stamped link further down still counts
    expect(refusalOf(new Error("outer", {cause: new SimulationError("rate_limited")}))).toBeUndefined();
    expect(refusalOf(new Error("outer", {cause: refusal("chain_halted", "halted")}))).toEqual({reason: "chain_halted"});
  });

  it("is never a retry signal on a transaction that may have been broadcast", () => {
    const network = withReason(new TypeError("Network request failed"), "upstream_unavailable");
    expect(refusalOf(new Swap2MaybeSentError("swap2: the source transaction may have been broadcast", "0xabc", undefined, {cause: network}))).toBeUndefined();
    expect(refusalOf(new Error("outer", {cause: new Swap2MaybeSentError("maybe", undefined, undefined, {cause: network})}))).toBeUndefined();
    expect(refusalOf(new Error("outer", {cause: Object.assign(withReason(new Error("x"), "rate_limited"), {maybeSent: true})}))).toBeUndefined();
  });
});

describe("refusalInfo()", () => {
  it("reads a plain object's valid fields (a server body, an onRefusal argument), no cause walk", () => {
    expect(refusalInfo({reason: "no_route", retryAfterMs: "5", httpStatus: "503"})).toEqual({reason: "no_route"});
    expect(refusalInfo({reason: "rate_limited", retryAfterMs: 1000, httpStatus: 429, extra: 1})).toEqual({reason: "rate_limited", retryAfterMs: 1000, httpStatus: 429});
    expect(refusalInfo({reason: "nope"})).toBeUndefined();
    expect(refusalInfo({cause: {reason: "no_route"}})).toBeUndefined();
    for (const v of [null, undefined, "no_route", 42]) expect(refusalInfo(v)).toBeUndefined();
  });
});

describe("HTTP statuses", () => {
  it("parses Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter("120", NOW)).toBe(120_000);
    expect(parseRetryAfter(" 0 ", NOW)).toBe(0);
    expect(parseRetryAfter(new Date(NOW + 30_000).toUTCString(), NOW)).toBe(30_000);
    expect(parseRetryAfter(new Date(NOW - 30_000).toUTCString(), NOW)).toBe(0);
    expect(parseRetryAfter("999999999", NOW)).toBe(86_400_000);
    for (const v of ["soon", "-5", "1.5", "", "2026-11-13T12:00:30Z", "Fri, 13 Nov 2026 12:00:30 UTC", null, undefined]) expect(parseRetryAfter(v, NOW)).toBeUndefined();
  });

  it("429 → rate_limited, 401/403 → key_rejected, 408/425/5xx → upstream_unavailable, the rest unclassified", () => {
    expect(httpRefusal(429, "7", NOW)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000});
    expect(httpRefusal(429, null, NOW)).toEqual({reason: "rate_limited", httpStatus: 429});
    expect(httpRefusal(401)).toEqual({reason: "key_rejected", httpStatus: 401});
    expect(httpRefusal(403)).toEqual({reason: "key_rejected", httpStatus: 403});
    for (const s of [408, 425, 500, 502, 503, 504, 599]) expect(httpRefusal(s)).toEqual({reason: "upstream_unavailable", httpStatus: s});
    for (const s of [200, 301, 400, 404, 409, 410, 422, 99, 600, 500.5]) expect(httpRefusal(s)).toBeUndefined();
  });
});

describe("combinedRefusal()", () => {
  const r = (reason: Swap2Refusal["reason"], extra: Partial<Swap2Refusal> = {}): Swap2Refusal => ({message: "m", ...(reason ? {reason} : {}), ...extra});
  it("no refusals, mixed reasons or an unclassified one add up to no_route", () => {
    expect(combinedRefusal([])).toEqual({reason: "no_route"});
    expect(combinedRefusal([r("amount_too_small"), r("chain_halted")])).toEqual({reason: "no_route"});
    expect(combinedRefusal([r("amount_too_small"), r(undefined)])).toEqual({reason: "no_route"});
    expect(combinedRefusal([r(undefined)])).toEqual({reason: "no_route"});
  });
  it("one shared reason is the answer; rate limits wait for the soonest venue", () => {
    expect(combinedRefusal([r("amount_too_small"), r("amount_too_small")])).toEqual({reason: "amount_too_small"});
    expect(combinedRefusal([r("rate_limited", {retryAfterMs: 5000}), r("rate_limited", {retryAfterMs: 2000})])).toEqual({reason: "rate_limited", retryAfterMs: 2000});
    expect(combinedRefusal([r("rate_limited", {retryAfterMs: 5000}), r("rate_limited")])).toEqual({reason: "rate_limited"});
    expect(combinedRefusal([r("upstream_unavailable", {httpStatus: 503}), r("upstream_unavailable", {httpStatus: 503})])).toEqual({reason: "upstream_unavailable", httpStatus: 503});
    expect(combinedRefusal([r("upstream_unavailable", {httpStatus: 503}), r("upstream_unavailable", {httpStatus: 502})])).toEqual({reason: "upstream_unavailable"});
  });
});

describe("refusalNotes()", () => {
  it("hands the text back, remembers its reason, and forgets the oldest past its limit", () => {
    const notes = refusalNotes(2);
    expect(notes.note("a: recipient differs", "recipient_mismatch")).toBe("a: recipient differs");
    notes.note("b: vault moved", {reason: "vault_mismatch"});
    expect(notes.reasonOf("a: recipient differs")).toEqual({reason: "recipient_mismatch"});
    notes.note("c: halted", "chain_halted");
    expect(notes.reasonOf("a: recipient differs")).toBeUndefined();
    expect(notes.reasonOf("b: vault moved")).toEqual({reason: "vault_mismatch"});
    expect(notes.reasonOf("c: halted")).toEqual({reason: "chain_halted"});
    expect(notes.reasonOf("never noted")).toBeUndefined();
  });
  it("a text noted with an invalid reason is not classified, and forgets an older classification of the same text", () => {
    const notes = refusalNotes();
    notes.note("x", "price_check_failed");
    expect(notes.note("x", "nope" as never)).toBe("x");
    expect(notes.reasonOf("x")).toBeUndefined();
  });
});

describe("Swap2Error", () => {
  it("keeps its stage code and takes a reason through its options; none without", () => {
    const e = new Swap2FeeLimitError("swap2: network fee exceeds configured cap", {reason: "policy_refused"});
    expect(e.code).toBe("FEE_LIMIT");
    expect(e.reason).toBe("policy_refused");
    expect(e.message).toBe("swap2: network fee exceeds configured cap");
    const plain = new Swap2QuoteError("swap2: quote expired before source broadcast");
    expect(plain.reason).toBeUndefined();
    expect(["reason", "retryAfterMs", "httpStatus", "refusals"].filter((k) => k in plain)).toEqual([]);
    expect(new Swap2Error("x", "QUOTE", {reason: "bogus" as never}).reason).toBeUndefined();
  });
  it("freezes the venues' refusals it carries", () => {
    const list = [{message: "a: no", reason: "no_route" as const, provider: "a"}];
    const e = new Swap2QuoteError("swap2: no route available for the requested pair", {reason: "no_route", refusals: list});
    expect(e.refusals).toEqual(list);
    expect(Object.isFrozen(e.refusals)).toBe(true);
    expect(Object.isFrozen(e.refusals![0])).toBe(true);
    list[0]!.message = "changed";
    expect(e.refusals![0]!.message).toBe("a: no");
  });
});

// ---- the engine --------------------------------------------------------------------------------

const SELF = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const txRequest = {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "21000", approvalAddress: DIAMOND};
const options = {
  fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161,
  recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
};
const quote = (params: QuoteParams, over: Partial<Quote> = {}): Quote => ({
  provider: "edge", intentId: "intent-1", depositAddress: "", depositMemo: null, txRequest,
  sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
  feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000, ...over,
});
const provider = (over: Partial<CrossChainProvider> = {}): CrossChainProvider => ({
  name: "edge", enabled: () => true, supportsRoute: () => true,
  getQuote: async (params) => quote(params),
  buildDeposit: async () => ({chain: "eip155:1", to: DIAMOND, value: "0"}),
  trackIntent: async () => ({state: "pending"}),
  ...over,
});
const account = {getAddress: async () => SELF, getChainId: async () => 1};
function protocol(p: CrossChainProvider) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(account as never, {fromChain: "eip155:1"});
}
const noRoute = async (p: CrossChainProvider): Promise<Swap2QuoteError> => {
  const e = await protocol(p).quoteSwap2(options).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(Swap2QuoteError);
  return e as Swap2QuoteError;
};

describe("the engine's no route", () => {
  it("carries the venue's classified refusal; the text reads as before", async () => {
    const e = await noRoute(provider({getQuote: async (p) => { p.onRefusal?.("below the 5 USD minimum", {reason: "amount_too_small"}); return null; }}));
    expect(e.message).toBe("swap2: no route available for the requested pair :: edge: below the 5 USD minimum");
    expect(e.code).toBe("QUOTE");
    expect(e.reason).toBe("amount_too_small");
    expect(e.refusals).toEqual([{message: "edge: below the 5 USD minimum", provider: "edge", reason: "amount_too_small"}]);
  });

  it("a thrown refusal keeps its wait; an unclassified one adds up to no_route", async () => {
    const limited = await noRoute(provider({getQuote: async () => { throw refusal("rate_limited", "429 Too Many Requests", {retryAfterMs: 3000, httpStatus: 429}); }}));
    expect(limited.message).toBe("swap2: no route available for the requested pair :: edge: 429 Too Many Requests");
    expect(limited.reason).toBe("rate_limited");
    expect(limited.retryAfterMs).toBe(3000);
    const plain = await noRoute(provider({getQuote: async () => { throw new Error("something odd"); }}));
    expect(plain.reason).toBe("no_route");
    expect(plain.refusals).toEqual([{message: "edge: something odd", provider: "edge"}]);
  });

  it("a venue that sits out without a text is classified without changing the message", async () => {
    const silent = await noRoute(provider({getQuote: async () => null}));
    expect(silent.message).toBe("swap2: no route available for the requested pair");
    expect(silent.reason).toBe("no_route");
    const disabled = await noRoute(provider({enabled: () => false}));
    expect(disabled.message).toBe("swap2: no route available for the requested pair");
    expect(disabled.reason).toBe("policy_refused");
    const unsupported = await noRoute(provider({supportsRoute: () => false}));
    expect(unsupported.message).toBe("swap2: no route available for the requested pair");
    expect(unsupported.reason).toBe("unsupported_pair");
  });

  it("the engine's own checks are classified: the floor → price_check_failed, fee caps → policy_refused", async () => {
    const below = await protocol(provider()).quoteSwap2({...options, minAmountOut: 990_001n}).then(() => null, (x: Error) => x);
    expect(below?.message).toBe("swap2: no route available for the requested pair :: edge: rejected by validation (minDest=980000 vs floor=990001)");
    expect(refusalOf(below)).toEqual({reason: "price_check_failed"});
    class Capped extends SingleProviderSwap2 {
      protected readonly provider = provider({getQuote: async (p) => quote(p, {fees: [{type: "network", amount: "500000", token: "USDC", included: true}] as never})});
      protected chainSupported(): boolean { return true; }
    }
    const capped = await new Capped(account as never, {fromChain: "eip155:1", maxNetworkFeeBps: 10} as never).quoteSwap2(options).then(() => null, (x: Error) => x);
    expect(capped).toBeInstanceOf(Swap2FeeLimitError);
    expect((capped as Swap2FeeLimitError).reason).toBe("policy_refused");
  });
});

// ---- the backend and its client ----------------------------------------------------------------

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453",
  destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100000000",
  destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "mock", intentId: "intent-1", depositAddress: "0x2222222222222222222222222222222222222222", depositMemo: null,
  txRequest: {to: "0x3333333333333333333333333333333333333333", data: "0xdeadbeef", value: "0", chainId: 1, approvalAddress: "0x3333333333333333333333333333333333333333"},
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0.1,
  etaSeconds: 30, reliability: 0.97, validUntilMs: Date.now() + 60_000,
};
const TX: UnsignedTx = {chain: "eip155:1", to: "0x3333333333333333333333333333333333333333", value: "0", data: "0xdeadbeef", chainId: 1};
const mock = (over: Partial<CrossChainProvider> = {}): CrossChainProvider => ({
  name: "mock", enabled: () => true, supportsRoute: () => true,
  getQuote: async () => ({...QUOTE}), buildDeposit: async () => TX, trackIntent: async () => ({state: "pending"}),
  ...over,
});
const allow = () => {};
/** The real client, wired straight into the handler (no network). */
function wire(handle: ReturnType<typeof createSwap2Handler<string>>, extra: Partial<Parameters<typeof remoteProvider>[0]> = {}) {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "u");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  return remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl, ...extra});
}
/** A client against a backend that answers one fixed response. */
const against = (status: number, body: string, headers: Record<string, string> = {}, extra: Partial<Parameters<typeof remoteProvider>[0]> = {}) =>
  remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl: (async () => new Response(body, {status, headers})) as unknown as typeof fetch, ...extra});

describe("server → remote stub", () => {
  it("a venue's classified refusal crosses the wire with its text unchanged", async () => {
    const handle = createSwap2Handler({providers: [mock({getQuote: async (p) => { p.onRefusal?.("mock: 429 from the venue", {reason: "rate_limited", retryAfterMs: 4000, httpStatus: 429}); return null; }})], sealSecret: SECRET, guard: allow});
    expect((await handle("quote", {provider: "mock", params: PARAMS}, "u")).body).toEqual({noQuote: "mock: 429 from the venue", reason: "rate_limited", retryAfterMs: 4000, httpStatus: 429});
    const err = await wire(handle).getQuote(PARAMS).catch((e: Error) => e);
    expect((err as Error).message).toBe("mock: 429 from the venue");
    expect(refusalOf(err)).toEqual({reason: "rate_limited", retryAfterMs: 4000, httpStatus: 429});
  });

  it("an unclassified refusal stays unclassified; a bogus reason from the backend is dropped", async () => {
    const handle = createSwap2Handler({providers: [mock({getQuote: async (p) => { p.onRefusal?.("mock: plain"); return null; }})], sealSecret: SECRET, guard: allow});
    expect((await handle("quote", {provider: "mock", params: PARAMS}, "u")).body).toEqual({noQuote: "mock: plain"});
    const bogus = against(200, JSON.stringify({noQuote: "mock: odd", reason: "BOGUS", retryAfterMs: -1}));
    const err = await bogus.getQuote(PARAMS).catch((e: Error) => e);
    expect((err as Error).message).toBe("mock: odd");
    expect(refusalOf(err)).toBeUndefined();
  });

  it("a build refusal (422) and an expired quote (410) carry their reasons", async () => {
    const handle = createSwap2Handler({providers: [mock({buildDeposit: async () => { throw refusal("vault_mismatch", "mock: the vault moved"); }})], sealSecret: SECRET, guard: allow});
    const sealed = (await handle("quote", {provider: "mock", params: PARAMS}, "u")).body as Quote;
    const built = await handle("build", {provider: "mock", quote: sealed}, "u");
    expect(built).toEqual({status: 422, body: {error: "mock: the vault moved", reason: "vault_mismatch"}});
    const client = wire(handle);
    const err = await client.buildDeposit(sealed).catch((e: Error) => e);
    expect((err as Error).message).toBe(`swap2-remote mock/build: 422 ${JSON.stringify({error: "mock: the vault moved", reason: "vault_mismatch"})}`);
    expect(refusalOf(err)).toEqual({reason: "vault_mismatch"});
    const expired = await handle("build", {provider: "mock", quote: {...sealed, validUntilMs: 1}}, "u");
    expect(expired.status).toBe(400); // the seal covers validUntilMs: a rewritten one fails integrity first
    const old = createSwap2Handler({providers: [mock({getQuote: async () => ({...QUOTE, validUntilMs: Date.now() + 30})})], sealSecret: SECRET, guard: allow});
    const short = (await old("quote", {provider: "mock", params: PARAMS}, "u")).body as Quote;
    await new Promise((r) => setTimeout(r, 60));
    expect(await old("build", {provider: "mock", quote: short}, "u")).toEqual({status: 410, body: {error: "quote expired: ask for a new one", reason: "quote_expired"}});
  });

  it("a disabled provider answers 403 policy_refused, never read as a rejected key", async () => {
    const handle = createSwap2Handler({providers: [mock({enabled: () => false})], sealSecret: SECRET, guard: allow});
    expect(await handle("quote", {provider: "mock", params: PARAMS}, "u")).toEqual({status: 403, body: {error: "provider 'mock' is disabled", reason: "policy_refused"}});
    const err = await wire(handle).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(err)).toEqual({reason: "policy_refused"});
  });

  it("the guard's own refusal keeps the reason the app gave it; internal errors stay unclassified 500s", async () => {
    const guard = () => { throw withReason(new Swap2HandlerError(429, "slow down"), {reason: "rate_limited", retryAfterMs: 1000}); };
    const handle = createSwap2Handler({providers: [mock()], sealSecret: SECRET, guard});
    expect(await handle("quote", {provider: "mock", params: PARAMS}, "u")).toEqual({status: 429, body: {error: "slow down", reason: "rate_limited", retryAfterMs: 1000}});
    const broken = createSwap2Handler({providers: [mock({trackIntent: async () => { throw refusal("upstream_unavailable", "socket hang up"); }})], sealSecret: SECRET, guard: allow});
    const sealed = (await broken("quote", {provider: "mock", params: PARAMS}, "u")).body as Quote;
    expect(await broken("track", {provider: "mock", ref: {intentId: sealed.intentId}}, "u")).toEqual({status: 500, body: {error: "internal error"}});
  });

  it("without a classified body the stub reads the status: 429 with Retry-After, 401, 503; 400 stays unclassified", async () => {
    const limited = await against(429, "Too Many Requests", {"retry-after": "9"}).getQuote(PARAMS).catch((e: Error) => e);
    expect((limited as Error).message).toBe("swap2-remote mock/quote: 429 Too Many Requests");
    expect(refusalOf(limited)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 9000});
    expect(refusalOf(await against(401, "").getQuote(PARAMS).catch((e: Error) => e))).toEqual({reason: "key_rejected", httpStatus: 401});
    expect(refusalOf(await against(503, "<html>oops</html>").getQuote(PARAMS).catch((e: Error) => e))).toEqual({reason: "upstream_unavailable", httpStatus: 503});
    expect(refusalOf(await against(400, JSON.stringify({error: "params.amountIn: expected digits"})).getQuote(PARAMS).catch((e: Error) => e))).toBeUndefined();
  });

  it("an unreachable backend is upstream_unavailable; the caller's own abort is not", async () => {
    const down = remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl: (async () => { throw new TypeError("Network request failed"); }) as unknown as typeof fetch});
    const err = await down.getQuote(PARAMS).catch((e: Error) => e);
    expect(err).toBeInstanceOf(TypeError);
    expect((err as Error).message).toBe("Network request failed");
    expect(refusalOf(err)).toEqual({reason: "upstream_unavailable"});
    const controller = new AbortController();
    const hanging = remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl: ((_u: string, init: RequestInit) => new Promise((_r, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    })) as unknown as typeof fetch});
    const pending = hanging.getQuote(PARAMS, controller.signal).catch((e: Error) => e);
    controller.abort();
    expect(refusalOf(await pending)).toBeUndefined();
  });

  it("a pins refusal carries the reason its pins give; a throwing or foreign reasonOf leaves it unclassified", async () => {
    const pins: Pick<RemotePins, "verifyQuote" | "reasonOf"> = {
      verifyQuote: () => "the recipient in the calldata is 0xbad, not the requested one",
      reasonOf: (text) => (text.startsWith("the recipient") ? {reason: "recipient_mismatch"} : undefined),
    };
    const handle = createSwap2Handler({providers: [mock()], sealSecret: SECRET, guard: allow});
    const err = await wire(handle, pins).getQuote(PARAMS).catch((e: Error) => e);
    expect((err as Error).message).toBe("mock: the quote fails this app's own check — the recipient in the calldata is 0xbad, not the requested one");
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
    const throwing = await wire(handle, {...pins, reasonOf: () => { throw new Error("app bug"); }}).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(throwing)).toBeUndefined();
    const foreign = await wire(handle, {...pins, reasonOf: () => ({reason: "nope"}) as never}).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(foreign)).toBeUndefined();
    const build = await wire(handle, {verifyBuild: async () => "the vault is not the confirmed one", reasonOf: () => ({reason: "vault_mismatch"})});
    const q = await build.getQuote(PARAMS);
    const berr = await build.buildDeposit(q!).catch((e: Error) => e);
    expect((berr as Error).message).toBe("mock: the build fails this app's own check — the vault is not the confirmed one");
    expect(refusalOf(berr)).toEqual({reason: "vault_mismatch"});
  });
});

// ---- review round: per-call outcomes, normalized intake, the remaining server / stub paths ----------------

describe("review round", () => {
  it("overlapping quotes on one protocol each get their own reason and refusals", async () => {
    const p = protocol(provider({
      getQuote: async (params) => {
        const big = params.amountIn === "5000";
        await new Promise((r) => setTimeout(r, big ? 10 : 60));
        params.onRefusal?.(big ? "halted" : "below its minimum", {reason: big ? "chain_halted" : "amount_too_small"});
        return null;
      },
    }));
    const [small, big] = await Promise.all([
      p.quoteSwap2(options).catch((e: Swap2QuoteError) => e),
      new Promise((r) => setTimeout(r, 5)).then(() => p.quoteSwap2({...options, fromTokenAmount: 5000n}).catch((e: Swap2QuoteError) => e)),
    ]);
    expect((small as Swap2QuoteError).message).toBe("swap2: no route available for the requested pair :: edge: below its minimum");
    expect((small as Swap2QuoteError).reason).toBe("amount_too_small");
    expect((big as Swap2QuoteError).message).toBe("swap2: no route available for the requested pair :: edge: halted");
    expect((big as Swap2QuoteError).reason).toBe("chain_halted");
  });

  it("a provider's onRefusal info is normalized and cannot rename the venue or rewrite its text", async () => {
    const spoof = await noRoute(provider({getQuote: async (p) => { p.onRefusal?.("x", {reason: "slippage", provider: "lifi", message: "lifi: spoofed", retryAfterMs: -5} as never); return null; }}));
    expect(spoof.reason).toBe("no_route");
    expect(spoof.refusals).toEqual([{message: "edge: x", provider: "edge"}]);
    const named = await noRoute(provider({getQuote: async (p) => { p.onRefusal?.("y", {reason: "rate_limited", provider: "lifi", message: "z", retryAfterMs: 1000} as never); return null; }}));
    expect(named.refusals).toEqual([{reason: "rate_limited", retryAfterMs: 1000, message: "edge: y", provider: "edge"}]);
    const str = await noRoute(provider({getQuote: async (p) => { p.onRefusal?.("w", "no_route" as never); return null; }}));
    expect(str.refusals).toEqual([{message: "edge: w", provider: "edge"}]);
    const e = new Swap2QuoteError("x", {refusals: [{message: "m", reason: "bogus" as never, retryAfterMs: 1e15, provider: 7 as never, extra: 1} as never]});
    expect(e.refusals).toEqual([{message: "m"}]);
  });

  it("a quote the engine would reject is classified on the server too (502 price_check_failed / quote_expired)", async () => {
    const low = createSwap2Handler({providers: [mock({getQuote: async () => ({...QUOTE, minDestAmount: "1"})})], sealSecret: SECRET, guard: allow});
    expect(await low("quote", {provider: "mock", params: {...PARAMS, minAmountOut: "99000000"}}, "u")).toEqual({status: 502, body: {error: "mock returned a quote the swap engine would reject", reason: "price_check_failed"}});
    const stale = createSwap2Handler({providers: [mock({getQuote: async () => ({...QUOTE, validUntilMs: Date.now() - 1})})], sealSecret: SECRET, guard: allow});
    expect(await stale("quote", {provider: "mock", params: PARAMS}, "u")).toEqual({status: 502, body: {error: "mock returned a quote the swap engine would reject", reason: "quote_expired"}});
    const other = createSwap2Handler({providers: [mock({getQuote: async () => ({...QUOTE, provider: "spoof"})})], sealSecret: SECRET, guard: allow});
    expect((await other("quote", {provider: "mock", params: PARAMS}, "u")).body).toEqual({error: "mock returned a quote the swap engine would reject", reason: "policy_refused"});
  });

  it("a classified refusal thrown from getQuote keeps its reason behind the opaque 500; anything else stays bare", async () => {
    const limited = createSwap2Handler({providers: [mock({getQuote: async () => { throw refusal("rate_limited", "mock: 429 at https://api.mock.test/?key=SECRET", {retryAfterMs: 4000}); }})], sealSecret: SECRET, guard: allow});
    expect(await limited("quote", {provider: "mock", params: PARAMS}, "u")).toEqual({status: 500, body: {error: "internal error", reason: "rate_limited", retryAfterMs: 4000}});
    const err = await wire(limited).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(err)).toEqual({reason: "rate_limited", retryAfterMs: 4000});
    const bare = createSwap2Handler({providers: [mock({getQuote: async () => { throw new Error("boom at https://rpc/key"); }})], sealSecret: SECRET, guard: allow});
    expect(await bare("quote", {provider: "mock", params: PARAMS}, "u")).toEqual({status: 500, body: {error: "internal error"}});
  });

  it("the server's intent-token 403s are policy_refused, never read as a rejected key", async () => {
    const handle = createSwap2Handler({providers: [mock()], sealSecret: SECRET, guard: allow});
    expect(await handle("track", {provider: "mock", ref: {intentId: "abc"}}, "u")).toEqual({status: 403, body: {error: "swap id carries no intent token from this server", reason: "policy_refused"}});
    expect(refusalOf(await wire(handle).trackIntent({intentId: "abc"}).catch((e: Error) => e))).toEqual({reason: "policy_refused"});
    expect((await handle("track", {provider: "mock", ref: {intentId: `abc~${"0".repeat(32)}`}}, "u")).body).toEqual({error: "swap id carries an invalid intent token", reason: "policy_refused"});
  });

  it("the stub: a 2xx that is not JSON is upstream_unavailable; a classified body keeps the status's wait; a classified verify throw keeps its reason", async () => {
    const html = await against(200, "<html>captive portal</html>").getQuote(PARAMS).catch((e: Error) => e);
    expect(html).toBeInstanceOf(SyntaxError);
    expect(refusalOf(html)).toEqual({reason: "upstream_unavailable"});
    const merged = await against(429, JSON.stringify({error: "slow", reason: "rate_limited"}), {"retry-after": "30"}).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(merged)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 30_000});
    const own = await against(429, JSON.stringify({error: "slow", reason: "rate_limited", retryAfterMs: 5000}), {"retry-after": "30"}).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(own)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000});
    const differs = await against(403, JSON.stringify({error: "provider 'mock' is disabled", reason: "policy_refused"})).getQuote(PARAMS).catch((e: Error) => e);
    expect(refusalOf(differs)).toEqual({reason: "policy_refused"});
    const handle = createSwap2Handler({providers: [mock()], sealSecret: SECRET, guard: allow});
    const thrown = await wire(handle, {verifyQuote: () => { throw refusal("recipient_mismatch", "the recipient differs"); }}).getQuote(PARAMS).catch((e: Error) => e);
    expect((thrown as Error).message).toBe("mock: the quote fails this app's own check — the recipient differs");
    expect(refusalOf(thrown)).toEqual({reason: "recipient_mismatch"});
  });

  it("quoteRejection says why validQuote refuses, check for check", async () => {
    const {quoteRejection, validQuote} = await import("../src/validate.js");
    const q = {...QUOTE};
    expect(quoteRejection(q, PARAMS, "mock")).toBeNull();
    expect(validQuote(q, PARAMS, "mock")).toBe(true);
    const cases: [Partial<Quote>, Partial<QuoteParams>, unknown][] = [
      [{provider: "other"}, {}, {reason: "policy_refused"}],
      [{sourceAmount: "1"}, {}, {reason: "policy_refused"}],
      [{destAmount: "x"}, {}, {reason: "upstream_unavailable"}],
      [{reliability: 2}, {}, {reason: "upstream_unavailable"}],
      [{minDestAmount: "99900001"}, {}, {reason: "upstream_unavailable"}],
      [{}, {minAmountOut: "99800001"}, {reason: "price_check_failed"}],
      [{minDestAmount: "1"}, {slippageBps: 50}, {reason: "price_check_failed"}],
      [{validUntilMs: Date.now() - 1}, {}, {reason: "quote_expired"}],
      [{validUntilMs: Number.NaN}, {}, {reason: "upstream_unavailable"}],
      [{}, {minAmountOut: "abc"}, {}],
      [{}, {slippageBps: 1.5}, {}],
    ];
    for (const [over, params, want] of cases) {
      expect(quoteRejection({...q, ...over} as Quote, {...PARAMS, ...params}, "mock")).toEqual(want);
      expect(validQuote({...q, ...over} as Quote, {...PARAMS, ...params}, "mock")).toBe(false);
    }
  });

  it("the helpers take a wait or status that may be undefined (exactOptionalPropertyTypes)", () => {
    const header: string | null = null;
    const e = refusal("rate_limited", "x: 429", {retryAfterMs: parseRetryAfter(header), httpStatus: 429});
    expect(refusalOf(e)).toEqual({reason: "rate_limited", httpStatus: 429});
    const status: number | undefined = undefined;
    expect(refusalOf(withReason(new Error("y"), {reason: "upstream_unavailable", httpStatus: status}))).toEqual({reason: "upstream_unavailable"});
    expect(new Swap2QuoteError("z", {reason: undefined, retryAfterMs: undefined}).reason).toBeUndefined();
  });
});
