// QuoteParams.blockNumber (0.6.0): an app prices one comparison round at one block. Every price read of a Uniswap quote
// — v3's candidates and probes, the impact gate's getPool / slot0, v4's discovery and V4Quoter aggregates, their gas
// re-reads and probe, the block gas limit the routes are bounded by — goes to that block, both venues of a
// venueRoutes "both" pass too; the deployment checks and the token-input simulation stay at "latest"; the quote names
// the block (Quote.blockNumber). Without it every request is 0.5.0's, byte for byte (fixtures/unpinned-0.5.0.json). A
// node that lacks the block is retried on the next endpoint, then refused as stale_node naming it — never asked at
// "latest" instead.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {UNISWAP_V3, uniswapPins} from "../src/addresses.js";
import {UNISWAP_LATEST_ONLY_CHAINS, uniswapProvider} from "../src/provider.js";
import {uniswapRemoteProvider} from "../src/remote.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {D, ME, RPC, USDT, rpcStub, type StubOptions} from "./fixtures.js";
import {MONAD_RPC, SCENARIOS, callsOf, digested, monadReplay, run, type Recorded} from "./block-number-scenarios.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const golden = JSON.parse(readFileSync(new URL("../fixtures/unpinned-0.5.0.json", import.meta.url), "utf8")) as {module: string; scenarios: Record<string, ReturnType<typeof digested>>};
const tagOf = (block: string) => `0x${BigInt(block).toString(16)}`;
type Call = ReturnType<typeof callsOf>[number];
/** The checks and simulations of a quote, which stay at "latest": deployment linkage (factory, WETH9, poolManager), code, the token-input check (balance, allowance, eth_simulateV1, access lists, state overrides). */
const STAYS_LATEST = new Set(["0xc45a0155", "0x4aa4a4fc", "0xdc4c90d3", "0x70a08231", "0xdd62ed3e"]);
const isCheck = (c: Call) => c.method === "eth_getCode" || c.method === "eth_simulateV1" || c.method === "eth_createAccessList" || c.overrides || (c.method === "eth_call" && STAYS_LATEST.has(c.selector ?? ""));
/** A price read: every other eth_call (QuoterV2, Multicall3 over the StateView and V4Quoter, getPool, slot0) and the block gas read. */
const isPrice = (c: Call) => !isCheck(c) && (c.method === "eth_call" || c.method === "eth_getBlockByNumber");
const everyCall = (r: Recorded) => r.requests.flatMap(([, body]) => callsOf(body));

describe("without blockNumber: 0.5.0, byte for byte", () => {
  it("the fixture is 0.5.0's and covers every scenario", () => {
    expect(golden.module).toMatch(/protocol-swap2-uniswap 0\.5\.0 \(source of origin\/main d77449a0\)/);
    expect(Object.keys(golden.scenarios)).toEqual(SCENARIOS.map((s) => s.name));
  });

  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const got = digested(await run(uniswapProvider as never, s));
      const want = golden.scenarios[s.name]!;
      expect(got.requests).toEqual(want.requests);
      expect(got.refusals).toEqual(want.refusals);
      expect(got.quotes).toEqual(want.quotes);
      for (const q of got.quotes) expect("blockNumber" in q).toBe(false);
    });
  }
});

describe("with blockNumber: every price read at that block, every check at latest", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const plain = await run(uniswapProvider as never, s);
      const pinned = await run(uniswapProvider as never, s, s.block);
      const tag = tagOf(s.block);
      const calls = everyCall(pinned);
      expect(calls.some(isPrice)).toBe(true);
      for (const c of calls) {
        // The caller's block replaces the one a gated quote would read: no eth_blockNumber.
        expect(c.method).not.toBe("eth_blockNumber");
        if (isPrice(c)) expect([c.method, c.to, c.selector, c.tag]).toEqual([c.method, c.to, c.selector, tag]);
        else if (c.tag !== undefined) expect([c.method, c.to, c.selector, c.tag]).toEqual([c.method, c.to, c.selector, "latest"]);
      }
      // The same calls as without it, each at the block: the unpinned requests with the price reads re-tagged (and a
      // gated quote's eth_blockNumber gone) are exactly the pinned ones.
      const retag = (body: string): string => {
        const items = (JSON.parse(body) as {method: string; params: unknown[]}[]).filter((c) => c.method !== "eth_blockNumber");
        return JSON.stringify(items.map((item, i) => {
          const c = callsOf(JSON.stringify([item]))[0]!;
          if (!isPrice(c)) return item;
          const params = [...item.params];
          params[item.method === "eth_getBlockByNumber" ? 0 : 1] = tag;
          return {...item, id: i, params};
        }));
      };
      const expected = plain.requests.map(([url, body]) => [url, retag(body)]).filter(([, body]) => body !== "[]").map((r) => r.join(" ")).sort();
      expect(pinned.requests.map(([url, body]) => `${url} ${JSON.stringify(JSON.parse(body))}`).sort()).toEqual(expected);
      // The same answers, each naming the block; the same refusals.
      expect(pinned.quotes).toEqual(plain.quotes.map((q) => ({...q, blockNumber: s.block})));
      expect(pinned.refusals).toEqual(plain.refusals);
    });
  }

  it('venueRoutes "both": the v3 and the v4 candidate at the one block, both naming it', async () => {
    const s = SCENARIOS.find((x) => x.name.startsWith("venueRoutes both: 62,000"))!;
    const pinned = await run(uniswapProvider as never, s, s.block);
    expect(pinned.quotes.map((q) => [q.routeId, q.blockNumber])).toEqual([["v3", s.block], ["v4", s.block]]);
    const calls = everyCall(pinned);
    const v3Quoter = calls.filter((c) => c.to === UNISWAP_V3[143]!.quoter.toLowerCase() && isPrice(c));
    const v4Reads = calls.filter((c) => c.to === MULTICALL3.toLowerCase());
    expect(v3Quoter.length).toBeGreaterThan(0);
    expect(v4Reads.length).toBeGreaterThan(0);
    expect(new Set([...v3Quoter, ...v4Reads].map((c) => c.tag))).toEqual(new Set([tagOf(s.block)]));
  });

  it("the token-input check (eth_simulateV1 of approve + swap) stays at latest while the quote's prices are at the block", async () => {
    const s = SCENARIOS.find((x) => x.name.startsWith("v4 all, token input"))!;
    const calls = everyCall(await run(uniswapProvider as never, s, s.block));
    expect(calls.filter((c) => c.method === "eth_simulateV1").map((c) => c.tag)).toEqual(["latest"]);
    expect(calls.filter((c) => c.to === MULTICALL3.toLowerCase()).every((c) => c.tag === tagOf(s.block))).toBe(true);
  });

  it("under rpcCallsPerSecond too (real clock): the reads at the block, the quote names it", async () => {
    const tags: string[] = [];
    const inner = rpcStub();
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      for (const c of callsOf(String(init?.body))) if (isPrice(c)) tags.push(String(c.tag));
      return inner(url, init);
    }) as typeof fetch);
    const q = await uniswapProvider({rpcUrls: RPC, rpcCallsPerSecond: 13}).getQuote({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: "1000000", destAddress: ME, blockNumber: "24000000"});
    expect(q?.blockNumber).toBe("24000000");
    expect(tags.length).toBeGreaterThan(10);
    expect(new Set(tags)).toEqual(new Set([tagOf("24000000")]));
  });
});

// ── A node that lacks the block ──

const params = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: "1000000", destAddress: ME, refundAddress: ME, ...extra});
const BLOCK = "24000000";
type Item = {id: number; method: string; params: unknown[]};
/**
 * The Ethereum stub of fixtures.ts, except that `lacking` endpoints answer each call at the pinned block with `answer`
 * (an item, or a whole HTTP reply). Every call is kept with its endpoint and tag.
 */
function lackingNode(lacking: string[], answer: (item: Item) => object | {http: number; body: unknown}, stub: StubOptions = {}) {
  const inner = rpcStub(stub);
  const seen: {url: string; method: string; tag: unknown; selector?: string}[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const batch = JSON.parse(String(init?.body)) as Item[];
    for (const c of batch) seen.push({url, method: c.method, tag: c.method === "eth_getBlockByNumber" ? c.params[0] : c.params[1], ...((c.params[0] as {data?: string})?.data ? {selector: (c.params[0] as {data: string}).data.slice(0, 10)} : {})});
    const pinned = batch.filter((c) => (c.method === "eth_getBlockByNumber" ? c.params[0] : c.params[1]) === tagOf(BLOCK));
    if (!lacking.includes(url) || pinned.length === 0) return inner(input, init);
    const first = answer(pinned[0]!);
    if ("http" in first) return new Response(JSON.stringify((first as {body: unknown}).body), {status: (first as {http: number}).http});
    const served = JSON.parse(await (await inner(input, init)).text()) as {id: number}[];
    return new Response(JSON.stringify(served.map((r) => (pinned.some((c) => c.id === r.id) ? {jsonrpc: "2.0", id: r.id, ...answer(batch[r.id]!)} : r))));
  }) as typeof fetch;
  return {fetch: f, seen};
}
async function quoteOn(node: ReturnType<typeof lackingNode>, urls: string[], extra: Partial<QuoteParams> = {}, config: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", node.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: {1: urls}, ...config}).getQuote(params({blockNumber: BLOCK, ...extra, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }}));
  return {q, heard};
}
const HEADER_NOT_FOUND = () => ({error: {code: -32000, message: "header not found"}});
const QUOTER_CALL = /^0x(c6a5026a|cdca1753)$/; // QuoterV2 quoteExactInputSingle / quoteExactInput

describe("a node without the block", () => {
  it("one endpoint lacks it: the next endpoint answers, and the quote names the block", async () => {
    const node = lackingNode(["https://a.test"], HEADER_NOT_FOUND);
    const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({blockNumber: BLOCK, destAmount: "1000000"});
    const quoter = node.seen.filter((c) => QUOTER_CALL.test(c.selector ?? ""));
    expect(quoter.some((c) => c.url === "https://a.test")).toBe(true);
    expect(quoter.some((c) => c.url === "https://b.test")).toBe(true);
    expect(quoter.every((c) => c.tag === tagOf(BLOCK))).toBe(true);
  });

  const lacks: Array<[string, (item: Item) => object]> = [
    ['"header not found" (geth, Erigon, Nitro, Monad)', HEADER_NOT_FOUND],
    ['"block not found" (reth, op-reth)', () => ({error: {code: -32001, message: "block not found: 0x16e3600"}})],
    ['Monad\'s "Block requested not found"', () => ({error: {code: -32602, message: "Block requested not found. Request might be querying historical state that is not available."}})],
    ['"missing trie node" (past a node\'s pruning)', () => ({error: {code: -32000, message: "missing trie node 9a3db399db1a12719f47f70001caa30d0a1e3e31914f1e7ca63eaa1ba935ce27 (path )"}})],
    ["a null result", () => ({result: null})],
  ];
  for (const [what, answer] of lacks) {
    it(`no endpoint has it — ${what}: stale_node naming the block; nothing is read at "latest" instead`, async () => {
      const node = lackingNode(["https://a.test", "https://b.test"], answer);
      const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
      expect(q).toBeNull();
      expect(heard).toHaveLength(1);
      expect(heard[0]![1]).toEqual({reason: "stale_node"});
      expect(heard[0]![0]).toMatch(new RegExp(`^uniswap: no RPC on chain 1 served block ${BLOCK} \\(`));
      expect(heard[0]![0]).toMatch(/nothing is read at "latest" instead/);
      // Both endpoints were asked (the retries start at the next one), and no price read went out at "latest".
      const quoter = node.seen.filter((c) => QUOTER_CALL.test(c.selector ?? ""));
      expect(new Set(quoter.map((c) => c.url))).toEqual(new Set(["https://a.test", "https://b.test"]));
      expect(quoter.every((c) => c.tag === tagOf(BLOCK))).toBe(true);
    });
  }

  it('an HTTP 400 whose JSON-RPC body says "block is out of range" (X Layer, Celo): stale_node naming the block', async () => {
    const node = lackingNode(["https://a.test"], () => ({http: 400, body: {jsonrpc: "2.0", id: 1, error: {code: -32019, message: "block is out of range"}}}));
    const {q, heard} = await quoteOn(node, ["https://a.test"]);
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(new RegExp(`served block ${BLOCK} \\(.*block is out of range`)), {reason: "stale_node"}]]);
  });

  it("an HTTP 403 for an old block (publicnode: archive requests need a token): stale_node, not key_rejected", async () => {
    const node = lackingNode(["https://a.test"], () => ({http: 403, body: {jsonrpc: "2.0", id: 1, error: {code: -32602, message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"}}}));
    const {q, heard} = await quoteOn(node, ["https://a.test"]);
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "stale_node"});
    expect(heard[0]![0]).not.toMatch(/allnodes\.com/); // URLs are taken out of refusal texts
  });

  it("gated (maxPriceImpactBps): the same stale_node, not an unmeasured impact", async () => {
    const node = lackingNode(["https://a.test"], HEADER_NOT_FOUND);
    const {q, heard} = await quoteOn(node, ["https://a.test"], {}, {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard[0]).toEqual([expect.stringMatching(new RegExp(`served block ${BLOCK}`)), {reason: "stale_node"}]);
    expect(node.seen.some((c) => c.method === "eth_blockNumber")).toBe(false);
  });

  it("v4 (Monad recording): a node without the block refuses the v4 reads as stale_node naming it", async () => {
    const replay = monadReplay();
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Item[];
      if (!batch.some((c) => c.params?.[1] === tagOf("125409523"))) return replay(url, init);
      return new Response(JSON.stringify(batch.map((c) => (c.params?.[1] === tagOf("125409523") ? {jsonrpc: "2.0", id: c.id, error: {code: -32602, message: "Block requested not found. Request might be querying historical state that is not available."}} : {jsonrpc: "2.0", id: c.id, error: {code: -32603, message: "unused"}}))));
    }) as typeof fetch);
    const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
    const q = await uniswapProvider({rpcUrls: MONAD_RPC, v4: "native-in", deployments: {}}).getQuote({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", amountIn: (100n * 10n ** 18n).toString(), destAddress: ME, blockNumber: "125409523", onRefusal: (t, i) => { heard.push([t, i]); }});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/^uniswap: no RPC on chain 143 served block 125409523 \(-32602 Block requested not found/), {reason: "stale_node"}]]);
  });

  it("an error that says nothing about the block (an internal error) stays upstream_unavailable", async () => {
    const node = lackingNode(["https://a.test"], () => ({error: {code: -32603, message: "internal error"}}));
    const {heard} = await quoteOn(node, ["https://a.test"]);
    expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
  });
});

describe("the request's blockNumber", () => {
  for (const bad of ["0x16e3600", "024000000", "-1", "+1", "1.5", "1e6", "", " 24000000", "latest", "18446744073709551616", 24_000_000 as never]) {
    it(`${JSON.stringify(bad)} is refused before anything is sent`, async () => {
      const f = vi.fn(rpcStub());
      vi.stubGlobal("fetch", f);
      const heard: string[] = [];
      const q = await uniswapProvider({rpcUrls: RPC}).getQuote(params({blockNumber: bad, onRefusal: (t) => { heard.push(t); }}));
      expect(q).toBeNull();
      expect(heard).toEqual(["uniswap: blockNumber must be a decimal block number (digits only, no leading zero)"]);
      expect(f).not.toHaveBeenCalled();
    });
  }

  it("the provider declares honorsBlockNumber", () => {
    expect(uniswapProvider({rpcUrls: RPC}).honorsBlockNumber).toBe(true);
    expect(uniswapProvider({rpcUrls: RPC, v4: "native-in", venueRoutes: "both"}).honorsBlockNumber).toBe(true);
  });

  it("a chain whose RPCs ignore the tag (UNISWAP_LATEST_ONLY_CHAINS: HyperEVM): read at latest as without it, the quote names no block", async () => {
    expect(UNISWAP_LATEST_ONLY_CHAINS).toEqual([999]);
    expect(Object.isFrozen(UNISWAP_LATEST_ONLY_CHAINS)).toBe(true);
    const tags = new Set<unknown>();
    const inner = rpcStub();
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      for (const c of callsOf(String(init?.body))) if (c.tag !== undefined) tags.add(c.tag);
      return inner(url, init);
    }) as typeof fetch);
    // The Ethereum stub stands in for a node of chain 999 (a v3 deployment given for the test).
    const q = await uniswapProvider({rpcUrls: {999: ["https://rpc.test"]}, deployments: {999: D}}).getQuote({...params({blockNumber: BLOCK}), sourceChain: "eip155:999", destChain: "eip155:999", sourceToken: D.weth, sourceDecimals: 18, destToken: USDT});
    expect(q).not.toBeNull();
    expect("blockNumber" in q!).toBe(false);
    expect(tags).toEqual(new Set(["latest"]));
  });
});

describe("through the router and a backend", () => {
  it("the router hands blockNumber to Uniswap; both candidates come back naming it", async () => {
    vi.stubGlobal("fetch", monadReplay());
    const router = new CrossChainRouter([uniswapProvider({rpcUrls: MONAD_RPC, v4: "native-in", venueRoutes: "both"})]);
    expect(router.getProvider("uniswap")!.honorsBlockNumber).toBe(true);
    const set = await router.getQuotes({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", amountIn: (62_000n * 10n ** 18n).toString(), destAddress: ME, blockNumber: "125409523"});
    expect(set!.quotes.map((q) => [q.routeId, q.blockNumber]).sort()).toEqual([["v3", "125409523"], ["v4", "125409523"]]);
  });

  it("uniswapRemoteProvider: the block reaches the backend, the sealed quote names it and passes the pins; honorsBlockNumber is opt-in", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const handle = createSwap2Handler({providers: [uniswapProvider({rpcUrls: RPC})], sealSecret: "block-number-test-seal-secret-32-bytes!", guard: () => {}, subject: () => "test"});
    const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init?.body)), "test");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as typeof fetch;
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/swap2", fetchImpl, honorsBlockNumber: true});
    expect(stub.honorsBlockNumber).toBe(true);
    expect(uniswapRemoteProvider({baseUrl: "https://backend.example/swap2", fetchImpl}).honorsBlockNumber).toBeUndefined();
    const p = params({blockNumber: BLOCK});
    const q = (await stub.getQuote(p)) as Quote;
    expect(q.blockNumber).toBe(BLOCK);
    expect(validQuote(q, p, "uniswap")).toBe(true);
    expect(uniswapPins.verifyQuote!(p, q)).toBeNull();
    // A quote naming a block another request asked for is not this request's.
    expect(validQuote(q, params({blockNumber: "24000001"}), "uniswap")).toBe(false);
    expect(validQuote(q, params(), "uniswap")).toBe(false);
  });
});

