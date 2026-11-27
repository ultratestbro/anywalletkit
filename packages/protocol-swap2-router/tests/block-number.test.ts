// QuoteParams.blockNumber through the router (0.9.0): it goes to every provider of the round unchanged — getQuote,
// getQuotes candidates, a routeId request, a pinned `only()` re-quote, `quoteSwap2Routes` — and the router never picks a
// block itself. The snapshot carries `honorsBlockNumber`; a quote naming another block than the round's is refused; a
// request whose blockNumber is not a decimal block number is refused before any provider is asked.
import {describe, expect, it, vi} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "../src/router.js";
import {RouterSwap2Protocol} from "../src/swap2/router.js";

const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:1", destToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  amountIn: "100000000", destAddress: "0x3333333333333333333333333333333333333333",
};
const quote = (name: string, p: QuoteParams, extra: Partial<Quote> = {}): Quote => ({
  provider: name, intentId: `${name}-intent`, depositAddress: "", depositMemo: null,
  txRequest: {to: "0x4444444444444444444444444444444444444444", data: "0x01", value: "0"},
  sourceAmount: p.amountIn, destAmount: "99000000", minDestAmount: "98000000", feeUsd: 0, etaSeconds: 15, reliability: 1, validUntilMs: Date.now() + 60_000,
  ...(p.routeId !== undefined ? {routeId: p.routeId} : {}), ...extra,
});
/** A venue that prices on chain: it names the block it was asked for. */
const onChain = (name: string, seen: QuoteParams[], over: Partial<CrossChainProvider> = {}): CrossChainProvider => ({
  name,
  enabled: () => true,
  supportsRoute: () => true,
  supportsSameChain: true,
  honorsBlockNumber: true,
  getQuote: async (p) => { seen.push(p); return quote(name, p, p.blockNumber !== undefined ? {blockNumber: p.blockNumber} : {}); },
  buildDeposit: async () => ({chain: "", to: "0x4444444444444444444444444444444444444444", value: "0", data: "0x01"}),
  trackIntent: async () => ({state: "pending"}),
  ...over,
});
/** A venue that prices by API: it ignores the field and names no block. */
const byApi = (name: string, seen: QuoteParams[]): CrossChainProvider => {
  const {honorsBlockNumber: _h, ...rest} = onChain(name, seen);
  return {...rest, getQuote: async (p) => { seen.push(p); return quote(name, p); }};
};

describe("the router and QuoteParams.blockNumber", () => {
  it("hands the round's block to every provider unchanged; the on-chain venues name it, the API venues name none", async () => {
    const seen: QuoteParams[] = [];
    const router = new CrossChainRouter([onChain("uniswap", seen), onChain("curve", seen), byApi("lifi", seen)]);
    const set = await router.getQuotes({...PARAMS, blockNumber: "23456789"});
    expect(seen.map((p) => [p.blockNumber, p.amountIn])).toEqual([["23456789", "100000000"], ["23456789", "100000000"], ["23456789", "100000000"]]);
    expect(Object.fromEntries(set!.quotes.map((q) => [q.provider, q.blockNumber ?? null]))).toEqual({uniswap: "23456789", curve: "23456789", lifi: null});
    const best = await router.getBestQuote({...PARAMS, blockNumber: "23456789"});
    expect(best!.blockNumber).toBe(best!.provider === "lifi" ? undefined : "23456789");
  });

  it("without it nobody gets one, and nobody names one (as before)", async () => {
    const seen: QuoteParams[] = [];
    const set = await new CrossChainRouter([onChain("uniswap", seen), byApi("lifi", seen)]).getQuotes(PARAMS);
    expect(seen.every((p) => !("blockNumber" in p))).toBe(true);
    expect(set!.quotes.every((q) => !("blockNumber" in q))).toBe(true);
  });

  it("getQuotes candidates and a routeId request get it too, and so does a pinned only() re-quote", async () => {
    const seen: QuoteParams[] = [];
    const multi = onChain("multi", seen, {
      getQuotes: async (p) => { seen.push(p); return ["v3", "v4"].map((routeId) => quote("multi", {...p, routeId}, {blockNumber: p.blockNumber!})); },
    });
    const router = new CrossChainRouter([multi]);
    const set = await router.getQuotes({...PARAMS, blockNumber: "7"});
    expect(set!.quotes.map((q) => [q.routeId, q.blockNumber]).sort()).toEqual([["v3", "7"], ["v4", "7"]]);
    await router.getQuotes({...PARAMS, routeId: "v4", blockNumber: "7"});
    await router.only("multi").getQuotes({...PARAMS, routeId: "v3", dry: false, blockNumber: "8"});
    expect(seen.map((p) => [p.routeId ?? null, p.blockNumber, p.dry ?? null])).toEqual([[null, "7", true], ["v4", "7", null], ["v3", "8", false]]);
  });

  it("the snapshot carries honorsBlockNumber (and only where the provider declares it)", () => {
    const router = new CrossChainRouter([onChain("uniswap", []), byApi("lifi", [])]);
    expect(router.getProvider("uniswap")!.honorsBlockNumber).toBe(true);
    expect("honorsBlockNumber" in router.getProvider("lifi")!).toBe(false);
    expect(router.only("uniswap").getProvider("uniswap")!.honorsBlockNumber).toBe(true);
  });

  it("a quote naming another block than the round's is refused (policy_refused), the others stand", async () => {
    const liar = onChain("liar", [], {getQuote: async (p) => quote("liar", p, {blockNumber: "1"})});
    const unasked = onChain("unasked", [], {getQuote: async (p) => quote("unasked", p, {blockNumber: "23456789"})});
    const router = new CrossChainRouter([onChain("uniswap", []), liar, unasked]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const set = await router.getQuotes({...PARAMS, blockNumber: "23456789"});
      expect(set!.quotes.map((q) => q.provider).sort()).toEqual(["unasked", "uniswap"]);
      expect(router.lastRefusals).toEqual([expect.objectContaining({provider: "liar", reason: "policy_refused"})]);
      // A quote naming a block when the round named none is another request's too.
      const plain = await router.getQuotes(PARAMS);
      expect(plain!.quotes.map((q) => q.provider)).toEqual(["uniswap"]);
      expect(router.lastRefusals.map((r) => [r.provider, r.reason]).sort()).toEqual([["liar", "policy_refused"], ["unasked", "policy_refused"]]);
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a blockNumber that is not a decimal block number before any provider is asked", async () => {
    const seen: QuoteParams[] = [];
    const router = new CrossChainRouter([onChain("uniswap", seen)]);
    for (const bad of ["0x165ec15", "023456789", "-1", "", "latest", 23456789 as never]) {
      expect(await router.getQuotes({...PARAMS, blockNumber: bad})).toBeNull();
      expect(router.lastRefusals).toEqual([{message: "swap2-router: blockNumber must be a decimal block number (digits only, no leading zero)"}]);
      expect(router.lastRejections).toEqual(["swap2-router: blockNumber must be a decimal block number (digits only, no leading zero)"]);
    }
    expect(seen).toEqual([]);
  });

  it("RouterSwap2Protocol.quoteSwap2Routes takes the round's blockNumber and names it on each route that priced at it", async () => {
    const seen: QuoteParams[] = [];
    const swap2 = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [onChain("uniswap", seen), byApi("lifi", seen)]});
    const options = {fromToken: "USDT", toToken: PARAMS.destToken, toChain: "eip155:1", fromTokenAmount: 100_000_000n, recipient: PARAMS.destAddress};
    const routes = await swap2.quoteSwap2Routes(options, {blockNumber: "23456789"});
    expect(seen.map((p) => [p.blockNumber, p.dry])).toEqual([["23456789", true], ["23456789", true]]);
    expect(Object.fromEntries(routes.map((r) => [r.provider, r.blockNumber ?? null]))).toEqual({uniswap: "23456789", lifi: null});
    seen.length = 0;
    const plain = await swap2.quoteSwap2Routes(options);
    expect(seen.every((p) => !("blockNumber" in p))).toBe(true);
    expect(plain.every((r) => !("blockNumber" in r))).toBe(true);
  });
});
