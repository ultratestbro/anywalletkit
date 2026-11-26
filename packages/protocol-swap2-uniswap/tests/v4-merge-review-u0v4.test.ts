// Verifier findings on the 0.5.0 merge of the 0.4.12 release-review fixes (feat/uniswap-v4-merge), the v4 paths:
// - U0V4-1: the v4 spot loss (and its net-of-fees twin) was 10000 − ⌊out × 10000 / spot⌋, which rounds the loss UP by as
//   much as 1 bp, where v3 rounds it down so that `loss ≥ limit` holds exactly when the true loss reaches the limit: the
//   gate refused a deep pool under its limit and the fee-aware text then said the fees reached a limit they do not.
//   Now the v4 measures are v3's own over the route's pools.
// - U0V4-2: a pool taking a protocol fee had only its LP fee named in the "the route's fees (…) bring it to the limit"
//   text, while the thin / fees choice nets the protocol fee out too.
// - U0V4-3: `eth_simulateV1` answering `null` read as a simulation "in another shape": the v4 route was set aside for v3's
//   at once, never asked again. `null` is no answer now (NEVER_NULL), retried.
// - U0V4-4 (MIN_CALLS_PER_SECOND_V4 counted without multicallBatch's halving and the re-read at the cap) is in
//   tests/v4-release-review-merge.test.ts, beside the floor's model.
import {afterEach, describe, expect, it, vi} from "vitest";
import {getAddress, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {spotImpactNetOfFeesBps, spotValueLossBps, type Hop} from "../src/impact.js";
import {poolIdOf} from "../src/v4/pool.js";
import {v4RouteFeesText, v4SpotImpactNetOfFeesBps, v4SpotLossBps, type V4Hop, type V4Route} from "../src/v4/quote.js";
import {AUSD, CHAIN, D4, ME, V4, fakeNode} from "./v4-fake-node.js";
import {MON_AUSD_500_1} from "./v4-helpers.js";

afterEach(() => vi.unstubAllGlobals());

type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};
type Heard = Array<[string, Swap2RefusalInfo | undefined]>;
const P_ID = poolIdOf(MON_AUSD_500_1).toLowerCase(); // MON/AUSD 0.05%/1: the fake node reads it at price 1
const AUSD_USDC_9_1 = "0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8";
const MON = 100n * 10n ** 18n;
const USDC_IN = 700_000_000n;
const monToAusd = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "MON", destToken: AUSD, amountIn: MON.toString(), destAddress: ME, refundAddress: ME});
const usdcToAusd = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "USDC", destToken: AUSD, amountIn: USDC_IN.toString(), destAddress: ME, refundAddress: ME, sender: ME});
/** The native-in node with the MON/AUSD 0.05%/1 pool paying `out` for 100 MON (v3's 0.3% route pays 1 AUSD). */
const nativeNode = (out: bigint, protocolFee?: number) => fakeNode({amount: MON, v3: {tokenOut: AUSD, fee: 3000, out: 1_000_000n}, v4: new Map([[P_ID, {out, gas: 90_000n}]]), ...(protocolFee !== undefined ? {protocolFees: new Map([[P_ID, protocolFee]])} : {})});
const tokenNode = () => fakeNode({amount: USDC_IN, v3: {tokenOut: AUSD, fee: 100, out: 699_000_000n}, v4: new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}]])});

async function quote(f: typeof fetch, p: QuoteParams, c: Partial<UniswapProviderConfig> = {}) {
  vi.stubGlobal("fetch", f);
  const heard: Heard = [];
  const warned: Array<[string, unknown]> = [];
  const q = await uniswapProvider({rpcUrls: {[CHAIN]: ["https://monad.fake"]}, v4Deployments: V4, ...c, onV4Warning: (t, i) => { warned.push([t, i]); }}).getQuote({...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, warned};
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

// Sorted currencies (a v4 key's currency0 < currency1).
const A = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
const B = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const C = getAddress("0xe7cd86e13ac4309349f30b3435a9d337750fc82d");
const ZERO = "0x0000000000000000000000000000000000000000" as Hex;
/** A hop through the pool of `x`/`y` (any order), selling `from`. */
function hop(x: Hex, y: Hex, from: Hex, sqrtPriceX96: bigint, fee: number, protocolFee = 0): V4Hop {
  const [currency0, currency1] = BigInt(x) < BigInt(y) ? [x, y] : [y, x];
  const zeroForOne = from === currency0;
  return {pool: {key: {currency0, currency1, fee, tickSpacing: 1, hooks: ZERO}, id: "0x", state: {sqrtPriceX96, tick: 0, protocolFee, lpFee: fee, liquidity: 1n}, source: "listed"}, zeroForOne, currencyIn: zeroForOne ? currency0 : currency1, currencyOut: zeroForOne ? currency1 : currency0};
}
const route = (...hops: V4Hop[]): V4Route => ({currencyIn: hops[0]!.currencyIn, currencyOut: hops[hops.length - 1]!.currencyOut, hops, label: "t", poolFee: hops.map((h) => `${h.pool.key.fee / 10_000}%`).join(" + ")});
/** The same route as the v3 measures read it. */
const v3Hops = (r: V4Route): Hop[] => r.hops.map((h) => ({tokenIn: h.currencyIn, tokenOut: h.currencyOut, fee: h.pool.key.fee}));
const prices = (r: V4Route) => r.hops.map((h) => h.pool.state.sqrtPriceX96);

describe("U0V4-1: the v4 spot loss is v3's, rounded down — a deep pool under the limit is not refused", () => {
  it("one 0.3% hop at price 1, 10¹² in, 0.997 × in − 1 out: 30 / 0, as v3 (31 / 1 before)", () => {
    const r = route(hop(A, B, A, 2n ** 96n, 3000));
    const amountIn = 10n ** 12n;
    const out = (amountIn * 997n) / 1000n - 1n;
    expect([v4SpotLossBps(r, amountIn, out), v4SpotImpactNetOfFeesBps(r, amountIn, out)]).toEqual([30, 0]);
    expect([spotValueLossBps(v3Hops(r), prices(r), amountIn, out), spotImpactNetOfFeesBps(v3Hops(r), prices(r), amountIn, out)]).toEqual([30, 0]);
  });

  it("the same figures as v3's measures over the same pools, one and two hops, either direction (a deterministic sweep)", () => {
    let seed = 0x2545f491n;
    const next = (bits: bigint) => {
      seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n);
      return seed >> (64n - bits);
    };
    const fees = [0, 1, 50, 100, 500, 3000, 10_000];
    let compared = 0;
    for (let i = 0; i < 400; i++) {
      const p1 = (1n << 80n) + next(30n) * (1n << 66n); // prices spread over ~2⁻³² .. 2³²
      const p2 = (1n << 90n) + next(30n) * (1n << 70n);
      const f1 = fees[Number(next(3n)) % fees.length]!, f2 = fees[Number(next(3n)) % fees.length]!;
      const hops = i % 2 === 0 ? [hop(A, B, i % 4 === 0 ? A : B, p1, f1)] : [hop(A, B, A, p1, f1), hop(B, C, B, p2, f2)];
      const r = route(...hops);
      const amountIn = 10n ** 6n + next(40n);
      // An output near the mid less the fees, either side of a whole bp.
      const mid = hops.reduce((x, h) => (h.zeroForOne ? (x * h.pool.state.sqrtPriceX96 ** 2n) / 2n ** 192n : (x * 2n ** 192n) / h.pool.state.sqrtPriceX96 ** 2n), amountIn);
      if (mid < 10_000n) continue;
      const out = (mid * (10_000n - next(7n))) / 10_000n - next(2n);
      if (out <= 0n) continue;
      expect([i, v4SpotLossBps(r, amountIn, out)]).toEqual([i, spotValueLossBps(v3Hops(r), prices(r), amountIn, out)]);
      expect([i, v4SpotImpactNetOfFeesBps(r, amountIn, out)]).toEqual([i, spotImpactNetOfFeesBps(v3Hops(r), prices(r), amountIn, out)]);
      compared++;
    }
    expect(compared).toBeGreaterThan(300);
  });

  it("the provider: the deep MON/AUSD 0.05% pool one raw unit under its mid less the fee (true loss 5.000…1 bps) passes a limit of 6, refused at 5 for its fee", async () => {
    const out = (MON * 9_995n) / 10_000n - 1n;
    const at6 = await quote(nativeNode(out).fetch, monToAusd(), {v4: "native-in", maxPriceImpactBps: 6});
    expect(at6.heard).toEqual([]); // before: refused, "the route's fees (0.05%) bring it to the limit … (limit 0.06%…)"
    expect(at6.q).toMatchObject({destAmount: out.toString(), txRequest: {to: D4.universalRouter}, providerData: {venue: "v4", valueLossBps: "5"}});
    const at5 = await quote(nativeNode(out).fetch, monToAusd(), {v4: "native-in", maxPriceImpactBps: 5});
    expect(at5.q).toBeNull();
    expect(at5.heard).toEqual([["uniswap: loses 0.1% of the value to price impact and pool fees — the route's fees (0.05%) bring it to the limit; its price impact alone is under it (limit 0.05%; best route v4 direct 0.05%/1)", {reason: "insufficient_liquidity"}]]);
  });
});

describe("U0V4-2: the fee text names a pool's protocol fee where it takes one", () => {
  it("a route's fees: each LP fee, and the protocol fee of the swap's direction (none: the route's poolFee)", () => {
    const plain = route(hop(A, B, A, 2n ** 96n, 500), hop(B, C, B, 2n ** 96n, 50));
    expect(v4RouteFeesText(plain)).toBe(plain.poolFee);
    expect(v4RouteFeesText(plain)).toBe("0.05% + 0.005%");
    expect(v4RouteFeesText(route(hop(A, B, A, 2n ** 96n, 500, 1000), hop(B, C, B, 2n ** 96n, 50)))).toBe("0.05% + 0.1% protocol + 0.005%");
    expect(v4RouteFeesText(route(hop(A, B, A, 2n ** 96n, 500, 1000 << 12)))).toBe("0.05%"); // the other direction's: not this swap's
    expect(v4RouteFeesText(route(hop(A, B, B, 2n ** 96n, 500, 1000 << 12)))).toBe("0.05% + 0.1% protocol");
  });

  it("MON/AUSD 0.05% taking a 0.1% protocol fee, paying its mid less both (0.15%): refused at 10 naming both fees", async () => {
    const out = (MON * 9_985n) / 10_000n;
    const {q, heard} = await quote(nativeNode(out, 1000).fetch, monToAusd(), {v4: "native-in", maxPriceImpactBps: 10});
    expect(q).toBeNull();
    // Before: "the route's fees (0.05%) bring it to a 0.1% limit".
    expect(heard).toEqual([["uniswap: loses 0.1% of the value to price impact and pool fees — the route's fees (0.05% + 0.1% protocol) bring it to the limit; its price impact alone is under it (limit 0.1%; best route v4 direct 0.05%/1)", {reason: "insufficient_liquidity"}]]);
    expect(/^loses ([\d.]+)% of the value to price impact/.exec(heard[0]![0].replace(/^uniswap: /, ""))?.[1]).toBe("0.1"); // cp0x refusals.ts
    // The other direction's protocol fee is not this swap's: net of its 0.05% the same route loses 10 bps — too thin.
    const other = await quote(nativeNode(out, 1000 << 12).fetch, monToAusd(), {v4: "native-in", maxPriceImpactBps: 10});
    expect(other.heard).toEqual([["uniswap: loses 0.1% of the value to price impact — its pools are too thin for this amount (limit 0.1%; best route v4 direct 0.05%/1)", {reason: "insufficient_liquidity"}]]);
    // Under the limit it goes out.
    expect((await quote(nativeNode(out, 1000).fetch, monToAusd(), {v4: "native-in", maxPriceImpactBps: 16})).q).toMatchObject({providerData: {venue: "v4", valueLossBps: "15"}});
  });
});

describe("U0V4-3: eth_simulateV1 answering null is no answer — asked again, never v3 in v4's place at once", () => {
  it("null once: asked again, the v4 route is simulated and quoted (approve + swap), no alert", async () => {
    const s = overriding(tokenNode().fetch, (r, seen) => (r.method === "eth_simulateV1" && seen === 0 ? {result: null} : undefined));
    const {q, heard, warned} = await quote(s.fetch, usdcToAusd(), {v4: "all"});
    expect(heard).toEqual([]);
    // Before: v3's 699000000, "the best Uniswap v4 route on chain 143 was set aside (the approve + swap simulation … came
    // back in another shape …) — quoted v3", eth_simulateV1 asked once.
    expect(warned).toEqual([]);
    expect(q).toMatchObject({destAmount: "700500000", txRequest: {to: D4.swapProxy}, providerData: {venue: "v4", simulated: "approve+swap"}});
    expect(s.calls.filter((c) => c.method === "eth_simulateV1")).toHaveLength(2);
  });

  it("null every time: retried as any unanswered simulation, then the check goes on to its other simulations (never read as an answer)", async () => {
    const s = overriding(tokenNode().fetch, (r) => (r.method === "eth_simulateV1" ? {result: null} : undefined));
    const {warned} = await quote(s.fetch, usdcToAusd(), {v4: "all"});
    expect(s.calls.filter((c) => c.method === "eth_simulateV1")).toHaveLength(4); // one pass, then one with the item retries
    expect(s.calls.some((c) => c.method === "eth_createAccessList")).toBe(true); // the allowance-override fallback
    // (The fake node runs no executor, so past the fallbacks it ends on v3 — never with "came back in another shape".)
    expect(JSON.stringify(warned)).not.toMatch(/another shape/);
  });
});
