// U0 (0.4.12), decision 12: a per-item JSON-RPC error is no longer read as "no pool". Before, rpcBatch stored null for
// any item with `error`, so a `-32007 "50/second request limit reached"` on the best pool's quote made it silently "not
// a candidate" and a worse route won (gaps/impact-gate §1.1 M1; one research lane lost the decisive Monad pool this way
// and reported 584.56 AUSD at 1,337 bps). Now a revert is an answer (no candidate, as before); a rate limit, a node
// error or an item left out is retried, then refused as rate_limited / upstream_unavailable. error.data is kept.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {RPC_BATCH_MAX, RPC_MAX_IN_FLIGHT, rpcErrorKind, uniswapRpc} from "../src/rpc.js";
import {D, ME, RPC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const QUOTER = parseAbi(["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)"]);
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"};

type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};
/** The fee of a full-size single-pool quote, else undefined. */
function mainFee(req: Req): number | undefined {
  const p = req.params?.[0] as {data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data?.startsWith("0xc6a5026a")) return undefined;
  const a = decodeFunctionData({abi: QUOTER, data: p.data}).args[0] as {amountIn: bigint; fee: number};
  return a.amountIn === 1_000_000n ? a.fee : undefined;
}
const isVerify = (req: Req) => /^0x(c45a0155|4aa4a4fc)/.test((req.params?.[0] as {data?: string} | undefined)?.data ?? "");

/** The fixtures' stub with items replaced by `rule(req, seen, url)`; every batch is logged with its URL. */
function stub(o: StubOptions, rule: (req: Req, seen: number, url: string) => object | undefined) {
  const inner = rpcStub(o);
  const counts = new Map<string, number>();
  const log: Array<[string, Req[]]> = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Req[];
    log.push([String(url), batch]);
    const res = (await (await inner(url, init)).json()) as {id: number}[];
    return new Response(JSON.stringify(res.map((r, i) => {
      const req = batch[i]!;
      const key = JSON.stringify([req.method, req.params]);
      const seen = counts.get(key) ?? 0;
      counts.set(key, seen + 1);
      const a = rule(req, seen, String(url));
      return a === undefined ? r : a === DROP ? null : {jsonrpc: "2.0", id: r.id, ...a};
    }).filter((x) => x !== null)));
  }) as typeof fetch;
  return {fetch: f, log};
}
const DROP = {};

async function quote(fetchImpl: typeof fetch, config: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", fetchImpl);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, ...config}).getQuote({...base, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never);
  return {q, heard};
}

const tiers = {byFee: {100: 900_000n, 500: 1_000_000n, 3000: 990_000n}};

describe("per-item JSON-RPC errors in the quote batch (maxPriceImpactBps unset)", () => {
  it("a per-item 429 on the best pool, every attempt → rate_limited, never the next-best route", async () => {
    const s = stub(tiers, (r) => (mainFee(r) === 500 ? {error: {code: 429, message: "Too Many Requests"}} : undefined));
    const {q, heard} = await quote(s.fetch);
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: no RPC answered on chain 1 (429 Too Many Requests)", {reason: "rate_limited"}]]);
    expect(s.log.flatMap(([, b]) => b).filter((r) => mainFee(r) === 500)).toHaveLength(3); // asked, retried twice
  });

  it("a transient -32007 on the best pool is asked again: the 0.05% route wins, as with a clean answer", async () => {
    const s = stub(tiers, (r, seen) => (mainFee(r) === 500 && seen === 0 ? {error: {code: -32007, message: "50/second request limit reached"}} : undefined));
    const {q, heard} = await quote(s.fetch);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "1000000", providerData: {fee: "500"}});
    // Only the unanswered call was sent again.
    const retry = s.log[s.log.length - 2]![1];
    expect(retry).toHaveLength(1);
    expect(mainFee(retry[0]!)).toBe(500);
  });

  it("the retry starts at the next endpoint", async () => {
    const s = stub(tiers, (r, _seen, url) => (mainFee(r) === 500 && url === "https://a.test" ? {error: {code: -32005, message: "Rate limit exceeded"}} : undefined));
    const {q} = await quote(s.fetch, {rpcUrls: {1: ["https://a.test", "https://b.test"]}});
    expect(q).toMatchObject({providerData: {fee: "500"}});
    const retry = s.log.find(([, b]) => b.length === 1 && mainFee(b[0]!) === 500)!;
    expect(retry[0]).toBe("https://b.test");
  });

  it("a node error or a call left out of the answer → upstream_unavailable, never no_route", async () => {
    const down = await quote(stub(tiers, (r) => (mainFee(r) === 500 ? {error: {code: -32000, message: "header not found"}} : undefined)).fetch);
    expect(down.heard).toEqual([["uniswap: no RPC answered on chain 1 (-32000 header not found)", {reason: "upstream_unavailable"}]]);
    const missing = await quote(stub(tiers, (r) => (mainFee(r) === 500 ? DROP : undefined)).fetch);
    expect(missing.heard).toEqual([["uniswap: no RPC answered on chain 1 (the node left a call unanswered)", {reason: "upstream_unavailable"}]]);
  });

  it("a node's error text reaches the refusal without URLs (a keyed endpoint may echo its own) and kept short", async () => {
    const message = `Archive requests require a personal token. Get one at: https://rpc.example/key/SECRET123 ${"x".repeat(400)}`;
    const {heard} = await quote(stub(tiers, (r) => (mainFee(r) === 500 ? {error: {code: -32602, message}} : undefined)).fetch);
    expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
    expect(heard[0]![0]).not.toMatch(/SECRET123|https?:/);
    expect(heard[0]![0]).toMatch(/^uniswap: no RPC answered on chain 1 \(-32602 Archive requests require a personal token\. Get one at: <url> x+\)$/);
    expect(heard[0]![0].length).toBeLessThan(260);
  });

  it("every revert shape is still an answer: no candidate, and no pool at all is no_route", async () => {
    const shapes = [
      {code: 3, message: "execution reverted", data: "0x"},
      {code: -32000, message: "execution reverted"},
      {code: -32000, message: "Execution reverted", data: "0x7a5ed734"},
      {code: -32015, message: "VM execution error.", data: "revert"},
      {code: -32603, message: "internal", data: "0x08c379a000000000"},
    ];
    for (const error of shapes) {
      const all = await quote(stub({byFee: {}}, (r) => (mainFee(r) !== undefined ? {error} : undefined)).fetch);
      expect(all.heard).toEqual([["uniswap: no Uniswap v3 pool route for this pair and amount", {reason: "no_route"}]]);
      const best = await quote(stub(tiers, (r) => (mainFee(r) === 500 ? {error} : undefined)).fetch);
      expect(best.q).toMatchObject({providerData: {fee: "3000"}}); // the 0.05% pool reverted: the next one wins, as always
    }
  });

  it("a batch refused with a JSON-RPC error object is retried, then classified", async () => {
    let n = 0;
    const inner = rpcStub(tiers);
    const once = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (batch.some((r) => mainFee(r) !== undefined) && n++ === 0) return new Response(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32007, message: "50/second request limit reached"}}));
      return inner(url, init);
    }) as typeof fetch;
    expect((await quote(once)).q).toMatchObject({providerData: {fee: "500"}});
    const always = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (batch.some((r) => mainFee(r) !== undefined)) return new Response(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32007, message: "50/second request limit reached"}}));
      return inner(url, init);
    }) as typeof fetch;
    expect((await quote(always)).heard).toEqual([["uniswap: no RPC answered on chain 1 (50/second request limit reached)", {reason: "rate_limited"}]]);
  });

  it("an HTTP failure of every endpoint is not retried (0.4.11: failover only; the 429's wait goes to the caller)", async () => {
    const urls: string[] = [];
    const inner = rpcStub(tiers);
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (batch.some((r) => mainFee(r) !== undefined)) {
        urls.push(String(url));
        return new Response("{}", {status: 429, headers: {"retry-after": "3"}});
      }
      return inner(url, init);
    }) as typeof fetch;
    const {heard} = await quote(f);
    expect(heard).toEqual([["uniswap: no RPC answered on chain 1 (HTTP 429)", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 3000}]]);
    expect(urls).toEqual(["https://rpc.test"]); // the chunk with the single-pool quotes, sent once
  });
});

describe("per-item errors in the deployment check and the preflight", () => {
  it("a rate-limited factory() read is rate_limited, not a deployment mismatch (and is not cached)", async () => {
    const s = stub({}, (r) => (isVerify(r) ? {error: {code: -32007, message: "50/second request limit reached"}} : undefined));
    vi.stubGlobal("fetch", s.fetch);
    const p = uniswapProvider({rpcUrls: RPC});
    let why: [string, unknown] | undefined;
    expect(await p.getQuote({...base, onRefusal: (t: string, i?: unknown) => { why = [t, i]; }})).toBeNull();
    expect(why).toEqual(["uniswap: no RPC answered on chain 1 (-32007 50/second request limit reached)", {reason: "rate_limited"}]);
    vi.stubGlobal("fetch", rpcStub());
    expect(await p.getQuote(base)).not.toBeNull();
  });

  it("a revert of the pinned WETH9() is still vault_mismatch", async () => {
    const {heard} = await quote(rpcStub({quoterNoWeth: true}));
    expect(heard).toEqual([["uniswap: the router/quoter on chain 1 do not match the pinned deployment — refusing", {reason: "vault_mismatch"}]]);
  });

  it("preflight: a per-item 429 is rate_limited, not 'the pool no longer quotes this route'", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = uniswapProvider({rpcUrls: RPC});
    const q = (await p.getQuote(base))!;
    vi.stubGlobal("fetch", stub({}, (r) => (r.method === "eth_call" ? {error: {code: 429, message: "Too Many Requests"}} : undefined)).fetch);
    const err = await p.preflightDeposit!(q, await p.buildDeposit(q)).then(() => null, (e: Error) => e);
    expect(err!.message).toBe("uniswap: no RPC answered on chain 1 (429 Too Many Requests)");
    expect(refusalOf(err)).toEqual({reason: "rate_limited"});
  });
});

describe("the RPC layer", () => {
  it("reads per-item errors: reverts by code, data or text; rate limits by code or text; the rest unavailable", () => {
    const table: Array<[Parameters<typeof rpcErrorKind>[0], ReturnType<typeof rpcErrorKind>]> = [
      [{code: 3, message: "execution reverted: rate limit"}, "revert"],
      [{code: -32000, message: "execution reverted"}, "revert"],
      [{code: -32015, message: "VM execution error."}, "revert"],
      [{code: -32603, message: "x", data: "0x7a5ed734"}, "revert"],
      [{code: -32000, message: "out of gas"}, "revert"],
      [{code: -32007, message: "50/second request limit reached"}, "rate_limited"],
      [{code: -32005, message: "limit exceeded"}, "rate_limited"],
      [{code: 429, message: "Too Many Requests"}, "rate_limited"],
      [{code: -32029, message: "Too Many Requests, Please apply an API key"}, "rate_limited"],
      [{code: -32090, message: "Too many requests, reason: call rate limit exhausted, retry in 10s"}, "rate_limited"],
      [{code: -32000, message: "request rate limit reached"}, "rate_limited"],
      [{code: -32000, message: "header not found"}, "upstream_unavailable"],
      [{code: -32000, message: "missing trie node"}, "upstream_unavailable"],
      [{code: -32603, message: "Internal error"}, "upstream_unavailable"],
      [{message: "weird"}, "upstream_unavailable"],
    ];
    for (const [e, kind] of table) expect([e, rpcErrorKind(e)]).toEqual([e, kind]);
  });

  it("keeps a revert's error.data for the caller", async () => {
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      return new Response(JSON.stringify(batch.map((r) => ({jsonrpc: "2.0", id: r.id, error: {code: 3, message: "execution reverted", data: "0x7a5ed734"}}))));
    }) as typeof fetch);
    const slots = await uniswapRpc({1: ["https://rpc.test"]}).slots(1, [{method: "eth_call", params: [{to: D.quoter, data: "0x"}, "latest"]}], "items");
    expect(slots).toEqual([{ok: false, revert: {code: 3, message: "execution reverted", data: "0x7a5ed734"}}]);
  });

  it(`sends at most ${RPC_BATCH_MAX} calls a batch and ${RPC_MAX_IN_FLIGHT} batches at once, answers in order`, async () => {
    let inFlight = 0;
    let peak = 0;
    let largest = 0;
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      largest = Math.max(largest, batch.length);
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response(JSON.stringify(batch.map((r) => ({jsonrpc: "2.0", id: r.id, result: (r.params[0] as {data: string}).data}))));
    }) as typeof fetch);
    const calls = Array.from({length: 95}, (_, i) => ({method: "eth_call", params: [{to: D.quoter, data: `0x${i.toString(16).padStart(4, "0")}`}, "latest"]}));
    const out = await uniswapRpc({1: ["https://rpc.test"]}).results(1, calls, "items");
    expect(out).toEqual(calls.map((c) => (c.params[0] as {data: string}).data));
    expect(largest).toBe(RPC_BATCH_MAX);
    expect(peak).toBe(RPC_MAX_IN_FLIGHT);
  });

  it("the caller's abort during a retry wait ends it, unclassified", async () => {
    const ctrl = new AbortController();
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
      setTimeout(() => ctrl.abort(), 10);
      const batch = JSON.parse(String(init?.body)) as Req[];
      return new Response(JSON.stringify(batch.map((r) => ({jsonrpc: "2.0", id: r.id, error: {code: -32007, message: "50/second request limit reached"}}))));
    }) as typeof fetch);
    const started = Date.now();
    const err = await uniswapRpc({1: ["https://rpc.test"]}).results(1, [{method: "eth_blockNumber", params: []}], "all", ctrl.signal).then(() => null, (e: Error) => e);
    expect(Date.now() - started).toBeLessThan(250);
    expect(err!.message).toBe("uniswap: no RPC answered on chain 1 (This operation was aborted)");
    expect(refusalOf(err)).toBeUndefined();
  });
});
