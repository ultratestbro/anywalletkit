// LIVE-VR-3 on the v4 line (0.5.0, 2026-11-26). 0.4.12 ranks out a v3 route no transaction can carry before the best
// is picked, and judges the route picked and the route bounded by one block read (tests/live-vr3-u0.test.ts,
// tests/live-vr3-bounds-u0.test.ts). With Uniswap v4 on, the merge first carried that to v3 alone:
// - "best" compared the v4 candidates with v3's best route by output, ranked out or not, so a v4 route paying more than
//   the v3 route the chain can carry lost to one it cannot (and v3's lower route was quoted);
// - the v4 candidates were ranked by a block read taken before they were built (waiting up to 1.5 s for a first read,
//   even for a refusal that needs no gas figure, and before the probe went out) and bounded at their gas step by
//   another read: a read landing in between set a route aside "for gas" that the ranking had let through (RANK-1), or
//   ranked one out that the gas step would have let through (ID-1); and the v3 row of a "both" pass went by a later
//   read than the v4 row.
// Now both venues' candidates are walked in the order a "best" pass ranks them, by one set of gas bounds per quote,
// taken once with the wait the gas step always had and shared by v3 and v4. Fake Avalanche node (no per-transaction
// cap: the block gas limit binds); every delay below is the node's, in fake milliseconds.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionResult, getAddress, parseAbi, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {UNISWAP_V3} from "../src/addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {poolIdOf, type V4PoolKey} from "../src/v4/pool.js";
import {V4_QUOTER_ABI} from "../src/v4/quote.js";
import {fakeNode, v4PinsFor, type PricedPool} from "./v4-fake-node.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const AVAX = 43114;
const D3 = UNISWAP_V3[AVAX]!;
const V4 = v4PinsFor(AVAX);
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const USDC = getAddress("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E");
const ME = getAddress("0x4444444444444444444444444444444444444444");
const key = (fee: number, tickSpacing: number): V4PoolKey => ({currency0: NATIVE, currency1: USDC, fee, tickSpacing, hooks: NATIVE});
/** Shipped Avalanche AVAX/USDC pools. */
const P500 = poolIdOf(key(500, 10)).toLowerCase();
const P3000 = poolIdOf(key(3000, 60)).toLowerCase();
const AMT = 1_000n * 10n ** 18n; // 1,000 AVAX
const T0 = Date.UTC(2026, 10, 26);
const MIN = 60_000;
const Q96 = 1n << 96n;

const V3_QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const V3_POOL = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};
/** A block read's answer: the gasLimit after `ms`, or a read that never answers. */
type Read = {limit: bigint; ms: number} | "hang";
/** A v3 direct route the QuoterV2 prices: its output for AMT (pro rata below), its gas, its pool's mid price (slot0). */
type V3Leg = {out: bigint; gas: bigint; sqrtPrice?: bigint};
const poolAddr = (fee: number) => getAddress(`0x${(0xa000 + fee).toString(16).padStart(40, "0")}`);

/** The v3 direct quote an item is ({fee, amountIn}), else undefined. */
function v3Quote(req: Body): {fee: number; amountIn: bigint} | undefined {
  const p = req.params?.[0] as {to?: string; data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data || !p.to || getAddress(p.to) !== getAddress(D3.quoter)) return undefined;
  try {
    const c = decodeFunctionData({abi: V3_QUOTER, data: p.data});
    return c.functionName === "quoteExactInputSingle" ? (c.args[0] as {fee: number; amountIn: bigint}) : {fee: -1, amountIn: c.args[1] as bigint};
  } catch {
    return undefined;
  }
}
/** The V4Quoter inputs an item carries (straight, or inside a Multicall3 aggregate). */
function v4Inputs(req: Body): bigint[] {
  const p = req.params?.[0] as {to?: string; data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data || !p.to) return [];
  const one = (data: Hex): bigint[] => {
    try {
      const c = decodeFunctionData({abi: V4_QUOTER_ABI, data});
      return [(c.args[0] as {exactAmount: bigint}).exactAmount];
    } catch {
      return [];
    }
  };
  if (getAddress(p.to) !== getAddress(MULTICALL3)) return one(p.data);
  try {
    return decodeFunctionData({abi: MC3, data: p.data}).args[0].flatMap((c) => one(c.callData));
  } catch {
    return [];
  }
}

/**
 * The fake Avalanche node: v3 direct routes from `v3` (fee → leg; every other v3 route reverts), its pool lookups and
 * slot0, v4 pools from `v4` (fakeNode: discovery, V4Quoter, deployment checks), block reads answering `reads` in turn,
 * and a batch carrying either venue's 1/1000 probe answered after `probeMs`. `log`: [ms after T0 within the minute, what].
 */
function node(v3: Record<number, V3Leg>, v4: Record<string, PricedPool>, reads: Read[], probeMs: number) {
  const inner = fakeNode({chainId: AVAX, amount: AMT, v4: new Map(Object.entries(v4))});
  const log: string[] = [];
  let read = 0;
  const answer = (r: Body): unknown | undefined => {
    const q = v3Quote(r);
    if (q) {
      const leg = v3[q.fee];
      if (!leg) return {error: {code: 3, message: "execution reverted", data: "0x"}};
      return {result: encodeFunctionResult({abi: V3_QUOTER, functionName: "quoteExactInputSingle", result: [(leg.out * q.amountIn) / AMT, Q96 + 1n, 1, leg.gas]})};
    }
    const p = r.params?.[0] as {to?: string; data?: Hex} | undefined;
    if (r.method === "eth_call" && p?.to && p.data) {
      if (getAddress(p.to) === getAddress(D3.factory) && p.data.startsWith("0x1698ee82")) {
        const [, , fee] = decodeFunctionData({abi: V3_POOL, data: p.data}).args as readonly [Hex, Hex, number];
        return {result: `0x${poolAddr(fee).slice(2).toLowerCase().padStart(64, "0")}`};
      }
      const fee = Object.keys(v3).map(Number).find((f) => poolAddr(f) === getAddress(p.to!));
      if (fee !== undefined && p.data === "0x3850c7bd") return {result: encodeFunctionResult({abi: V3_POOL, functionName: "slot0", result: [v3[fee]!.sqrtPrice ?? Q96, 0, 0, 1, 1, 0, true]})};
    }
    return undefined;
  };
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const raw = JSON.parse(String(init?.body)) as Body | Body[];
    const batch = Array.isArray(raw) ? raw : [raw];
    const at = (Date.now() - T0) % MIN;
    if (batch.some((b) => b.method === "eth_getBlockByNumber")) {
      log.push(`${at} block read`);
      const r = reads[Math.min(read++, reads.length - 1)]!;
      if (r === "hang") return new Promise<Response>(() => {});
      await new Promise((ok) => setTimeout(ok, r.ms));
      const out = batch.map((b) => ({jsonrpc: "2.0", id: b.id, result: {number: "0x1234", gasLimit: `0x${r.limit.toString(16)}`}}));
      return new Response(JSON.stringify(Array.isArray(raw) ? out : out[0]));
    }
    const probe = batch.some((b) => v3Quote(b)?.amountIn === AMT / 1000n || v4Inputs(b).includes(AMT / 1000n));
    if (probe) {
      log.push(`${at} probe${batch.some((b) => v3Quote(b)?.amountIn === AMT / 1000n) ? " v3" : ""}${batch.some((b) => v4Inputs(b).includes(AMT / 1000n)) ? " v4" : ""}`);
      await new Promise((ok) => setTimeout(ok, probeMs));
    }
    const mine = batch.map(answer);
    const rest = batch.filter((_, i) => mine[i] === undefined);
    const theirs = rest.length ? ((await (await inner.fetch(url, {...init, body: JSON.stringify(rest)})).json()) as {id: number}[]) : [];
    const out = batch.map((b, i) => (mine[i] !== undefined ? {jsonrpc: "2.0", id: b.id, ...(mine[i] as object)} : theirs.find((t) => t.id === b.id)));
    return new Response(JSON.stringify(Array.isArray(raw) ? out : out[0]));
  }) as typeof fetch;
  return {fetch: f, log};
}

const avaxToUsdc = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: `eip155:${AVAX}`, destChain: `eip155:${AVAX}`, sourceToken: "AVAX", destToken: USDC, amountIn: AMT.toString(), destAddress: ME, refundAddress: ME, ...extra});
type Heard = Array<[string, Swap2RefusalInfo | undefined]>;
type Run = {ms: number; heard: Heard; warned: Array<[string, unknown]>; q: Quote | null; qs?: Quote[]};

/** One provider; each quote begins `at` ms after T0 (11 min apart: the block read is due again). `how`: the call made. */
async function quotes(n: {fetch: typeof fetch}, at: number[], config: Partial<UniswapProviderConfig> = {}, how: "quote" | "quotes" | "v3" = "quote"): Promise<Run[]> {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
  vi.setSystemTime(T0);
  vi.stubGlobal("fetch", n.fetch);
  const warned: Array<[string, unknown]> = [];
  const p = uniswapProvider({rpcUrls: {[AVAX]: ["https://avax.fake"]}, v4Deployments: V4, v4: "native-in", ...config, onV4Warning: (t, i) => { warned.push([t, i]); }});
  const out: Run[] = [];
  for (const t of at) {
    vi.setSystemTime(T0 + t);
    const heard: Heard = [];
    const from = warned.length;
    const onRefusal = (w: string, i?: Swap2RefusalInfo) => { heard.push([w, i]); };
    let done = false;
    const job: Promise<Quote | Quote[] | null> = how === "quotes" ? p.getQuotes!({...avaxToUsdc(), onRefusal}) : p.getQuote({...avaxToUsdc(how === "v3" ? {routeId: "v3"} : {}), onRefusal});
    void job.then(() => { done = true; });
    const start = Date.now();
    while (!done) await vi.advanceTimersByTimeAsync(1);
    const r = await job;
    out.push({ms: Date.now() - start, heard, warned: warned.slice(from), q: Array.isArray(r) ? null : r, ...(Array.isArray(r) ? {qs: r} : {})});
    await vi.advanceTimersByTimeAsync(5_000); // every read lands before the next quote
  }
  vi.useRealTimers();
  return out;
}
/** A quote's time (fake ms): from `want` to a few ticks after it. */
const took = (ms: number, want: number) => expect([ms >= want, ms < want + 10, ms]).toEqual([true, true, ms]);
const USD = (n: number) => BigInt(n) * 1_000_000n;

describe("LIVE-VR-3 with v4 on: v4 is compared with v3's best route the chain can carry", () => {
  // v3 direct 0.05% pays most but needs 16,926,000 gas, over the 15M block; v3 0.3% fits. v4 0.05%/10 pays in between.
  const v3 = {500: {out: USD(3_000), gas: 16_000_000n}, 3000: {out: USD(2_900), gas: 1_000_000n}};
  const v4 = {[P500]: {out: USD(2_950), gas: 1_000_000n}};
  const reads: Read[] = [{limit: 15_000_000n, ms: 0}];

  it('"best": the v4 route that beats v3\'s minable best is quoted (before: compared with the ranked-out 0.05%, so v3\'s 0.3% was quoted)', async () => {
    const [r] = await quotes(node(v3, v4, reads, 0), [0]);
    expect(r!.heard).toEqual([]);
    expect(r!.warned).toEqual([]);
    expect(r!.q).toMatchObject({destAmount: USD(2_950).toString(), txRequest: {to: V4[AVAX]!.universalRouter, gasLimit: "1650000"}, providerData: {venue: "v4", route: "v4 direct 0.05%/10"}});
  });

  it('"best" with v4MinEdgeBps: v4 must still beat v3\'s minable best by the edge', async () => {
    // 2,950 over 2,900 is 172 bps: an edge of 200 keeps v3's 0.3%, one of 150 lets v4 through.
    const [keep] = await quotes(node(v3, v4, reads, 0), [0], {v4MinEdgeBps: 200});
    expect(keep!.q).toMatchObject({destAmount: USD(2_900).toString(), txRequest: {to: D3.router}, providerData: {route: "direct 0.3%"}});
    const [edge] = await quotes(node(v3, v4, reads, 0), [0], {v4MinEdgeBps: 150});
    expect(edge!.q).toMatchObject({destAmount: USD(2_950).toString(), providerData: {venue: "v4"}});
  });

  it('"both": the v3 row is v3\'s minable best, a picked "v3" gives the same route, and the "best" winner is v4', async () => {
    const [both] = await quotes(node(v3, v4, reads, 0), [0], {venueRoutes: "both"}, "quotes");
    expect(both!.qs!.map((q) => [q.routeId, q.destAmount, q.providerData!.route])).toEqual([["v3", USD(2_900).toString(), "direct 0.3%"], ["v4", USD(2_950).toString(), "v4 direct 0.05%/10"]]);
    const [picked] = await quotes(node(v3, v4, reads, 0), [0], {venueRoutes: "both"}, "v3");
    expect(picked!.q).toMatchObject({routeId: "v3", destAmount: USD(2_900).toString(), providerData: {route: "direct 0.3%"}});
    expect(picked!.q!.txRequest).toEqual({...both!.qs![0]!.txRequest, data: picked!.q!.txRequest!.data});
    const [best] = await quotes(node(v3, v4, reads, 0), [0], {venueRoutes: "both"});
    expect(best!.q).toMatchObject({routeId: "v4", destAmount: USD(2_950).toString()});
  });
});

describe("LIVE-VR-3 with v4 on: one set of gas bounds per quote, shared by v3 and v4", () => {
  it("ID-1: a pending re-read that lets the best v4 route through at its gas step keeps it (before: ranked out on the older read, v3 quoted)", async () => {
    // Read 15M; 11 min later the re-read (30M) answers at 2 s, the probe at 2.5 s. v4 0.05%/10 needs 19,057,500.
    const n = node({3000: {out: USD(2_900), gas: 1_000_000n}}, {[P500]: {out: USD(3_000), gas: 18_000_000n}}, [{limit: 15_000_000n, ms: 0}, {limit: 30_000_000n, ms: 2_000}], 2_500);
    const [, second] = await quotes(n, [0, 11 * MIN]);
    expect(second!.heard).toEqual([]);
    expect(second!.q).toMatchObject({destAmount: USD(3_000).toString(), txRequest: {gasLimit: "27150000"}, providerData: {venue: "v4", route: "v4 direct 0.05%/10"}});
    took(second!.ms, 2_500);
  });

  it("RANK-1: a re-read landing during the best v4 route's probe ranks it out; the next route under the same read goes on, nothing set aside (before: set aside \"for gas\" and alerted)", async () => {
    // Read 20M; 11 min later the re-read answers 15M at 200 ms while the probe (400 ms) is out. v4 0.05% needs 16,957,500.
    const n = node({3000: {out: USD(2_800), gas: 1_000_000n}}, {[P500]: {out: USD(3_000), gas: 16_000_000n}, [P3000]: {out: USD(2_900), gas: 1_000_000n}}, [{limit: 20_000_000n, ms: 0}, {limit: 15_000_000n, ms: 200}], 400);
    const [first, second] = await quotes(n, [0, 11 * MIN]);
    expect(first!.q).toMatchObject({destAmount: USD(3_000).toString(), providerData: {venue: "v4", route: "v4 direct 0.05%/10"}});
    expect(second!.warned).toEqual([]); // before: "the best Uniswap v4 route … was set aside (the swap needs 16957500 gas …) — quoted another v4 route"
    expect(second!.heard).toEqual([]);
    expect(second!.q).toMatchObject({destAmount: USD(2_900).toString(), txRequest: {gasLimit: "1650000"}, providerData: {venue: "v4", route: "v4 direct 0.3%/60", v4Unexecutable: "1"}});
    // One block read a quote; the next route's probe goes out once the read that ranked the best out is in.
    expect(n.log).toEqual(["0 block read", "0 probe v4", "0 block read", "0 probe v4", "400 probe v4"]);
  });

  it("RANK-2: a v4 refusal that needs no gas figure is not held by a pending first block read (before: 1.5 s)", async () => {
    // maxPriceImpactBps 50: v4 0.05%/10 loses 1% against its pool's mid; the first block read never answers.
    const n = node({3000: {out: (AMT * 98n) / 100n, gas: 1_000_000n, sqrtPrice: 78_436_440_064_262_093_893_064_802_099n}}, {[P500]: {out: (AMT * 99n) / 100n, gas: 1_000_000n}}, ["hang"], 0);
    const [r] = await quotes(n, [0], {maxPriceImpactBps: 50});
    expect(r!.q).toBeNull();
    expect(r!.heard).toEqual([[expect.stringMatching(/^uniswap: loses 1\.0% of the value to price impact/), {reason: "insufficient_liquidity"}]]);
    expect(r!.ms).toBeLessThan(50);
  });

  it("RANK-2: the v4 probe goes out with the quote and the block read is waited for alongside it (before: one after the other)", async () => {
    const n = node({3000: {out: USD(2_900), gas: 1_000_000n}}, {[P500]: {out: USD(3_000), gas: 1_000_000n}}, [{limit: 60_000_000n, ms: 1_400}], 1_000);
    const [r] = await quotes(n, [0]);
    expect(r!.q).toMatchObject({destAmount: USD(3_000).toString(), providerData: {venue: "v4"}});
    expect(n.log).toEqual(["0 block read", "0 probe v4"]);
    took(r!.ms, 1_400);
  });

  it('"both": the v3 row and the v4 row are bounded by the same read (before: v4 by the read in hand, v3 by the one landing later)', async () => {
    // Read 15M; 11 min later the re-read (30M) answers at 2 s, both probes at 2.5 s. Both best routes need ~19M.
    const n = node({500: {out: USD(2_900), gas: 18_000_000n}}, {[P500]: {out: USD(3_000), gas: 18_000_000n}}, [{limit: 15_000_000n, ms: 0}, {limit: 30_000_000n, ms: 2_000}], 2_500);
    const [, second] = await quotes(n, [0, 11 * MIN], {venueRoutes: "both"}, "quotes");
    expect(second!.heard).toEqual([]); // before: v4 "every Uniswap v4 route … needs more gas than … (15000000)" beside a v3 row bounded by 30M
    expect(second!.qs!.map((q) => [q.routeId, q.destAmount, q.txRequest!.gasLimit])).toEqual([["v3", USD(2_900).toString(), "27120000"], ["v4", USD(3_000).toString(), "27150000"]]);
  });

  it("a v4 refusal before the gas step of a route the read in hand cannot carry waits for the bounds, and gives way to the route they let through", async () => {
    // Read 15M; 11 min later the re-read is out (1 s). maxPriceImpactBps 50: v4 0.05%/10 (need 16,957,500) loses 1%;
    // the bounds (the read in hand: 15M) rank it out, and v3's 0.3% — its mid priced so it loses nothing — is quoted.
    const n = node({3000: {out: (AMT * 98n) / 100n, gas: 1_000_000n, sqrtPrice: 78_436_440_064_262_093_893_064_802_099n}}, {[P500]: {out: (AMT * 99n) / 100n, gas: 16_000_000n}}, [{limit: 15_000_000n, ms: 0}, {limit: 15_000_000n, ms: 1_000}], 0);
    const [, second] = await quotes(n, [0, 11 * MIN], {maxPriceImpactBps: 50});
    expect(second!.heard).toEqual([]);
    expect(second!.q).toMatchObject({destAmount: ((AMT * 98n) / 100n).toString(), txRequest: {to: D3.router}, providerData: {route: "direct 0.3%", v4Unexecutable: "1"}});
  });

  it("every route over the bounds, v4's ranked out: v3's best by output is refused as before, its own need named", async () => {
    const n = node({500: {out: USD(2_900), gas: 16_000_000n}}, {[P500]: {out: USD(3_000), gas: 16_000_000n}}, [{limit: 15_000_000n, ms: 0}], 0);
    const [r] = await quotes(n, [0]);
    expect(r!.q).toBeNull();
    expect(r!.warned).toEqual([]);
    expect(r!.heard).toEqual([[`uniswap: the swap needs 16926000 gas, more than chain ${AVAX} takes in one transaction (15000000) — its pools are too thin for this amount`, {reason: "insufficient_liquidity"}]]);
  });

  it("no v3 route and every v4 route over the bounds: refused naming the cap the quote's bounds set", async () => {
    const n = node({}, {[P500]: {out: USD(3_000), gas: 16_000_000n}}, [{limit: 15_000_000n, ms: 0}], 0);
    const [r] = await quotes(n, [0]);
    expect(r!.q).toBeNull();
    expect(r!.heard).toEqual([[`uniswap: every Uniswap v3 and v4 route for this pair and amount is out: the v4 ones need more gas than one transaction on chain ${AVAX} may have (15000000) — its pools are too thin for this amount`, {reason: "insufficient_liquidity"}]]);
  });
});
