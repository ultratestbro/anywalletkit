// CS-13: every refusal this module raises carries a stable `reason` next to its text, and the text is unchanged.
// Everything below runs the module's real code paths on real recorded 0x answers; only `fetch` is replaced. Each
// recording is replayed with the chain table of its pin era (tests/recorded.ts).
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {getAddress} from "viem";
import {SWAP2_REFUSAL_REASONS, Swap2QuoteError, refusalOf, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {zeroExProvider, type ZeroExProviderConfig} from "../src/provider.js";
import {zeroExPins, zeroExVerifyBuild, zeroExVerifyQuote} from "../src/remote.js";
import {ZeroExTransactionError, checkZeroExTransaction, createSettlerResolver} from "../src/settler.js";
import {getKey} from "./fixtures.js";
import {bodyOf, chainOf, chainsConfigOf, chainsOf, loadRecorded, paramsOf, recordedFetch, rpcOf, type RecordedQuote} from "./recorded.js";

const OTHER = "0x1111111111111111111111111111111111111111";
const TOKEN = "base-usdc-eth"; // Base USDC → ETH, a Permit2 token sale
const NATIVE = "base-eth-usdc"; // Base ETH → USDC, a native-coin sale
const PRICE = "base-usdc-eth-price";

/** Every reason a test below saw, checked against the union at the end. */
const seen = new Set<Swap2RefusalReason>();

interface Heard {text: string; info: Swap2RefusalInfo | undefined}
function heardParams(f: RecordedQuote, over: Partial<QuoteParams> = {}): QuoteParams & {heard: Heard[]} {
  const heard: Heard[] = [];
  return {...paramsOf(f), onRefusal: (text, info) => heard.push({text, info}), heard, ...over};
}
/** One refusal heard through `onRefusal`: exactly this text, classified as `info` (undefined: not classified). */
function expectHeard(params: {heard: Heard[]}, text: string, info: Swap2RefusalInfo | undefined): void {
  expect(params.heard).toHaveLength(1);
  expect(params.heard[0]!.text).toBe(text);
  expect(params.heard[0]!.info).toEqual(info);
  if (info) seen.add(info.reason);
}
function expectThrown(err: unknown, text: string, reason: Swap2RefusalReason | undefined): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(text);
  expect(refusalOf(err)?.reason).toBe(reason);
  if (reason) seen.add(reason);
}
async function caught(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

/** A quote of a recording, its answer (or the whole fetch) replaced first. */
async function quote(name: string, o: {over?: Partial<QuoteParams>; body?: unknown; status?: number; headers?: Record<string, string>; registry?: {current?: string | null; prev?: string | null}; config?: Partial<ZeroExProviderConfig>; fetchImpl?: typeof fetch} = {}) {
  const f = loadRecorded(name);
  vi.setSystemTime(f.request.nowMs);
  vi.stubGlobal("fetch", o.fetchImpl ?? recordedFetch(f, {...(o.body !== undefined ? {body: o.body} : {}), ...(o.status ? {status: o.status} : {}), ...(o.headers ? {headers: o.headers} : {}), ...(o.registry ? {registry: o.registry} : {})}));
  const provider = zeroExProvider({apiKey: getKey, rpcUrls: rpcOf(f), chains: chainsConfigOf(f), ...o.config});
  const params = heardParams(f, o.over);
  const q = await provider.getQuote(params);
  return {f, provider, params, quote: q};
}
const edited = (name: string, edit: (b: Record<string, any>) => unknown) => {
  const b = bodyOf(loadRecorded(name));
  return edit(b) ?? b;
};

/** A copy of a quote without its transaction. */
const withoutTx = ({txRequest: _tx, ...rest}: Quote): Quote => rest;

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("getQuote: 0x's HTTP answer", () => {
  const http = (status: number, body: unknown, headers: Record<string, string> = {}) => quote(TOKEN, {status, body, headers});

  it("429 is rate_limited, with Retry-After and the status — whatever the body names", async () => {
    expectHeard((await http(429, {message: "Too many"}, {"retry-after": "7"})).params, "zeroex: rate limited (HTTP 429)", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000});
    expectHeard((await http(429, "")).params, "zeroex: rate limited (HTTP 429)", {reason: "rate_limited", httpStatus: 429});
    expectHeard((await http(429, {name: "INPUT_INVALID"}, {"retry-after": "2"})).params, "zeroex: 0x rejected the request as invalid (INPUT_INVALID)", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 2000});
  });
  it("401 / 403 is key_rejected", async () => {
    expectHeard((await http(401, {message: "Invalid API key"})).params, "zeroex: API key rejected (HTTP 401)", {reason: "key_rejected", httpStatus: 401});
    expectHeard((await http(403, "<html>Forbidden</html>")).params, "zeroex: API key rejected (HTTP 403)", {reason: "key_rejected", httpStatus: 403});
  });
  it("5xx is upstream_unavailable with the status", async () => {
    expectHeard((await http(502, "<html>")).params, "zeroex: API answered HTTP 502", {reason: "upstream_unavailable", httpStatus: 502});
    expectHeard((await http(500, {name: "INTERNAL_SERVER_ERROR", message: "x"})).params, "zeroex: 0x had an internal error (INTERNAL_SERVER_ERROR)", {reason: "upstream_unavailable", httpStatus: 500});
  });
  it("any other status: a JSON refusal is a quote 0x does not have, anything else an answer of another shape", async () => {
    expectHeard((await http(400, {})).params, "zeroex: API answered HTTP 400", {reason: "no_route"});
    expectHeard((await http(404, "<html>Not Found</html>")).params, "zeroex: API answered HTTP 404", {reason: "upstream_unavailable", httpStatus: 404});
    // a name it does not know, or a key of Object.prototype, is never echoed
    expectHeard((await http(400, {name: "SOMETHING_NEW"})).params, "zeroex: API answered HTTP 400", {reason: "no_route"});
    expectHeard((await http(400, {name: "constructor"})).params, "zeroex: API answered HTTP 400", {reason: "no_route"});
  });
  it.each<[string, number, string, Swap2RefusalInfo]>([
    ["INPUT_INVALID", 400, "0x rejected the request as invalid", {reason: "no_route"}],
    ["SWAP_VALIDATION_FAILED", 400, "0x could not validate this swap", {reason: "no_route"}],
    ["UNCATEGORIZED", 400, "0x could not quote this swap", {reason: "no_route"}],
    ["TOKEN_NOT_SUPPORTED", 400, "0x does not support one of these tokens", {reason: "unsupported_pair"}],
    ["RECIPIENT_NOT_SUPPORTED", 400, "0x does not support a separate recipient for this swap", {reason: "unsupported_pair"}],
    ["USER_NOT_AUTHORIZED", 403, "0x does not serve this account", {reason: "unsupported_pair"}],
    ["TAKER_NOT_AUTHORIZED_FOR_TRADE", 403, "0x does not serve this account", {reason: "unsupported_pair"}],
    ["RECIPIENT_NOT_AUTHORIZED_FOR_TRADE", 403, "0x does not serve this recipient", {reason: "unsupported_pair"}],
    ["BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE", 403, "0x does not serve the token being bought", {reason: "unsupported_pair"}],
    ["SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE", 403, "0x does not serve the token being sold", {reason: "unsupported_pair"}],
    ["XSTOCKS_NOT_AUTHORIZED", 403, "0x does not serve this token for this account", {reason: "unsupported_pair"}],
    ["INSUFFICIENT_ASSET_LIQUIDITY", 400, "0x has too little liquidity for this pair and amount", {reason: "insufficient_liquidity"}],
    ["INTERNAL_SERVER_ERROR", 503, "0x had an internal error", {reason: "upstream_unavailable", httpStatus: 503}],
  ])("error name %s at %i", async (name, status, text, info) => {
    expectHeard((await http(status, {name, message: "x", data: {zid: "0x1"}})).params, `zeroex: ${text} (${name})`, info);
  });
  it("an unreachable API is upstream_unavailable; the caller's own abort is not classified", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expectHeard((await quote(PRICE, {fetchImpl: down})).params, "zeroex: API unreachable (TypeError)", {reason: "upstream_unavailable"});
    const f = loadRecorded(PRICE);
    vi.setSystemTime(f.request.nowMs);
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", (async (_u: string, init: RequestInit) => { ctrl.abort(); throw init.signal?.reason ?? new DOMException("aborted", "AbortError"); }) as unknown as typeof fetch);
    const params = heardParams(f);
    expect(await zeroExProvider({apiKey: getKey, chains: chainsConfigOf(f)}).getQuote(params, ctrl.signal)).toBeNull();
    expect(params.heard).toHaveLength(1);
    expect(params.heard[0]!.text).toMatch(/^zeroex: API unreachable \(/);
    expect(params.heard[0]!.info).toBeUndefined();
  });
});

describe("getQuote: the request and the route", () => {
  it("a pair, chain or flow 0x does not serve is unsupported_pair; no key is key_rejected", async () => {
    expectHeard((await quote(PRICE, {over: {flex: true}})).params, "zeroex: amount-flexible deposits are not supported", {reason: "unsupported_pair"});
    expectHeard((await quote(PRICE, {over: {destChain: "eip155:1"}})).params, "zeroex: same-chain swaps only", {reason: "unsupported_pair"});
    expectHeard((await quote(PRICE, {over: {sourceChain: "eip155:100", destChain: "eip155:100"}})).params, "zeroex: 0x is not configured for eip155:100", {reason: "unsupported_pair"});
    expectHeard((await quote(NATIVE, {over: {sourceToken: "NOPE"}})).params, "zeroex: unknown source token NOPE", {reason: "unsupported_pair"});
    expectHeard((await quote(PRICE, {over: {destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"}})).params, "zeroex: same token in and out", {reason: "unsupported_pair"});
    expectHeard((await quote(NATIVE, {over: {destToken: "0x4200000000000000000000000000000000000006"}})).params, "zeroex: wrapping and unwrapping are not 0x swaps", {reason: "unsupported_pair"});
    expectHeard((await quote(PRICE, {config: {apiKey: () => undefined}})).params, "zeroex: no 0x API key is configured", {reason: "key_rejected"});
  });
  it("a live quote without an EVM recipient is recipient_mismatch", async () => {
    expectHeard((await quote(TOKEN, {over: {destAddress: "nope"}})).params, "zeroex: recipient must be an EVM address", {reason: "recipient_mismatch"});
  });
  it("the caller's own malformed request is not classified", async () => {
    expectHeard((await quote(PRICE, {over: {amountIn: "1.5"}})).params, "zeroex: amount is not an integer", undefined);
    expectHeard((await quote(PRICE, {over: {amountIn: "0"}})).params, "zeroex: amount must be positive", undefined);
    expectHeard((await quote(PRICE, {over: {slippageBps: 10_000}})).params, "zeroex: invalid slippage", undefined);
    expectHeard((await quote(PRICE, {over: {minAmountOut: "-1"}})).params, "zeroex: minimum output is not an integer", undefined);
    expectHeard((await quote(PRICE, {over: {destToken: "ETH"}})).params, "zeroex: destination token must be an EVM address", undefined);
  });
});

describe("getQuote: the registry read", () => {
  it("no RPC configured is policy_refused, a silent RPC upstream_unavailable, a paused feature chain_halted, a foreign answer vault_mismatch", async () => {
    expectHeard((await quote(TOKEN, {config: {rpcUrls: {}}})).params, "zeroex: no RPC is configured for chain 8453 — the 0x Settler cannot be resolved", {reason: "policy_refused"});
    const f = loadRecorded(TOKEN);
    const down = (async (u: string, init?: RequestInit) => (init?.method === "POST" ? new Response("bad gateway", {status: 502}) : recordedFetch(f)(u, init))) as unknown as typeof fetch;
    expectHeard((await quote(TOKEN, {fetchImpl: down})).params, "zeroex: no RPC answered on chain 8453 — the 0x Settler cannot be resolved", {reason: "upstream_unavailable"});
    const failing = (async (u: string, init?: RequestInit) => (init?.method === "POST" ? new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: -32000, message: "header not found"}})) : recordedFetch(f)(u, init))) as unknown as typeof fetch;
    expectHeard((await quote(TOKEN, {fetchImpl: failing})).params, "zeroex: the RPC on chain 8453 could not read the 0x Settler registry", {reason: "upstream_unavailable"});
    expectHeard((await quote(TOKEN, {registry: {current: null}})).params, "zeroex: the 0x Settler registry on chain 8453 reports no taker Settler in force (paused or removed)", {reason: "chain_halted"});
    expectHeard((await quote(TOKEN, {registry: {current: OTHER}})).params, `zeroex: the RPC on chain 8453 names ${OTHER} as the 0x Settler, which is not an address the 0x registry deploys Settlers to`, {reason: "vault_mismatch"});
  });
});

describe("getQuote: what the API answers", () => {
  it.each<[string, string, (b: Record<string, any>) => unknown, string, Swap2RefusalReason]>([
    ["no liquidity", TOKEN, () => ({liquidityAvailable: false, zid: "0x1"}), "no liquidity for this pair and amount", "insufficient_liquidity"],
    ["a liquidity flag that is not a boolean", TOKEN, (b) => { b.liquidityAvailable = "yes"; }, "malformed API response (liquidity)", "upstream_unavailable"],
    ["a body that is not an object", TOKEN, () => "[]", "malformed API response", "upstream_unavailable"],
    ["an oversized body", TOKEN, () => `{"x":"${"a".repeat(600_001)}"}`, "the API answer is larger than any quote", "upstream_unavailable"],
    ["an exact-output quote", TOKEN, (b) => { b.mode = "exact-out"; }, "the API answered a quote that is not exact-input", "policy_refused"],
    ["other tokens", TOKEN, (b) => { b.buyToken = OTHER; }, "the API quoted other tokens than the ones asked for", "policy_refused"],
    ["amounts that are not integers", TOKEN, (b) => { b.buyAmount = "1e18"; }, "malformed quote amounts", "upstream_unavailable"],
    ["another input", TOKEN, (b) => { b.sellAmount = "25000001"; }, "quoted 25000001, not the requested 25000000", "policy_refused"],
    ["a minimum above the output", TOKEN, (b) => { b.minBuyAmount = (BigInt(b.buyAmount) + 1n).toString(); }, "the quoted minimum is not between zero and the quoted output", "price_check_failed"],
    ["a buy token that taxes transfers", TOKEN, (b) => { b.tokenMetadata.buyToken.transferTaxBps = "100"; }, "the token being bought taxes transfers — the amount received cannot be guaranteed", "unsupported_pair"],
    ["a tax that cannot be read", TOKEN, (b) => { b.tokenMetadata.buyToken.buyTaxBps = "lots"; }, "malformed API response (token tax)", "upstream_unavailable"],
    ["no transaction", TOKEN, (b) => { delete b.transaction; }, "the quote carries no transaction", "upstream_unavailable"],
    ["fees that cannot be read", TOKEN, (b) => { delete b.fees; }, "the quote's fees are missing", "upstream_unavailable"],
    ["an integrator fee nobody asked for", TOKEN, (b) => { b.fees.integratorFee = {amount: "10", token: b.sellToken, type: "volume"}; }, "the quote carries an integrator fee this wallet did not ask for", "policy_refused"],
    ["an allowance asked for another spender", TOKEN, (b) => { b.issues.allowance = {actual: "0", spender: OTHER}; }, "the API asks for an allowance to something other than canonical Permit2", "vault_mismatch"],
    ["an allowance target that is not Permit2", TOKEN, (b) => { b.allowanceTarget = OTHER; }, "the API asks for an allowance to something other than canonical Permit2", "vault_mismatch"],
    ["an allowance target other than Permit2 on a native sale", NATIVE, (b) => { b.allowanceTarget = OTHER; }, "the API asks for a token allowance on a native-coin sale", "policy_refused"],
    ["an excluded source 0x does not know", TOKEN, (b) => { b.issues.invalidSourcesPassed = ["NotARealSource_xyz"]; }, "0x does not know the excluded source NotARealSource_xyz — they would not be excluded", "policy_refused"],
    ["a transaction that cannot be read", TOKEN, (b) => { b.transaction.value = "0x0"; }, "malformed quote transaction", "upstream_unavailable"],
    ["a Permit2 request on a native sale", NATIVE, (b) => { b.permit2 = bodyOf(loadRecorded(TOKEN)).permit2; }, "the API asks for a Permit2 signature on a native-coin sale", "policy_refused"],
    ["no Permit2 payload on a token sale", TOKEN, (b) => { b.permit2 = null; }, "the quote carries no Permit2 payload to sign", "policy_refused"],
    ["a permit for more than the input", TOKEN, (b) => { b.permit2.eip712.message.permitted.amount = "25000001"; }, "Permit2 transfer refused — the permitted amount is not the swap's 25000000", "price_check_failed"],
    ["a permit for another spender", TOKEN, (b) => { b.permit2.eip712.message.spender = OTHER; }, "Permit2 transfer refused — the spender is not the contract the swap calls", "vault_mismatch"],
    ["a permit whose hash is not 0x's", TOKEN, (b) => { b.permit2.hash = `0x${"00".repeat(32)}`; }, "the Permit2 payload does not hash to what the API says is being signed", "policy_refused"],
    ["a permit whose deadline is past", TOKEN, (b) => { b.permit2.eip712.message.deadline = "1"; }, "Permit2 transfer refused — the deadline has passed or is not a uint256", "quote_expired"],
    ["a target outside the registry", TOKEN, (b) => { b.transaction.to = OTHER; b.permit2.eip712.message.spender = OTHER; b.permit2.hash = null; }, `the transaction target ${OTHER} is not a 0x Settler from the on-chain registry`, "vault_mismatch"],
    ["calldata paying someone else", TOKEN, (b) => { b.transaction.data = `${b.transaction.data.slice(0, 10)}${OTHER.slice(2).padStart(64, "0")}${b.transaction.data.slice(74)}`; }, `the swap pays ${OTHER}, not the recipient of this swap`, "recipient_mismatch"],
    ["value with a token sale", TOKEN, (b) => { b.transaction.value = "1"; }, "the transaction sends native coin with a token sale", "price_check_failed"],
    ["a native sale without NATIVE_CHECK first", NATIVE, (b) => { b.transaction.data = b.transaction.data.replace("bd01c226", "38c9c147"); }, "the swap's first action 0x38c9c147 is not the native-value check a native-coin sale opens with", "policy_refused"],
  ])("%s", async (_name, name, edit, text, reason) => {
    const {params} = await quote(name, {body: edited(name, edit)});
    expectHeard(params, `zeroex: ${text}`, {reason});
  });
  it("a deadline too close to sign against is quote_expired", async () => {
    const f = loadRecorded(TOKEN);
    const deadline = Number(f.response.permit2.eip712.message.deadline);
    const {params} = await quote(TOKEN, {fetchImpl: (async (u: string, init?: RequestInit) => { vi.setSystemTime((deadline - 10) * 1000); return recordedFetch(f)(u, init); }) as unknown as typeof fetch});
    expectHeard(params, "zeroex: the Permit2 deadline is too close to sign against", {reason: "quote_expired"});
  });
  it("the floor and the slippage are price_check_failed", async () => {
    const f = loadRecorded(TOKEN);
    expectHeard((await quote(TOKEN, {over: {minAmountOut: (BigInt(f.response.minBuyAmount) + 1n).toString()}})).params, `zeroex: floor breach (min=${f.response.minBuyAmount} < floor=${BigInt(f.response.minBuyAmount) + 1n})`, {reason: "price_check_failed"});
    expectHeard((await quote(TOKEN, {over: {slippageBps: 10}})).params, `zeroex: the quoted minimum ${f.response.minBuyAmount} is below the requested slippage (10 bps of ${f.response.buyAmount})`, {reason: "price_check_failed"});
  });
});

describe("checkZeroExTransaction and the resolver throw classified ZeroExTransactionErrors", () => {
  const f = loadRecorded(TOKEN);
  const expectation = {chainId: 8453, chain: chainOf(f), settlers: [f.registry.current], sellToken: f.request.sourceToken, buyToken: f.request.destToken, sellAmount: BigInt(f.request.amountIn), recipient: f.request.destAddress, minBuyAmount: BigInt(f.response.minBuyAmount), nowMs: f.request.nowMs};
  const tx = () => ({to: f.response.transaction.to, data: f.response.transaction.data, value: "0", chainId: 8453, approvalAddress: "0x000000000022D473030F116dDEE9F6B43aC78BA3", permit2Transfer: JSON.stringify(f.response.permit2.eip712)});
  it("keeps its class, name and text next to the reason", async () => {
    const err = await caught(() => checkZeroExTransaction({...tx(), chainId: 1}, expectation));
    expect(err).toBeInstanceOf(ZeroExTransactionError);
    expect((err as Error).name).toBe("ZeroExTransactionError");
    expectThrown(err, "zeroex: the transaction is for chain 1, not 8453", "vault_mismatch");
    expectThrown(await caught(() => checkZeroExTransaction({...tx(), gasLimit: "7000000"}, expectation)), "zeroex: the transaction asks for more gas than any 0x swap needs", "policy_refused");
    expectThrown(await caught(() => checkZeroExTransaction(tx(), {...expectation, settlers: []})), "zeroex: the 0x Settler for chain 8453 is not resolved", "upstream_unavailable");
    expectThrown(await caught(() => checkZeroExTransaction({...tx(), data: "0x1fff991fzz"}, expectation)), "zeroex: the transaction data is not hex bytes", "policy_refused");
    expectThrown(await caught(() => checkZeroExTransaction({...tx(), data: "0x095ea7b3"}, expectation)), "zeroex: the transaction does not call Settler.execute", "policy_refused");
    expectThrown(await caught(() => checkZeroExTransaction({...tx(), permit2Transfer: "{"}, expectation)), "zeroex: Permit2 transfer refused — the typed data is not JSON", "policy_refused");
    expect(new ZeroExTransactionError("x").reason).toBeUndefined();
  });
  it("a request it cannot hold a transaction to is the caller's error: unclassified", async () => {
    expectThrown(await caught(() => checkZeroExTransaction(tx(), {...expectation, recipient: "0x0000000000000000000000000000000000000000"})), "zeroex: the swap names no recipient", undefined);
    expectThrown(await caught(() => checkZeroExTransaction(tx(), {...expectation, sellAmount: 0n})), "zeroex: the swap has no input or no minimum output", undefined);
  });
  it("the resolver: an unknown chain is unsupported_pair", async () => {
    vi.stubGlobal("fetch", recordedFetch(f));
    expectThrown(await caught(createSettlerResolver({chains: chainsOf(f), rpcUrls: {100: ["https://rpc.test"]}}).resolve(100)), "zeroex: chain 100 is not in the 0x chain table", "unsupported_pair");
  });
});

describe("build and preflight", () => {
  it("a transaction that is not the quoted one or names no chain is policy_refused; a Settler that left the registry vault_mismatch", async () => {
    const {provider, quote: q, f} = await quote(TOKEN);
    const tx = await provider.buildDeposit(q!);
    expectThrown(await caught(provider.preflightDeposit!(q!, {...tx, data: `${tx.data}00`})), "zeroex: the transaction is not the quoted swap. Nothing was sent; refresh the quote.", "policy_refused");
    expectThrown(await caught(provider.preflightDeposit!({...q!, intentId: "zeroex:100:x"}, tx)), "zeroex: the quote names no chain this provider serves. Nothing was sent.", "policy_refused");
    vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: OTHER, prev: null}}));
    // a registry that moved on: whatever it names now must itself be a 0x deployment, or the read is refused first
    expectThrown(await caught(provider.preflightDeposit!(q!, tx)), `zeroex: the RPC on chain 8453 names ${OTHER} as the 0x Settler, which is not an address the 0x registry deploys Settlers to`, "vault_mismatch");
    vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: f.registry.prev, prev: null}}));
    expectThrown(await caught(provider.preflightDeposit!(q!, tx)), "zeroex: the quoted 0x Settler is no longer in the on-chain registry. Nothing was sent; refresh the quote.", "vault_mismatch");
    vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: null}}));
    expectThrown(await caught(provider.preflightDeposit!(q!, tx)), "zeroex: the 0x Settler registry on chain 8453 reports no taker Settler in force (paused or removed)", "chain_halted");
    const {quote: dry, provider: p2} = await quote(PRICE);
    expectThrown(await caught(p2.buildDeposit(dry!)), "zeroex: not a live quote — it carries no transaction", "policy_refused");
  });
});

describe("zeroExPins: every text the verifiers return is classified through reasonOf", () => {
  async function live(name = TOKEN) {
    const {quote: q, params, provider, f} = await quote(name);
    return {q: q!, params, provider, f, ctx: {chains: chainsOf(f), settlers: () => [f.registry.current, ...(f.registry.prev ? [f.registry.prev] : [])], nowMs: f.request.nowMs}};
  }
  const pins = zeroExPins();
  const classified = (text: string | null, want: string, reason: Swap2RefusalReason | undefined) => {
    expect(text).toBe(want);
    expect(pins.reasonOf!(text!)?.reason).toBe(reason);
    if (reason) seen.add(reason);
  };
  it("verifyQuote", async () => {
    const {q, params, ctx} = await live();
    classified(zeroExVerifyQuote(params, {...q, provider: "lifi"}, ctx), "the quote is not a 0x quote", "policy_refused");
    classified(zeroExVerifyQuote({...params, destChain: "eip155:1"}, q, ctx), "0x swaps stay on one chain", "unsupported_pair");
    classified(zeroExVerifyQuote(params, {...q, intentId: "zeroex:1:x"}, ctx), "the intent id does not name this chain", "policy_refused");
    classified(zeroExVerifyQuote(params, {...q, sourceAmount: "1"}, ctx), `the quote spends 1, not the ${params.amountIn} input`, "policy_refused");
    classified(zeroExVerifyQuote(params, {...q, destAmount: "x"}, ctx), "the quote's amounts are not integers", "upstream_unavailable");
    classified(zeroExVerifyQuote(params, {...q, minDestAmount: (BigInt(q.destAmount) + 1n).toString()}, ctx), "the quoted minimum is not between zero and the quoted output", "price_check_failed");
    classified(zeroExVerifyQuote({...params, minAmountOut: q.destAmount}, q, ctx), `the quoted minimum ${q.minDestAmount} is below the caller's floor`, "price_check_failed");
    classified(zeroExVerifyQuote(params, withoutTx(q), ctx), "a live quote carries no transaction", "upstream_unavailable");
    classified(zeroExVerifyQuote({...params, dry: true}, q, ctx), "an indicative quote carries a transaction", "policy_refused");
    classified(zeroExVerifyQuote(params, {...q, txRequest: {...q.txRequest!, nativeFee: "1"}}, ctx), "the quote carries more than a Settler call", "policy_refused");
    classified(zeroExVerifyQuote(params, {...q, txRequest: {...q.txRequest!, to: OTHER}}, ctx), `the transaction target ${OTHER} is not a 0x Settler from the on-chain registry`, "vault_mismatch");
    classified(zeroExVerifyQuote({...params, destAddress: OTHER}, q, ctx), `the swap pays ${getAddress(params.destAddress)}, not the recipient of this swap`, "recipient_mismatch");
    classified(zeroExVerifyQuote(params, {...q, validUntilMs: q.validUntilMs + 3_600_000}, ctx), "the quote outlives its Permit2 deadline", "policy_refused");
  });
  it("the app's own malformed request stays unclassified, and so does any other text", async () => {
    const {q, params, ctx} = await live();
    classified(zeroExVerifyQuote({...params, destToken: "ETH"}, q, ctx), "the destination token is not an EVM address", undefined);
    classified(zeroExVerifyQuote({...params, slippageBps: -1}, q, ctx), "invalid slippage", undefined);
    classified(zeroExVerifyQuote({...params, amountIn: "x"}, q, ctx), "the quote's amounts are not integers", undefined);
    expect(pins.reasonOf!("zeroex: something else")).toBeUndefined();
  });
  it("verifyBuild", async () => {
    const {q, params, provider, f, ctx} = await live();
    const tx = await provider.buildDeposit(q);
    const resolver = createSettlerResolver({chains: chainsOf(f), rpcUrls: rpcOf(f)});
    classified(await zeroExVerifyBuild(q, tx, undefined, {...ctx, resolver}), "the request this quote answered is not known to the app", "policy_refused");
    classified(await zeroExVerifyBuild(q, {...tx, gasLimit: "1"}, params, {...ctx, resolver}), "the built transaction is not the quoted swap", "policy_refused");
    classified(await zeroExVerifyBuild(withoutTx(q), tx, params, {...ctx, resolver}), "the quote carries no transaction", "policy_refused");
    vi.stubGlobal("fetch", recordedFetch(f, {registry: {current: null}}));
    classified(await zeroExVerifyBuild(q, tx, params, {...ctx, resolver}), "the 0x Settler registry on chain 8453 reports no taker Settler in force (paused or removed)", "chain_halted");
  });
  it("a remote stub's refusal carries the pins' reason", async () => {
    const {q, params, f} = await live();
    const lying = {...q, txRequest: {...q.txRequest!, to: OTHER}};
    const backend = (async () => new Response(JSON.stringify(lying))) as unknown as typeof fetch;
    const resolver = createSettlerResolver({chains: chainsOf(f), rpcUrls: rpcOf(f)});
    await resolver.resolve(8453);
    const local = zeroExPins({settlerResolver: resolver, chains: chainsConfigOf(f)});
    const stub = remoteProvider({name: "zeroex", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend, ...local});
    expectThrown(await caught(stub.getQuote(params)), `zeroex: the quote fails this app's own check — the transaction target ${OTHER} is not a 0x Settler from the on-chain registry`, "vault_mismatch");
  });
});

describe("through the engine", () => {
  it("a throttled 0x makes the engine's no-route error rate_limited, its text unchanged", async () => {
    const f = loadRecorded(PRICE);
    vi.setSystemTime(f.request.nowMs);
    vi.stubGlobal("fetch", recordedFetch(f, {status: 429, body: "slow down", headers: {"retry-after": "5"}}));
    const protocol = new ZeroExSwap2Protocol(undefined, {fromChain: "eip155:8453", apiKey: getKey, chains: chainsConfigOf(f)});
    const err = await caught(protocol.quoteSwap2({fromToken: "USDC", toToken: f.request.destToken, toChain: 8453, recipient: f.request.destAddress, fromTokenAmount: BigInt(f.request.amountIn)}));
    expect(err).toBeInstanceOf(Swap2QuoteError);
    expect((err as Error).message).toBe("swap2: no route available for the requested pair :: zeroex: rate limited (HTTP 429)");
    expect(refusalOf(err)).toEqual({reason: "rate_limited", retryAfterMs: 5000});
    expect((err as Swap2QuoteError).refusals).toEqual([{provider: "zeroex", message: "zeroex: rate limited (HTTP 429)", reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000}]);
  });
});

describe("coverage", () => {
  it("every reason seen is one of the union, and these are the ones 0x emits", () => {
    for (const r of seen) expect(SWAP2_REFUSAL_REASONS).toContain(r);
    expect([...seen].sort()).toEqual([
      "chain_halted", "insufficient_liquidity", "key_rejected", "no_route", "policy_refused", "price_check_failed", "quote_expired",
      "rate_limited", "recipient_mismatch", "unsupported_pair", "upstream_unavailable", "vault_mismatch",
    ]);
  });
});
