// U0 (0.4.12) pre-release review, 2026-11-26: `rpcCallsPerSecond`. A rate too low to carry one quote was accepted
// (U0C-1: at 5, every pair with two mid tokens was refused at once on an idle endpoint); the 4 s wait bound held per
// batch, so a gated quote's five passes under load ran past the router's 8 s and were aborted unclassified
// (U0-LIVE-1); and windows were counted at booking instants, so a batch whose timer fired late shared a window with
// the next one (U0-LIVE-3). Now: a floor (MIN_CALLS_PER_SECOND), a bound per quote (QUOTE_WAIT_MAX_MS), and windows
// counted at the moment each batch went.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {MIN_CALLS_PER_SECOND, QUOTE_WAIT_MAX_MS, RATE_WINDOW_MS, uniswapRpc} from "../src/rpc.js";
import {D, ME, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};
// OP Mainnet knows all four mid tokens (WETH, USDC, USDT, USDT0): DAI → LINK has the most candidates, 4 + 4 × 9 = 40.
const DAI = "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1";
const LINK = "0x350a791bfc2c21f9ed5d10980dad2e2638ffa7f6";
const largest = {sourceChain: "eip155:10", destChain: "eip155:10", destAddress: ME, refundAddress: ME, sourceToken: DAI, sourceDecimals: 18, destToken: LINK, amountIn: "1000000"};
const OP = {rpcUrls: {10: ["https://rpc.test"]}, deployments: {10: {...D}}};

const fake = () => {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
  vi.setSystemTime(Date.UTC(2026, 10, 26));
  return Date.now();
};

/** The stub answering every batch after `rttMs`; logs [ms since t0, calls] per batch. */
function slowStub(o: StubOptions, rttMs: number, t0: number) {
  const inner = rpcStub(o);
  const sent: Array<[number, number]> = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    sent.push([Date.now() - t0, (JSON.parse(String(init?.body)) as Req[]).length]);
    if (rttMs) await new Promise((r) => setTimeout(r, rttMs));
    return inner(url, init);
  }) as typeof fetch;
  return {fetch: f, sent};
}

describe(`U0C-1: the floor (${MIN_CALLS_PER_SECOND} calls a second) carries the largest quote on an idle endpoint`, () => {
  for (const rtt of [0, 250, 500]) {
    it(`round trips of ${rtt} ms: the 51-call gated quote and the 46-call unset one (with its probe) are served within ${QUOTE_WAIT_MAX_MS / 1000} s`, async () => {
      for (const [config, calls] of [[{maxPriceImpactBps: 500}, 51], [{}, 46]] as const) {
        const t0 = fake();
        // Two-pool best route: two pool lookups and two slot0() reads on top of the probe.
        const s = slowStub({byFee: {}, multiHop: 990_000n}, rtt, t0);
        vi.stubGlobal("fetch", s.fetch);
        const heard: string[] = [];
        const job = uniswapProvider({...OP, ...config, rpcCallsPerSecond: MIN_CALLS_PER_SECOND}).getQuote({...largest, onRefusal: (t: string) => { heard.push(t); }} as never);
        await vi.advanceTimersByTimeAsync(QUOTE_WAIT_MAX_MS + rtt);
        const q = await job;
        expect([config, heard]).toEqual([config, []]);
        expect(q).toMatchObject({providerData: {route: "via WETH 0.01% → 0.01%", priceImpactBps: "0"}});
        expect(s.sent.reduce((a, [, n]) => a + n, 0)).toBe(calls);
        expect(Math.max(...s.sent.map(([t]) => t))).toBeLessThanOrEqual(QUOTE_WAIT_MAX_MS);
        vi.useRealTimers();
      }
    });
  }
});

describe("U0-LIVE-1: under load a quote is refused as rate_limited in time, never run into the router's 8 s", () => {
  it("20 gated quotes at once, 45 calls a second, 150 ms round trips, an 8 s signal each: each settles by ~5 s, quoted or rate_limited", async () => {
    const t0 = fake();
    const s = slowStub({multiHop: 990_000n}, 150, t0);
    vi.stubGlobal("fetch", s.fetch);
    const p = uniswapProvider({...OP, maxPriceImpactBps: 500, rpcCallsPerSecond: 45});
    const outcomes: Array<{ms: number; ok: boolean; reason?: string | undefined; text?: string}> = [];
    const jobs = Array.from({length: 20}, () => {
      const ctrl = new AbortController();
      setTimeout(() => ctrl.abort(), 8_000); // the router's budget
      const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
      return p.getQuote({...largest, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never, ctrl.signal).then((q) => {
        outcomes.push({ms: Date.now() - t0, ok: q !== null, ...(heard[0] ? {reason: heard[0][1]?.reason, text: heard[0][0]} : {})});
      });
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(jobs);
    expect(outcomes).toHaveLength(20);
    for (const o of outcomes) {
      expect(o.ms).toBeLessThan(QUOTE_WAIT_MAX_MS + 1_000); // the last pass's round trip after the bound, never 8 s
      // Refused in the candidates ("booked …") or in the measure that followed them ("could not measure …"): rate_limited.
      if (!o.ok) expect([o.reason, o.text]).toEqual(["rate_limited", expect.stringMatching(/calls a second are booked|could not measure the price impact/)]);
    }
    // Turns go to the quote that began first, so those under way finish (first come first served across quotes held
    // every quote a pass behind the others: 1 of 20 here, 0 of 20 live on Monad).
    expect(outcomes.filter((o) => o.ok).length).toBeGreaterThanOrEqual(4);
    // No batch of any quote goes after its quote's bound (all began at t0).
    expect(Math.max(...s.sent.map(([t]) => t))).toBeLessThanOrEqual(QUOTE_WAIT_MAX_MS);
  });

  it(`a batch is not sent past waitUntil, even with its turn at once; and a retry that could only go after it is not begun`, async () => {
    const t0 = fake();
    const sent: number[] = [];
    let answer = (b: Req[]): object[] => b.map((x) => ({jsonrpc: "2.0", id: x.id, error: {code: -32603, message: "internal error"}}));
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      sent.push(Date.now() - t0);
      return new Response(JSON.stringify(answer(batch)));
    }) as typeof fetch);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 20});
    const call = {method: "eth_blockNumber", params: []};
    // A node error at 0: the retry at 300–600 ms is past a waitUntil of 200 ms, so it is not begun; the call keeps its reason.
    const job = net.slots(1, [call], "all", undefined, {waitUntil: t0 + 200}).then((s) => s.map((x) => ("failed" in x ? x.failed.message : x)));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await job).toEqual(["uniswap: no RPC answered on chain 1 (-32603 internal error)"]);
    expect(sent).toEqual([0]);
    // Past waitUntil already: refused as rate_limited without a request.
    answer = (b) => b.map((x) => ({jsonrpc: "2.0", id: x.id, result: "0x1"}));
    const late = await net.results(1, [call], "none", undefined, {waitUntil: Date.now() - 1}).then(() => null, (e: Error) => e.message);
    expect(late).toBe(`uniswap: no RPC answered on chain 1 (the endpoint's 20 calls a second are booked past ${QUOTE_WAIT_MAX_MS / 1000} s into the quote)`);
    expect(sent).toEqual([0]);
  });
});

describe("turns: the quote that began first goes first, and a batch that can no longer go in time is refused then", () => {
  it("a later pass of an earlier quote goes before the waiting batch of a quote that began after it", async () => {
    const t0 = fake();
    const sent: Array<[number, string]> = [];
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      sent.push([Date.now() - t0, `${batch[0]!.params[0]}×${batch.length}`]);
      return new Response(JSON.stringify(batch.map((x) => ({jsonrpc: "2.0", id: x.id, result: "0x1"}))));
    }) as typeof fetch);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 20});
    const calls = (tag: string, n: number) => Array.from({length: n}, () => ({method: "eth_getBalance", params: [tag]}));
    const bound = {waitUntil: t0 + QUOTE_WAIT_MAX_MS};
    // Quotes 1 and 2 began in the same millisecond; quote 2 asked first: two chunks fill the window, the third waits.
    const two = net.results(1, calls("q2", 30), "none", undefined, {...bound, quote: 2});
    const one = net.results(1, calls("q1-first", 10), "none", undefined, {...bound, quote: 1});
    await vi.advanceTimersByTimeAsync(10);
    const oneLater = net.results(1, calls("q1-later", 10), "none", undefined, {...bound, quote: 1});
    await vi.advanceTimersByTimeAsync(3_000);
    await Promise.all([one, oneLater, two]);
    expect(sent).toEqual([[0, "q2×10"], [0, "q2×10"], [1000, "q1-first×10"], [1000, "q1-later×10"], [2000, "q2×10"]]);
  });

  it("a waiting batch that the turns given before it push past its bound is refused then, unsent — the next endpoint is asked", async () => {
    const t0 = fake();
    const sent: Array<[number, string, string]> = [];
    vi.stubGlobal("fetch", (async (u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      sent.push([Date.now() - t0, String(u), `${batch[0]!.params[0]}×${batch.length}`]);
      return new Response(JSON.stringify(batch.map((x) => ({jsonrpc: "2.0", id: x.id, result: "0x1"}))));
    }) as typeof fetch);
    const net = uniswapRpc({1: ["https://a.test", "https://b.test"]}, {callsPerSecond: 20});
    const calls = (tag: string, n: number) => Array.from({length: n}, () => ({method: "eth_getBalance", params: [tag]}));
    // A request outside any quote: two chunks at 0 on a, the third to go at 1000 (its bound: 4 s after it was asked).
    const other = net.results(1, calls("other", 30), "none");
    // A quote takes the turns from 1000 to 4000 on a: the third chunk could only go at 5000, so it goes to b at once.
    const quote = net.results(1, calls("quote", 80), "none", undefined, {waitUntil: t0 + QUOTE_WAIT_MAX_MS, quote: 1});
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await Promise.all([other, quote])).map((r) => r.length)).toEqual([30, 80]);
    expect(sent.filter(([, u]) => u === "https://b.test")).toEqual([[0, "https://b.test", "other×10"]]);
    expect(sent.filter(([, u]) => u === "https://a.test").map(([t, , w]) => [t, w])).toEqual([
      [0, "other×10"], [0, "other×10"],
      [1000, "quote×10"], [1000, "quote×10"], [2000, "quote×10"], [2000, "quote×10"], [3000, "quote×10"], [3000, "quote×10"], [4000, "quote×10"], [4000, "quote×10"],
    ]);
  });
});

describe("U0-LIVE-3: a window is counted at the moment each batch went, not when it was booked to", () => {
  it("a batch whose timer fired 30 ms late keeps the next one out of its window: that one waits the 30 ms", async () => {
    const t0 = fake();
    const sent: Array<[number, number]> = [];
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      sent.push([Date.now() - t0, batch.length]);
      return new Response(JSON.stringify(batch.map((x) => ({jsonrpc: "2.0", id: x.id, result: "0x1"}))));
    }) as typeof fetch);
    const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: 10});
    const many = (n: number) => Array.from({length: n}, () => ({method: "eth_blockNumber", params: []}));
    const jobs = [net.results(1, many(10), "none"), net.results(1, many(10), "none"), net.results(1, many(10), "none")]; // booked at 0, 1000, 2000
    await vi.advanceTimersByTimeAsync(999);
    vi.setSystemTime(Date.now() + 30); // the clock runs 30 ms ahead of the timers: the 1000 ms one fires at 1030
    await vi.advanceTimersByTimeAsync(1);
    vi.setSystemTime(Date.now() - 30); // and the 2000 ms one on time
    await vi.advanceTimersByTimeAsync(1_100);
    expect((await Promise.all(jobs)).map((r) => r.length)).toEqual([10, 10, 10]);
    expect(sent).toEqual([[0, 10], [1030, 10], [2030, 10]]);
    for (const [t] of sent) expect(sent.filter(([u]) => u > t - RATE_WINDOW_MS && u <= t).reduce((a, [, n]) => a + n, 0)).toBeLessThanOrEqual(10);
  });
});
