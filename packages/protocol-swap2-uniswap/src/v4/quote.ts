import {decodeAbiParameters, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {bigintToNumber} from "@anywalletkit/core";
import {refusal, refusalOf, withReason} from "@anywalletkit/protocol-swap2-core/errors";
import {MULTICALL3, type V4BlockTag, type V4EthCall, type V4Pool} from "./discover.js";
import {V4_NATIVE} from "./addresses.js";
import {spotImpactNetOfFeesBps, spotValueLossBps, type Hop} from "../impact.js";

/**
 * Uniswap v4 quotes on the V4Quoter (research §3.3): single-pool and two-pool exact-input candidates over the pools
 * {@link discoverV4Pools} found, the best by output, and the two price-impact measures the v3 path uses — a 1/1000
 * probe on the same route and the value lost against the pools' fee-free mid prices (slot0 at the discovery block).
 *
 * `NotEnoughLiquidity(poolId)` — raw, or wrapped in `UnexpectedRevertBytes(bytes)` — is a partial fill: the candidate
 * is out, and if nothing fills the whole input the answer is `insufficient_liquidity`. Any other revert with data drops
 * the candidate. A failure without revert data (out of gas, a node that strips it) or a transport error is not a fact
 * about the pool: the quote refuses (`upstream_unavailable` / the caller's reason) instead of ranking fewer candidates —
 * unless the caller gives a {@link V4GasBound}: then such a call is read again alone, straight to the quoter, with the
 * chain's per-transaction gas bound named, and one that still fails without revert data needs more gas than any
 * transaction on the chain may have — it could never be mined (§6.5 row 17), so it is not a route ("unexecutable", counted
 * on the result). Anything else that read again says (an answer, revert data, a transport error) is taken as it is.
 *
 * Pure over an injected {@link V4CallBatch} (a JSON-RPC batch with per-item revert data, or {@link multicallBatch}).
 */

export const V4_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "struct PathKey { address intermediateCurrency; uint24 fee; int24 tickSpacing; address hooks; bytes hookData; }",
  "struct QuoteExactParams { address exactCurrency; PathKey[] path; uint128 exactAmount; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)",
  "function quoteExactInput(QuoteExactParams params) returns (uint256 amountOut, uint256 gasEstimate)",
]);

/** V4Quoter / PoolManager error selectors the classifier knows (research §3.9). */
export const V4_ERRORS = Object.freeze({
  UnexpectedRevertBytes: "0x6190b2b0",
  NotEnoughLiquidity: "0x7a5ed734",
  PoolNotInitialized: "0x486aa307",
  PriceLimitAlreadyExceeded: "0x7c9c6e8f",
  SwapAmountCannotBeZero: "0xbe8b8507",
  WrappedError: "0x90bfb865",
} as const);

const UINT128_MAX = (1n << 128n) - 1n;
const Q192 = 1n << 192n;
/** Default candidate caps: pools per pair kept for a direct route, and per leg of a two-pool route (by in-range liquidity). */
export const V4_MAX_DIRECT = 8;
export const V4_MAX_PER_LEG = 4;
/**
 * Quoter calls per aggregate3 in {@link multicallBatch}. A V4Quoter call is 40–150k gas on a normal size but crossed
 * 2.2M on a pool-draining one (Monad, 1e9 MON): 10 keeps one aggregate under the common 50M eth_call cap. A sub-call that
 * runs out of gas comes back without revert data, which refuses the quote rather than dropping the route.
 */
export const V4_QUOTES_PER_AGGREGATE = 10;

/** One call's outcome: its return data, or the revert data it failed with ("0x" when the node gave none). */
export type V4CallOutcome = {ok: true; data: Hex} | {ok: false; revert: Hex};
/**
 * Runs read-only calls at the quote's block and returns one outcome per call, in order. A revert is an outcome; any
 * other failure (transport, rate limit, a per-item batch error that is not a revert) must throw, ideally with a refusal
 * reason attached.
 */
export type V4CallBatch = (calls: readonly {to: Hex; data: Hex}[]) => Promise<readonly V4CallOutcome[]>;

export interface V4Hop {
  pool: V4Pool;
  zeroForOne: boolean;
  currencyIn: Hex;
  currencyOut: Hex;
}
export interface V4Route {
  currencyIn: Hex;
  currencyOut: Hex;
  /** One or two pools. */
  hops: readonly V4Hop[];
  /** e.g. "v4 direct 0.05%/10", "v4 via USDC 0.05%/10 → 0.005%/1". */
  label: string;
  /** The LP fees the route pays (already inside the quoted output). */
  poolFee: string;
}

export interface V4Candidate {
  route: V4Route;
  /** "unexecutable": it needs more gas than one transaction on the chain may have (see {@link V4GasBound}). */
  outcome: "quoted" | "partial" | "dropped" | "unexecutable";
  amountOut?: bigint;
  gasEstimate?: bigint;
  /** The revert selector of a dropped or partial candidate. */
  error?: string;
}
export interface V4QuoteResult {
  best: {route: V4Route; amountOut: bigint; gasEstimate: bigint} | null;
  /** A candidate could not fill the whole input. */
  partial: boolean;
  /** Candidates left out because they need more gas than one transaction on the chain may have. */
  unexecutable: number;
  candidates: V4Candidate[];
}

/**
 * How a quoter call that failed without revert data is told apart from a node that did not answer (§6.5 row 17): `cap`,
 * the most gas one transaction on the chain may have (its per-transaction cap), and `calls`, which runs each call alone,
 * straight to the quoter, with exactly `cap` gas named, at the quote's block — one outcome per call (a revert is an
 * outcome; a call the node did not answer, or answered under a gas cap of its own below `cap`, throws, classified).
 * Given only for a chain whose per-transaction cap is known.
 */
export interface V4GasBound {
  cap: bigint;
  calls: (calls: readonly {to: Hex; data: Hex}[]) => Promise<readonly V4CallOutcome[]>;
}

const lc = (a: string) => a.toLowerCase();
const pct = (pips: number) => `${pips / 10_000}%`;

function hopOf(pool: V4Pool, currencyIn: Hex): V4Hop | null {
  const c0 = lc(pool.key.currency0), c1 = lc(pool.key.currency1), x = lc(currencyIn);
  if (x !== c0 && x !== c1) return null;
  const zeroForOne = x === c0;
  return {pool, zeroForOne, currencyIn: zeroForOne ? pool.key.currency0 : pool.key.currency1, currencyOut: zeroForOne ? pool.key.currency1 : pool.key.currency0};
}

/** The pools of one pair, deepest in-range liquidity first (L is comparable within a pair), at most `cap`. */
function topPools(pools: readonly V4Pool[], a: Hex, b: Hex, cap: number): V4Pool[] {
  const x = lc(a), y = lc(b);
  return pools
    .filter((p) => (lc(p.key.currency0) === x && lc(p.key.currency1) === y) || (lc(p.key.currency0) === y && lc(p.key.currency1) === x))
    .sort((p, q) => (p.state.liquidity > q.state.liquidity ? -1 : p.state.liquidity < q.state.liquidity ? 1 : p.key.fee - q.key.fee || (p.id < q.id ? -1 : 1)))
    .slice(0, cap);
}

/**
 * Every candidate route currencyIn → currencyOut over the discovered pools: each direct pool (the deepest
 * `maxDirect`), and for each hub each pair of legs (the deepest `maxPerLeg` per leg). Never more than two pools, never
 * through the input or output currency, so no cycles.
 */
export function buildV4Routes(args: {currencyIn: Hex; currencyOut: Hex; pools: readonly V4Pool[]; hubs: readonly Hex[]; hubName?: (hub: Hex) => string; maxDirect?: number; maxPerLeg?: number}): V4Route[] {
  const {currencyIn, currencyOut, pools, hubs} = args;
  const maxDirect = args.maxDirect ?? V4_MAX_DIRECT, maxPerLeg = args.maxPerLeg ?? V4_MAX_PER_LEG;
  const out: V4Route[] = [];
  for (const p of topPools(pools, currencyIn, currencyOut, maxDirect)) {
    const h = hopOf(p, currencyIn)!;
    out.push({currencyIn, currencyOut, hops: [h], label: `v4 direct ${pct(p.key.fee)}/${p.key.tickSpacing}`, poolFee: pct(p.key.fee)});
  }
  const used = new Set<string>();
  for (const hub of hubs) {
    const m = lc(hub);
    if (m === lc(currencyIn) || m === lc(currencyOut) || used.has(m)) continue;
    used.add(m);
    const name = args.hubName?.(hub) ?? (m === V4_NATIVE ? "native" : getAddress(hub));
    for (const p1 of topPools(pools, currencyIn, hub, maxPerLeg)) {
      for (const p2 of topPools(pools, hub, currencyOut, maxPerLeg)) {
        const h1 = hopOf(p1, currencyIn)!, h2 = hopOf(p2, hub)!;
        out.push({currencyIn, currencyOut, hops: [h1, h2], label: `v4 via ${name} ${pct(p1.key.fee)}/${p1.key.tickSpacing} → ${pct(p2.key.fee)}/${p2.key.tickSpacing}`, poolFee: `${pct(p1.key.fee)} + ${pct(p2.key.fee)}`});
      }
    }
  }
  return out;
}

/** The V4Quoter calldata for a route at `amountIn` (exact input, no hook data). */
export function quoteCallData(route: V4Route, amountIn: bigint): Hex {
  if (amountIn <= 0n || amountIn > UINT128_MAX) throw refusal("amount_too_large", "uniswap v4: the amount does not fit the quoter's uint128");
  if (route.hops.length === 1) {
    const h = route.hops[0]!;
    return encodeFunctionData({abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{poolKey: h.pool.key, zeroForOne: h.zeroForOne, exactAmount: amountIn, hookData: "0x"}]});
  }
  if (route.hops.length !== 2) throw new Error("uniswap v4: a route is one or two pools");
  return encodeFunctionData({
    abi: V4_QUOTER_ABI,
    functionName: "quoteExactInput",
    args: [{
      exactCurrency: route.currencyIn,
      path: route.hops.map((h) => ({intermediateCurrency: h.currencyOut, fee: h.pool.key.fee, tickSpacing: h.pool.key.tickSpacing, hooks: h.pool.key.hooks, hookData: "0x" as Hex})),
      exactAmount: amountIn,
    }],
  });
}

/**
 * The same V4Quoter calldata as {@link quoteCallData}, from the pool keys alone (preflight rebuilds the quoted route from
 * `providerData.poolKeys`): hop i sells the running currency into its pool's other currency. Throws when a pool does not
 * hold the running currency, or for more than two pools.
 */
export function quoteCallDataOfKeys(currencyIn: Hex, keys: readonly {currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex}[], amountIn: bigint): Hex {
  if (keys.length < 1 || keys.length > 2) throw new Error("uniswap v4: a route is one or two pools");
  let cur = lc(currencyIn);
  const hops: V4Hop[] = keys.map((key) => {
    const c0 = lc(key.currency0), c1 = lc(key.currency1);
    if (cur !== c0 && cur !== c1) throw new Error("uniswap v4: the pools of the route are not continuous");
    const zeroForOne = cur === c0;
    cur = zeroForOne ? c1 : c0;
    const pool: V4Pool = {key: {currency0: getAddress(key.currency0), currency1: getAddress(key.currency1), fee: key.fee, tickSpacing: key.tickSpacing, hooks: getAddress(key.hooks)}, id: "0x", state: {sqrtPriceX96: 0n, tick: 0, protocolFee: 0, lpFee: key.fee, liquidity: 0n}, source: "listed"};
    return {pool, zeroForOne, currencyIn: zeroForOne ? pool.key.currency0 : pool.key.currency1, currencyOut: zeroForOne ? pool.key.currency1 : pool.key.currency0};
  });
  return quoteCallData({currencyIn: getAddress(currencyIn), currencyOut: hops[hops.length - 1]!.currencyOut, hops, label: "", poolFee: ""}, amountIn);
}

/** Decodes a V4Quoter answer strictly — exactly (uint256 amountOut, uint256 gasEstimate) — or throws `upstream_unavailable`. */
export function decodeV4QuoteAnswer(data: Hex): {amountOut: bigint; gasEstimate: bigint} {
  return decodeQuoteAnswer(data);
}

/** What a quoter revert means: "partial" (NotEnoughLiquidity, raw or wrapped), "dropped" (any other error), "empty" (no data). */
export function classifyV4QuoteRevert(data: Hex): {kind: "partial" | "dropped" | "empty"; selector?: string} {
  let d = lc(data) as Hex;
  for (let depth = 0; depth < 3 && d.startsWith(V4_ERRORS.UnexpectedRevertBytes); depth++) {
    try {
      [d] = decodeAbiParameters([{type: "bytes"}], `0x${d.slice(10)}`) as unknown as [Hex];
      d = lc(d) as Hex;
    } catch {
      return {kind: "dropped", selector: V4_ERRORS.UnexpectedRevertBytes};
    }
  }
  if (d.length < 10) return d.length > 2 ? {kind: "dropped", selector: d} : {kind: "empty"};
  const selector = d.slice(0, 10);
  return {kind: selector === V4_ERRORS.NotEnoughLiquidity ? "partial" : "dropped", selector};
}

/** Decodes a quoter answer strictly: exactly (uint256 amountOut, uint256 gasEstimate). */
function decodeQuoteAnswer(data: Hex): {amountOut: bigint; gasEstimate: bigint} {
  // Both entry points return (uint256 amountOut, uint256 gasEstimate).
  if ((data.length - 2) / 2 !== 64) throw refusal("upstream_unavailable", `uniswap v4: the quoter answered ${(data.length - 2) / 2} bytes, not 64 — refusing`);
  const [amountOut, gasEstimate] = decodeAbiParameters([{type: "uint256"}, {type: "uint256"}], data);
  return {amountOut, gasEstimate};
}

/** Better route first: more output, then fewer pools, then the lower fee sum, then the label (deterministic). */
function better(a: {route: V4Route; amountOut: bigint}, b: {route: V4Route; amountOut: bigint}): boolean {
  if (a.amountOut !== b.amountOut) return a.amountOut > b.amountOut;
  if (a.route.hops.length !== b.route.hops.length) return a.route.hops.length < b.route.hops.length;
  const fa = a.route.hops.reduce((s, h) => s + h.pool.key.fee, 0), fb = b.route.hops.reduce((s, h) => s + h.pool.key.fee, 0);
  if (fa !== fb) return fa < fb;
  return a.route.label < b.route.label;
}

/**
 * The best full fill among `candidates` whose every pool `allow`s (default: all) — more output, then fewer pools, then the
 * lower fee sum, then the label — or null.
 */
export function bestV4Candidate(candidates: readonly V4Candidate[], allow: (pool: V4Pool) => boolean = () => true): V4QuoteResult["best"] {
  return rankedV4Candidates(candidates, allow)[0] ?? null;
}

/**
 * Every full fill among `candidates` whose every pool `allow`s (default: all) and that `keep` keeps (default: all), best
 * first — the order {@link bestV4Candidate} picks by: a provider that cannot build the best one falls back to the next.
 */
export function rankedV4Candidates(
  candidates: readonly V4Candidate[],
  allow: (pool: V4Pool) => boolean = () => true,
  keep: (c: NonNullable<V4QuoteResult["best"]>) => boolean = () => true,
): NonNullable<V4QuoteResult["best"]>[] {
  const out: NonNullable<V4QuoteResult["best"]>[] = [];
  for (const c of candidates) {
    if (c.outcome !== "quoted" || c.amountOut === undefined || c.gasEstimate === undefined || !c.route.hops.every((h) => allow(h.pool))) continue;
    const x = {route: c.route, amountOut: c.amountOut, gasEstimate: c.gasEstimate};
    if (keep(x)) out.push(x);
  }
  return out.sort((a, b) => (better(a, b) ? -1 : better(b, a) ? 1 : 0));
}

const asQuoterReadFailure = (e: unknown): Error => (refusalOf(e) ? (e as Error) : withReason(new Error(`uniswap v4: the quoter read failed (${e instanceof Error ? e.message : String(e)})`), "upstream_unavailable"));

/** Quotes every route at `amountIn` and picks the best full fill (see the module comment for failure handling). */
export async function quoteV4Routes(args: {quoter: Hex; routes: readonly V4Route[]; amountIn: bigint; gasBound?: V4GasBound | undefined}, batch: V4CallBatch): Promise<V4QuoteResult> {
  const quoter = getAddress(args.quoter);
  if (!args.routes.length) return {best: null, partial: false, unexecutable: 0, candidates: []};
  const calls = args.routes.map((r) => ({to: quoter, data: quoteCallData(r, args.amountIn)}));
  let outcomes: V4CallOutcome[];
  try {
    outcomes = [...(await batch(calls))];
  } catch (e) {
    throw asQuoterReadFailure(e);
  }
  if (outcomes.length !== calls.length) throw refusal("upstream_unavailable", `uniswap v4: ${outcomes.length} quoter answers for ${calls.length} calls — refusing`);
  // A call without revert data: refused, unless the chain's per-transaction bound tells "too much gas for any
  // transaction" (read again alone at the bound, still without data) from a node that did not answer.
  const empty = outcomes.flatMap((o, i) => (!o.ok && classifyV4QuoteRevert(o.revert).kind === "empty" ? [i] : []));
  const unexecutableAt = new Set<number>();
  if (empty.length) {
    const bound = args.gasBound;
    if (!bound) throw refusal("upstream_unavailable", `uniswap v4: a quoter call failed without revert data (${args.routes[empty[0]!]!.label}) — refusing rather than ranking fewer routes`);
    let again: readonly V4CallOutcome[];
    try {
      again = await bound.calls(empty.map((i) => calls[i]!));
    } catch (e) {
      throw asQuoterReadFailure(e);
    }
    if (again.length !== empty.length) throw refusal("upstream_unavailable", `uniswap v4: ${again.length} answers for ${empty.length} quoter calls read again — refusing`);
    empty.forEach((i, j) => {
      const o = again[j]!;
      if (!o.ok && classifyV4QuoteRevert(o.revert).kind === "empty") unexecutableAt.add(i);
      else outcomes[i] = o;
    });
  }
  const candidates: V4Candidate[] = [];
  let best: V4QuoteResult["best"] = null;
  let partial = false;
  args.routes.forEach((route, i) => {
    if (unexecutableAt.has(i)) {
      candidates.push({route, outcome: "unexecutable"});
      return;
    }
    const o = outcomes[i]!;
    if (!o.ok) {
      const c = classifyV4QuoteRevert(o.revert);
      if (c.kind === "empty") throw refusal("upstream_unavailable", `uniswap v4: a quoter call failed without revert data (${route.label}) — refusing rather than ranking fewer routes`);
      if (c.kind === "partial") partial = true;
      candidates.push({route, outcome: c.kind, ...(c.selector ? {error: c.selector} : {})});
      return;
    }
    const {amountOut, gasEstimate} = decodeQuoteAnswer(o.data);
    if (amountOut <= 0n) {
      candidates.push({route, outcome: "dropped", amountOut});
      return;
    }
    candidates.push({route, outcome: "quoted", amountOut, gasEstimate});
    const c = {route, amountOut, gasEstimate};
    if (!best || better(c, best)) best = c;
  });
  return {best, partial, unexecutable: unexecutableAt.size, candidates};
}

/** An eth_call refused for gas (the node's eth_call cap or the block gas limit), by its message. */
const OUT_OF_GAS = /out of gas|gas required exceeds|exceeds (the )?(block )?gas limit|gas limit (reached|exceeded)|intrinsic gas/i;

/**
 * A {@link V4CallBatch} over Multicall3 `aggregate3` (allowFailure, so a revert comes back as data), `perAggregate`
 * calls per request, all at `blockTag`. The aggregate itself failing or answering in another shape throws.
 *
 * Gas: a node caps eth_call gas (Avalanche's public RPC ran out on 10 quotes of 1 AVAX, 2026-11-26: two routes there
 * cost 5.9M each), and inside an aggregate a sub-call that runs out of gas fails with no revert data, or with
 * `UnexpectedRevertBytes("")` when the quoter's own inner call starved. Either way the chunk is split in two and each half
 * read again, down to single calls, so every route is still quoted; a single call that still fails stays a failure
 * (an error, or an outcome without revert data, which refuses the quote). Nothing is dropped.
 */
export function multicallBatch(ethCall: V4EthCall, blockTag: V4BlockTag, multicall: Hex = MULTICALL3, perAggregate: number = V4_QUOTES_PER_AGGREGATE): V4CallBatch {
  if (!Number.isInteger(perAggregate) || perAggregate < 1) throw new Error("uniswap v4: perAggregate must be a positive integer");
  const abi = parseAbi([
    "struct Call3 { address target; bool allowFailure; bytes callData; }",
    "struct Result { bool success; bytes returnData; }",
    "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
  ]);
  type Calls = Parameters<V4CallBatch>[0];
  const split = async (chunk: Calls): Promise<V4CallOutcome[]> => {
    const mid = Math.ceil(chunk.length / 2);
    const [a, b] = await Promise.all([run(chunk.slice(0, mid)), run(chunk.slice(mid))]);
    return [...a, ...b];
  };
  const run = async (chunk: Calls): Promise<V4CallOutcome[]> => {
    let raw: Hex;
    try {
      raw = await ethCall({to: multicall, data: encodeFunctionData({abi, functionName: "aggregate3", args: [chunk.map((c) => ({target: c.to, allowFailure: true, callData: c.data}))]})}, blockTag);
    } catch (e) {
      if (chunk.length > 1 && OUT_OF_GAS.test(e instanceof Error ? e.message : String(e))) return split(chunk);
      throw e;
    }
    let res: readonly {success: boolean; returnData: Hex}[];
    try {
      res = decodeFunctionResult({abi, functionName: "aggregate3", data: raw});
    } catch {
      throw refusal("upstream_unavailable", "uniswap v4: the quote read answered in another shape — refusing");
    }
    if (res.length !== chunk.length) throw refusal("upstream_unavailable", `uniswap v4: the quote read returned ${res.length} answers for ${chunk.length} calls — refusing`);
    const out = res.map((r): V4CallOutcome => (r.success ? {ok: true, data: r.returnData} : {ok: false, revert: r.returnData}));
    // No revert data — raw, or wrapped empty by the quoter (its own inner call starved) — is how a sub-call that ran out
    // of the aggregate's gas looks: read it again with more gas per call.
    if (chunk.length > 1 && out.some((o) => !o.ok && classifyV4QuoteRevert(o.revert).kind === "empty")) return split(chunk);
    return out;
  };
  return async (calls) => {
    const chunks: Calls[] = [];
    for (let i = 0; i < calls.length; i += perAggregate) chunks.push(calls.slice(i, i + perAggregate));
    return (await Promise.all(chunks.map(run))).flat();
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Price-impact measures (same as the v3 path): both are information unless the app set `maxPriceImpactBps`.
// ---------------------------------------------------------------------------------------------------------------------

/** One hop's fee-free output at the pool's mid price (sqrtPriceX96² / 2^192 currency1 per currency0). */
function midOut(hop: V4Hop, amountIn: bigint): bigint {
  const p2 = hop.pool.state.sqrtPriceX96 * hop.pool.state.sqrtPriceX96;
  if (p2 === 0n) return 0n;
  return hop.zeroForOne ? (amountIn * p2) / Q192 : (amountIn * Q192) / p2;
}

/** What the route would pay at the pools' mid prices with no fees and no impact (0 when unmeasurable). */
export function v4SpotOut(route: V4Route, amountIn: bigint): bigint {
  let x = amountIn;
  for (const h of route.hops) x = midOut(h, x);
  return x;
}

/**
 * The route's pools as the v3 measures read them ({@link spotValueLossBps}): one {@link Hop} per pool — `fee` the swap
 * fee the pool takes in this direction ({@link swapFeePips}) when `netOfFees` — and the pools' mid prices. A v4 key is
 * sorted (currency0 < currency1), so the v3 measures' address order is the hop's direction; a hop that says otherwise,
 * or a fee no pool can charge, is not measured.
 */
function midHops(route: V4Route, netOfFees: boolean): {hops: Hop[]; prices: bigint[]} | undefined {
  const hops: Hop[] = [];
  const prices: bigint[] = [];
  for (const h of route.hops) {
    if ((BigInt(h.currencyIn) < BigInt(h.currencyOut)) !== h.zeroForOne) return undefined;
    const fee = netOfFees ? swapFeePips(h) : 0;
    if (fee === undefined) return undefined;
    hops.push({tokenIn: h.currencyIn, tokenOut: h.currencyOut, fee});
    prices.push(h.pool.state.sqrtPriceX96);
  }
  return {hops, prices};
}

/**
 * Value lost against the fee-free mid prices, in bps (fees included), 0..10000: the v3 measure ({@link spotValueLossBps})
 * over the route's pools — the output's exact shortfall against `amountIn × Π rate`, rounded down to a whole bp, so
 * `loss ≥ limit` holds exactly when the true loss reaches the limit (U0V4-1: `10000 − ⌊out × 10000 / spotOut⌋` rounded
 * the loss up by as much as 1 bp, and the gate refused a deep pool under its limit). Undefined when the mid output
 * rounds to 0.
 */
export function v4SpotLossBps(route: V4Route, amountIn: bigint, amountOut: bigint): number | undefined {
  if (v4SpotOut(route, amountIn) <= 0n) return undefined;
  const m = midHops(route, false);
  return m && spotValueLossBps(m.hops, m.prices, amountIn, amountOut);
}

/** The protocol fee a hop's pool takes in the swap's direction, in pips (12 bits each, low = zeroForOne). */
function protocolFeePips(hop: V4Hop): number {
  const pf = hop.pool.state.protocolFee;
  return hop.zeroForOne ? pf & 0xfff : (pf >> 12) & 0xfff;
}

/**
 * One hop's swap fee in pips, as the PoolManager takes it from the input: the LP fee, and where the pool pays a protocol
 * fee in this direction (12 bits each, low = zeroForOne) both, `protocolFee + lpFee − protocolFee × lpFee / 10⁶` (v4's
 * ProtocolFeeLibrary.calculateSwapFee). Undefined when it is not a fee a pool can charge.
 */
function swapFeePips(hop: V4Hop): number | undefined {
  const lp = hop.pool.state.lpFee;
  const pf = hop.pool.state.protocolFee;
  if (!Number.isInteger(lp) || lp < 0 || lp >= 1_000_000 || !Number.isInteger(pf) || pf < 0) return undefined;
  const p = protocolFeePips(hop);
  const fee = p === 0 ? lp : p + lp - Math.floor((p * lp) / 1_000_000);
  return fee < 1_000_000 ? fee : undefined;
}

/**
 * The same value loss net of the pools' fees: the v3 measure ({@link spotImpactNetOfFeesBps}) against the mid output
 * after each hop's swap fee (`× (1 − fee)` per pool, the protocol fee included where one is taken), exact and rounded
 * down as {@link v4SpotLossBps} is, so what is left is the price impact alone (and the pools' rounding). It tells a route
 * whose pools are too thin from one that reaches a limit only with its fees (U0C-2 on the v4 path); the gate itself goes
 * by {@link v4SpotLossBps}. Undefined when the mid output rounds to 0.
 */
export function v4SpotImpactNetOfFeesBps(route: V4Route, amountIn: bigint, amountOut: bigint): number | undefined {
  if (v4SpotOut(route, amountIn) <= 0n) return undefined;
  const m = midHops(route, true);
  return m && spotImpactNetOfFeesBps(m.hops, m.prices, amountIn, amountOut);
}

/**
 * The fees a route's pools take from the input, as the impact refusal names them when only they bring the loss to the
 * limit (U0C-2): each pool's LP fee, and where the pool takes a protocol fee in the swap's direction that one too
 * ("0.05% + 0.1% protocol") — the fees {@link v4SpotImpactNetOfFeesBps} nets out (U0V4-2: the text named the LP fees
 * alone, "0.05%", for a 0.15% swap fee). Without a protocol fee it is the route's `poolFee`.
 */
export function v4RouteFeesText(route: V4Route): string {
  return route.hops.map((h) => {
    const p = protocolFeePips(h);
    return p > 0 ? `${pct(h.pool.key.fee)} + ${pct(p)} protocol` : pct(h.pool.key.fee);
  }).join(" + ");
}

/**
 * The v3 probe on the same route: the full-size rate's shortfall against a 1/1000 quote's rate, in bps (pool fees
 * cancel). Tried twice; undefined when it cannot be measured (amount too small to probe, the probe reverted or failed).
 */
export async function v4ProbeImpactBps(args: {quoter: Hex; route: V4Route; amountIn: bigint; amountOut: bigint}, batch: V4CallBatch): Promise<number | undefined> {
  const probeIn = args.amountIn / 1000n;
  if (probeIn <= 0n || args.amountOut <= 0n) return undefined;
  const call = {to: getAddress(args.quoter), data: quoteCallData(args.route, probeIn)};
  for (let attempt = 0; attempt < 2; attempt++) {
    let o: V4CallOutcome | undefined;
    try {
      [o] = await batch([call]);
    } catch {
      continue;
    }
    if (!o?.ok || (o.data.length - 2) / 2 !== 64) return undefined;
    const {amountOut: probeOut} = decodeQuoteAnswer(o.data);
    if (probeOut <= 0n) return undefined;
    const ratioBps = (args.amountOut * probeIn * 10_000n) / (probeOut * args.amountIn);
    return Math.max(0, bigintToNumber(10_000n - ratioBps));
  }
  return undefined;
}

/**
 * Both measures for the chosen route: `probeBps` (the 1/1000 probe, fees excluded) and `spotBps` (the spot value loss
 * against the pools' mid prices, fees included), each when it could be measured, and `impactBps`, the larger of the
 * ones that were — the probe alone when spot could not be. The provider's own gate (`maxPriceImpactBps`) never passes
 * on the probe alone (it is blind to a pool parked past an empty range): without `spotBps` it refuses unless the probe
 * already reaches the limit. An app gating with this helper does the same — refuse when `spotBps` is undefined (and
 * when `impactBps` is), else gate on `impactBps`. The provider does not call it.
 */
export async function measureV4Impact(args: {quoter: Hex; route: V4Route; amountIn: bigint; amountOut: bigint}, batch: V4CallBatch): Promise<{probeBps?: number; spotBps?: number; impactBps?: number}> {
  const probeBps = await v4ProbeImpactBps(args, batch);
  const spotBps = v4SpotLossBps(args.route, args.amountIn, args.amountOut);
  const measured = [probeBps, spotBps].filter((x): x is number => x !== undefined);
  return {
    ...(probeBps !== undefined ? {probeBps} : {}),
    ...(spotBps !== undefined ? {spotBps} : {}),
    ...(measured.length ? {impactBps: Math.max(...measured)} : {}),
  };
}
