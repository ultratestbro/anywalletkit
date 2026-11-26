// U0 (0.4.12), decision 12: a per-item JSON-RPC error is no longer read as "no pool". Before, rpcBatch stored null for
// any item with `error`, so a `-32007 "50/second request limit reached"` on the best pool's quote made it silently "not
// a candidate" and a worse route won (gaps/impact-gate §1.1 M1; one research lane lost the decisive Monad pool this way
// and reported 584.56 AUSD at 1,337 bps). Now a revert is an answer (no candidate, as before); a rate limit, a node
// error or an item left out is retried, then refused as rate_limited / upstream_unavailable. error.data is kept.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {RATE_WAIT_MAX_MS, RATE_WINDOW_MS, RETRY_DELAYS_MS, RPC_BATCH_MAX, rpcErrorKind, uniswapRpc} from "../src/rpc.js";
import {D, ME, RPC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

  it("U0-SEC-4: a rate limit or internal error carrying hex data on the best pool is not 'no candidate'", async () => {
    // 0.05% pays 1,000,000, 0.3% 990,000: before, both answers below silently made the 0.3% route win.
    const shapes: Array<[object, string, Swap2RefusalInfo]> = [
      [{code: -32000, message: "rate limit exceeded", data: "0x00000000"}, "uniswap: no RPC answered on chain 1 (-32000 rate limit exceeded)", {reason: "rate_limited"}],
      [{code: -32603, message: "internal error", data: "0x0000000000000000"}, "uniswap: no RPC answered on chain 1 (-32603 internal error)", {reason: "upstream_unavailable"}],
    ];
    for (const [error, text, info] of shapes) {
      const unset = await quote(stub(tiers, (r) => (mainFee(r) === 500 ? {error} : undefined)).fetch);
      expect(unset.q).toBeNull();
      expect(unset.heard).toEqual([[text, info]]);
      const gated = await quote(stub(tiers, (r) => (mainFee(r) === 500 ? {error} : undefined)).fetch, {maxPriceImpactBps: 500});
      expect(gated.heard).toEqual([[text, info]]); // never "loses …% … best route direct 0.3%"
      const once = await quote(stub(tiers, (r, seen) => (mainFee(r) === 500 && seen === 0 ? {error} : undefined)).fetch);
      expect(once.q).toMatchObject({destAmount: "1000000", providerData: {fee: "500"}});
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
      // Round 1 (U0-SEC-4): a rate limit or a node fault is read from the text before hex `data` is taken for revert
      // bytes (the research classifier's rule); a revert reason that mentions a rate limit is still a revert.
      [{code: -32000, message: "rate limit exceeded", data: "0x00000000"}, "rate_limited"],
      [{code: -32000, message: "Too many requests", data: "0x7a5ed734"}, "rate_limited"],
      [{code: -32603, message: "internal error", data: "0x0000000000000000"}, "upstream_unavailable"],
      [{code: -32603, message: "request timed out", data: "0x08c379a0"}, "upstream_unavailable"],
      [{code: -32000, message: "header not found", data: "0x12345678"}, "upstream_unavailable"],
      [{code: -32000, message: "service unavailable", data: "0x12345678"}, "upstream_unavailable"],
      [{code: -32000, message: "execution reverted: rate limit exceeded", data: "0x08c379a0"}, "revert"],
      // The call ran and the gas the node lets one call use ran out: an answer, never a rate limit.
      [{code: -32000, message: "gas limit reached"}, "revert"],
      [{code: -32000, message: "gas required exceeds allowance (50000000)"}, "revert"],
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

  it(`sends at most ${RPC_BATCH_MAX} calls a batch, every chunk at once as 0.4.11 sent them, answers in order`, async () => {
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
    expect(peak).toBe(10); // round 1 held them to 4 in flight per chain
  });

  it("a caller's signal does not lift the request timeout: a hung endpoint is given up after it", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      setTimeout(() => c.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError")), 10);
      return c.signal;
    });
    let hang = true;
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (hang) {
        await new Promise((_r, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError"))));
      }
      return new Response(JSON.stringify(batch.map((r) => ({jsonrpc: "2.0", id: r.id, result: "0x1"}))));
    }) as typeof fetch);
    const net = uniswapRpc({1: ["https://rpc.test"]});
    const call = {method: "eth_blockNumber", params: []};
    const ctrl = new AbortController(); // never aborted
    const stuck = await net.results(1, Array.from({length: 40}, () => call), "none", ctrl.signal).then(() => null, (e: Error) => e);
    expect(stuck!.message).toBe("uniswap: no RPC answered on chain 1 (This operation was aborted)");
    expect(refusalOf(stuck)).toEqual({reason: "upstream_unavailable"});
    hang = false;
    expect(await net.results(1, [call], "none", ctrl.signal)).toEqual(["0x1"]);
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

describe("U0-R2-1 / U0-R2-SEC-1: no shared lane — concurrent quotes go out as 0.4.11 sent them", () => {
  /** The fixtures' stub answering each batch after `rtt` ms; counts the batches in flight. */
  function slow(rtt: number, o: StubOptions = {}) {
    const inner = rpcStub(o);
    const seen = {inFlight: 0, peak: 0};
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.peak = Math.max(seen.peak, ++seen.inFlight);
      await new Promise((r) => setTimeout(r, rtt));
      seen.inFlight--;
      return inner(url, init);
    }) as typeof fetch;
    return {f, seen};
  }

  it("10 concurrent quotes with no signal (the server path) take no more than one round trip longer than one alone", async () => {
    // Round 1's lane (4 batches per chain, FIFO, unbounded) made 10 such quotes at 300 ms per round trip take 1.8–2.4 s
    // against 0.6 s, and at 1 s per round trip pushed the last past the router's 8 s quote timeout.
    const RTT = 100;
    for (const config of [{}, {maxPriceImpactBps: 500}]) {
      const one = slow(RTT);
      vi.stubGlobal("fetch", one.f);
      let t = Date.now();
      expect(await uniswapProvider({rpcUrls: RPC, ...config}).getQuote(base)).not.toBeNull();
      const alone = Date.now() - t;
      const many = slow(RTT);
      vi.stubGlobal("fetch", many.f);
      const p = uniswapProvider({rpcUrls: RPC, ...config});
      t = Date.now();
      const quotes = await Promise.all(Array.from({length: 10}, () => p.getQuote(base)));
      const all = Date.now() - t;
      for (const q of quotes) expect(q).toMatchObject({destAmount: "1000000", providerData: {fee: "500"}});
      expect([config, all]).toEqual([config, expect.any(Number)]);
      expect(all).toBeLessThan(alone + RTT + 50);
      expect(many.seen.peak).toBeGreaterThanOrEqual(20); // every quote's two candidate batches at once, as in 0.4.11
    }
  });

  it("two providers and many quotes share nothing: no queue to wait in, whatever the load", async () => {
    const s = slow(20);
    vi.stubGlobal("fetch", s.f);
    const [a, b] = [uniswapProvider({rpcUrls: RPC}), uniswapProvider({rpcUrls: RPC})];
    const t = Date.now();
    const quotes = await Promise.all([...Array.from({length: 20}, () => a.getQuote(base)), ...Array.from({length: 20}, () => b.getQuote(base))]);
    expect(quotes.every((q) => q !== null)).toBe(true);
    expect(Date.now() - t).toBeLessThan(1_000); // four sequential steps of 20 ms; round 1 queued 80+ batches four at a time
    expect(s.seen.peak).toBeGreaterThanOrEqual(80);
  });
});

describe("rpcCallsPerSecond (opt-in): at most N calls a second per endpoint, a bounded wait", () => {
  const call = {method: "eth_blockNumber", params: []};
  const many = (n: number) => Array.from({length: n}, () => call);
  /** Answers every call at once; logs [ms since start, url, calls] per batch. */
  function answering(t0: number, rule?: (url: string, batch: Req[], k: number) => Promise<Response> | undefined) {
    const sent: Array<[number, string, number]> = [];
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      sent.push([Date.now() - t0, String(url), batch.length]);
      const r = rule?.(String(url), batch, sent.length);
      if (r) return r;
      return new Response(JSON.stringify(batch.map((x) => ({jsonrpc: "2.0", id: x.id, result: "0x1"}))));
    }) as typeof fetch);
    return sent;
  }
  const fake = () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    return Date.now();
  };

  it("must be an integer ≥ 1; unset is the default (no limit)", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "50", null]) {
      expect(() => uniswapProvider({rpcUrls: RPC, rpcCallsPerSecond: bad as never})).toThrow("uniswap: rpcCallsPerSecond must be an integer ≥ 1");
    }
    for (const ok of [1, 50, 1000]) expect(() => uniswapProvider({rpcUrls: RPC, rpcCallsPerSecond: ok})).not.toThrow();
  });

  it("no window of 1 s holds more than N calls on an endpoint, across concurrent requests, first come first served", async () => {
    const t0 = fake();
    const sent = answering(t0);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 25});
    const jobs = [net.results(1, many(40), "none"), net.results(1, many(30), "none"), net.results(1, many(5), "none")];
    await vi.advanceTimersByTimeAsync(RATE_WAIT_MAX_MS);
    expect((await Promise.all(jobs)).map((o) => o.length)).toEqual([40, 30, 5]);
    expect(sent.map(([t, , n]) => [t, n])).toEqual([[0, 10], [0, 10], [1000, 10], [1000, 10], [2000, 10], [2000, 10], [3000, 10], [3000, 5]]);
    for (const [t] of sent) {
      const inWindow = sent.filter(([u]) => u > t - RATE_WINDOW_MS && u <= t).reduce((a, [, , n]) => a + n, 0);
      expect(inWindow).toBeLessThanOrEqual(25);
    }
  });

  it("batches carry at most N calls when N is under 10", async () => {
    const t0 = fake();
    const sent = answering(t0);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 4});
    const job = net.results(1, many(9), "none");
    await vi.advanceTimersByTimeAsync(RATE_WAIT_MAX_MS);
    expect(await job).toHaveLength(9);
    expect(sent.map(([t, , n]) => [t, n])).toEqual([[0, 4], [1000, 4], [2000, 1]]);
  });

  it(`a batch that would wait over ${RATE_WAIT_MAX_MS / 1000} s is never queued: the next endpoint, else rate_limited at once`, async () => {
    const t0 = fake();
    const sent = answering(t0);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 10});
    const busy = net.results(1, many(50), "none"); // one batch a second: at 0, 1, 2, 3 and 4 s
    const over = net.results(1, many(10), "none").then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(0);
    const err = await over;
    expect(err!.message).toBe("uniswap: no RPC answered on chain 1 (the endpoint's 10 calls a second are booked more than 4 s ahead)");
    expect(refusalOf(err)).toEqual({reason: "rate_limited"});
    await vi.advanceTimersByTimeAsync(RATE_WAIT_MAX_MS);
    expect(await busy).toHaveLength(50);
    expect(sent.map(([t]) => t)).toEqual([0, 1000, 2000, 3000, 4000]);
    // With a second endpoint, the overflow goes there at once (each endpoint has its own budget).
    const t1 = Date.now();
    sent.length = 0;
    const two = uniswapRpc({1: ["https://a.test", "https://b.test"]}, {callsPerSecond: 10});
    const a = two.results(1, many(50), "none");
    const b = two.results(1, many(10), "none");
    await vi.advanceTimersByTimeAsync(0);
    expect(sent.filter(([, u]) => u === "https://b.test").map(([t, , n]) => [t - (t1 - t0), n])).toEqual([[0, 10]]);
    await vi.advanceTimersByTimeAsync(RATE_WAIT_MAX_MS);
    expect([(await a).length, (await b).length]).toEqual([50, 10]);
  });

  it("a batch waiting for its turn ends at the caller's abort, unsent and unclassified, and gives its turn back", async () => {
    const t0 = fake();
    const sent = answering(t0);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 10});
    const first = net.results(1, many(10), "none");
    const ctrl = new AbortController();
    const waiting = net.results(1, many(10), "none", ctrl.signal).then(() => null, (e: Error) => e);
    await vi.advanceTimersByTimeAsync(500);
    ctrl.abort();
    const err = await waiting;
    expect(err!.message).toBe("uniswap: no RPC answered on chain 1 (This operation was aborted)");
    expect(refusalOf(err)).toBeUndefined();
    expect(await first).toHaveLength(10);
    const next = net.results(1, many(10), "none");
    await vi.advanceTimersByTimeAsync(1000);
    expect(await next).toHaveLength(10);
    expect(sent.map(([t]) => t)).toEqual([0, 1000]); // the aborted batch was never sent; its turn went to the next one
  });

  it("U0-R2-SEC-3: once a chunk fails the pass, a later retryable chunk failure does not revive it — the waiting chunks are not sent", async () => {
    // Round 1: `failed = !isChunkFailure(e) || …` reset the flag on chunk 2's retryable JSON-RPC batch refusal, so the
    // chunks still waiting went out after slots() had already rejected.
    const t0 = fake();
    const sent = answering(t0, (_url, _batch, k) => {
      if (k === 1) return Promise.resolve(new Response("{}", {status: 503}));
      if (k === 2) return new Promise<Response>((r) => setTimeout(() => r(new Response(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32005, message: "limit exceeded"}}))), 10));
      return undefined;
    });
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 20});
    const job = net.slots(1, many(60), "items").then(() => null, (e: Error) => e); // six chunks: two a second
    await vi.advanceTimersByTimeAsync(10);
    expect((await job)!.message).toBe("uniswap: no RPC answered on chain 1 (HTTP 503)");
    await vi.advanceTimersByTimeAsync(3 * RATE_WINDOW_MS);
    expect(sent.map(([t, , n]) => [t, n])).toEqual([[0, 10], [0, 10]]);
  });

  it("a provider with the option set still quotes, its batches within the budget", async () => {
    const inner = rpcStub({multiHop: 990_000n});
    const sent: Array<[number, number]> = [];
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      sent.push([Date.now(), (JSON.parse(String(init?.body)) as Req[]).length]);
      return inner(url, init);
    }) as typeof fetch);
    const p = uniswapProvider({rpcUrls: RPC, rpcCallsPerSecond: 50});
    const quotes = await Promise.all([0, 1].map(() => p.getQuote(base)));
    for (const q of quotes) expect(q).toMatchObject({destAmount: "1000000", providerData: {fee: "500"}});
    for (const [t] of sent) expect(sent.filter(([u]) => u > t - RATE_WINDOW_MS && u <= t).reduce((a, [, n]) => a + n, 0)).toBeLessThanOrEqual(50);
  });
});

describe("round 2: answers without a result, id-less errors, EVM error text, redacted transport errors", () => {
  it("U0-R2-SEC-2: an eth_call answered with neither result nor error, or with result null, is no answer — retried, then upstream_unavailable", async () => {
    // Round 1 stored both as {ok: true, result: null}: read as a revert, the 0.05% pool dropped out and 0.3% won.
    const NO_RESULT = "uniswap: no RPC answered on chain 1 (the node answered a call with no result)";
    for (const answer of [{}, {result: null}]) {
      for (const config of [{}, {maxPriceImpactBps: 500}]) {
        const s = stub(tiers, (r) => (mainFee(r) === 500 ? answer : undefined));
        const {q, heard} = await quote(s.fetch, config);
        expect([answer, config, q]).toEqual([answer, config, null]);
        expect(heard).toEqual([[NO_RESULT, {reason: "upstream_unavailable"}]]);
        expect(s.log.flatMap(([, b]) => b).filter((r) => mainFee(r) === 500)).toHaveLength(3); // asked, retried twice
      }
      const once = await quote(stub(tiers, (r, seen) => (mainFee(r) === 500 && seen === 0 ? answer : undefined)).fetch);
      expect(once.q).toMatchObject({destAmount: "1000000", providerData: {fee: "500"}});
    }
  });

  it("U0-R2-SEC-2: null stays an answer where it means one (a receipt not mined, a block the node has not got)", async () => {
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      return new Response(JSON.stringify(batch.map((r) => (r.method === "eth_chainId" ? {jsonrpc: "2.0", id: r.id} : {jsonrpc: "2.0", id: r.id, result: null}))));
    }) as typeof fetch);
    const slots = await uniswapRpc({1: ["https://rpc.test"]}).slots(1, [
      {method: "eth_getTransactionReceipt", params: ["0x01"]},
      {method: "eth_getBlockByNumber", params: ["latest", false]},
      {method: "eth_call", params: [{to: D.quoter, data: "0x"}, "latest"]},
      {method: "eth_chainId", params: []},
    ], "none");
    expect(slots.slice(0, 2)).toEqual([{ok: true, result: null}, {ok: true, result: null}]);
    expect(slots.slice(2).map((x) => "failed" in x && [x.failed.message, refusalOf(x.failed)])).toEqual([
      ["uniswap: no RPC answered on chain 1 (the node answered a call with no result)", {reason: "upstream_unavailable"}],
      ["uniswap: no RPC answered on chain 1 (the node answered a call with no result)", {reason: "upstream_unavailable"}],
    ]);
  });

  it("U0-R2-SEC-4: geth's 'stack limit reached 1024 (1023)' and other EVM errors are reverts, not rate limits", () => {
    const table: Array<[Parameters<typeof rpcErrorKind>[0], ReturnType<typeof rpcErrorKind>]> = [
      [{code: -32000, message: "stack limit reached 1024 (1023)"}, "revert"],
      [{code: -32000, message: "max call depth exceeded"}, "revert"],
      [{code: -32000, message: "write protection"}, "revert"],
      [{code: -32000, message: "return data out of bounds"}, "revert"],
      // Still rate limits:
      [{code: -32000, message: "request limit reached"}, "rate_limited"],
      [{code: -32000, message: "daily limit exceeded"}, "rate_limited"],
    ];
    for (const [e, kind] of table) expect([e, rpcErrorKind(e)]).toEqual([e, kind]);
  });

  it("U0-R2-SEC-4: an error sent without an id (a batch-level rate limit as an array entry) classifies every unanswered call", async () => {
    const inner = rpcStub(tiers);
    const idless = (body: object) => (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (batch.some((r) => mainFee(r) !== undefined)) return new Response(JSON.stringify([body]));
      return inner(url, init);
    }) as typeof fetch;
    const limited = await quote(idless({jsonrpc: "2.0", id: null, error: {code: -32005, message: "rate limited"}}));
    expect(limited.heard).toEqual([["uniswap: no RPC answered on chain 1 (-32005 rate limited)", {reason: "rate_limited"}]]);
    const fault = await quote(idless({jsonrpc: "2.0", error: {code: -32603, message: "internal error"}}));
    expect(fault.heard).toEqual([["uniswap: no RPC answered on chain 1 (-32603 internal error)", {reason: "upstream_unavailable"}]]);
    // An answer with its id is still read as its own, beside an id-less entry.
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      return new Response(JSON.stringify([{jsonrpc: "2.0", id: null, error: {code: -32007, message: "50/second request limit reached"}}, {jsonrpc: "2.0", id: 1, result: "0x2"}]));
    }) as typeof fetch);
    const slots = await uniswapRpc({1: ["https://rpc.test"]}).slots(1, [{method: "eth_blockNumber", params: []}, {method: "eth_blockNumber", params: []}], "none");
    expect(slots[1]).toEqual({ok: true, result: "0x2"});
    expect("failed" in slots[0]! && refusalOf(slots[0].failed)).toEqual({reason: "rate_limited"});
  });

  it("U0-R2-SEC-6: a transport error that names the endpoint reaches the refusal without it", async () => {
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL) => {
      throw new TypeError(`Request cannot be constructed from a URL that includes credentials: ${String(url)}`);
    }) as typeof fetch);
    const heard: string[] = [];
    const q = await uniswapProvider({rpcUrls: {1: ["https://user:secret@host.example/key123"]}}).getQuote({...base, onRefusal: (t: string) => { heard.push(t); }} as never);
    expect(q).toBeNull();
    expect(heard).toEqual(["uniswap: no RPC answered on chain 1 (Request cannot be constructed from a URL that includes credentials: <url>)"]);
  });
});
