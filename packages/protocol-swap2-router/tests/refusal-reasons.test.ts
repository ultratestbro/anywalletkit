// CS-13: each venue's refusal in the auction, classified where the venue could. The texts in
// lastRejections are unchanged; lastRefusals and RouteSet.refusals carry the same ones with a reason.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {CrossChainProvider, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {Swap2QuoteError, refusal, refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {CrossChainRouter} from "../src/router.js";
import {RouterSwap2Protocol} from "../src/swap2/router.js";

const provider = (name: string, overrides: Partial<CrossChainProvider> = {}): CrossChainProvider => ({
  name,
  enabled: () => true,
  supportsRoute: () => true,
  getQuote: async (params) => ({
    provider: name, intentId: `${name}-intent`, depositAddress: "0xdeposit", depositMemo: null,
    sourceAmount: params.amountIn, destAmount: "100", minDestAmount: "100",
    feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
  }),
  buildDeposit: async () => ({chain: "", to: "0xdeposit", value: "0"}),
  trackIntent: async () => ({state: "pending"}),
  ...overrides,
});
const PARAMS: QuoteParams = {sourceChain: "eip155:1", sourceToken: "ETH", destChain: "eip155:10", destToken: "0x0", amountIn: "1", destAddress: "0x1"};
const byProvider = <T extends {provider?: string}>(list: readonly T[]) => [...list].sort((a, b) => String(a.provider).localeCompare(String(b.provider)));

afterEach(() => { vi.useRealTimers(); });

describe("lastRefusals", () => {
  it("classifies each venue next to the unchanged lastRejections", async () => {
    const outer: [string, unknown][] = [];
    const router = new CrossChainRouter([
      provider("a", {getQuote: async (p) => { p.onRefusal?.("below the 5 USD minimum", {reason: "amount_too_small"}); return null; }}),
      provider("b", {getQuote: async () => { throw refusal("rate_limited", "b: 429", {retryAfterMs: 2000, httpStatus: 429}); }}),
      provider("c", {getQuote: async () => null}),
      provider("d", {getQuote: async (p) => ({...(await provider("d").getQuote(p))!, minDestAmount: "1"})}),
      provider("e", {getQuote: async () => { throw new Error("odd"); }}),
      provider("f", {getQuote: async (p) => { p.onRefusal?.("f: plain text"); return null; }}),
    ]);
    await expect(router.getBestQuote({...PARAMS, minAmountOut: "50", onRefusal: (r, info) => outer.push([r, info])})).resolves.toBeNull();
    const texts = [...router.lastRejections].sort();
    expect(texts).toHaveLength(6);
    expect(texts.filter((t) => !t.startsWith("d: "))).toEqual(["a: below the 5 USD minimum", "b: b: 429", "c: returned no quote", "e: odd", "f: plain text"]);
    expect(texts.find((t) => t.startsWith("d: "))).toMatch(/^d: rejected by validation \(minDest=1 vs floor=50, /);
    expect(byProvider(router.lastRefusals)).toEqual([
      {provider: "a", message: "a: below the 5 USD minimum", reason: "amount_too_small"},
      {provider: "b", message: "b: b: 429", reason: "rate_limited", retryAfterMs: 2000, httpStatus: 429},
      {provider: "c", message: "c: returned no quote", reason: "no_route"},
      {provider: "d", message: expect.stringMatching(/^d: rejected by validation/), reason: "price_check_failed"},
      {provider: "e", message: "e: odd"},
      {provider: "f", message: "f: plain text"},
    ]);
    // the caller's own onRefusal hears the classification too
    expect(outer).toContainEqual(["below the 5 USD minimum", {reason: "amount_too_small"}]);
    expect(outer).toContainEqual(["f: plain text", undefined]);
  });

  it("a venue slower than the auction is upstream_unavailable", async () => {
    vi.useFakeTimers();
    const router = new CrossChainRouter([provider("slow", {getQuote: () => new Promise(() => {})}), provider("other", {getQuote: async () => null})]);
    const pending = router.getBestQuote(PARAMS);
    await vi.advanceTimersByTimeAsync(8_001);
    await expect(pending).resolves.toBeNull();
    expect(byProvider(router.lastRefusals)).toEqual([
      {provider: "other", message: "other: returned no quote", reason: "no_route"},
      {provider: "slow", message: "slow: quote timed out after 8000ms", reason: "upstream_unavailable"},
    ]);
  });

  it("a remote route to an address the app did not pin is policy_refused", async () => {
    const remote = provider("r", {
      remote: true, callTargets: () => [], spenders: () => [], verifiesQuotes: true,
      getQuote: async (p) => ({...(await provider("r").getQuote(p))!, depositAddress: "", txRequest: {to: "0x00000000000000000000000000000000000000aa", data: "0x01", value: "0", chainId: 1}}),
    });
    const router = new CrossChainRouter([remote]);
    await expect(router.getBestQuote(PARAMS)).resolves.toBeNull();
    expect(router.lastRefusals).toEqual([{provider: "r", message: expect.stringContaining("which the app did not pin as a call target"), reason: "policy_refused"}]);
  });

  it("no venue serving the route is one unsupported_pair; lastRejections stays empty", async () => {
    const router = new CrossChainRouter([provider("a", {supportsRoute: () => false}), provider("b", {supportsRoute: () => false, enabled: () => false})]);
    await expect(router.getBestQuote(PARAMS)).resolves.toBeNull();
    expect(router.lastRejections).toEqual([]);
    expect(router.lastRefusals).toEqual([{message: "swap2-router: no enabled provider serves this route", reason: "unsupported_pair"}]);
  });

  it("when only disabled venues serve the route, each is policy_refused, as on the single-provider path", async () => {
    const router = new CrossChainRouter([provider("a", {supportsRoute: () => false}), provider("dark", {enabled: () => false}), provider("broken", {enabled: () => { throw new Error("x"); }})]);
    await expect(router.getBestQuote(PARAMS)).resolves.toBeNull();
    expect(router.lastRejections).toEqual([]);
    expect(router.lastRefusals).toEqual([{reason: "policy_refused", message: "dark: disabled", provider: "dark"}]);
  });

  it("is reset per call, and a route set carries the refusals of the venues that sat out", async () => {
    const router = new CrossChainRouter([provider("ok"), provider("no", {getQuote: async (p) => { p.onRefusal?.("halted", {reason: "chain_halted"}); return null; }})]);
    const set = await router.getQuotes(PARAMS);
    expect(set?.quotes.map((q) => q.provider)).toEqual(["ok"]);
    expect(set?.rejections).toEqual(["no: halted"]);
    expect(set?.refusals).toEqual([{provider: "no", message: "no: halted", reason: "chain_halted"}]);
    expect(router.lastRefusals).toEqual(set?.refusals);
    const clean = new CrossChainRouter([provider("ok")]);
    await clean.getQuotes(PARAMS);
    expect(clean.lastRefusals).toEqual([]);
  });
});

describe("RouterSwap2Protocol's no route", () => {
  const options = {fromToken: "USDT", toToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", toChain: "eip155:42161", fromTokenAmount: 100n, recipient: "0x3333333333333333333333333333333333333333"};
  const quoteError = async (providers: CrossChainProvider[]): Promise<Swap2QuoteError> => {
    const e = await new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers}).quoteSwap2(options).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Swap2QuoteError);
    return e as Swap2QuoteError;
  };

  it("one shared reason is the error's reason; the message reads as before", async () => {
    const small = (name: string) => provider(name, {getQuote: async (p) => { p.onRefusal?.(`${name}: below its minimum`, {reason: "amount_too_small"}); return null; }});
    const e = await quoteError([small("a"), small("b")]);
    expect(e.message).toMatch(/^swap2: no route available for the requested pair :: (a: below its minimum; b: below its minimum|b: below its minimum; a: below its minimum)$/);
    expect(e.reason).toBe("amount_too_small");
    expect(byProvider(e.refusals!)).toEqual([
      {provider: "a", message: "a: below its minimum", reason: "amount_too_small"},
      {provider: "b", message: "b: below its minimum", reason: "amount_too_small"},
    ]);
  });

  it("different reasons add up to no_route; every venue rate-limited waits for the soonest", async () => {
    const mixed = await quoteError([
      provider("a", {getQuote: async (p) => { p.onRefusal?.("halted", {reason: "chain_halted"}); return null; }}),
      provider("b", {getQuote: async () => null}),
    ]);
    expect(mixed.reason).toBe("no_route");
    const limited = await quoteError([
      provider("a", {getQuote: async () => { throw refusal("rate_limited", "429", {retryAfterMs: 5000}); }}),
      provider("b", {getQuote: async () => { throw refusal("rate_limited", "429", {retryAfterMs: 1000}); }}),
    ]);
    expect(refusalOf(limited)).toEqual({reason: "rate_limited", retryAfterMs: 1000});
  });

  it("a pair no enabled venue serves is unsupported_pair, with the bare message", async () => {
    const e = await quoteError([provider("a", {supportsRoute: () => false})]);
    expect(e.message).toBe("swap2: no route available for the requested pair");
    expect(e.reason).toBe("unsupported_pair");
  });
});

describe("review round", () => {
  const options = {fromToken: "USDT", toToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", toChain: "eip155:42161", fromTokenAmount: 100n, recipient: "0x3333333333333333333333333333333333333333"};

  it("overlapping quotes on one router protocol each get their own reason, refusals and text", async () => {
    const venue = provider("v", {
      getQuote: async (params) => {
        const big = params.amountIn === "5000";
        await new Promise((r) => setTimeout(r, big ? 10 : 60));
        params.onRefusal?.(big ? "halted" : "below its minimum", {reason: big ? "chain_halted" : "amount_too_small"});
        return null;
      },
    });
    const swaps = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [venue]});
    const [small, big] = await Promise.all([
      swaps.quoteSwap2(options).catch((e: Swap2QuoteError) => e),
      new Promise((r) => setTimeout(r, 5)).then(() => swaps.quoteSwap2({...options, fromTokenAmount: 5000n}).catch((e: Swap2QuoteError) => e)),
    ]);
    expect((small as Swap2QuoteError).message).toBe("swap2: no route available for the requested pair :: v: below its minimum");
    expect((small as Swap2QuoteError).reason).toBe("amount_too_small");
    expect((small as Swap2QuoteError).refusals).toEqual([{reason: "amount_too_small", message: "v: below its minimum", provider: "v"}]);
    expect((big as Swap2QuoteError).message).toBe("swap2: no route available for the requested pair :: v: halted");
    expect((big as Swap2QuoteError).reason).toBe("chain_halted");
  });

  it("refusalsFor / rejectionsFor answer per params object", async () => {
    const router = new CrossChainRouter([provider("a", {getQuote: async (p) => { p.onRefusal?.("no", {reason: "no_route"}); return null; }})]);
    const one = {...PARAMS};
    const two = {...PARAMS, amountIn: "2"};
    await router.getBestQuote(one);
    await router.getBestQuote(two);
    expect(router.refusalsFor(one)).toEqual([{reason: "no_route", message: "a: no", provider: "a"}]);
    expect(router.rejectionsFor(two)).toEqual(["a: no"]);
    expect(router.refusalsFor({...PARAMS})).toBeUndefined();
  });

  it("an adapter cannot file its refusal under another venue or smuggle values outside the reasons", async () => {
    const heard: unknown[] = [];
    const router = new CrossChainRouter([
      provider("evil", {getQuote: async (p) => { p.onRefusal?.("evil: nope", {reason: "totally_bogus", provider: "lifi", message: "lifi: spoofed", retryAfterMs: -5, httpStatus: "x"} as never); return null; }}),
      provider("str", {getQuote: async (p) => { p.onRefusal?.("str: nope", "no_route" as never); return null; }}),
      provider("ok", {getQuote: async (p) => { p.onRefusal?.("ok: busy", {reason: "rate_limited", provider: "evil", retryAfterMs: 2000} as never); return null; }}),
    ]);
    await router.getBestQuote({...PARAMS, onRefusal: (_t, info) => heard.push(info)});
    expect(byProvider(router.lastRefusals)).toEqual([
      {message: "evil: nope", provider: "evil"},
      {reason: "rate_limited", retryAfterMs: 2000, message: "ok: busy", provider: "ok"},
      {message: "str: nope", provider: "str"},
    ]);
    expect(heard).toContainEqual({reason: "rate_limited", retryAfterMs: 2000});
    expect(heard.filter((h) => h !== undefined)).toHaveLength(1);
  });

  it("an expired or malformed quote is not called a price failure", async () => {
    const router = new CrossChainRouter([
      provider("stale", {getQuote: async (p) => ({...(await provider("stale").getQuote(p))!, validUntilMs: Date.now() - 1})}),
      provider("odd", {getQuote: async (p) => ({...(await provider("odd").getQuote(p))!, reliability: 2})}),
    ]);
    await router.getBestQuote(PARAMS);
    expect(byProvider(router.lastRefusals).map((r) => [r.provider, r.reason])).toEqual([["odd", "upstream_unavailable"], ["stale", "quote_expired"]]);
  });

  it("using() a disabled venue says policy_refused, like the single-provider path", async () => {
    const swaps = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [provider("dark", {enabled: () => false}), provider("other")]});
    const e = await swaps.using("dark").quoteSwap2(options).catch((x: Swap2QuoteError) => x);
    expect(e).toBeInstanceOf(Swap2QuoteError);
    expect((e as Swap2QuoteError).message).toBe("swap2: no route available for the requested pair");
    expect((e as Swap2QuoteError).reason).toBe("policy_refused");
  });
});
