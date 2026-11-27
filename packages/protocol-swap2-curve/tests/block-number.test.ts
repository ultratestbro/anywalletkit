// QuoteParams.blockNumber (0.2.0): every get_dy of a Curve quote — the candidate routes and the impact probe — goes to
// the request's block, and the quote names it (Quote.blockNumber); the router's code / version check and the
// preflight's re-check stay at "latest". Without it every request is 0.1.10's, byte for byte
// (fixtures/unpinned-0.1.10.json). A node that lacks the block fails its endpoint — the next is asked, every endpoint
// once more after a pause — then the quote is refused as stale_node naming the block, never asked at "latest".
//
// The quote has one addition next to the fixture (the gas estimate, released with the same version): `gasEstimate` /
// `gasEstimateSource` (protocol-swap2-core's expected gas used), from the measured table of src/gas.ts — no request
// more. The two fields are taken out of the quote before it is compared with 0.1.10's and checked on their own (against
// the core contract; the figures in tests/gas-estimate.test.ts); every other field is compared as 0.1.10 returned it.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import {CURVE_LATEST_ONLY_CHAINS, curveProvider} from "../src/provider.js";
import {GET_DY_SELECTOR} from "../src/abi.js";
import {ME, POOLS, TABLES, USDT, rpcStub} from "./fixtures.js";
import {SCENARIOS, callsOf, digested, run} from "./block-number-scenarios.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const golden = JSON.parse(readFileSync(new URL("../fixtures/unpinned-0.1.10.json", import.meta.url), "utf8")) as {module: string; scenarios: Record<string, ReturnType<typeof digested>>};
const BLOCK = "24000000";
const TAG = `0x${BigInt(BLOCK).toString(16)}`;
const GET_DY = new Set<string>(Object.values(GET_DY_SELECTOR));

describe("without blockNumber: 0.1.10, byte for byte", () => {
  it("the fixture is 0.1.10's and covers every scenario", () => {
    expect(golden.module).toMatch(/protocol-swap2-curve 0\.1\.10 \(source of origin\/main d77449a0\)/);
    expect(Object.keys(golden.scenarios)).toEqual(SCENARIOS.map((s) => s.name));
  });
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const got = digested(await run(curveProvider as never, s));
      const {gasEstimate, gasEstimateSource, ...quote} = (got.quote ?? {}) as Quote;
      expect({...got, quote: got.quote === null ? null : quote}).toEqual(golden.scenarios[s.name]);
      expect(got.quote && "blockNumber" in got.quote).toBe(false);
      if (got.quote !== null) {
        expect(gasEstimateProblem(got.quote, s.params.sourceChain)).toBeNull();
        if (gasEstimate !== undefined) expect(gasEstimateSource).toBe("model");
      }
    });
  }
});

describe("with blockNumber: every get_dy of the quote at that block", () => {
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const plain = await run(curveProvider as never, s);
      const pinned = await run(curveProvider as never, s, BLOCK);
      expect(pinned.quote).toEqual({...plain.quote, blockNumber: BLOCK});
      expect(pinned.refusals).toEqual(plain.refusals);
      expect(pinned.preflight).toEqual(plain.preflight);
      // The quote's get_dy calls (candidates and probe) at the block; the router check — and the preflight, whose fresh
      // get_dy runs right before signing — at latest.
      const quoteRequests = s.preflight ? pinned.requests.slice(0, plain.requests.length - 1) : pinned.requests;
      const quoteCalls = quoteRequests.flatMap(([, body]) => callsOf(body));
      const priced = quoteCalls.filter((c) => c.method === "eth_call" && GET_DY.has(c.selector ?? ""));
      expect(priced.length).toBeGreaterThan(0);
      for (const c of quoteCalls) expect([c.method, c.selector, c.tag]).toEqual([c.method, c.selector, priced.includes(c) ? TAG : "latest"]);
      if (s.preflight) expect(callsOf(pinned.requests.at(-1)![1]).every((c) => c.tag === "latest")).toBe(true);
      // The same requests as without it, the get_dy calls re-tagged.
      const retag = (body: string) => JSON.stringify((JSON.parse(body) as {method: string; params: unknown[]}[]).map((c) => {
        const sel = (c.params[0] as {data?: string})?.data?.slice(0, 10) ?? "";
        return c.method === "eth_call" && GET_DY.has(sel) && c.params[1] === "latest" && !(s.preflight && body === plain.requests.at(-1)![1]) ? {...c, params: [c.params[0], TAG]} : c;
      }));
      expect(pinned.requests.map(([u, b]) => `${u} ${JSON.stringify(JSON.parse(b))}`)).toEqual(plain.requests.map(([u, b]) => `${u} ${retag(b)}`));
    });
  }
});

const params = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", destAddress: ME, refundAddress: ME, blockNumber: BLOCK, ...extra});
type Item = {id: number; method: string; params: unknown[]};
/** The fixture stub, except that `lacking` endpoints answer each call at the block with `answer` (an item, or a whole HTTP reply). */
function lackingNode(lacking: string[], answer: () => object | {http: number; body: unknown}) {
  const inner = rpcStub();
  const seen: {url: string; tag: unknown; getDy: boolean}[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const batch = JSON.parse(String(init?.body)) as Item[];
    // One entry per request: its endpoint, whether it prices (get_dy), and the blocks its calls name.
    const dy = batch.filter((c) => GET_DY.has(((c.params[0] as {data?: string})?.data ?? "").slice(0, 10)));
    seen.push({url, tag: [...new Set(dy.map((c) => c.params[1]))].join(","), getDy: dy.length > 0});
    if (!lacking.includes(url) || !batch.some((c) => c.params[1] === TAG)) return inner(input, init);
    const a = answer();
    if ("http" in a) return new Response(JSON.stringify((a as {body: unknown}).body), {status: (a as {http: number}).http});
    const served = JSON.parse(await (await inner(input, init)).text()) as {id: number}[];
    return new Response(JSON.stringify(served.map((r) => (batch[r.id]!.params[1] === TAG ? {jsonrpc: "2.0", id: r.id, ...a} : r))));
  }) as typeof fetch;
  return {fetch: f, seen};
}
async function quoteOn(node: ReturnType<typeof lackingNode>, urls: string[], extra: Partial<QuoteParams> = {}) {
  vi.stubGlobal("fetch", node.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await curveProvider({rpcUrls: {1: urls}, ...TABLES, onWarning: () => {}}).getQuote(params({...extra, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }}));
  return {q, heard};
}

describe("a node without the block", () => {
  it("one endpoint lacks it: the next answers, and the quote names the block", async () => {
    const node = lackingNode(["https://a.test"], () => ({error: {code: -32000, message: "header not found"}}));
    const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({blockNumber: BLOCK, destAmount: "998999999"});
    expect(new Set(node.seen.filter((c) => c.getDy).map((c) => c.url))).toEqual(new Set(["https://a.test", "https://b.test"]));
  });

  const lacks: Array<[string, () => object | {http: number; body: unknown}]> = [
    ['"header not found"', () => ({error: {code: -32000, message: "header not found"}})],
    ['"block not found" (reth)', () => ({error: {code: -32001, message: "block not found: 0x16e3600"}})],
    ['"missing trie node" (pruned)', () => ({error: {code: -32000, message: "missing trie node 9a3db399 (path )"}})],
    ["a null result", () => ({result: null})],
    ['an HTTP 400 with "block is out of range" (X Layer, Celo)', () => ({http: 400, body: {jsonrpc: "2.0", id: 0, error: {code: -32019, message: "block is out of range"}}})],
    ["an HTTP 403 for state past the pruning (publicnode)", () => ({http: 403, body: {jsonrpc: "2.0", id: 0, error: {code: -32602, message: "Archive requests require a personal token. Get one at: https://www.allnodes.com/publicnode"}}})],
  ];
  for (const [what, answer] of lacks) {
    it(`no endpoint has it — ${what}: stale_node naming the block, nothing read at "latest" instead`, async () => {
      const node = lackingNode(["https://a.test", "https://b.test"], answer);
      const {q, heard} = await quoteOn(node, ["https://a.test", "https://b.test"]);
      expect(q).toBeNull();
      expect(heard).toEqual([[expect.stringMatching(new RegExp(`^curve: no RPC answered on chain 1 \\(block ${BLOCK} is not served by the node \\(`)), {reason: "stale_node"}]]);
      const getDy = node.seen.filter((c) => c.getDy);
      // Both endpoints, twice each (once more after the pause); never at latest.
      expect(getDy.map((c) => c.url)).toEqual(["https://a.test", "https://b.test", "https://a.test", "https://b.test"]);
      expect(heard[0]![0]).not.toMatch(/latest|allnodes/);
      expect(getDy.every((c) => c.tag === TAG)).toBe(true);
    });
  }

  it("an error that says nothing about the block stays upstream_unavailable", async () => {
    const node = lackingNode(["https://a.test"], () => ({error: {code: -32603, message: "internal error"}}));
    const {heard} = await quoteOn(node, ["https://a.test"]);
    expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
  });

  // Review 2026-11-28 #6: a revert is never a node without the block, whatever its reason says — on the HTTP-error and
  // batch-refusal paths too (the batch items were already told apart by isExecutionError).
  const reverts: Array<[string, () => object | {http: number; body: unknown}]> = [
    ["an HTTP 400 whose body is a revert (code 3, \"… in the future\")", () => ({http: 400, body: {jsonrpc: "2.0", id: 0, error: {code: 3, message: "execution reverted: oracle timestamp in the future"}}})],
    ["a batch refused with a revert's text (\"execution reverted: unknown block\")", () => ({http: 200, body: {jsonrpc: "2.0", id: null, error: {code: -32000, message: "execution reverted: unknown block"}}})],
  ];
  for (const [what, answer] of reverts) {
    it(`${what}: not stale_node`, async () => {
      const node = lackingNode(["https://a.test"], answer);
      const {q, heard} = await quoteOn(node, ["https://a.test"]);
      expect(q).toBeNull();
      expect(heard).toHaveLength(1);
      expect(heard[0]![1]).not.toEqual({reason: "stale_node"});
      expect(heard[0]![0]).not.toMatch(/is not served by the node/);
    });
  }
});

describe("the request's blockNumber", () => {
  for (const bad of ["0x16e3600", "024000000", "-1", "1.5", "", "latest", 24_000_000 as never]) {
    it(`${JSON.stringify(bad)} is refused before anything is sent`, async () => {
      const f = vi.fn(rpcStub());
      vi.stubGlobal("fetch", f);
      const heard: string[] = [];
      expect(await curveProvider({rpcUrls: {1: ["https://rpc.test"]}, ...TABLES, onWarning: () => {}}).getQuote(params({blockNumber: bad, onRefusal: (t) => { heard.push(t); }}))).toBeNull();
      expect(heard).toEqual(["curve: blockNumber must be a decimal block number (digits only, no leading zero)"]);
      expect(f).not.toHaveBeenCalled();
    });
  }

  it("the provider declares honorsBlockNumber", () => {
    expect(curveProvider({rpcUrls: {}}).honorsBlockNumber).toBe(true);
  });

  it("HyperEVM (CURVE_LATEST_ONLY_CHAINS: its RPCs ignore the tag): read at latest as without it, the quote names no block", async () => {
    expect(CURVE_LATEST_ONLY_CHAINS).toEqual([999]);
    expect(Object.isFrozen(CURVE_LATEST_ONLY_CHAINS)).toBe(true);
    const tags = new Set<unknown>();
    const inner = rpcStub();
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      for (const c of callsOf(String(init?.body))) tags.add(c.tag);
      return inner(url, init);
    }) as typeof fetch);
    // The fixture's Arbitrum USDC/USDT0 stable-ng pool listed on chain 999 stands in for a HyperEVM pool (the stub
    // answers by address; HyperEVM's router is the [4][5] family, which drives stable-ng pools).
    const pools = {...POOLS, 999: {...POOLS[42161]!, chainId: 999}};
    const [a, b] = POOLS[42161]!.pools[0]!.coins as [string, string];
    const heard: string[] = [];
    const q = await curveProvider({rpcUrls: {999: ["https://rpc.test"]}, deployments: TABLES.deployments, pools, onWarning: () => {}}).getQuote(params({sourceChain: "eip155:999", destChain: "eip155:999", sourceToken: a, sourceDecimals: 6, destToken: b, onRefusal: (t) => { heard.push(t); }}));
    expect(heard).toEqual([]);
    expect(q).not.toBeNull();
    expect("blockNumber" in q!).toBe(false);
    expect(tags).toEqual(new Set(["latest"]));
  });
});
