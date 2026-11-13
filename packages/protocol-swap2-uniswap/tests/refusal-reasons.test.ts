// CS-13: every Uniswap v3 refusal keeps its text and carries a stable `reason` (Swap2RefusalReason). The real provider,
// verifier, pins and engine run against a fake JSON-RPC (the venue is the chain): no network, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionResult, encodeFunctionData, parseAbi, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {Swap2QuoteError} from "@anywalletkit/protocol-swap2-core";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider} from "../src/provider.js";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {ADDRESS_THIS, UNISWAP_V3, uniswapPins, uniswapVerifyQuote} from "../src/addresses.js";
import {D, ME, RPC, SQRT_CEIL, SQRT_FLOOR, USDC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const ZERO = "0x0000000000000000000000000000000000000000";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"};
const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
]);

/** The fixtures' RPC, plus: HTTP answers per call (`http`, consumed in order, then the stub), the caller's abort honoured. */
function rpc(o: StubOptions & {http?: Array<{status: number; headers?: Record<string, string>} | "down" | {raw: string}>} = {}): typeof fetch {
  const inner = rpcStub(o);
  const queue = [...(o.http ?? [])];
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const next = queue.shift();
    if (next === "down") throw new TypeError("fetch failed");
    if (next && "raw" in next) return new Response(next.raw);
    if (next) return new Response("{}", {status: next.status, headers: next.headers ?? {}});
    return inner(url, init);
  }) as typeof fetch;
}

/** getQuote: the onRefusal text and its classification. */
async function quote(fetchImpl: typeof fetch, over: Record<string, unknown> = {}, config: Record<string, unknown> = {}, signal?: AbortSignal) {
  vi.stubGlobal("fetch", fetchImpl);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, ...config}).getQuote({...base, ...over, onRefusal: (text: string, info?: Swap2RefusalInfo) => { heard.push([text, info]); }} as never, signal);
  expect(q).toBeNull();
  expect(heard).toHaveLength(1);
  return {text: heard[0]![0], info: heard[0]![1]};
}

async function rejection(run: () => unknown): Promise<Error> {
  try { await run(); } catch (e) { return e as Error; }
  throw new Error("expected a rejection");
}

describe("uniswap getQuote: the request this venue does not serve", () => {
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>, string, Swap2RefusalInfo["reason"]]> = [
    ["an amount-flexible deposit", {flex: true}, {}, "uniswap: amount-flexible deposits are not supported", "unsupported_pair"],
    ["a cross-chain request", {destChain: "eip155:8453"}, {}, "uniswap: same-chain swaps only", "unsupported_pair"],
    ["a chain without a deployment or RPC", {sourceChain: "eip155:8453", destChain: "eip155:8453"}, {}, "uniswap: no Uniswap v3 deployment or RPC for eip155:8453", "unsupported_pair"],
    ["a token the catalog does not list", {sourceToken: "NOPE"}, {}, "uniswap: unknown source token NOPE", "unsupported_pair"],
    ["native out where the router wraps nothing (Celo)", {sourceChain: "eip155:42220", destChain: "eip155:42220", destToken: ZERO}, {rpcUrls: {42220: ["https://rpc.test"]}}, "uniswap: this chain's router has no wrapped native — swap the coin's ERC-20 instead", "unsupported_pair"],
    ["a destination token that is not an EVM address", {destToken: "So11111111111111111111111111111111111111112"}, {}, "uniswap: destination token must be an EVM address", "unsupported_pair"],
    ["a wrap", {sourceToken: "ETH", destToken: D.weth}, {}, "uniswap: that is a wrap/unwrap, not a swap", "unsupported_pair"],
    ["the same token in and out", {destToken: USDC}, {}, "uniswap: same token in and out", "unsupported_pair"],
    ["a recipient that cannot receive on an EVM chain", {destAddress: "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG"}, {}, "uniswap: recipient must be an EVM address", "recipient_mismatch"],
  ];
  for (const [what, over, config, text, reason] of cases) {
    it(`${what} → ${reason}, the text unchanged`, async () => {
      expect(await quote(rpc(), over, config)).toEqual({text, info: {reason}});
    });
  }

  it("an invalid argument or option from the developer stays unclassified", async () => {
    expect(await quote(rpc(), {amountIn: "1.5"})).toEqual({text: "uniswap: amount is not an integer", info: undefined});
    expect(await quote(rpc(), {amountIn: "0"})).toEqual({text: "uniswap: amount must be positive", info: undefined});
    const err = await rejection(() => uniswapProvider({rpcUrls: RPC, defaultSlippageBps: 0}));
    expect(err.message).toBe("uniswap: defaultSlippageBps must be 1..4999");
    expect(refusalOf(err)).toBeUndefined();
  });
});

describe("uniswap getQuote: what the pools say", () => {
  it("no pool → no_route; every route runs a pool dry → insufficient_liquidity", async () => {
    expect(await quote(rpc({byFee: {}}))).toEqual({text: "uniswap: no Uniswap v3 pool route for this pair and amount", info: {reason: "no_route"}});
    expect(await quote(rpc({byFee: {500: 1n, 3000: 1n}, sqrtAfter: {500: SQRT_CEIL, 3000: SQRT_FLOOR}})))
      .toEqual({text: "uniswap: pool liquidity runs out before the full amount (partial fill)", info: {reason: "insufficient_liquidity"}});
  });

  it("a minimum that rounds to 0 → amount_too_small; the caller's floor → price_check_failed", async () => {
    expect(await quote(rpc({byFee: {500: 1_000_000n}}), {amountIn: "1"}))
      .toEqual({text: "uniswap: the minimum output rounds to 0 (quoted 1 at 50 bps slippage) — the amount is too small for this pool", info: {reason: "amount_too_small"}});
    expect(await quote(rpc(), {minAmountOut: "999000"})).toEqual({text: "uniswap: floor breach (min=995000 < floor=999000)", info: {reason: "price_check_failed"}});
  });

  it("a router/quoter that no longer match the pinned deployment → vault_mismatch", async () => {
    expect(await quote(rpc({badFactory: true}))).toEqual({text: "uniswap: the router/quoter on chain 1 do not match the pinned deployment — refusing", info: {reason: "vault_mismatch"}});
  });
});

describe("uniswap getQuote: the RPC through the real fetch path", () => {
  it("HTTP 429 with Retry-After → rate_limited with the wait", async () => {
    expect(await quote(rpc({http: [{status: 429, headers: {"retry-after": "3"}}]})))
      .toEqual({text: "uniswap: no RPC answered on chain 1 (HTTP 429)", info: {reason: "rate_limited", httpStatus: 429, retryAfterMs: 3000}});
  });

  it("HTTP 401 / 403 → key_rejected", async () => {
    expect(await quote(rpc({http: [{status: 401}]}))).toEqual({text: "uniswap: no RPC answered on chain 1 (HTTP 401)", info: {reason: "key_rejected", httpStatus: 401}});
    expect(await quote(rpc({http: [{status: 403}]}))).toEqual({text: "uniswap: no RPC answered on chain 1 (HTTP 403)", info: {reason: "key_rejected", httpStatus: 403}});
  });

  it("HTTP 5xx, the network failing, an answer that is not JSON → upstream_unavailable", async () => {
    expect(await quote(rpc({http: [{status: 503}]}))).toEqual({text: "uniswap: no RPC answered on chain 1 (HTTP 503)", info: {reason: "upstream_unavailable", httpStatus: 503}});
    expect(await quote(rpc({http: ["down"]}))).toEqual({text: "uniswap: no RPC answered on chain 1 (fetch failed)", info: {reason: "upstream_unavailable"}});
    const notJson = await new Response("not json").json().then(() => "", (e: Error) => e.message);
    expect(await quote(rpc({http: [{raw: "not json"}]}))).toEqual({text: `uniswap: no RPC answered on chain 1 (${notJson})`, info: {reason: "upstream_unavailable"}});
  });

  it("with failover the last endpoint's answer classifies it", async () => {
    const two = {rpcUrls: {1: ["https://a.test", "https://b.test"]}};
    expect(await quote(rpc({http: [{status: 429, headers: {"retry-after": "3"}}, {status: 502}]}), {}, two))
      .toEqual({text: "uniswap: no RPC answered on chain 1 (HTTP 502)", info: {reason: "upstream_unavailable", httpStatus: 502}});
    expect(await quote(rpc({http: ["down", {status: 429, headers: {"retry-after": "3"}}]}), {}, two))
      .toEqual({text: "uniswap: no RPC answered on chain 1 (HTTP 429)", info: {reason: "rate_limited", httpStatus: 429, retryAfterMs: 3000}});
  });

  it("the caller's own abort is not upstream_unavailable", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await quote(rpc(), {}, {}, ctrl.signal)).toEqual({text: "uniswap: no RPC answered on chain 1 (This operation was aborted)", info: undefined});
  });
});

describe("uniswap preflightDeposit and buildDeposit", () => {
  async function quoted(stub: StubOptions = {}) {
    vi.stubGlobal("fetch", rpc(stub));
    const p = uniswapProvider({rpcUrls: RPC});
    const q = (await p.getQuote(base))!;
    return {p, q, tx: await p.buildDeposit(q)};
  }

  it("the route no longer quotes → no_route; a drained pool → insufficient_liquidity; a lower price → price_check_failed", async () => {
    const {p, q, tx} = await quoted();
    const cases: Array<[typeof fetch, string, Swap2RefusalInfo["reason"]]> = [
      [rpc({byFee: {}}), "uniswap: the pool no longer quotes this route — refresh and try again", "no_route"],
      [rpc({sqrtAfter: {500: SQRT_FLOOR}}), "uniswap: pool liquidity runs out before the full amount (partial fill) — the pool can no longer take this swap. Nothing was sent; refresh the quote.", "insufficient_liquidity"],
      [rpc({byFee: {500: 900_000n}}), "uniswap: price moved — the pool now pays 900000, under your minimum 995000. Nothing was sent; refresh the quote.", "price_check_failed"],
    ];
    for (const [fetchImpl, text, reason] of cases) {
      vi.stubGlobal("fetch", fetchImpl);
      const err = await rejection(() => p.preflightDeposit!(q, tx));
      expect(err.message).toBe(text);
      expect(err.constructor).toBe(Error);
      expect(refusalOf(err)).toEqual({reason});
    }
  });

  it("an RPC that does not answer → upstream_unavailable; a quoter answer that does not decode → upstream_unavailable, its error kept", async () => {
    const {p, q, tx} = await quoted();
    vi.stubGlobal("fetch", rpc({http: [{status: 502}]}));
    const down = await rejection(() => p.preflightDeposit!(q, tx));
    expect(down.message).toBe("uniswap: no RPC answered on chain 1 (HTTP 502)");
    expect(refusalOf(down)).toEqual({reason: "upstream_unavailable", httpStatus: 502});
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify([{jsonrpc: "2.0", id: 0, result: "0x1234"}]))) as unknown as typeof fetch);
    const odd = await rejection(() => p.preflightDeposit!(q, tx));
    const expected = (() => { try { decodeFunctionResult({abi: QUOTER, functionName: "quoteExactInputSingle", data: "0x1234"}); return null; } catch (e) { return e as Error; } })()!;
    expect(odd.message).toBe(expected.message);
    expect(odd.name).toBe(expected.name);
    expect(refusalOf(odd)).toEqual({reason: "upstream_unavailable"});
  });

  it("a quote without a transaction → policy_refused", async () => {
    const err = await rejection(() => uniswapProvider({rpcUrls: RPC}).buildDeposit({intentId: "uniswap:1"} as Quote));
    expect(err.message).toBe("swap2: Uniswap quote has no transaction request");
    expect(refusalOf(err)).toEqual({reason: "policy_refused"});
  });
});

describe("uniswapPins.reasonOf classifies uniswapVerifyQuote's texts (return type unchanged)", () => {
  const params: QuoteParams = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: "1000000", destAddress: ME, refundAddress: ME};
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const multicall = (...legs: Hex[]) => encodeFunctionData({abi: ROUTER, functionName: "multicall", args: [deadline, legs]});
  const single = (o: Partial<{tokenOut: string; recipient: string; amountOutMinimum: bigint}> = {}) =>
    encodeFunctionData({abi: ROUTER, functionName: "exactInputSingle", args: [{tokenIn: USDC, tokenOut: USDT, fee: 500, recipient: ME, amountIn: 1_000_000n, amountOutMinimum: 995_000n, sqrtPriceLimitX96: 0n, ...o} as never]});
  async function real(p: QuoteParams = params): Promise<Quote> {
    vi.stubGlobal("fetch", rpc());
    return (await uniswapProvider({rpcUrls: RPC}).getQuote(p))!;
  }

  it("each refusal text → its reason; the real build → null", async () => {
    const q = await real();
    expect(uniswapVerifyQuote(params, q)).toBeNull();
    const withTx = (over: Partial<NonNullable<Quote["txRequest"]>>): Quote => ({...q, txRequest: {...q.txRequest!, ...over}});
    const {txRequest: _drop, ...noTx} = q;
    const cases: Array<[QuoteParams, Quote, string, Swap2RefusalInfo["reason"]]> = [
      [{...params, destChain: "eip155:8453"}, q, "not a same-chain swap on a pinned Uniswap deployment", "unsupported_pair"],
      [params, noTx as Quote, "the quote carries no router call", "policy_refused"],
      [params, withTx({to: ATTACKER}), `the call targets ${ATTACKER}, not the SwapRouter`, "vault_mismatch"],
      [{...params, sourceToken: "NOPE"}, q, "unknown source token NOPE", "unsupported_pair"],
      [params, withTx({value: "1"}), "a token input attaches no value and approves the SwapRouter", "policy_refused"],
      [params, withTx({data: single()}), "exactInputSingle is not multicall(deadline, legs)", "policy_refused"],
      [params, withTx({data: "0xdeadbeef"}), "the router call is not multicall(deadline, legs)", "policy_refused"],
      [params, withTx({data: multicall(single(), single())}), "the multicall has 2 legs, not a swap", "policy_refused"],
      [params, withTx({data: multicall(single({tokenOut: D.weth}))}), "the swap trades other tokens", "policy_refused"],
      [params, withTx({data: multicall(single({amountOutMinimum: 1n}))}), "the swap's input, minimum or price limit is not the quote's", "price_check_failed"],
      [params, withTx({data: multicall(single({recipient: ATTACKER}))}), `the swap pays ${ATTACKER}, not the recipient`, "recipient_mismatch"],
    ];
    for (const [p, quote, text, reason] of cases) {
      const refusal = uniswapVerifyQuote(p, quote);
      expect(refusal).toBe(text);
      expect(uniswapPins.reasonOf!(refusal!)).toEqual({reason});
    }
  });

  it("native out: an unwrap to someone else → recipient_mismatch; Celo native → unsupported_pair", async () => {
    const nativeOut = {...params, destToken: ZERO};
    const q = await real(nativeOut);
    const unwrapTo = {...q, txRequest: {...q.txRequest!, data: multicall(single({tokenOut: D.weth, recipient: ADDRESS_THIS}), encodeFunctionData({abi: ROUTER, functionName: "unwrapWETH9", args: [995_000n, ATTACKER]}))}};
    expect(uniswapVerifyQuote(nativeOut, unwrapTo)).toBe("the unwrap pays someone else or less than the minimum");
    expect(uniswapPins.reasonOf!("the unwrap pays someone else or less than the minimum")).toEqual({reason: "recipient_mismatch"});
    // The same text, by the clause that failed: only the amount under the minimum → price_check_failed; both → the recipient.
    const unwrapWith = (amount: bigint, to: string): Quote => ({...q, txRequest: {...q.txRequest!, data: multicall(single({tokenOut: D.weth, recipient: ADDRESS_THIS}), encodeFunctionData({abi: ROUTER, functionName: "unwrapWETH9", args: [amount, to as Hex]}))}});
    expect(uniswapVerifyQuote(nativeOut, unwrapWith(995_000n, ME))).toBeNull();
    expect(uniswapVerifyQuote(nativeOut, unwrapWith(1n, ME))).toBe("the unwrap pays someone else or less than the minimum");
    expect(uniswapPins.reasonOf!("the unwrap pays someone else or less than the minimum")).toEqual({reason: "price_check_failed"});
    expect(uniswapVerifyQuote(nativeOut, unwrapWith(1n, ATTACKER))).toBe("the unwrap pays someone else or less than the minimum");
    expect(uniswapPins.reasonOf!("the unwrap pays someone else or less than the minimum")).toEqual({reason: "recipient_mismatch"});
    const celo = {...nativeOut, sourceChain: "eip155:42220", destChain: "eip155:42220"};
    const onCelo = {...q, txRequest: {...q.txRequest!, to: UNISWAP_V3[42220]!.router}};
    expect(uniswapVerifyQuote(celo, onCelo)).toBe("this chain's router has no wrapped native");
    expect(uniswapPins.reasonOf!("this chain's router has no wrapped native")).toEqual({reason: "unsupported_pair"});
  });

  it("a request that does not parse, and a text these pins never produced, stay unclassified", async () => {
    const q = await real();
    const refusal = uniswapVerifyQuote({...params, destAddress: "not an address"}, q);
    expect(refusal).toBe("the request does not name EVM tokens, a recipient and amounts");
    expect(uniswapPins.reasonOf!(refusal!)).toBeUndefined();
    expect(uniswapPins.reasonOf!("something else entirely")).toBeUndefined();
  });

  it("behind remoteProvider the stub's refusal carries the pins' reason", async () => {
    const q = await real();
    const evil = {...q, txRequest: {...q.txRequest!, data: multicall(single({recipient: ATTACKER}))}};
    const fetchImpl = (async () => new Response(JSON.stringify(evil), {status: 200})) as unknown as typeof fetch;
    const stub = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...uniswapPins});
    const err = await rejection(() => stub.getQuote(params));
    expect(err.message).toBe(`uniswap: the quote fails this app's own check — the swap pays ${ATTACKER}, not the recipient`);
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
  });
});

describe("the engine's no-route error carries Uniswap's reason", () => {
  it("UniswapSwap2Protocol.quoteSwap2 with no pool: the text unchanged, no_route", async () => {
    vi.stubGlobal("fetch", rpc({byFee: {}}));
    const err = await rejection(() => new UniswapSwap2Protocol(undefined, {fromChain: "eip155:1", rpcUrls: RPC}).quoteSwap2({fromToken: "USDC", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000n} as never));
    expect(err).toBeInstanceOf(Swap2QuoteError);
    expect(err.message).toBe("swap2: no route available for the requested pair :: uniswap: no Uniswap v3 pool route for this pair and amount");
    expect(refusalOf(err)).toEqual({reason: "no_route"});
    expect((err as Swap2QuoteError).refusals).toEqual([{message: "uniswap: no Uniswap v3 pool route for this pair and amount", provider: "uniswap", reason: "no_route"}]);
  });
});
