// The orderbook's HTTP refusals carry core's reasons like every other provider's (CS-13): a 429 is `rate_limited` with
// its Retry-After (quotes are limited to 1 a second and ~500 an hour per IP, docs.cow.fi rate limits, 2026-11-23),
// 5xx and an unreachable orderbook are `upstream_unavailable`; the router reads them with refusalOf into `lastRefusals`.
// Since 2026-11-25 the orderbook's own error types (NoLiquidity, UnsupportedToken, …) and every pre-check carry one too.
import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {cowApi} from "../src/api.js";
import {cowProvider} from "../src/provider.js";
import {ME, WETH} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());
const answer = (status: number, headers: Record<string, string> = {}, body: unknown = {errorType: "TooManyRequests", description: "slow down"}) =>
  vi.fn(async () => new Response(JSON.stringify(body), {status, headers: {"content-type": "application/json", ...headers}}));
const QUOTE = {sellToken: WETH, buyToken: WETH, from: ME, kind: "sell", sellAmountBeforeFee: "1"};

describe("orderbook refusals carry core's reasons", () => {
  it("429 → rate_limited with the Retry-After; 503 and an unreachable orderbook → upstream_unavailable", async () => {
    vi.stubGlobal("fetch", answer(429, {"retry-after": "7"}));
    const limited = await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e);
    expect(refusalOf(limited)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000});
    expect(String(limited)).toMatch(/cow: rate limited \(HTTP 429\)/);
    vi.stubGlobal("fetch", answer(503, {}, "down"));
    expect(refusalOf(await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e))).toMatchObject({reason: "upstream_unavailable", httpStatus: 503});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(refusalOf(await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e))).toMatchObject({reason: "upstream_unavailable"});
  });

  it("the orderbook's error types carry their reason; an unknown type on a 400 stays unclassified", async () => {
    const reasonFor = async (status: number, errorType: string) => {
      vi.stubGlobal("fetch", answer(status, {}, {errorType, description: "x"}));
      return refusalOf(await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e));
    };
    expect(await reasonFor(400, "SellAmountDoesNotCoverFee")).toEqual({reason: "amount_too_small", httpStatus: 400});
    expect(await reasonFor(404, "NoLiquidity")).toEqual({reason: "no_route", httpStatus: 404});
    expect(await reasonFor(400, "UnsupportedToken")).toMatchObject({reason: "unsupported_pair"});
    expect(await reasonFor(400, "InsufficientLiquidity")).toMatchObject({reason: "insufficient_liquidity"});
    expect(await reasonFor(400, "QuoteNotVerified")).toMatchObject({reason: "simulation_failed"});
    // CoW's 403 "Forbidden" is about the wallet, not an API key.
    expect(await reasonFor(403, "Forbidden")).toEqual({reason: "policy_refused", httpStatus: 403});
    // A status that classifies on its own still wins for 429 and 5xx, whatever the type says.
    expect(await reasonFor(500, "NoLiquidity")).toMatchObject({reason: "upstream_unavailable"});
    expect(await reasonFor(400, "SomethingNew")).toBeUndefined();
    expect(await reasonFor(400, "constructor")).toBeUndefined();
  });

  it("every pre-check refusal names its reason (the router can tell unsupported from no liquidity)", async () => {
    vi.stubGlobal("fetch", answer(404, {}, {errorType: "NoLiquidity", description: "none"}));
    const p = cowProvider({enabled: true});
    const seen = async (over: Record<string, unknown>) => {
      const out: unknown[] = [];
      await p.getQuote({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: WETH, amountIn: "25000000", destAddress: ME, dry: true, ...over,
        onRefusal: (_r: string, info: unknown) => out.push(info)} as never);
      return out;
    };
    expect(await seen({destChain: "eip155:8453"})).toEqual([{reason: "unsupported_pair"}]);
    expect(await seen({sourceToken: "NOPE"})).toEqual([{reason: "unsupported_pair"}]);
    expect(await seen({destToken: "USDC"})).toEqual([{reason: "unsupported_pair"}]);
    expect(await seen({amountIn: "0"})).toEqual([{reason: "policy_refused"}]);
    expect(await seen({slippageBps: 10_000})).toEqual([{reason: "price_check_failed"}]);
    expect(await seen({sourceToken: "ETH", destToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"})).toEqual([{reason: "unsupported_pair"}]);
    expect(await seen({})).toEqual([{reason: "no_route", httpStatus: 404}]);
  });

  it("a throttled CoW quote is refused with the reason and the wait (onRefusal's info, what the router keeps)", async () => {
    vi.stubGlobal("fetch", answer(429, {"retry-after": "3"}));
    const seen: [string, unknown][] = [];
    const q = await cowProvider({enabled: true}).getQuote({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: WETH, amountIn: "25000000", destAddress: ME, dry: true,
      onRefusal: (reason, info) => seen.push([reason, info])});
    expect(q).toBeNull();
    expect(seen).toEqual([[expect.stringMatching(/^cow: rate limited/), {reason: "rate_limited", httpStatus: 429, retryAfterMs: 3000}]]);
  });
});
