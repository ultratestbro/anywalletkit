// CS-13: refusal reasons for the wrap venue. Every refusal keeps its text byte for byte; `reason` classifies it.
// The provider runs its real code paths against a stubbed global fetch (the JSON-RPC it reads WETH9's symbol and
// decimals from); the remote stub runs the real provider behind the real swap2 handler. No network, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, encodeFunctionData, parseAbi} from "viem";
import {refusalOf, Swap2QuoteError, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {WRAPPED_NATIVE, wrapPins, wrapProvider, wrapVerifyQuote} from "../src/provider.js";
import {WrapSwap2Protocol} from "../src/protocol.js";

afterEach(() => vi.unstubAllGlobals());

const WETH = WRAPPED_NATIVE[1]!.address;
const ME = "0x4444444444444444444444444444444444444444";
const OTHER = "0x3333333333333333333333333333333333333333";
const ZERO = "0x0000000000000000000000000000000000000000";
const RPC = {1: ["https://rpc.test"]};
const AMOUNT = "1000000000000000";
const WRAP: QuoteParams = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "ETH", destToken: WETH, destAddress: ME, refundAddress: ME, amountIn: AMOUNT, dry: false};
const UNWRAP: QuoteParams = {...WRAP, sourceToken: "WETH", destToken: ZERO};
const ABI = parseAbi(["function withdraw(uint256 wad)", "function transfer(address to, uint256 amount) returns (bool)"]);

/** WETH9 on chain 1 behind a JSON-RPC: symbol / decimals by selector; `answer` replaces the reply when given. */
function rpc(o: {symbol?: string; answer?: (url: string) => Response | Promise<Response>} = {}): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (o.answer) return o.answer(String(url));
    const sel = (JSON.parse(String(init?.body)) as {params: [{data: string}]}).params[0].data;
    return new Response(JSON.stringify({result: sel === "0x95d89b41" ? encodeAbiParameters([{type: "string"}], [o.symbol ?? "WETH"]) : encodeAbiParameters([{type: "uint8"}], [18])}));
  }) as typeof fetch;
}

/** The error a promise rejects with; a promise that resolves fails the test. */
async function rejection<E = Error>(p: Promise<unknown>): Promise<E> {
  return p.then((v) => { throw new Error(`expected a rejection, got ${String(v)}`); }, (e: unknown) => e as E);
}

/** getQuote's refusals: each text with the classification onRefusal got next to it (`null` = a call with the text only). */
async function refusals(params: Partial<QuoteParams>, fetchImpl: typeof fetch = rpc(), rpcUrls: Record<number, string[]> = RPC) {
  vi.stubGlobal("fetch", fetchImpl);
  const got: [string, Swap2RefusalInfo | null][] = [];
  const q = await wrapProvider({rpcUrls}).getQuote({...WRAP, ...params, onRefusal: (...args: [string, Swap2RefusalInfo?]) => { got.push([args[0], args.length > 1 ? args[1]! : null]); }});
  expect(q).toBeNull();
  return got;
}

describe("getQuote: each refusal carries its reason next to the unchanged text", () => {
  it("unsupported_pair: flexible amounts, another chain, a chain without a wrapper or RPC, an unknown token, another pair", async () => {
    expect(await refusals({flex: true})).toEqual([["wrap: amount-flexible deposits are not supported", {reason: "unsupported_pair"}]]);
    expect(await refusals({destChain: "eip155:10"})).toEqual([["wrap: same-chain only", {reason: "unsupported_pair"}]]);
    expect(await refusals({sourceChain: "eip155:10", destChain: "eip155:10"})).toEqual([["wrap: no wrapped native token or RPC for eip155:10", {reason: "unsupported_pair"}]]);
    expect(await refusals({sourceToken: "NOPE"})).toEqual([["wrap: unknown source token NOPE", {reason: "unsupported_pair"}]]);
    expect(await refusals({sourceToken: "USDC"})).toEqual([["wrap: only ETH ↔ WETH", {reason: "unsupported_pair"}]]);
  });

  it("recipient_mismatch: WETH9 pays the sender, so another recipient is refused", async () => {
    expect(await refusals({destAddress: OTHER})).toEqual([["wrap: wrapping pays the sender's own address — send the result separately", {reason: "recipient_mismatch"}]]);
  });

  it("amount_too_small for a zero amount; price_check_failed for a floor above the 1:1 output", async () => {
    expect(await refusals({amountIn: "0"})).toEqual([["wrap: amount must be positive", {reason: "amount_too_small"}]]);
    expect(await refusals({minAmountOut: "1000000000000001"})).toEqual([["wrap: floor breach (min=1000000000000000 < floor=1000000000000001)", {reason: "price_check_failed"}]]);
  });

  it("vault_mismatch: the pinned address answers another symbol on-chain", async () => {
    expect(await refusals({}, rpc({symbol: "FAKE"}))).toEqual([[`wrap: ${WETH} on chain 1 is not WETH — refusing`, {reason: "vault_mismatch"}]]);
  });
});

describe("getQuote: the RPC's own failure, through the real fetch path", () => {
  it("HTTP 429 with Retry-After → rate_limited with the wait", async () => {
    const limited = rpc({answer: () => new Response("slow down", {status: 429, headers: {"retry-after": "12"}})});
    expect(await refusals({}, limited)).toEqual([["wrap: no RPC answered on chain 1 (HTTP 429)", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 12_000}]]);
  });

  it("HTTP 401 / 403 → key_rejected", async () => {
    for (const status of [401, 403]) {
      expect(await refusals({}, rpc({answer: () => new Response("no key", {status})}))).toEqual([[`wrap: no RPC answered on chain 1 (HTTP ${status})`, {reason: "key_rejected", httpStatus: status}]]);
    }
  });

  it("HTTP 5xx and any other failing status → upstream_unavailable with the status", async () => {
    for (const status of [500, 503, 404]) {
      expect(await refusals({}, rpc({answer: () => new Response("down", {status})}))).toEqual([[`wrap: no RPC answered on chain 1 (HTTP ${status})`, {reason: "upstream_unavailable", httpStatus: status}]]);
    }
  });

  it("a network failure, malformed JSON, a JSON-RPC error and an undecodable answer → upstream_unavailable", async () => {
    const network = rpc({answer: () => Promise.reject(new TypeError("fetch failed"))});
    expect(await refusals({}, network)).toEqual([["wrap: no RPC answered on chain 1 (fetch failed)", {reason: "upstream_unavailable"}]]);
    const garbled = await refusals({}, rpc({answer: () => new Response("<html>")}));
    expect(garbled).toHaveLength(1);
    expect(garbled[0]![0]).toMatch(/^wrap: no RPC answered on chain 1 \(/);
    expect(garbled[0]![1]).toEqual({reason: "upstream_unavailable"});
    expect(await refusals({}, rpc({answer: () => new Response(JSON.stringify({error: {message: "header not found"}}))}))).toEqual([["wrap: no RPC answered on chain 1 (header not found)", {reason: "upstream_unavailable"}]]);
    expect(await refusals({}, rpc({answer: () => new Response(JSON.stringify({error: {}}))}))).toEqual([["wrap: no RPC answered on chain 1 (rpc error)", {reason: "upstream_unavailable"}]]);
    const empty = await refusals({}, rpc({answer: () => new Response(JSON.stringify({result: "0x"}))}));
    expect(empty).toHaveLength(1);
    expect(empty[0]![1]).toEqual({reason: "upstream_unavailable"});
  });

  it("a node's throttling answer in a 200 (-32005 limit exceeded, a 429 code) → rate_limited, as usdt0 reads it; other codes stay upstream_unavailable", async () => {
    const answer = (error: object) => rpc({answer: () => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error}))});
    expect(await refusals({}, answer({code: -32005, message: "limit exceeded"}))).toEqual([["wrap: no RPC answered on chain 1 (limit exceeded)", {reason: "rate_limited"}]]);
    expect(await refusals({}, answer({code: 429, message: "exceeded its compute units per second capacity"}))).toEqual([["wrap: no RPC answered on chain 1 (exceeded its compute units per second capacity)", {reason: "rate_limited"}]]);
    expect(await refusals({}, answer({code: 429}))).toEqual([["wrap: no RPC answered on chain 1 (rpc error)", {reason: "rate_limited"}]]);
    expect(await refusals({}, answer({code: -32000, message: "header not found"}))).toEqual([["wrap: no RPC answered on chain 1 (header not found)", {reason: "upstream_unavailable"}]]);
    expect(await refusals({}, answer({code: -32603, message: "internal error"}))).toEqual([["wrap: no RPC answered on chain 1 (internal error)", {reason: "upstream_unavailable"}]]);
  });

  it("this module's own 10 s timeout cuts a node that never answers → upstream_unavailable", async () => {
    // The endpoint never answers: the request ends only when the module's timeoutSignal aborts it.
    const hang = ((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
      const s = init?.signal;
      if (s?.aborted) return reject(s.reason);
      s?.addEventListener("abort", () => reject(s.reason), {once: true});
    })) as typeof fetch;
    // Native AbortSignal.timeout: the module asks it for 10 s and hands its signal to fetch.
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => AbortSignal.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")));
    try {
      expect(await refusals({}, hang)).toEqual([["wrap: no RPC answered on chain 1 (The operation was aborted due to timeout)", {reason: "upstream_unavailable"}]]);
      expect(timeout).toHaveBeenCalledWith(10_000);
    } finally {
      timeout.mockRestore();
    }
    // Without AbortSignal.timeout (Hermes): the module's own timer aborts at 10 s, not before.
    const native = Object.getOwnPropertyDescriptor(AbortSignal, "timeout")!;
    Object.defineProperty(AbortSignal, "timeout", {value: undefined, configurable: true, writable: true});
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", hang);
      const got: [string, Swap2RefusalInfo | null][] = [];
      let settled = false;
      const pending = wrapProvider({rpcUrls: RPC}).getQuote({...WRAP, onRefusal: (...args: [string, Swap2RefusalInfo?]) => { got.push([args[0], args.length > 1 ? args[1]! : null]); }}).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(9_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBeNull();
      expect(got).toEqual([["wrap: no RPC answered on chain 1 (This operation was aborted)", {reason: "upstream_unavailable"}]]);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(AbortSignal, "timeout", native);
    }
  });

  it("the last endpoint's answer classifies the refusal: 500 then 429 is rate_limited", async () => {
    const two = rpc({answer: (url) => (url.startsWith("https://a.test") ? new Response("down", {status: 500}) : new Response("slow", {status: 429, headers: {"retry-after": "3"}}))});
    expect(await refusals({}, two, {1: ["https://a.test", "https://b.test"]})).toEqual([["wrap: no RPC answered on chain 1 (HTTP 429)", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 3000}]]);
  });
});

describe("buildDeposit", () => {
  it("a quote without a transaction: policy_refused, a plain Error with the same text", async () => {
    const p = wrapProvider({rpcUrls: RPC});
    const err = await rejection(p.buildDeposit({provider: "wrap", intentId: "wrap:1", depositAddress: "", depositMemo: null, sourceAmount: AMOUNT, destAmount: AMOUNT, minDestAmount: AMOUNT, feeUsd: 0, etaSeconds: 15, reliability: 1, validUntilMs: Date.now() + 60_000}));
    expect(err).toBeInstanceOf(Error);
    expect(err.constructor).toBe(Error);
    expect(err.name).toBe("Error");
    expect(err.message).toBe("swap2: wrap quote has no transaction request");
    expect(refusalOf(err)).toEqual({reason: "policy_refused"});
  });
});

describe("wrapVerifyQuote: every text it returns, with wrapPins.reasonOf", () => {
  it("each refusal is classified; a passing quote returns null", async () => {
    vi.stubGlobal("fetch", rpc());
    const p = wrapProvider({rpcUrls: RPC});
    const w = (await p.getQuote(WRAP))!;
    const u = (await p.getQuote(UNWRAP))!;
    const tx = (q: Quote, o: Record<string, unknown>): Quote => ({...q, txRequest: {...q.txRequest!, ...o}});
    const cases: [QuoteParams, Quote, string, Swap2RefusalInfo["reason"]][] = [
      [{...WRAP, sourceChain: "eip155:1", destChain: "eip155:10"}, w, "not a same-chain wrap on a pinned wrapped native", "unsupported_pair"],
      [{...WRAP, sourceChain: "eip155:999999", destChain: "eip155:999999"}, w, "not a same-chain wrap on a pinned wrapped native", "unsupported_pair"],
      [{...WRAP, sourceToken: "NOPE"}, w, "unknown source token NOPE", "unsupported_pair"],
      [{...WRAP, destToken: ZERO}, w, "only ETH ↔ WETH", "unsupported_pair"],
      [{...WRAP, destAddress: OTHER}, w, "wrapping pays the sender's own address", "recipient_mismatch"],
      [WRAP, tx(w, {serializedTx: "0x00"}), "the quote carries no wrapped-native call", "policy_refused"],
      [WRAP, tx(w, {data: undefined}), "the quote carries no wrapped-native call", "policy_refused"],
      [WRAP, tx(w, {to: OTHER}), `the call targets ${OTHER}, not WETH`, "vault_mismatch"],
      [WRAP, tx(w, {approvalAddress: OTHER}), "a wrap approves nothing", "vault_mismatch"],
      [WRAP, tx(w, {chainId: 10}), "the call is for chain 10", "policy_refused"],
      [WRAP, tx(w, {value: "1.5"}), "the request does not name amounts", "upstream_unavailable"],
      [WRAP, {...w, sourceAmount: "1"}, `the quote moves 1, not the ${AMOUNT} input`, "policy_refused"],
      [WRAP, tx(w, {data: "0x12345678"}), "the call is neither deposit() nor withdraw(amount)", "policy_refused"],
      [WRAP, tx(w, {data: u.txRequest!.data}), "withdraw is not deposit()", "policy_refused"],
      [WRAP, tx(w, {value: "1"}), `deposit() attaches 1, not the ${AMOUNT} input`, "policy_refused"],
      [UNWRAP, tx(u, {data: w.txRequest!.data}), "deposit is not withdraw(amount)", "policy_refused"],
      [UNWRAP, tx(u, {data: encodeFunctionData({abi: ABI, functionName: "withdraw", args: [1n]})}), `withdraw(1) is not the ${AMOUNT} input`, "policy_refused"],
      [UNWRAP, tx(u, {value: "1"}), "withdraw attaches no value", "policy_refused"],
      [UNWRAP, tx(u, {data: encodeFunctionData({abi: ABI, functionName: "transfer", args: [OTHER, 1n]})}), "the call is neither deposit() nor withdraw(amount)", "policy_refused"],
    ];
    for (const [params, quote, text, reason] of cases) {
      const got = wrapVerifyQuote(params, quote);
      expect(got, text).toBe(text);
      expect(wrapPins.reasonOf?.(got!), text).toEqual({reason});
    }
    expect(wrapVerifyQuote(WRAP, w)).toBeNull();
    expect(wrapVerifyQuote(UNWRAP, u)).toBeNull();
    // A text these pins never returned is not theirs to classify.
    expect(wrapPins.reasonOf?.("something else")).toBeUndefined();
  });

  it("a backend's sourceAmount that is not an integer, a target that is not an address: the check throws as before, its text classified upstream_unavailable", async () => {
    vi.stubGlobal("fetch", rpc());
    const w = (await wrapProvider({rpcUrls: RPC}).getQuote(WRAP))!;
    const thrown = (quote: Quote): Error => {
      try { wrapVerifyQuote(WRAP, quote); } catch (e) { return e as Error; }
      throw new Error("expected wrapVerifyQuote to throw");
    };
    const amount = thrown({...w, sourceAmount: "abc"});
    expect(amount).toBeInstanceOf(SyntaxError);
    expect(amount.message).toBe("Cannot convert abc to a BigInt");
    expect(wrapPins.reasonOf?.(amount.message)).toEqual({reason: "upstream_unavailable"});
    const target = thrown({...w, txRequest: {...w.txRequest!, to: "0x1234"}});
    expect(target.name).toBe("InvalidAddressError");
    expect(target.message).toMatch(/^Address "0x1234" is invalid\./);
    expect(wrapPins.reasonOf?.(target.message)).toEqual({reason: "upstream_unavailable"});
  });
});

describe("through the engine and the remote stub", () => {
  const options = {fromToken: "ETH", toToken: WETH, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 10n ** 15n};
  const account = {getAddress: async () => ME, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {}};

  it("the standalone protocol's no route carries the venue's reason; the message reads as before", async () => {
    vi.stubGlobal("fetch", rpc({answer: () => new Response("slow down", {status: 429, headers: {"retry-after": "5"}})}));
    const e = await rejection<Swap2QuoteError>(new WrapSwap2Protocol(account as never, {fromChain: "eip155:1", rpcUrls: RPC}).quoteSwap2(options as never));
    expect(e).toBeInstanceOf(Swap2QuoteError);
    expect(e.message).toBe("swap2: no route available for the requested pair :: wrap: no RPC answered on chain 1 (HTTP 429)");
    expect(e.reason).toBe("rate_limited");
    expect(e.retryAfterMs).toBe(5000);
    expect(e.refusals).toEqual([{message: "wrap: no RPC answered on chain 1 (HTTP 429)", provider: "wrap", reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000}]);
  });

  it("a backend's quote that fails wrapVerifyQuote: the stub's error carries the pins' reason", async () => {
    vi.stubGlobal("fetch", rpc());
    const handle = createSwap2Handler<string>({providers: [wrapProvider({rpcUrls: RPC})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const tampered = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      const body = res.body as Quote;
      return new Response(JSON.stringify(body.txRequest ? {...body, txRequest: {...body.txRequest, to: OTHER}} : body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub: CrossChainProvider = remoteProvider({name: "wrap", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: tampered, supportsSameChain: true, ...wrapPins});
    const err = await rejection(stub.getQuote(WRAP));
    expect(err.message).toBe(`wrap: the quote fails this app's own check — the call targets ${OTHER}, not WETH`);
    expect(refusalOf(err)).toEqual({reason: "vault_mismatch"});
    class P extends SingleProviderSwap2 { protected readonly provider = stub; protected chainSupported(): boolean { return true; } }
    const e = await rejection<Swap2QuoteError>(new P(account as never, {fromChain: "eip155:1"}).quoteSwap2(options as never));
    expect(e.reason).toBe("vault_mismatch");
  });

  it("a backend's quote whose sourceAmount is not an integer: the stub's error carries upstream_unavailable", async () => {
    vi.stubGlobal("fetch", rpc());
    const handle = createSwap2Handler<string>({providers: [wrapProvider({rpcUrls: RPC})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const tampered = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      const body = res.body as Quote;
      return new Response(JSON.stringify(body.txRequest ? {...body, sourceAmount: "abc"} : body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "wrap", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: tampered, supportsSameChain: true, ...wrapPins});
    const err = await rejection(stub.getQuote(WRAP));
    expect(err.message).toBe("wrap: the quote fails this app's own check — Cannot convert abc to a BigInt");
    expect(refusalOf(err)).toEqual({reason: "upstream_unavailable"});
  });

  it("a refusal of the backend's own provider comes back with its reason", async () => {
    vi.stubGlobal("fetch", rpc());
    const handle = createSwap2Handler<string>({providers: [wrapProvider({rpcUrls: RPC})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const backend = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "wrap", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: backend, supportsSameChain: true, ...wrapPins});
    const err = await rejection(stub.getQuote({...WRAP, destAddress: OTHER}));
    expect(err.message).toBe("wrap: wrapping pays the sender's own address — send the result separately");
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
  });
});

describe("what stays unclassified", () => {
  it("a developer's non-integer amount reaches onRefusal with the text only", async () => {
    expect(await refusals({amountIn: "1.5"})).toEqual([["wrap: amount is not an integer", null]]);
  });

  it("tracking never throws: an RPC failure is still pending", async () => {
    vi.stubGlobal("fetch", rpc({answer: () => new Response("down", {status: 503})}));
    expect(await wrapProvider({rpcUrls: RPC}).trackIntent({intentId: "wrap:1", sourceTxHash: "0xab"})).toEqual({state: "pending"});
  });
});
