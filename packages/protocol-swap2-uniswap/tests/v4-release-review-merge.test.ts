// The 0.4.12 pre-release review fixes (6afc313f, 039db9fe) were written for the v3 path; merged into 0.5.0, each one is
// carried to the v4 paths where the same defect was there:
// - U0-SEC-R3-1: a node's error text that echoes the endpoint (no scheme, so core redactUrls cannot see it) reached a
//   refusal through a v4 read's revert text, the node's gas-cap text and the wallet-short-of-funds text — the slots'
//   `revert` / `error` messages were the node's own. Now every slot carries them with the endpoints taken out.
// - U0C-2 / U0-LIVE-2: a v4 route that reaches maxPriceImpactBps only with its pool fees was called "too thin".
// - U0-LIVE-1 / U0C-1: a quote's v4 reads (discovery, V4Quoter aggregates, probe, the gas bound's re-reads, the
//   token-input check) went outside its turns: under load they waited 4 s a batch past the quote's 5 s, and the floor
//   (13) does not carry a v4 quote. Now they go by the quote's turns and bound, and with v4 on the floor is
//   MIN_CALLS_PER_SECOND_V4.
// - U0C-5: eth_getCode answering null read as "not the pinned build" (v4 off for the quote, a mismatch alert).
// - U0-SEC-R3-2: a V4Quoter candidate answer in a shape the quoter never gives was refused at once; now it is retried
//   like any unanswered read first (it never read as "no pool").
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {MIN_CALLS_PER_SECOND, MIN_CALLS_PER_SECOND_V4, QUOTE_WAIT_MAX_MS, shortOfFunds, uniswapRpc, type SlotOptions} from "../src/rpc.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {poolIdOf} from "../src/v4/pool.js";
import {V4_QUOTES_PER_AGGREGATE, multicallBatch, v4SpotImpactNetOfFeesBps, v4SpotLossBps, type V4Route} from "../src/v4/quote.js";
import {AUSD, CHAIN, D3, D4, ME, USDC, V4, fakeNode} from "./v4-fake-node.js";
import {MON_AUSD_500_1} from "./v4-helpers.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};
type Heard = Array<[string, Swap2RefusalInfo | undefined]>;
const KEY = "SECRETKEY1234567890";
/** An endpoint configured without a scheme: fetch and some nodes echo it as given, which redactUrls cannot see. */
const BARE = `monad.example.invalid/v2/${KEY}`;
const P_ID = poolIdOf(MON_AUSD_500_1).toLowerCase(); // MON/AUSD 0.05%/1
const AUSD_USDC_9_1 = "0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8";
const AUSD_USDC_50_1 = "0x092b650478145f0aee73a1b400b342b9c6314db2e07aeb91faf7e75e8159ce72";
const MON = 100n * 10n ** 18n;
const USDC_IN = 700_000_000n;
const monToAusd = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "MON", destToken: AUSD, amountIn: MON.toString(), destAddress: ME, refundAddress: ME});
const usdcToAusd = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "USDC", destToken: AUSD, amountIn: USDC_IN.toString(), destAddress: ME, refundAddress: ME, sender: ME});
const nativeNode = () => fakeNode({amount: MON, v3: {tokenOut: AUSD, fee: 3000, out: 1_000_000n}, v4: new Map([[P_ID, {out: 1_200_000n, gas: 90_000n}]])});
/** The same with the v4 pool paying its mid price less its 0.05% fee (the node's pools read price 1): the gate passes. */
const deepNativeNode = () => fakeNode({amount: MON, v3: {tokenOut: AUSD, fee: 3000, out: 1_000_000n}, v4: new Map([[P_ID, {out: (MON * 9_995n) / 10_000n, gas: 90_000n}]])});
const tokenNode = () => fakeNode({amount: USDC_IN, v3: {tokenOut: AUSD, fee: 100, out: 699_000_000n}, v4: new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}], [AUSD_USDC_50_1, {out: 700_200_000n, gas: 60_000n}]])});

const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const MC3_RESULT = parseAbi([
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns (Result[] returnData)",
]);
/** Stand-in quoter calldata for the halving count (only its identity matters). */
const MC3_CALL = parseAbi(["function probe(uint256 i)"]);
/** Passes multicallBatch takes to halve an aggregate down to the call that starves in it: ⌈log2 V4_QUOTES_PER_AGGREGATE⌉. */
const HALVINGS = Math.ceil(Math.log2(V4_QUOTES_PER_AGGREGATE));
/** Whether a request is a Multicall3 aggregate of V4Quoter calls (the candidates' reads, or the probe's). */
function quoterAggregate(r: Req): boolean {
  const c = r.params?.[0] as {to?: string; data?: Hex} | undefined;
  if (r.method !== "eth_call" || !c?.to || !c.data || getAddress(c.to) !== getAddress(MULTICALL3)) return false;
  try {
    return decodeFunctionData({abi: MC3, data: c.data}).args[0].some((x) => getAddress(x.target) === getAddress(D4.quoter));
  } catch {
    return false;
  }
}
/** Whether a request is the v4 discovery (an aggregate of StateView reads). */
function discovery(r: Req): boolean {
  const c = r.params?.[0] as {to?: string; data?: Hex} | undefined;
  if (r.method !== "eth_call" || !c?.to || !c.data || getAddress(c.to) !== getAddress(MULTICALL3)) return false;
  return decodeFunctionData({abi: MC3, data: c.data}).args[0].some((x) => getAddress(x.target) === getAddress(D4.stateView));
}

/** `inner` with items replaced by `rule(req, seen)` (`seen`: how often a request rule() matched was asked before). */
function overriding(inner: typeof fetch, rule: (req: Req, seen: number) => object | undefined) {
  const counts = new Map<string, number>();
  const calls: Req[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Req[];
    calls.push(...batch);
    const res = (await (await inner(url, init)).json()) as {id: number}[];
    return new Response(JSON.stringify(res.map((r, i) => {
      const req = batch[i]!;
      const key = JSON.stringify([req.method, req.params]);
      const seen = counts.get(key) ?? 0;
      const a = rule(req, seen);
      if (a !== undefined) counts.set(key, seen + 1);
      return a === undefined ? r : {jsonrpc: "2.0", id: r.id, ...a};
    })));
  }) as typeof fetch;
  return {fetch: f, calls};
}

async function quote(f: typeof fetch, p: QuoteParams, c: Partial<UniswapProviderConfig> = {}) {
  vi.stubGlobal("fetch", f);
  const heard: Heard = [];
  const warned: Array<[string, unknown]> = [];
  const q = await uniswapProvider({rpcUrls: {[CHAIN]: ["https://monad.fake"]}, v4Deployments: V4, ...c, onV4Warning: (t, i) => { warned.push([t, i]); }}).getQuote({...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, warned};
}

describe("U0-SEC-R3-1 on the v4 paths: a node echoing its endpoint never puts the key into a refusal", () => {
  it("a v4 discovery read reverted with the endpoint in its text: the refusal names <url>", async () => {
    const s = overriding(nativeNode().fetch, (r) => (discovery(r) ? {error: {code: 3, message: `execution reverted (node ${BARE})`, data: "0x"}} : undefined));
    const {q, heard} = await quote(s.fetch, monToAusd(), {v4: "native-in", rpcUrls: {[CHAIN]: [BARE]}});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/a read reverted on chain 143 \(execution reverted \(node <url>\)\)/), {reason: "upstream_unavailable"}]]);
    for (let k = 6; k <= KEY.length; k++) expect(JSON.stringify(heard)).not.toContain(KEY.slice(0, k));
  });

  it("every slot carries the node's message with the endpoints taken out: a revert, an unanswered call, a wallet short of funds", async () => {
    const echo = (m: string) => `${m} at ${BARE} (and again: //${BARE})`;
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      return new Response(JSON.stringify(batch.map((x, i) => ({jsonrpc: "2.0", id: x.id, error: [
        {code: 3, message: echo("execution reverted"), data: "0x"},
        {code: -32000, message: echo("insufficient funds for transfer")},
        {code: -32000, message: echo("gas required exceeds allowance (16777216)")},
      ][i]}))));
    }) as typeof fetch);
    const slots = await uniswapRpc({[CHAIN]: [BARE]}).slots(CHAIN, [0, 1, 2].map(() => ({method: "eth_call", params: []})), "none");
    expect(slots.map((s) => ("revert" in s ? s.revert.message : "failed" in s ? s.error?.message : ""))).toEqual([
      "execution reverted at <url> (and again: //<url>)",
      "insufficient funds for transfer at <url> (and again: //<url>)",
      "gas required exceeds allowance (16777216) at <url> (and again: //<url>)",
    ]);
    // The wallet-short-of-funds text the v4 preflight refuses with, and the classification still read from the node's text.
    expect(shortOfFunds(slots[1])).toBe("-32000 insufficient funds for transfer at <url> (and again: //<url>)");
    expect("revert" in slots[2]!).toBe(true); // "gas required exceeds" is the EVM's answer, kept as a revert
    expect(JSON.stringify(slots.map((s) => ("failed" in s ? s.failed.message : "")))).not.toContain(KEY);
    expect(JSON.stringify(slots)).not.toContain(KEY);
  });
});

describe("U0C-2 / U0-LIVE-2 on the v4 path: the loss net of the pools' fees", () => {
  const P1 = 2n ** 96n; // price 1
  const hop = (fee: number, protocolFee = 0, zeroForOne = true) => ({
    pool: {key: {currency0: AUSD, currency1: USDC, fee, tickSpacing: 1, hooks: "0x0000000000000000000000000000000000000000" as Hex}, id: "0x" as Hex, state: {sqrtPriceX96: P1, tick: 0, protocolFee, lpFee: fee, liquidity: 1n}, source: "listed" as const},
    zeroForOne, currencyIn: zeroForOne ? AUSD : USDC, currencyOut: zeroForOne ? USDC : AUSD,
  });
  const route = (...hops: ReturnType<typeof hop>[]): V4Route => ({currencyIn: hops[0]!.currencyIn, currencyOut: hops[hops.length - 1]!.currencyOut, hops, label: "t", poolFee: "t"});

  it("gross against the mids, net of each hop's swap fee (the protocol fee of that direction included)", () => {
    expect([v4SpotLossBps(route(hop(3000)), 1_000_000n, 997_000n), v4SpotImpactNetOfFeesBps(route(hop(3000)), 1_000_000n, 997_000n)]).toEqual([30, 0]);
    expect([v4SpotLossBps(route(hop(3000)), 1_000_000n, 900_000n), v4SpotImpactNetOfFeesBps(route(hop(3000)), 1_000_000n, 900_000n)]).toEqual([1000, 972]); // net: the true loss 972.92 bps, rounded down as v3 rounds (U0V4-1: it read 973)
    // Protocol fee 0.1% zeroForOne (low 12 bits): the swap fee is 1000 + 3000 − 3 = 3997 pips.
    expect(v4SpotImpactNetOfFeesBps(route(hop(3000, 1000)), 1_000_000n, 996_003n)).toBe(0);
    expect(v4SpotImpactNetOfFeesBps(route(hop(3000, 1000 << 12)), 1_000_000n, 996_003n)).toBe(10); // the other direction's: not this swap's
    expect(v4SpotImpactNetOfFeesBps(route(hop(3000, 1000 << 12, false)), 1_000_000n, 996_003n)).toBe(0);
    // Two pools, 0.05% + 0.005%: 5.5 bps of fees.
    expect(v4SpotImpactNetOfFeesBps(route(hop(500), hop(50, 0, false)), 1_000_000n, 999_450n)).toBe(0);
    expect(v4SpotImpactNetOfFeesBps(route({...hop(0), pool: {...hop(0).pool, state: {...hop(0).pool.state, sqrtPriceX96: 0n}}}), 1_000_000n, 1n)).toBeUndefined();
  });
});

describe("U0-LIVE-1 / U0C-1 on the v4 path: a quote's v4 reads go by its turns, and the floor carries a v4 quote", () => {
  const fake = () => {
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    return Date.now();
  };
  /** `inner` answering each batch after `rttMs`; logs [ms since t0, calls] per batch (and eth_simulateV1 not served). */
  const slow = (inner: typeof fetch, rttMs: number, t0: number, noSimulate = false) => {
    const sent: Array<[number, number]> = [];
    const f = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      sent.push([Date.now() - t0, batch.length]);
      if (rttMs) await new Promise((r) => setTimeout(r, rttMs));
      if (noSimulate && batch.some((x) => x.method === "eth_simulateV1")) {
        return new Response(JSON.stringify(batch.map((x) => ({jsonrpc: "2.0", id: x.id, error: {code: -32601, message: "the method eth_simulateV1 does not exist/is not available"}}))));
      }
      return inner(u, init);
    }) as typeof fetch;
    return {fetch: f, sent};
  };

  it(`with v4 on the provider refuses a rate under ${MIN_CALLS_PER_SECOND_V4}; with v4 off ${MIN_CALLS_PER_SECOND} stands as in 0.4.12`, () => {
    const rpcUrls = {[CHAIN]: ["https://monad.fake"]};
    for (const v4 of ["native-in", "all"] as const) {
      expect(() => uniswapProvider({rpcUrls, v4, rpcCallsPerSecond: MIN_CALLS_PER_SECOND_V4 - 1})).toThrow(`uniswap: rpcCallsPerSecond must be an integer ≥ ${MIN_CALLS_PER_SECOND_V4} with Uniswap v4 on (it carries the largest v4 quote, with a margin)`);
      expect(() => uniswapProvider({rpcUrls, v4, rpcCallsPerSecond: MIN_CALLS_PER_SECOND_V4})).not.toThrow();
    }
    for (const off of [{}, {v4: "off" as const}]) {
      expect(() => uniswapProvider({rpcUrls, ...off, rpcCallsPerSecond: MIN_CALLS_PER_SECOND})).not.toThrow();
      expect(() => uniswapProvider({rpcUrls, ...off, rpcCallsPerSecond: MIN_CALLS_PER_SECOND - 1})).toThrow(`uniswap: rpcCallsPerSecond must be an integer ≥ ${MIN_CALLS_PER_SECOND} (the least that carries one quote)`);
    }
  });

  it(`the largest v4 quote (up to 127 calls in sixteen passes) fits ${QUOTE_WAIT_MAX_MS / 1000} s at ${MIN_CALLS_PER_SECOND_V4} on an idle endpoint answering within 250 ms; at 30, refused`, async () => {
    // The passes of a gated token-input quote with the sender known, venueRoutes "both", on an RPC without
    // eth_simulateV1, for an output token the shipped list does not know, through the provider's own uniswapRpc — and,
    // `pastCap` > 0, with that many V4Quoter candidates past the chain's per-transaction cap, each in its own aggregate
    // (LIVE-1, the shape of the recorded Monad 2,000 AUSD → MON): each such aggregate halved down to the call, two
    // aggregates a pass (`HALVINGS` passes, as multicallBatch runs it below), then those candidates read again at the cap.
    const largest = async (rate: number, rtt: number, pastCap = 0) => {
      const t0 = fake();
      const sent: number[] = [];
      vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body)) as Req[];
        sent.push(Date.now() - t0);
        if (rtt) await new Promise((r) => setTimeout(r, rtt));
        return new Response(JSON.stringify(b.map((x) => (x.method === "eth_simulateV1" ? {jsonrpc: "2.0", id: x.id, error: {code: -32601, message: "method not found"}} : {jsonrpc: "2.0", id: x.id, result: "0x01"}))));
      }) as typeof fetch);
      const net = uniswapRpc({1: ["https://a.test"]}, {callsPerSecond: rate});
      const o: SlotOptions = {waitUntil: t0 + QUOTE_WAIT_MAX_MS, quote: 1};
      const refused: string[] = [];
      const r = (n: number, policy: "all" | "items" | "none", opt: SlotOptions = o, method = "eth_call") =>
        net.slots(1, Array.from({length: n}, () => ({method, params: []})), policy, undefined, opt).then(
          (s) => { for (const x of s) if ("failed" in x && !x.error) refused.push(x.failed.message); },
          (e: Error) => { refused.push(e.message); },
        );
      const job = (async () => {
        await Promise.all([r(4, "items", {}), r(5, "items", {}), r(1, "none", {}, "eth_getBlockByNumber")]); // deployment checks, block read
        await r(1, "all", o, "eth_blockNumber"); // the gated quote's block
        await Promise.all([
          r(40, "all"), // v3 candidates
          (async () => {
            await r(1, "all"); // discovery
            await r(1, "all"); // the unlisted-token grid
            await Promise.all(Array.from({length: 11}, () => r(1, "all"))); // 11 V4Quoter aggregates
            if (pastCap) {
              for (let pass = 0; pass < HALVINGS; pass++) await Promise.all(Array.from({length: 2 * pastCap}, () => r(1, "all"))); // halved
              await r(pastCap, "all"); // read again at the chain's cap
            }
          })(),
        ]);
        await Promise.all([
          (async () => { await r(3, "all"); await r(2, "all"); })(), // v3: pool lookups + probe, slot0()
          (async () => { await r(1, "all"); await r(2, "all"); await r(1, "none", o, "eth_simulateV1"); await r(1, "none", o, "eth_createAccessList"); await r(16, "items"); await r(1, "items"); })(), // v4 build
        ]);
      })();
      await vi.advanceTimersByTimeAsync(12_000);
      await job;
      vi.useRealTimers();
      return {refused, lastSend: Math.max(...sent), calls: sent.length};
    };
    // The halving the model counts is multicallBatch's own: an aggregate of V4_QUOTES_PER_AGGREGATE whose first call
    // starves (no revert data, alone too) is read again in HALVINGS more passes of two aggregates each (10 → 5 → 3 → 2 → 1).
    const sizes: number[] = [];
    const starving = encodeFunctionData({abi: MC3_CALL, functionName: "probe", args: [0n]});
    await multicallBatch(async (c) => {
      const calls = decodeFunctionData({abi: MC3, data: c.data}).args[0];
      sizes.push(calls.length);
      return encodeFunctionResult({abi: MC3_RESULT, functionName: "aggregate3", result: calls.map((x) => ({success: x.callData !== starving, returnData: (x.callData === starving ? "0x" : `0x${"00".repeat(64)}`) as Hex}))}) as Hex;
    }, "latest")(Array.from({length: V4_QUOTES_PER_AGGREGATE}, (_, i) => ({to: D4.quoter, data: encodeFunctionData({abi: MC3_CALL, functionName: "probe", args: [BigInt(i)]})})));
    expect(sizes).toEqual([10, 5, 5, 3, 2, 2, 1, 1, 1]); // the aggregate, then two a pass
    expect(sizes.length).toBe(1 + 2 * HALVINGS);
    // Every answer time up to 250 ms, 5 ms apart, and 1 ms apart over 190–250 ms where four such candidates are tightest
    // (U0V4-4 recheck: 33 refused four at every answer time from 201 to 249 ms and fit only at 200 and 250).
    const rtts = (pastCap: number) => [...Array.from({length: 51}, (_, i) => i * 5), ...(pastCap >= 3 ? Array.from({length: 61}, (_, i) => 190 + i) : [])];
    for (const pastCap of [0, 1, 2, 3, 4]) {
      for (const rtt of rtts(pastCap)) {
        const m = await largest(MIN_CALLS_PER_SECOND_V4, rtt, pastCap);
        expect([pastCap, rtt, m.refused]).toEqual([pastCap, rtt, []]);
        expect(m.lastSend).toBeLessThanOrEqual(QUOTE_WAIT_MAX_MS);
      }
    }
    // RPC-1 re-measure: 33 refused it (201–249 ms, four such candidates) only because the scheduler kept batches sent in
    // the same millisecond in the window. Booked by the window it really holds, 31 is the least that carries every
    // timing above (every ms 0–250, 0–4 candidates past the cap) and 30 refuses from 231 ms; the floor stays at 34.
    expect((await largest(MIN_CALLS_PER_SECOND_V4 - 1, 230, 4)).refused).toEqual([]);
    for (const rtt of [190, 210, 230, 240, 250]) expect([rtt, (await largest(31, rtt, 4)).refused]).toEqual([rtt, []]);
    const under = await largest(30, 235, 1);
    expect(under.refused[0]).toMatch(/calls a second are booked past 5 s into the quote/);
    // U0V4-4: 22, the floor counted without the halving and the re-read, refused a quote with one candidate past the cap
    // from 150 ms (it carried the quote without one).
    expect((await largest(22, 250, 0)).refused).toEqual([]);
    for (const rtt of [150, 200, 250]) expect([rtt, (await largest(22, rtt, 1)).refused.length > 0]).toEqual([rtt, true]);
    // Not carried (MIN_CALLS_PER_SECOND_V4's doc): candidates past the cap in all eleven aggregates.
    expect((await largest(MIN_CALLS_PER_SECOND_V4, 250, 11)).refused.length).toBeGreaterThan(0);
    // At 13 (the v3 floor) even an endpoint answering at once refuses it.
    expect((await largest(MIN_CALLS_PER_SECOND, 0)).refused.length).toBeGreaterThan(0);
  }, 60_000);

  it("a v4 token-input quote on an idle endpoint at the floor (250 ms, no eth_simulateV1): every read within the quote's 5 s, quoted", async () => {
    const t0 = fake();
    const s = slow(tokenNode().fetch, 250, t0, true);
    vi.stubGlobal("fetch", s.fetch);
    const heard: Heard = [];
    const job = uniswapProvider({rpcUrls: {[CHAIN]: ["https://monad.fake"]}, v4Deployments: V4, v4: "all", rpcCallsPerSecond: MIN_CALLS_PER_SECOND_V4})
      .getQuote({...usdcToAusd(), onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
    await vi.advanceTimersByTimeAsync(QUOTE_WAIT_MAX_MS + 1_000);
    const q = await job;
    // The fake node runs no executor: past eth_simulateV1 the check falls back to v3 — the point is every read in time.
    expect(heard).toEqual([]);
    expect(q).not.toBeNull();
    expect(Math.max(...s.sent.map(([t]) => t))).toBeLessThanOrEqual(QUOTE_WAIT_MAX_MS);
  });

  it("under load: 20 v4 quotes at once, 45 calls a second, 150 ms round trips, an 8 s signal each — every v4 read within its quote's 5 s, each settled by ~5 s", async () => {
    for (const [name, node, params, config] of [
      ["native in, gated", deepNativeNode, monToAusd(), {v4: "native-in", maxPriceImpactBps: 500}],
      ["token in, sender known", tokenNode, usdcToAusd(), {v4: "all"}],
    ] as const) {
      const t0 = fake();
      const s = slow(node().fetch, 150, t0);
      vi.stubGlobal("fetch", s.fetch);
      const p = uniswapProvider({rpcUrls: {[CHAIN]: ["https://monad.fake"]}, v4Deployments: V4, ...config, rpcCallsPerSecond: 45});
      const outcomes: Array<{ms: number; ok: boolean; reason?: string | undefined}> = [];
      const jobs = Array.from({length: 20}, () => {
        const ctrl = new AbortController();
        setTimeout(() => ctrl.abort(), 8_000); // the router's budget
        const heard: Heard = [];
        return p.getQuote({...params, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never, ctrl.signal).then((q) => {
          outcomes.push({ms: Date.now() - t0, ok: q !== null, ...(heard[0] ? {reason: heard[0][1]?.reason} : {})});
        });
      });
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all(jobs);
      vi.useRealTimers();
      expect(outcomes).toHaveLength(20);
      // No batch of any quote goes after its quote's bound (all began at t0): before, the v4 reads went outside the
      // quote's turns and kept being sent past it (each batch bounded at 4 s on its own).
      expect([name, Math.max(...s.sent.map(([t]) => t))]).toEqual([name, expect.any(Number)]);
      expect(Math.max(...s.sent.map(([t]) => t)), name).toBeLessThanOrEqual(QUOTE_WAIT_MAX_MS);
      for (const o of outcomes) {
        expect(o.ms, name).toBeLessThan(QUOTE_WAIT_MAX_MS + 1_000);
        if (!o.ok) expect([name, o.reason]).toEqual([name, "rate_limited"]);
      }
      expect(outcomes.filter((o) => o.ok).length, name).toBeGreaterThanOrEqual(4); // the quotes that began first finish
    }
  }, 30_000);
});

describe("U0C-5 on the v4 path: eth_getCode answering null is no answer", () => {
  it("null once: asked again, the v4 deployment check passes and the v4 quote goes out — no mismatch alert", async () => {
    const s = overriding(nativeNode().fetch, (r, seen) => (r.method === "eth_getCode" && seen === 0 ? {result: null} : undefined));
    const {q, heard, warned} = await quote(s.fetch, monToAusd(), {v4: "native-in"});
    expect(heard).toEqual([]);
    expect(warned).toEqual([]); // before: "Uniswap v4 is off on chain 143: the deployment does not match its pins", then v3's quote
    expect(q).toMatchObject({txRequest: {to: D4.universalRouter}, providerData: {venue: "v4"}});
    expect(s.calls.filter((c) => c.method === "eth_getCode")).toHaveLength(2);
  });

  it("null every time: refused upstream_unavailable, never a mismatch alert and v3 in v4's place", async () => {
    const s = overriding(nativeNode().fetch, (r) => (r.method === "eth_getCode" ? {result: null} : undefined));
    const {q, heard, warned} = await quote(s.fetch, monToAusd(), {v4: "native-in"});
    expect(q).toBeNull();
    expect(warned).toEqual([]);
    expect(heard).toEqual([["uniswap: no RPC answered on chain 143 (the node answered a call with no result)", {reason: "upstream_unavailable"}]]);
  });
});

describe("U0-SEC-R3-2 on the v4 path: a V4Quoter candidate answer in another shape is no answer, retried", () => {
  for (const [name, answer] of [["bytes that are no aggregate3 result", {result: "0x1234"}], ["a number", {result: 7}], ["not hex", {result: "0xzz"}]] as const) {
    it(`${name}: once — asked again, the v4 quote stands; every time — refused upstream_unavailable (never v3 in its place)`, async () => {
      const once = overriding(nativeNode().fetch, (r, seen) => (quoterAggregate(r) && seen === 0 ? answer : undefined));
      const a = await quote(once.fetch, monToAusd(), {v4: "native-in"});
      expect(a.heard).toEqual([]); // before: refused at once ("answered in another shape")
      expect(a.q).toMatchObject({txRequest: {to: D4.universalRouter}, providerData: {venue: "v4"}});
      const always = overriding(nativeNode().fetch, (r) => (quoterAggregate(r) ? answer : undefined));
      const b = await quote(always.fetch, monToAusd(), {v4: "native-in"});
      expect(b.q).toBeNull();
      expect(b.heard).toEqual([["uniswap: no RPC answered on chain 143 (the node answered a call in a shape the contract never returns)", {reason: "upstream_unavailable"}]]);
      expect(b.q?.txRequest?.to).not.toBe(D3.router);
    });
  }
});
