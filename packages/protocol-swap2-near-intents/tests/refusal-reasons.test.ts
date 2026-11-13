// CS-13 refusal reasons: every refusal the NEAR Intents (1Click) provider produces keeps its text byte for byte and
// carries a stable `reason` (Swap2RefusalReason) next to it — on `onRefusal`'s second argument and on thrown errors
// (`refusalOf`). Driven through the provider's real code paths with a mocked fetch.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {refusalOf, Swap2QuoteError, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {nearIntentsProvider, type NearIntentsProviderConfig} from "../src/provider.js";
import {nearIntentsChainRefusal} from "../src/config.js";
import {NearIntentsSwap2Protocol} from "../src/protocol.js";

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const EVM_DEST = "0x4444444444444444444444444444444444444444";
const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const DRY: QuoteParams = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:56", destToken: BSC_USDT, amountIn: "100000000", destAddress: EVM_DEST, dry: true, slippageBps: 100};
const LIVE: QuoteParams = {...DRY, dry: false, refundAddress: EVM_DEST};
const SUFFIX = "[dry=true eip155:8453->eip155:56 amount=100000000]";
const LIVE_SUFFIX = "[dry=false eip155:8453->eip155:56 amount=100000000]";

type Call = [text: string, info: Swap2RefusalInfo | undefined, arity: number];
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...headers}});

/** One getQuote against `answer` (a fetch stub): every refusal `onRefusal` heard, and the wire calls made. */
async function quote(answer: (init?: RequestInit) => Response | Promise<Response>, params: QuoteParams = DRY, config: NearIntentsProviderConfig = {}, signal?: AbortSignal) {
  const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => answer(init));
  vi.stubGlobal("fetch", fetchSpy);
  const calls: Call[] = [];
  const q = await nearIntentsProvider({apiUrl: "https://near.invalid", ...config}).getQuote({...params, onRefusal: (...args: unknown[]) => { calls.push([args[0] as string, args[1] as Swap2RefusalInfo | undefined, args.length]); }}, signal);
  expect(q).toBeNull();
  return {calls, fetchSpy};
}
async function expectRefusal(run: Promise<{calls: Call[]}>, text: string, info: Swap2RefusalInfo | undefined) {
  const {calls} = await run;
  expect(calls).toHaveLength(1);
  expect(calls[0]![0]).toBe(text);
  expect(calls[0]![1]).toEqual(info);
  if (info === undefined) expect(calls[0]![2]).toBe(1); // an unclassified refusal is heard exactly as before: one argument
}
const quoteBody = (over: Record<string, unknown> = {}) => ({quote: {depositAddress: "0xdeposit", amountIn: "100000000", amountOut: "99000000", minAmountOut: "98000000", deadline: new Date(Date.now() + 60_000).toISOString(), ...over}});
const never = () => { throw new Error("no wire call expected"); };

describe("up-front refusals (no wire call)", () => {
  it("a chain 1Click does not serve or list → unsupported_pair; one the app paused → policy_refused (the app's own switch)", async () => {
    await expectRefusal(quote(never, {...DRY, sourceChain: "cosmos:cosmoshub-4"}), "1Click does not serve cosmos:cosmoshub-4 [dry=true cosmos:cosmoshub-4->eip155:56 amount=100000000]", {reason: "unsupported_pair"});
    await expectRefusal(quote(never, {...DRY, destChain: "eip155:480"}), "1Click does not list eip155:480 [dry=true eip155:8453->eip155:480 amount=100000000]", {reason: "unsupported_pair"});
    await expectRefusal(quote(never, {...DRY, sourceChain: "ton:-239", sourceToken: "USDT"}, {suspendedChains: {"ton:-239": "HOT omni-bridge corridors not quoting"}}),
      "1Click corridor paused by the app: ton:-239 — HOT omni-bridge corridors not quoting [dry=true ton:-239->eip155:56 amount=100000000]", {reason: "policy_refused"});
  });

  it("the exported nearIntentsChainRefusal keeps returning the bare text", () => {
    expect(nearIntentsChainRefusal("cosmos:cosmoshub-4")).toBe("1Click does not serve cosmos:cosmoshub-4");
    expect(nearIntentsChainRefusal("eip155:8453")).toBeNull();
  });

  it("a token 1Click does not list → unsupported_pair", async () => {
    await expectRefusal(quote(never, {...DRY, sourceToken: "NOPE"}), `1Click does not list eip155:8453 NOPE ${SUFFIX}`, {reason: "unsupported_pair"});
    await expectRefusal(quote(never, {...DRY, destToken: "0x1111111111111111111111111111111111111111"}), `1Click does not list eip155:56 0x1111111111111111111111111111111111111111 ${SUFFIX}`, {reason: "unsupported_pair"});
  });

  it("INTENTS delivery: a destination off NEAR → unsupported_pair; a recipient no key controls → recipient_mismatch", async () => {
    await expectRefusal(quote(never, DRY, {recipientType: "INTENTS"}), `INTENTS credits intents.near: destChain must be a NEAR chain, not eip155:56 ${SUFFIX}`, {reason: "unsupported_pair"});
    await expectRefusal(quote(never, {...DRY, sourceChain: "eip155:1", sourceToken: "USDT", destChain: "near:mainnet", destToken: NEAR_USDC, destAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"}, {recipientType: "INTENTS"}),
      "INTENTS recipient must be a NEAR Intents account id [dry=true eip155:1->near:mainnet amount=100000000]", {reason: "recipient_mismatch"});
  });

  it("a live quote without a refund address is the caller's own error: unclassified, heard as before", async () => {
    await expectRefusal(quote(never, {...LIVE, refundAddress: ""}), `live quote without a refund address ${LIVE_SUFFIX}`, undefined);
  });
});

describe("1Click's error answers (real fetch path)", () => {
  it("a known amount floor → amount_too_small, with the presentable text", async () => {
    await expectRefusal(quote(() => json({message: "Temporary swap limits: minimum swap amount is $1,000"}, 400)), "near_intents: below the 1Click minimum ($1,000)", {reason: "amount_too_small"});
    await expectRefusal(quote(() => json({message: "Amount is too low for bridge, try at least 150000"}, 400)), "near_intents: below the 1Click minimum (at least 0.15 USDC)", {reason: "amount_too_small"});
    // A floor wording 1Click wrote without digits is still a floor; the raw text stays.
    await expectRefusal(quote(() => json({message: "minimum swap amount is $,."}, 400)), `1Click 400: minimum swap amount is $,. ${SUFFIX}`, {reason: "amount_too_small"});
  });

  it("other 400 messages name their reason; anything else is 1Click declining the request (no_route)", async () => {
    await expectRefusal(quote(() => json({message: "Amount is too high for bridge"}, 400)), `1Click 400: Amount is too high for bridge ${SUFFIX}`, {reason: "amount_too_large"});
    await expectRefusal(quote(() => json({message: "Invalid recipient address"}, 400)), `1Click 400: Invalid recipient address ${SUFFIX}`, {reason: "recipient_mismatch"});
    await expectRefusal(quote(() => json({message: "Asset nep141:foo.near is not supported"}, 400)), `1Click 400: Asset nep141:foo.near is not supported ${SUFFIX}`, {reason: "unsupported_pair"});
    await expectRefusal(quote(() => json({message: "Failed to get quote"}, 400)), `1Click 400: Failed to get quote ${SUFFIX}`, {reason: "no_route"});
    await expectRefusal(quote(() => json({message: "Something unexpected"}, 404)), `1Click 404: Something unexpected ${SUFFIX}`, {reason: "no_route"});
  });

  it("a rate limit or a halt named by a 400's message → rate_limited (with the wait) / chain_halted", async () => {
    await expectRefusal(quote(() => json({message: "rate limit exceeded"}, 400, {"retry-after": "4"})), `1Click 400: rate limit exceeded ${SUFFIX}`, {reason: "rate_limited", httpStatus: 400, retryAfterMs: 4000});
    await expectRefusal(quote(() => json({message: "rate limit exceeded"}, 400)), `1Click 400: rate limit exceeded ${SUFFIX}`, {reason: "rate_limited", httpStatus: 400});
    await expectRefusal(quote(() => json({message: "Corridor paused for maintenance"}, 400)), `1Click 400: Corridor paused for maintenance ${SUFFIX}`, {reason: "chain_halted"});
  });

  it("429 with Retry-After → rate_limited, with the wait and the status, on one wire call", async () => {
    const run = quote(() => json({message: "Too many requests"}, 429, {"retry-after": "12"}));
    await expectRefusal(run, `1Click 429: Too many requests ${SUFFIX}`, {reason: "rate_limited", httpStatus: 429, retryAfterMs: 12_000});
    expect((await run).fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("401 and 403 → key_rejected (the status wins over a floor wording outside a 400)", async () => {
    await expectRefusal(quote(() => json({message: "Unauthorized"}, 401)), `1Click 401: Unauthorized ${SUFFIX}`, {reason: "key_rejected", httpStatus: 401});
    await expectRefusal(quote(() => json({message: "minimum swap amount is $1,000"}, 403)), `1Click 403: minimum swap amount is $1,000 ${SUFFIX}`, {reason: "key_rejected", httpStatus: 403});
  });

  it("'No liquidity available' after the retries → insufficient_liquidity", async () => {
    const run = quote(() => json({message: "No liquidity available"}, 400));
    await expectRefusal(run, `1Click 400: No liquidity available ${SUFFIX}`, {reason: "insufficient_liquidity"});
    expect((await run).fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("5xx after the retries → upstream_unavailable with the status", async () => {
    const run = quote(() => new Response("upstream down", {status: 503}));
    await expectRefusal(run, `1Click 503:  ${SUFFIX}`, {reason: "upstream_unavailable", httpStatus: 503});
    expect((await run).fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("a 5xx whose message reads like a pair or route verdict stays upstream_unavailable with its status", async () => {
    const down = quote(() => json({message: "Service not available"}, 503));
    await expectRefusal(down, `1Click 503: Service not available ${SUFFIX}`, {reason: "upstream_unavailable", httpStatus: 503});
    expect((await down).fetchSpy).toHaveBeenCalledTimes(3);
    await expectRefusal(quote(() => json({message: "Failed to get quote"}, 500)), `1Click 500: Failed to get quote ${SUFFIX}`, {reason: "upstream_unavailable", httpStatus: 500});
    await expectRefusal(quote(() => json({message: "Amount is too low for bridge"}, 502)), `1Click 502: Amount is too low for bridge ${SUFFIX}`, {reason: "upstream_unavailable", httpStatus: 502});
  });

  it("a 5xx whose message names a passing condition keeps it: liquidity, a rate limit (with the wait), a halt", async () => {
    await expectRefusal(quote(() => json({message: "No liquidity available"}, 503)), `1Click 503: No liquidity available ${SUFFIX}`, {reason: "insufficient_liquidity"});
    await expectRefusal(quote(() => json({message: "Rate limit exceeded"}, 503, {"retry-after": "9"})), `1Click 503: Rate limit exceeded ${SUFFIX}`, {reason: "rate_limited", httpStatus: 503, retryAfterMs: 9000});
    await expectRefusal(quote(() => json({message: "Solana withdrawals halted"}, 500)), `1Click 500: Solana withdrawals halted ${SUFFIX}`, {reason: "chain_halted"});
  });

  it("the network failing every time → upstream_unavailable", async () => {
    const run = quote(() => { throw new TypeError("fetch failed"); });
    await expectRefusal(run, `threw: fetch failed ${SUFFIX}`, {reason: "upstream_unavailable"});
    expect((await run).fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("the caller's own abort is not upstream_unavailable: unclassified, heard as before", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const run = quote((init) => { if (init?.signal?.aborted) throw new DOMException("The user aborted a request.", "AbortError"); return json(quoteBody()); }, DRY, {}, ctrl.signal);
    await expectRefusal(run, `threw: The user aborted a request. ${SUFFIX}`, undefined);
    expect((await run).fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("the engine's no route carries the reason (NearIntentsSwap2Protocol.quoteSwap2)", async () => {
    vi.stubGlobal("fetch", async () => json({message: "Temporary swap limits: minimum swap amount is $1,000"}, 400));
    const account = {getAddress: async () => EVM_DEST, getChainId: async () => 8453};
    const e = await new NearIntentsSwap2Protocol(account as never, {fromChain: "eip155:8453", apiUrl: "https://near.invalid"})
      .quoteSwap2({fromToken: "USDC", toToken: BSC_USDT, toChain: 56, recipient: EVM_DEST, fromTokenAmount: 100_000_000n})
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Swap2QuoteError);
    expect((e as Error).message).toBe("swap2: no route available for the requested pair :: near_intents: below the 1Click minimum ($1,000)");
    expect(refusalOf(e)).toEqual({reason: "amount_too_small"});
  });

  it("the app's backend forwards a rate limit with its wait in {noQuote}", async () => {
    vi.stubGlobal("fetch", async () => json({message: "Too many requests"}, 429, {"retry-after": "5"}));
    const handle = createSwap2Handler<string>({providers: [nearIntentsProvider({apiUrl: "https://near.invalid"})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const res = await handle("quote", {provider: "near_intents", params: LIVE}, "alice");
    expect(res.body).toEqual({noQuote: `1Click 429: Too many requests ${LIVE_SUFFIX}`, reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000});
  });
});

describe("1Click's quote, held to the request", () => {
  it("a live quote without a deposit address, or without a minimum → upstream_unavailable", async () => {
    await expectRefusal(quote(() => json(quoteBody({depositAddress: undefined})), LIVE), `live quote came back without a deposit address ${LIVE_SUFFIX}`, {reason: "upstream_unavailable"});
    await expectRefusal(quote(() => json(quoteBody({minAmountOut: undefined}))), `quote has no minAmountOut ${SUFFIX}`, {reason: "upstream_unavailable"});
  });

  it("a deadline already past → quote_expired; one that does not parse → upstream_unavailable", async () => {
    await expectRefusal(quote(() => json(quoteBody({deadline: "2020-01-01T00:00:00Z"})), LIVE), `unusable deadline 2020-01-01T00:00:00Z ${LIVE_SUFFIX}`, {reason: "quote_expired"});
    await expectRefusal(quote(() => json(quoteBody({deadline: "soon"})), LIVE), `unusable deadline soon ${LIVE_SUFFIX}`, {reason: "upstream_unavailable"});
  });

  it("another input → policy_refused; a minimum under the caller's floor → price_check_failed", async () => {
    await expectRefusal(quote(() => json(quoteBody({amountIn: "99999999"}))), `amountIn mismatch (99999999 vs 100000000) ${SUFFIX}`, {reason: "policy_refused"});
    await expectRefusal(quote(() => json(quoteBody()), {...DRY, minAmountOut: "98000001"}), `floor breach (min=98000000 < floor=98000001) ${SUFFIX}`, {reason: "price_check_failed"});
  });
});

describe("notifyDeposit, trackIntent and configuration", () => {
  const notify = async (answer: () => Response | Promise<Response>) => {
    vi.stubGlobal("fetch", async () => answer());
    return nearIntentsProvider({apiUrl: "https://near.invalid"}).notifyDeposit!("near1click:0xdeposit|", "0xhash").then(() => null, (e: unknown) => e);
  };

  it("an HTTP refusal is classified by its status; any other status stays unclassified", async () => {
    const limited = await notify(() => new Response("", {status: 429, headers: {"retry-after": "2"}}));
    expect((limited as Error).message).toBe("near-intents: deposit notification failed (429)");
    expect(refusalOf(limited)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 2000});
    const down = await notify(() => new Response("", {status: 502}));
    expect((down as Error).message).toBe("near-intents: deposit notification failed (502)");
    expect(refusalOf(down)).toEqual({reason: "upstream_unavailable", httpStatus: 502});
    const other = await notify(() => new Response("", {status: 404}));
    expect((other as Error).message).toBe("near-intents: deposit notification failed (404)");
    expect(refusalOf(other)).toBeUndefined();
  });

  it("the network failing → upstream_unavailable on the same error (class and text kept)", async () => {
    const failure = new TypeError("fetch failed");
    const err = await notify(() => { throw failure; });
    expect(err).toBe(failure);
    expect((err as Error).message).toBe("fetch failed");
    expect(refusalOf(err)).toEqual({reason: "upstream_unavailable"});
  });

  it("a malformed intent id and configuration errors are the developer's own: unclassified", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const malformed = await nearIntentsProvider().trackIntent({intentId: "near1click:%ZZ|"}).catch((e: unknown) => e);
    expect((malformed as Error).message).toBe("near-intents: malformed intent id");
    expect(refusalOf(malformed)).toBeUndefined();
    const config = (() => { try { nearIntentsProvider({feeRecipient: "fees.near"}); } catch (e) { return e; } })();
    expect((config as Error).message).toBe("near-intents: feeRecipient and feeBps must be configured together");
    expect(refusalOf(config)).toBeUndefined();
  });
});
