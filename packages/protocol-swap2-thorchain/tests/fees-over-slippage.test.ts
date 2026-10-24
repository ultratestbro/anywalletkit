/**
 * THORChain fees vs the caller's slippage. `tolerance_bps` puts LIM at the
 * FEELESS spot × (1 − tolerance); the expected output is spot minus
 * THORChain's fees. When the fees exceed the slippage the node rejects the
 * quote ("emit asset X less than price limit Y") and the route used to vanish
 * (500 USDC Base → BTC at 1%: fees ≈1.7%, 2026-10-24). With a caller slippage
 * the provider now asks for `liquidity_tolerance_bps` = slippage in ONE
 * request, which the node measures from the expected output after fees: LIM =
 * expected × (1 − slippage), the floor every other provider quotes and
 * validQuote enforces. Node answers below are shaped on live THORNode 3.21.0
 * responses (same day).
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {thorchainProvider} from "../src/provider.js";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

const NODE = "https://thor.invalid";
const VAULT = "0x1111111111111111111111111111111111111111";
const ETH_ROUTER = "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146";
const BASE_ROUTER = "0x00dc6100103bc402d490aee3f9a5560cbd91f1d4";
const NATIVE = "0x0000000000000000000000000000000000000000";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const EVM_DEST = "0x9999999999999999999999999999999999999999";

type Reply = {status: number; body: unknown};
let replies: Reply[];
let quoteUrls: URL[];

const priceLimit = (emit: number, limit: number): Reply => ({
  status: 400,
  body: {code: 3, message: `failed to simulate swap: failed to simulate handler: emit asset ${emit} less than price limit ${limit}: invalid request`, details: []},
});
const quote = (expected: string, memo: string, router = BASE_ROUTER, feeBps = 46): Reply => ({
  status: 200,
  body: {expected_amount_out: expected, inbound_address: VAULT, router, memo, expiry: Math.floor(Date.now() / 1000) + 3600, total_swap_seconds: 30, fees: {total_bps: feeBps}},
});

/** 500 USDC on Base → BTC, the prod case. */
function usdcBaseToBtc(overrides: Partial<QuoteParams> = {}): QuoteParams {
  return {
    sourceChain: "eip155:8453",
    sourceToken: "USDC",
    destChain: "bitcoin:mainnet",
    destToken: NATIVE,
    amountIn: "500000000",
    destAddress: BTC_DEST,
    slippageBps: 100,
    ...overrides,
  };
}

beforeEach(() => {
  replies = [];
  quoteUrls = [];
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/thorchain/quote/swap")) {
      quoteUrls.push(url);
      const next = replies.shift();
      if (!next) throw new Error(`unexpected quote request ${url.search}`);
      return new Response(JSON.stringify(next.body), {status: next.status});
    }
    if (url.pathname.endsWith("/thorchain/inbound_addresses")) {
      return new Response(JSON.stringify([
        {chain: "BASE", address: VAULT, router: BASE_ROUTER, halted: false},
        {chain: "ETH", address: VAULT, router: ETH_ROUTER, halted: false},
        {chain: "BTC", address: BTC_DEST, halted: false},
      ]), {status: 200});
    }
    return new Response("not found", {status: 404});
  });
});
afterEach(() => vi.unstubAllGlobals());

const limitParams = (u: URL) => ({tolerance: u.searchParams.get("tolerance_bps"), liquidity: u.searchParams.get("liquidity_tolerance_bps")});

describe("THORChain fees vs the caller's slippage", () => {
  it("one request with liquidity_tolerance_bps = slippage; minimum = expected × (1 − slippage) from the memo", async () => {
    // Live 2026-10-24: tolerance_bps=100 was rejected (emit 616464 < limit 621113, fees ≈1.74%).
    replies.push(quote("616464", `=:b:${BTC_DEST}:610299`, BASE_ROUTER, 174)); // floor(616464 × 0.99)
    const params = usdcBaseToBtc();
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(params);
    expect(q).not.toBeNull();
    expect(quoteUrls.map(limitParams)).toEqual([{tolerance: null, liquidity: "100"}]); // the node accepts only one of the two
    expect(quoteUrls[0]!.searchParams.get("streaming_quantity")).toBe("1");
    expect(q!.destAmount).toBe("616464");
    expect(q!.minDestAmount).toBe("610299");
    expect(q!.providerData?.memo).toBe(`=:BTC.BTC:${BTC_DEST}:610299`);
    expect(BigInt(q!.minDestAmount)).toBe((616464n * 9900n) / 10000n);
    expect(validQuote(q!, params, "thorchain")).toBe(true);
    // the old "tolerance = fees + slippage" idea put LIM ≈100 sat below this floor
    expect(validQuote({...q!, minDestAmount: "610210"}, params, "thorchain")).toBe(false);
  });

  it("fees inside the slippage: the same single request, the same floor (no more slippage − fees room)", async () => {
    replies.push(quote("624541", `=:b:${BTC_DEST}:618295`)); // floor(624541 × 0.99)
    const params = usdcBaseToBtc();
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(params);
    expect(quoteUrls.map(limitParams)).toEqual([{tolerance: null, liquidity: "100"}]);
    expect(q!.minDestAmount).toBe("618295");
    expect(validQuote(q!, params, "thorchain")).toBe(true);
  });

  it("asks 1 bp tighter for a destination with more than 8 decimals, so the 1e8 LIM never lands under the slippage floor", async () => {
    // Live 2026-10-24: 500 ETH.USDC → BASE.ETH (18 decimals) at 1%.
    replies.push(quote("20713241", `=:BASE.ETH:${EVM_DEST}:20508179`, ETH_ROUTER)); // floor(20713241 × 0.9901)
    const params: QuoteParams = {
      sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: NATIVE,
      amountIn: "500000000", destAddress: EVM_DEST, slippageBps: 100,
    };
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(params);
    expect(q).not.toBeNull();
    expect(quoteUrls.map(limitParams)).toEqual([{tolerance: null, liquidity: "99"}]);
    expect(q!.minDestAmount).toBe("20508179" + "0".repeat(10));
    expect(validQuote(q!, params, "thorchain")).toBe(true);
    // liquidity_tolerance_bps=100 would have floored to 20506108 — under the
    // 18-decimal floor (205061085900000000) by 5.9e9 wei.
    expect(validQuote({...q!, minDestAmount: "20506108" + "0".repeat(10)}, params, "thorchain")).toBe(false);
  });

  it("THORChain fees above 5%: no route, a named reason (from the node's fees.total_bps)", async () => {
    replies.push(quote("2700", `=:b:${BTC_DEST}:2673`, BASE_ROUTER, 1000));
    const reasons: string[] = [];
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(usdcBaseToBtc({onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(quoteUrls).toHaveLength(1);
    expect(reasons).toEqual(["thorchain: THORChain fees 10.00% — too expensive at this amount (cap 5%)"]);
  });

  it("fees just under the cap still quote (0.01 ETH-sized swap, fees ≈4.1%)", async () => {
    replies.push(quote("27724", `=:b:${BTC_DEST}:27446`, BASE_ROUTER, 410));
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(usdcBaseToBtc());
    expect(q?.minDestAmount).toBe("27446");
  });

  it("an explicit minAmountOut above the LIM is still refused (floor breach), at or below it passes", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    const reasons: string[] = [];
    replies.push(quote("616464", `=:b:${BTC_DEST}:610299`));
    await expect(provider.getQuote(usdcBaseToBtc({minAmountOut: "610300", onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(reasons[0]).toMatch(/floor breach \(limit=610299 < floor=610300/);
    replies.push(quote("616464", `=:b:${BTC_DEST}:610299`));
    await expect(provider.getQuote(usdcBaseToBtc({minAmountOut: "610299"}))).resolves.not.toBeNull();
  });

  it("a node rejection is the answer, named, with no retry", async () => {
    replies.push(priceLimit(600000, 610299));
    const reasons: string[] = [];
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(usdcBaseToBtc({onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(quoteUrls).toHaveLength(1);
    expect(reasons[0]).toMatch(/^thorchain: failed to simulate swap: .*emit asset 600000 less than price limit 610299/);
  });

  it("refuses, by name, an answer whose LIM sits below expected × (1 − slippage)", async () => {
    replies.push(quote("616464", `=:b:${BTC_DEST}:610000`));
    const reasons: string[] = [];
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(usdcBaseToBtc({onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: memo limit 610000 is below expected 616464 minus 100 bps slippage (1e8 units)"]);
  });

  it("zero slippage (or 1 bp to an 18-decimal destination) cannot carry a liquidity LIM: tolerance_bps as asked, never widened", async () => {
    const provider = thorchainProvider({nodeUrl: NODE});
    replies.push(priceLimit(616464, 627387));
    await expect(provider.getQuote(usdcBaseToBtc({slippageBps: 0}))).resolves.toBeNull();
    replies.push(priceLimit(20714993, 21658838));
    await expect(provider.getQuote({
      sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: NATIVE,
      amountIn: "500000000", destAddress: EVM_DEST, slippageBps: 1,
    })).resolves.toBeNull();
    expect(quoteUrls.map(limitParams)).toEqual([{tolerance: "0", liquidity: null}, {tolerance: "1", liquidity: null}]);
  });

  it("without a caller slippage (legacy): tolerance_bps 300, widened once to what the pool needs", async () => {
    replies.push(priceLimit(61302, 61597)); // spot 63502 → needs ≈3.47% + 0.5%
    replies.push(quote("61302", `=:b:${BTC_DEST}:60981`));
    const {slippageBps: _caller, ...legacy} = usdcBaseToBtc();
    const q = await thorchainProvider({nodeUrl: NODE}).getQuote(legacy);
    expect(q?.minDestAmount).toBe("60981");
    expect(quoteUrls.map(limitParams)).toEqual([{tolerance: "300", liquidity: null}, {tolerance: "397", liquidity: null}]);
  });

  it("names an out-of-range slippage before any request", async () => {
    const reasons: string[] = [];
    await expect(thorchainProvider({nodeUrl: NODE}).getQuote(usdcBaseToBtc({slippageBps: 501, onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(quoteUrls).toHaveLength(0);
    expect(reasons).toEqual(["thorchain: slippage 501 bps is outside 0–500 bps"]);
  });
});

describe("with an affiliate", () => {
  const affiliated = () => thorchainProvider({nodeUrl: NODE, affiliate: "vv", affiliateBps: "50"});

  it("one liquidity request carrying the affiliate; LIM from the after-affiliate output", async () => {
    replies.push(quote("613479", `=:b:${BTC_DEST}:607344:vv:50`)); // floor(613479 × 0.99)
    const params = usdcBaseToBtc();
    const q = await affiliated().getQuote(params);
    expect(q).not.toBeNull();
    expect(quoteUrls.map(limitParams)).toEqual([{tolerance: null, liquidity: "100"}]);
    expect(quoteUrls[0]!.searchParams.get("affiliate")).toBe("vv");
    expect(quoteUrls[0]!.searchParams.get("affiliate_bps")).toBe("50");
    expect(q!.minDestAmount).toBe("607344");
    expect(q!.providerData?.memo).toBe(`=:BTC.BTC:${BTC_DEST}:607344:vv:50`);
    expect(validQuote(q!, params, "thorchain")).toBe(true);
  });

  it("the 5% cap counts the affiliate share (the node's total_bps includes it)", async () => {
    replies.push(quote("2860", `=:b:${BTC_DEST}:2831:vv:50`, BASE_ROUTER, 513));
    const reasons: string[] = [];
    await expect(affiliated().getQuote(usdcBaseToBtc({onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(reasons[0]).toMatch(/^thorchain: THORChain fees 5\.13% — too expensive/);
  });
});
