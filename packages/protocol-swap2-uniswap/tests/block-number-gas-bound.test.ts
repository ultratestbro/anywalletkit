// Review 2026-11-28 #1/#5: the block gas bound of a quote pinned to QuoteParams.blockNumber. The routes of such a quote are
// bounded by that block's own gas limit; a node that lacks the block for that read ("header not found", a null block) no
// longer leaves the quote bounded by the known caps alone while its price reads, retried at the next endpoint, name the
// block. The read is retried at the next endpoint as the price reads are (within the quote's wait for it), and when no
// node gives it, the chain's newest good block gas limit in hand stands in — a cached answer, never a new read at
// "latest". Without blockNumber nothing changes (tests/block-number.test.ts against fixtures/unpinned-0.5.0.json).
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider} from "../src/provider.js";
import {D, ME, USDT, rpcStub} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const BLOCK = "24000000";
const tagOf = (block: string) => `0x${BigInt(block).toString(16)}`;
type Item = {id: number; method: string; params: unknown[]};
const tagOfCall = (c: Item): unknown => (c.method === "eth_getBlockByNumber" ? c.params[0] : c.params[1]);
const HEADER_NOT_FOUND = () => ({error: {code: -32000, message: "header not found"}});
const NULL_RESULT = () => ({result: null});
/** A block gas limit of 8M under a route the quoter measures at 9M gas: no block of the chain can carry it. */
const STUB = {blockGasLimit: 8_000_000n, quoterGas: 9_000_000n};
const TOO_BIG = (chainId: number) => [expect.stringMatching(new RegExp(`^uniswap: the swap needs 9576000 gas, more than chain ${chainId} takes in one transaction \\(8000000\\)`)), {reason: "insufficient_liquidity"}];

/**
 * The stub of fixtures.ts (block gas limit 8M, quoter gas 9M), except that on `lacking` endpoints the calls at `block`
 * — every one, or only the block gas read (`gasOnly`) — are answered with `answer`; `delayMs` holds that answer back.
 * Every call is kept with its endpoint and tag.
 */
function node(o: {lacking: string[]; answer?: (item: Item) => object; gasOnly?: boolean; block?: string; delayMs?: number}) {
  const inner = rpcStub(STUB);
  const seen: {url: string; method: string; tag: unknown; at: number}[] = [];
  const tag = tagOf(o.block ?? BLOCK);
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const batch = JSON.parse(String(init?.body)) as Item[];
    for (const c of batch) seen.push({url, method: c.method, tag: tagOfCall(c), at: Date.now()});
    const hit = batch.filter((c) => tagOfCall(c) === tag && (!o.gasOnly || c.method === "eth_getBlockByNumber"));
    if (!o.lacking.includes(url) || hit.length === 0) return inner(input, init);
    if (o.delayMs !== undefined) await new Promise((r) => setTimeout(r, o.delayMs));
    const answer = o.answer ?? HEADER_NOT_FOUND;
    const served = JSON.parse(await (await inner(input, init)).text()) as {id: number}[];
    return new Response(JSON.stringify(served.map((r) => (hit.some((c) => c.id === r.id) ? {jsonrpc: "2.0", id: r.id, ...answer(batch[r.id]!)} : r))));
  }) as typeof fetch;
  return {fetch: f, seen, gasReads: () => seen.filter((c) => c.method === "eth_getBlockByNumber")};
}

const request = (chainId: number, extra: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`, sourceToken: "USDC", destToken: USDT, amountIn: "1000000", destAddress: ME, refundAddress: ME, ...extra,
});
/** Avalanche has no KNOWN_TX_GAS_CAP and no KNOWN_BLOCK_GAS_LIMIT: the block's own gas limit is its only gas bound. */
const providerOn = (chainId: number, urls: string[]) => uniswapProvider({rpcUrls: {[chainId]: urls}, ...(chainId === 1 ? {} : {deployments: {[chainId]: D}})});
async function quote(p: ReturnType<typeof providerOn>, chainId: number, extra: Partial<QuoteParams> = {}) {
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await p.getQuote(request(chainId, {...extra, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }}));
  return {q, heard};
}

describe("the block gas bound of a quote at a pinned block", () => {
  for (const chainId of [43114, 1]) {
    it(`chain ${chainId}, without blockNumber: a route no block can carry is refused (the reference)`, async () => {
      const n = node({lacking: []});
      vi.stubGlobal("fetch", n.fetch);
      const {q, heard} = await quote(providerOn(chainId, ["https://a.test", "https://b.test"]), chainId);
      expect(q).toBeNull();
      expect(heard).toEqual([TOO_BIG(chainId)]);
    });

    for (const [what, answer] of [['"header not found"', HEADER_NOT_FOUND], ["a null result", NULL_RESULT]] as const) {
      it(`chain ${chainId}, the first endpoint trails (${what}): the block's gas limit is read at the next one — refused as without blockNumber, nothing at "latest"`, async () => {
        const n = node({lacking: ["https://a.test"], answer});
        vi.stubGlobal("fetch", n.fetch);
        const {q, heard} = await quote(providerOn(chainId, ["https://a.test", "https://b.test"]), chainId, {blockNumber: BLOCK});
        expect(q).toBeNull();
        expect(heard).toEqual([TOO_BIG(chainId)]);
        // The gas read went to a, then (the retry) to b — both at the block; none at "latest".
        expect(n.gasReads().map((c) => [c.url, c.tag])).toEqual([["https://a.test", tagOf(BLOCK)], ["https://b.test", tagOf(BLOCK)]]);
      });
    }
  }

  it("one endpoint that never serves the block's header (the gas read only): the chain's gas limit read at an earlier block stands in", async () => {
    const chainId = 43114;
    const p = providerOn(chainId, ["https://a.test"]);
    // An earlier round, at the block before: read in full.
    vi.stubGlobal("fetch", node({lacking: []}).fetch);
    expect((await quote(p, chainId, {blockNumber: "23999999"})).heard).toEqual([TOO_BIG(chainId)]);
    // This round: the price reads are served at the block, its header never is.
    const n = node({lacking: ["https://a.test"], gasOnly: true, answer: NULL_RESULT});
    vi.stubGlobal("fetch", n.fetch);
    const {q, heard} = await quote(p, chainId, {blockNumber: BLOCK});
    expect(q).toBeNull();
    expect(heard).toEqual([TOO_BIG(chainId)]);
    // The read and its one retry at the block; no read at "latest" for the stand-in.
    expect(n.gasReads().map((c) => c.tag)).toEqual([tagOf(BLOCK), tagOf(BLOCK)]);
  });

  it("the same with the gas limit a quote without blockNumber read (at latest) in hand", async () => {
    const chainId = 43114;
    const p = providerOn(chainId, ["https://a.test"]);
    vi.stubGlobal("fetch", node({lacking: []}).fetch);
    expect((await quote(p, chainId)).heard).toEqual([TOO_BIG(chainId)]);
    const n = node({lacking: ["https://a.test"], gasOnly: true});
    vi.stubGlobal("fetch", n.fetch);
    const {q, heard} = await quote(p, chainId, {blockNumber: BLOCK});
    expect(q).toBeNull();
    expect(heard).toEqual([TOO_BIG(chainId)]);
    expect(n.gasReads().every((c) => c.tag === tagOf(BLOCK))).toBe(true);
  });

  it("a read that failed with nothing in hand: a gas limit read since stands in for the next quote at that block", async () => {
    const chainId = 43114;
    const p = providerOn(chainId, ["https://a.test"]);
    // The block's read fails with nothing in hand to stand in for it (kept as failed for BLOCK_GAS_RETRY_MS).
    vi.stubGlobal("fetch", node({lacking: ["https://a.test"], gasOnly: true}).fetch);
    await quote(p, chainId, {blockNumber: BLOCK});
    // A quote without blockNumber reads the chain's gas limit at latest…
    vi.stubGlobal("fetch", node({lacking: []}).fetch);
    expect((await quote(p, chainId)).heard).toEqual([TOO_BIG(chainId)]);
    // …and the next quote at the block (its failed read still kept) goes by it, without reading the block again.
    const n = node({lacking: ["https://a.test"], gasOnly: true});
    vi.stubGlobal("fetch", n.fetch);
    const {q, heard} = await quote(p, chainId, {blockNumber: BLOCK});
    expect(q).toBeNull();
    expect(heard).toEqual([TOO_BIG(chainId)]);
    expect(n.gasReads()).toEqual([]);
  });

  it("a read still out as the quote's wait for it ends (1.5 s): the stand-in, not the caps alone", async () => {
    const chainId = 43114;
    const p = providerOn(chainId, ["https://a.test"]);
    vi.stubGlobal("fetch", node({lacking: []}).fetch);
    await quote(p, chainId, {blockNumber: "23999999"});
    // The block's header comes 2.5 s late (it would say 60M: the stub's other answer is not used here).
    vi.stubGlobal("fetch", node({lacking: ["https://a.test"], gasOnly: true, answer: () => ({result: {number: tagOf(BLOCK), gasLimit: `0x${(60_000_000).toString(16)}`}}), delayMs: 2_500}).fetch);
    const started = Date.now();
    const {q, heard} = await quote(p, chainId, {blockNumber: BLOCK});
    expect(Date.now() - started).toBeLessThan(2_400);
    expect(q).toBeNull();
    expect(heard).toEqual([TOO_BIG(chainId)]);
  });

  it("the read's retries all go out while a quote would still wait for it: none after the quote is answered", async () => {
    const chainId = 43114;
    const n = node({lacking: ["https://a.test"], gasOnly: true});
    vi.stubGlobal("fetch", n.fetch);
    const start = Date.now();
    await quote(providerOn(chainId, ["https://a.test"]), chainId, {blockNumber: BLOCK});
    await new Promise((r) => setTimeout(r, 2_200));
    const reads = n.gasReads();
    expect(reads.map((c) => c.tag)).toEqual([tagOf(BLOCK), tagOf(BLOCK)]);
    expect(reads.every((c) => c.at - start <= 1_500)).toBe(true);
  });
});
