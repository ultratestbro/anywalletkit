// Refusal reasons: every refusal keeps its text, byte for byte, and carries a stable `reason` next to it — on the
// provider's onRefusal, on what it throws, and on what the pins' verify functions return (`reasonOf`). Driven through
// the real provider over recorded answers of the public API (tests/fixtures) and hand-made HTTP failures.
import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {symbiosisProvider, symbiosisTronCall, type SymbiosisProviderConfig} from "../src/provider.js";
import {checkSymbiosisCall, symbiosisPins, symbiosisPinsFor, symbiosisRequest, symbiosisVerifyBuild, symbiosisVerifyQuote, type SymbiosisRequest} from "../src/verify.js";
import {EVIL, EVM, LIMITS, TRON, close, lastOnly, load, open, quoteOf, replay, rewrite, type Exchange} from "./fixtures.js";

const N = "eth-usdc-arb-usdc";
const at = (name: string) => new Date(load(name).recordedAt).getTime();
afterEach(() => { vi.useRealTimers(); });

interface Heard {quote: Quote | null; texts: string[]; infos: (Swap2RefusalInfo | undefined)[]; args: number[]}

/** The real provider on a recorded scenario (or a hand-made `fetchImpl`), with every onRefusal call it makes. */
async function run(name: string, o: {
  params?: Partial<QuoteParams>; config?: SymbiosisProviderConfig; fetchImpl?: typeof fetch; signal?: AbortSignal;
  patch?: (response: any, exchange: Exchange, index: number) => unknown; exchanges?: (all: Exchange[]) => Exchange[];
} = {}): Promise<Heard> {
  const recorded = load(name);
  const {fetchImpl} = replay(o.exchanges ? o.exchanges(recorded.exchanges) : recorded.exchanges, o.patch);
  const heard: Heard = {quote: null, texts: [], infos: [], args: []};
  heard.quote = await symbiosisProvider({...recorded.config, ...o.config, fetchImpl: o.fetchImpl ?? fetchImpl}).getQuote({
    ...recorded.params, ...o.params,
    onRefusal: (...a: [string, Swap2RefusalInfo?]) => { heard.texts.push(a[0]); heard.infos.push(a[1]); heard.args.push(a.length); },
  }, o.signal);
  return heard;
}
/** The one refusal a run heard: its exact text and its classification. */
async function refusal(name: string, o: Parameters<typeof run>[1] = {}): Promise<{text: string; info: Swap2RefusalInfo | undefined}> {
  const h = await run(name, o);
  expect(h.quote).toBeNull();
  expect(h.texts).toHaveLength(1);
  return {text: h.texts[0]!, info: h.infos[0]};
}
/** The live quote answer patched (the second recorded exchange). */
const patched = (edit: (r: any) => void) => ({exchanges: lastOnly, patch: (r: any, _e: Exchange, i: number) => { if (i === 1) edit(r); return r; }});

type Answer = {status: number; body?: unknown; raw?: string; headers?: Record<string, string>} | Error;
/** A `fetchImpl` serving these answers in order (an Error is a failed fetch). */
function serve(...answers: Answer[]): typeof fetch {
  let i = 0;
  return (async () => {
    const a = answers[i++];
    if (!a) throw new Error("unexpected request");
    if (a instanceof Error) throw a;
    return new Response(a.raw ?? JSON.stringify(a.body ?? {}), {status: a.status, headers: {"content-type": "application/json", ...a.headers}});
  }) as typeof fetch;
}
const limitsOk: Answer = {status: 200, body: LIMITS};

describe("HTTP and network failures, through the real fetch path", () => {
  it("429 with Retry-After: rate_limited, the wait in ms and the status; the text as before", async () => {
    const r = await refusal(N, {fetchImpl: serve(limitsOk, {status: 429, headers: {"retry-after": "7"}})});
    expect(r.text).toBe("Symbiosis API → 429");
    expect(r.info).toEqual({reason: "rate_limited", retryAfterMs: 7_000, httpStatus: 429});
    const worded = await refusal(N, {fetchImpl: serve(limitsOk, {status: 429, body: {message: "Too many requests"}, headers: {"retry-after": "2"}})});
    expect(worded.text).toBe("Symbiosis: Too many requests");
    expect(worded.info).toEqual({reason: "rate_limited", retryAfterMs: 2_000, httpStatus: 429});
  });
  it("401 / 403: key_rejected", async () => {
    const r401 = await refusal(N, {fetchImpl: serve(limitsOk, {status: 401})});
    expect(r401).toEqual({text: "Symbiosis API → 401", info: {reason: "key_rejected", httpStatus: 401}});
    const r403 = await refusal(N, {fetchImpl: serve(limitsOk, {status: 403, body: {message: "Invalid API key"}})});
    expect(r403).toEqual({text: "Symbiosis: Invalid API key", info: {reason: "key_rejected", httpStatus: 403}});
  });
  it("5xx: upstream_unavailable with the status — a JSON body or an HTML page alike", async () => {
    expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 503})})).toEqual({text: "Symbiosis API → 503", info: {reason: "upstream_unavailable", httpStatus: 503}});
    expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 502, raw: "<html>Bad Gateway</html>"})})).toEqual({text: "Symbiosis API → 502", info: {reason: "upstream_unavailable", httpStatus: 502}});
  });
  it("a 5xx whose message names a reason: the message wins", async () => {
    const r = await refusal(N, {fetchImpl: serve(limitsOk, {status: 500, body: {message: "Insufficient liquidity in the pool"}})});
    expect(r).toEqual({text: "Symbiosis: Insufficient liquidity in the pool", info: {reason: "insufficient_liquidity"}});
  });
  it("a 5xx whose message reads as no route is the venue failing, not an answer about the pair: upstream_unavailable with the status", async () => {
    for (const message of ["Service Unavailable", "Service temporarily unavailable", "No route found", "Cannot find module './quote'"]) {
      expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 503, body: {message}})}), message).toEqual({text: `Symbiosis: ${message}`, info: {reason: "upstream_unavailable", httpStatus: 503}});
    }
  });
  it("a throttle the message names: rate_limited, with the wait its Retry-After header gives", async () => {
    const r = await refusal(N, {fetchImpl: serve(limitsOk, {status: 400, body: {message: "Rate limit exceeded"}, headers: {"retry-after": "5"}})});
    expect(r).toEqual({text: "Symbiosis: Rate limit exceeded", info: {reason: "rate_limited", retryAfterMs: 5_000}});
    const unsaid = await refusal(N, {fetchImpl: serve(limitsOk, {status: 503, body: {message: "Too many requests"}})});
    expect(unsaid).toEqual({text: "Symbiosis: Too many requests", info: {reason: "rate_limited"}});
  });
  it("a quote request answered with another 4xx than Symbiosis' refusals (400 / 422): upstream_unavailable with the status", async () => {
    for (const [status, message] of [[404, "Not Found"], [405, "Method Not Allowed"], [415, "Unsupported Media Type"]] as const) {
      expect(await refusal(N, {fetchImpl: serve(limitsOk, {status, body: {message}})}), String(status)).toEqual({text: `Symbiosis: ${message}`, info: {reason: "upstream_unavailable", httpStatus: status}});
    }
    expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 404})})).toEqual({text: "Symbiosis API → 404", info: {reason: "upstream_unavailable", httpStatus: 404}});
    expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 422, body: {message: "Something went sideways"}})})).toEqual({text: "Symbiosis: Something went sideways", info: {reason: "no_route"}});
    expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 404, body: {message: "No route found"}})})).toEqual({text: "Symbiosis: No route found", info: {reason: "no_route"}});
  });
  it("the limits endpoint failing: its status (an unexpected 404 is upstream_unavailable), or an unreadable list", async () => {
    expect(await refusal(N, {fetchImpl: serve({status: 404})})).toEqual({text: "Symbiosis API → 404", info: {reason: "upstream_unavailable", httpStatus: 404}});
    expect(await refusal(N, {fetchImpl: serve({status: 200, body: []})})).toEqual({text: "Symbiosis limits are unreadable", info: {reason: "upstream_unavailable"}});
    expect(await refusal(N, {fetchImpl: serve({status: 200, body: [{chainId: 1, address: "0x", min: "1e6", max: "5"}]})})).toEqual({text: "Symbiosis limits are unreadable", info: {reason: "upstream_unavailable"}});
  });
  it("the network failing, or the module's own timeout: upstream_unavailable", async () => {
    expect(await refusal(N, {fetchImpl: serve(new TypeError("fetch failed"))})).toEqual({text: "fetch failed", info: {reason: "upstream_unavailable"}});
    expect(await refusal(N, {fetchImpl: serve(limitsOk, new TypeError("fetch failed"))})).toEqual({text: "fetch failed", info: {reason: "upstream_unavailable"}});
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(await refusal(N, {fetchImpl: serve(timeout)})).toEqual({text: "The operation was aborted due to timeout", info: {reason: "upstream_unavailable"}});
  });
  it("an answer that is no quote at all: upstream_unavailable", async () => {
    expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 200, raw: "null"})})).toEqual({text: "Symbiosis returned no quote", info: {reason: "upstream_unavailable"}});
  });
  it("the caller's own abort is not upstream_unavailable: the refusal stays unclassified", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const honour = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify(LIMITS));
    }) as typeof fetch;
    const h = await run(N, {fetchImpl: honour, signal: ctrl.signal});
    expect(h.quote).toBeNull();
    expect(h.texts).toEqual([(ctrl.signal.reason as Error).message]);
    expect(h.infos).toEqual([undefined]);
    expect(h.args).toEqual([1]);
  });
  it("the caller aborting while the limits body is read stays unclassified; a body that is not JSON is upstream_unavailable", async () => {
    const ctrl = new AbortController();
    const slow = (async (_url: RequestInfo | URL, init?: RequestInit) => ({
      ok: true, status: 200, headers: new Headers(),
      json: () => new Promise((_done, fail) => {
        init!.signal!.addEventListener("abort", () => fail(init!.signal!.reason), {once: true});
        setTimeout(() => ctrl.abort(), 10);
      }),
    })) as unknown as typeof fetch;
    const h = await run(N, {fetchImpl: slow, signal: ctrl.signal});
    expect(h.quote).toBeNull();
    expect(h.texts).toEqual(["Symbiosis limits are unreadable"]);
    expect(h.infos).toEqual([undefined]);
    expect(h.args).toEqual([1]);
    expect(await refusal(N, {fetchImpl: serve({status: 200, raw: "<html>"})})).toEqual({text: "Symbiosis limits are unreadable", info: {reason: "upstream_unavailable"}});
  });
});

describe("what Symbiosis' own error message says", () => {
  it("recorded 2026-11-10: \"Price impact is too high\" → price_check_failed", async () => {
    expect(await refusal("base-usdt-ton-usdt")).toEqual({text: "Symbiosis: Price impact is too high", info: {reason: "price_check_failed"}});
  });
  it("recorded 2026-11-10: \"This swap is not available\" → no_route", async () => {
    expect(await refusal("btc-btc-base-usdc")).toEqual({text: "Symbiosis: This swap is not available", info: {reason: "no_route"}});
  });
  const messages: [string, Swap2RefusalInfo["reason"]][] = [
    ["Amount 0.5 USDC less than fee 1.2 USDC", "amount_too_small"],
    ["The amount is too low. Min amount: 10 USDC", "amount_too_small"],
    ["The amount is too high. Max amount: 1000000 USDC", "amount_too_large"],
    ["Insufficient liquidity", "insufficient_liquidity"],
    ["BNB Chain is paused for maintenance", "chain_halted"],
    ["No route found", "no_route"],
    ["Something went sideways", "no_route"],
    ["Invalid API key", "key_rejected"],
    ["Unknown partner id", "key_rejected"],
    // A bare "forbidden" / "unauthorized" off a 401 / 403 says nothing about the key: a refused quote request.
    ["Forbidden token", "no_route"],
    ["Unauthorized address", "no_route"],
  ];
  for (const [message, reason] of messages) {
    it(`400 "${message}" → ${reason}`, async () => {
      expect(await refusal(N, {fetchImpl: serve(limitsOk, {status: 400, body: {message}})})).toEqual({text: `Symbiosis: ${message}`, info: {reason}});
    });
  }
});

describe("the provider's own refusals", () => {
  const before: [string, string, Partial<QuoteParams>, SymbiosisProviderConfig, string, Swap2RefusalInfo["reason"]][] = [
    ["flexible deposits", N, {flex: true}, {}, "the amount is sealed into the transaction (no flexible deposits)", "unsupported_pair"],
    ["unknown chain", N, {destChain: "eip155:999999"}, {}, "Symbiosis is not wired for this chain", "unsupported_pair"],
    ["same chain", N, {destChain: "eip155:1"}, {}, "same-chain swaps are not served", "unsupported_pair"],
    ["Bitcoin destination", N, {destChain: "bitcoin:mainnet", destToken: "BTC"}, {}, "Bitcoin is not a destination", "unsupported_pair"],
    ["zero", N, {amountIn: "0"}, {}, "amount must be positive", "amount_too_small"],
    ["source token", N, {sourceToken: "NOPE"}, {}, "unknown source token NOPE on Ethereum", "unsupported_pair"],
    ["TON native", "ton-usdt-tron-usdt", {sourceToken: "TON"}, {}, "TON's native coin is not bridged by Symbiosis itself", "unsupported_pair"],
    ["recipient format", N, {destAddress: TRON}, {}, "the recipient is not a Arbitrum address", "recipient_mismatch"],
    ["Tron switched off", "tron-usdt-base-usdc", {}, {tronSource: false}, "Tron sources are switched off (tronSource)", "policy_refused"],
    ["Tron → TON without the user's EVM address", "tron-usdt-ton-usdt", {}, {fallbackReceiver: undefined} as never, "Tron → TON needs the user's own EVM address (fallbackReceiver)", "unsupported_pair"],
  ];
  for (const [name, fixture, params, config, text, reason] of before) {
    it(`before any request: ${name} → ${reason}`, async () => {
      expect(await refusal(fixture, {exchanges: lastOnly, params, config})).toEqual({text, info: {reason}});
    });
  }
  it("an invalid argument from the developer stays unclassified", async () => {
    for (const [params, text] of [[{amountIn: "1.5"}, "amount must be a base-unit integer"], [{slippageBps: 10_000}, "slippage must be 0..9999 bps"], [{destAddress: ""}, "a live quote needs a recipient"]] as const) {
      const h = await run(N, {exchanges: lastOnly, params});
      expect(h.texts).toEqual([text]);
      expect(h.infos).toEqual([undefined]);
      expect(h.args).toEqual([1]);
    }
  });
  it("limits enforced on the device: amount_too_small / amount_too_large", async () => {
    expect(await refusal(N, {exchanges: lastOnly, params: {amountIn: "299999"}})).toEqual({text: "amount 299999 is below Symbiosis' minimum 300000 on Ethereum", info: {reason: "amount_too_small"}});
    const p = patched((r) => { r.tokenAmountOut.amount = "200000000001"; });
    expect(await refusal(N, p)).toEqual({text: "received amount 200000000001 is above Symbiosis' maximum 200000000000 on Arbitrum", info: {reason: "amount_too_large"}});
  });
  const answers: [string, (r: any) => void, string, Swap2RefusalInfo["reason"]][] = [
    ["another kind of route", (r) => { r.kind = "onchain-swap"; }, "Symbiosis answered with a 'onchain-swap' route", "upstream_unavailable"],
    ["a partner route", (r) => { r.labels = ["partner-swap"]; }, "Symbiosis answered with a partner-swap route (a third party holds the funds)", "recipient_unverifiable"],
    ["another output token", (r) => { r.tokenAmountOut.address = EVIL; }, "Symbiosis quoted another token or chain than requested", "price_check_failed"],
    ["a minimum above the amount", (r) => { r.tokenAmountOutMin.amount = String(BigInt(r.tokenAmountOut.amount) + 1n); }, "Symbiosis quoted an unusable output amount", "price_check_failed"],
    ["no fees", (r) => { r.fees = []; }, "Symbiosis reported no fees — a quote without readable fees is not shown", "upstream_unavailable"],
    ["a fee that cannot be read", (r) => { r.fees[0].value.amount = "0.5"; }, "Symbiosis reported a fee that cannot be read", "upstream_unavailable"],
    ["another chain id", (r) => { r.tx.chainId = 56; }, "Symbiosis built a transaction for chain 56, not Ethereum", "policy_refused"],
    ["no calldata", (r) => { delete r.tx.data; }, "Symbiosis returned no transaction", "upstream_unavailable"],
    ["another spender", (r) => { r.approveTo = EVIL; }, `Symbiosis asks to approve ${EVIL}, not the pinned Ethereum MetaRouterGateway`, "vault_mismatch"],
    ["another contract (the calldata check)", (r) => { r.tx.to = EVIL; }, `symbiosis: the transaction calls ${EVIL}, not the pinned Ethereum MetaRouterGateway`, "vault_mismatch"],
    ["a route paying someone else (the calldata check)", (r) => { const p = open(r.tx.data); p.burn.chain2address = EVIL; r.tx.data = close(p); }, `symbiosis: the burn pays ${EVIL}, not the recipient`, "recipient_mismatch"],
    ["a fee that takes the whole amount (the calldata check)", (r) => { const p = open(r.tx.data); p.s.stableBridgingFee = p.s.amount; r.tx.data = close(p); }, "symbiosis: the bridge request's fee takes the whole amount", "amount_too_small"],
    ["a minimum the route does not guarantee (the calldata check)", (r) => { r.tokenAmountOutMin.amount = String(BigInt(r.tokenAmountOutMin.amount) + 1n); }, "symbiosis: the route guarantees 99197101, below the quoted minimum 99197102", "price_check_failed"],
  ];
  for (const [name, edit, text, reason] of answers) {
    it(`the answer: ${name} → ${reason}`, async () => {
      expect(await refusal(N, patched(edit))).toEqual({text, info: {reason}});
    });
  }
  it("the caller's floor → price_check_failed; boundSourceOnly → policy_refused", async () => {
    expect(await refusal(N, {exchanges: lastOnly, params: {minAmountOut: "99197102"}})).toEqual({text: "the route guarantees 99197101, below the caller's floor 99197102", info: {reason: "price_check_failed"}});
    expect(await refusal("bsc-usdt-ton-usdt", {exchanges: lastOnly, config: {boundSourceOnly: true}})).toEqual({text: "the route swaps on the source chain before bridging (boundSourceOnly)", info: {reason: "policy_refused"}});
  });
  it("Tron: a fee limit above the ceiling → policy_refused; no fee limit → upstream_unavailable", async () => {
    const above = patched((r) => { r.tx.feeLimit = 300_000_001; });
    expect(await refusal("tron-usdt-base-usdc", above)).toEqual({text: "Symbiosis asks a Tron fee limit of 300000001 sun, above the 300000000 ceiling", info: {reason: "policy_refused"}});
    const none = patched((r) => { delete r.tx.feeLimit; });
    expect(await refusal("tron-usdt-base-usdc", none)).toEqual({text: "Symbiosis named no Tron fee limit", info: {reason: "upstream_unavailable"}});
  });
  it("TON: more than one message → upstream_unavailable; a value above the ceiling → policy_refused", async () => {
    const two = patched((r) => { r.tx.messages.push(r.tx.messages[0]); });
    expect(await refusal("ton-usdt-tron-usdt", two)).toEqual({text: "Symbiosis returned something other than one TON message", info: {reason: "upstream_unavailable"}});
    const much = patched((r) => { r.tx.messages[0].amount = "1000000001"; });
    expect(await refusal("ton-usdt-tron-usdt", much)).toEqual({text: "symbiosis: the message attaches 1000000001 nanotons, above the 1000000000 ceiling", info: {reason: "policy_refused"}});
  });
});

describe("what the wallet gets: buildDeposit, preflightDeposit and symbiosisTronCall throw classified errors", () => {
  const thrown = async (p: Promise<unknown> | (() => unknown)): Promise<Error> => {
    try { await (typeof p === "function" ? p() : p); } catch (e) { return e as Error; }
    throw new Error("did not throw");
  };
  it("EVM preflight: the pinned gateway, the quoted bytes, the quote's lifetime", async () => {
    vi.useFakeTimers({toFake: ["Date"], now: at(N)});
    const {quote, recorded} = await quoteOf(N, {exchanges: lastOnly});
    const p = symbiosisProvider(recorded.config);
    const tx = await p.buildDeposit(quote!);
    const to = await thrown(p.preflightDeposit!(quote!, {...tx, to: EVIL}));
    expect(to.message).toBe(`symbiosis: the transaction calls ${EVIL}, not the pinned Ethereum MetaRouterGateway`);
    expect(refusalOf(to)).toEqual({reason: "vault_mismatch"});
    const value = await thrown(p.preflightDeposit!(quote!, {...tx, value: "1"}));
    expect(value.message).toBe("symbiosis: the transaction attaches 1, expected 0");
    expect(refusalOf(value)).toEqual({reason: "policy_refused"});
    const other = rewrite(quote!, (parts) => { parts.pools[0]![5] += 1n; });
    const differs = await thrown(p.preflightDeposit!(quote!, {...tx, data: other.txRequest!.data!}));
    expect(differs.message).toBe("symbiosis: the build differs from the quoted transaction");
    expect(refusalOf(differs)).toEqual({reason: "policy_refused"});
    const sealed = await thrown(p.preflightDeposit!({...quote!, providerData: {}}, tx));
    expect(sealed.message).toBe("symbiosis: quote carries no sealed request");
    expect(refusalOf(sealed)).toEqual({reason: "policy_refused"});
    vi.setSystemTime(at(N) + 60_000);
    const expired = await thrown(p.preflightDeposit!(quote!, tx));
    expect(expired.message).toBe("symbiosis: the quote expired — re-quote");
    expect(refusalOf(expired)).toEqual({reason: "quote_expired"});
    expect(expired.constructor).toBe(Error);
  });
  it("buildDeposit: a foreign intent id or a quote without its transaction → policy_refused", async () => {
    const {quote, recorded} = await quoteOf(N, {exchanges: lastOnly});
    const p = symbiosisProvider(recorded.config);
    const foreign = await thrown(p.buildDeposit({...quote!, intentId: "lifi:1"}));
    expect(foreign.message).toBe("swap2: malformed Symbiosis intent id");
    expect(refusalOf(foreign)).toEqual({reason: "policy_refused"});
    const {txRequest: _, ...bare} = quote!;
    const none = await thrown(p.buildDeposit(bare as Quote));
    expect(none.message).toBe("swap2: Symbiosis quote carries no transaction");
    expect(refusalOf(none)).toEqual({reason: "policy_refused"});
  });
  it("TON preflight: another message → policy_refused", async () => {
    const n = "ton-usdt-tron-usdt";
    vi.useFakeTimers({toFake: ["Date"], now: at(n)});
    const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
    const p = symbiosisProvider(recorded.config);
    const tx = await p.buildDeposit(quote!);
    const e = await thrown(p.preflightDeposit!(quote!, {...tx, value: "300000000"}));
    expect(e.message).toBe("symbiosis: the build differs from the quoted TON message");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
  });
  it("Tron: preflight's fee ceiling, and symbiosisTronCall's re-check", async () => {
    const n = "tron-usdt-base-usdc";
    vi.useFakeTimers({toFake: ["Date"], now: at(n)});
    const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
    const p = symbiosisProvider(recorded.config);
    const tx = await p.buildDeposit(quote!);
    const ceiling = await thrown(p.preflightDeposit!(quote!, {...tx, gasLimit: "300000001"}));
    expect(ceiling.message).toBe("symbiosis: Tron fee limit above the ceiling");
    expect(refusalOf(ceiling)).toEqual({reason: "policy_refused"});
    const tampered = await thrown(() => symbiosisTronCall(rewrite(quote!, (parts) => { parts.burn.chain2address = EVIL; })));
    expect(tampered.message).toBe(`symbiosis: the burn pays ${EVIL}, not the recipient`);
    expect(refusalOf(tampered)).toEqual({reason: "recipient_mismatch"});
    const cap = await thrown(() => symbiosisTronCall(quote!, {feeLimitCap: 100_000_000n}));
    expect(cap.message).toBe("symbiosis: Tron fee limit 200000000 is missing or above the 100000000 sun ceiling");
    expect(refusalOf(cap)).toEqual({reason: "policy_refused"});
    // Handing it an EVM quote is a programming error, not a refusal.
    const evm = await quoteOf(N, {exchanges: lastOnly});
    const wrong = await thrown(() => symbiosisTronCall(evm.quote!));
    expect(wrong.message).toBe("symbiosis: not a Tron-source quote");
    expect(refusalOf(wrong)).toBeUndefined();
  });
});

describe("the pins: reasonOf classifies every text verifyQuote / verifyBuild return", () => {
  it("verifyQuote and verifyBuild texts, unchanged, with their reasons", async () => {
    const {quote, recorded} = await quoteOf(N, {exchanges: lastOnly});
    const tx = {chain: "eip155:1", to: quote!.txRequest!.to!, value: "0", data: quote!.txRequest!.data!, chainId: 1, approvalAddress: quote!.txRequest!.approvalAddress!};
    const hostile = rewrite(quote!, (p) => { p.burn.chain2address = EVIL; });
    const cases: [string | null, string, Swap2RefusalInfo["reason"]][] = [
      [symbiosisPins.verifyQuote!(recorded.params, hostile), `symbiosis: the burn pays ${EVIL}, not the recipient`, "recipient_mismatch"],
      [symbiosisPins.verifyQuote!({...recorded.params, amountIn: "100000001"}, quote!), "symbiosis: the quote is for a different amount", "policy_refused"],
      [symbiosisPins.verifyQuote!({...recorded.params, destChain: "eip155:999999"}, quote!), "symbiosis: unsupported chain", "unsupported_pair"],
      [symbiosisPins.verifyQuote!(recorded.params, {...quote!, minDestAmount: "0"}), "symbiosis: the quote names no minimum", "price_check_failed"],
      [await symbiosisPins.verifyBuild!(quote!, tx), "symbiosis: the build cannot be checked without the request", "policy_refused"],
      [await symbiosisPins.verifyBuild!(quote!, {...tx, approvalAddress: EVIL}, recorded.params), `symbiosis: the approval names ${EVIL}, not the pinned Ethereum MetaRouterGateway`, "vault_mismatch"],
      [await symbiosisPins.verifyBuild!(quote!, {...tx, chain: "eip155:56"}, recorded.params), "symbiosis: the build is for another chain", "policy_refused"],
      [symbiosisVerifyBuild(quote!, {...tx, data: `${tx.data}00`}, recorded.params), "symbiosis: metaRoute: calldata is not canonically encoded", "policy_refused"],
    ];
    for (const [got, text, reason] of cases) {
      expect(got).toBe(text);
      expect(symbiosisPins.reasonOf!(got!), text).toEqual({reason});
    }
    expect(symbiosisPins.reasonOf!("symbiosis: a text no check returned")).toBeUndefined();
  });
  it("Tron ↔ TON without the app's own EVM address: unsupported_pair (the same text as before)", async () => {
    const {quote, recorded} = await quoteOf("tron-usdt-ton-usdt", {exchanges: lastOnly});
    const text = symbiosisPins.verifyQuote!(recorded.params, quote!);
    expect(text).toBe("symbiosis: a non-EVM source to a non-EVM destination needs the user's own EVM address (fallbackReceiver)");
    expect(symbiosisPinsFor({fallbackReceiver: EVM}).reasonOf!(text!)).toEqual({reason: "unsupported_pair"});
    expect(symbiosisVerifyQuote(recorded.params, quote!, {fallbackReceiver: EVM})).toBeNull();
  });
  it("an invalid amount in the request stays unclassified", () => {
    const text = symbiosisRequest({sourceChain: "eip155:1", destChain: "eip155:42161", sourceToken: "USDC", destToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", amountIn: "1.5", destAddress: EVM, refundAddress: EVM});
    expect(text).toBe("amount must be a positive integer string");
    expect(symbiosisPins.reasonOf!(text as string)).toBeUndefined();
  });
  it("the exported checks throw their refusal with its reason", async () => {
    const {quote, recorded} = await quoteOf(N, {exchanges: lastOnly});
    const r = symbiosisRequest(recorded.params) as SymbiosisRequest;
    let e: unknown;
    try { checkSymbiosisCall(r, {to: EVIL, data: quote!.txRequest!.data!, value: "0"}, 1n); } catch (x) { e = x; }
    expect((e as Error).message).toBe(`the transaction calls ${EVIL}, not the pinned Ethereum MetaRouterGateway`);
    expect(refusalOf(e)).toEqual({reason: "vault_mismatch"});
  });
  it("through remoteProvider: the stub's refusal carries the reason the pins give its text", async () => {
    const {quote, recorded} = await quoteOf(N, {exchanges: lastOnly});
    const hostile = rewrite(quote!, (p) => { p.burn.chain2address = EVIL; });
    const fetchImpl = (async () => new Response(JSON.stringify(hostile))) as unknown as typeof fetch;
    const remote = remoteProvider({name: "symbiosis", baseUrl: "https://swap.test", fetchImpl, ...symbiosisPins});
    let e: unknown;
    try { await remote.getQuote(recorded.params); } catch (x) { e = x; }
    expect((e as Error).message).toBe(`symbiosis: the quote fails this app's own check — symbiosis: the burn pays ${EVIL}, not the recipient`);
    expect(refusalOf(e)).toEqual({reason: "recipient_mismatch"});
  });
});

describe("configuration errors are not refusals", () => {
  it("a bad option throws unclassified", () => {
    for (const config of [{apiUrl: "ftp://x"}, {quoteTtlMs: 0}, {slippageBps: 10_000}, {apiKey: ""}] as SymbiosisProviderConfig[]) {
      let e: unknown;
      try { symbiosisProvider(config); } catch (x) { e = x; }
      expect(e).toBeInstanceOf(Error);
      expect(refusalOf(e)).toBeUndefined();
    }
  });
});
