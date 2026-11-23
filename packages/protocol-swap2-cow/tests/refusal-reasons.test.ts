// The orderbook's HTTP refusals carry core's reasons like every other provider's (CS-13): a 429 is `rate_limited` with
// its Retry-After (quotes are limited to 1 a second and ~500 an hour per IP, docs.cow.fi rate limits, 2026-11-23),
// 5xx and an unreachable orderbook are `upstream_unavailable`; the router reads them with refusalOf into `lastRefusals`.
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
  it("429 → rate_limited with the Retry-After; 503 and an unreachable orderbook → upstream_unavailable; 400 unclassified", async () => {
    vi.stubGlobal("fetch", answer(429, {"retry-after": "7"}));
    const limited = await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e);
    expect(refusalOf(limited)).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000});
    expect(String(limited)).toMatch(/cow: rate limited \(HTTP 429\)/);
    vi.stubGlobal("fetch", answer(503, {}, "down"));
    expect(refusalOf(await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e))).toMatchObject({reason: "upstream_unavailable", httpStatus: 503});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network"); }));
    expect(refusalOf(await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e))).toMatchObject({reason: "upstream_unavailable"});
    vi.stubGlobal("fetch", answer(400, {}, {errorType: "SellAmountDoesNotCoverFee", description: "too small"}));
    expect(refusalOf(await cowApi().quote("mainnet", QUOTE).catch((e: unknown) => e))).toBeUndefined();
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
