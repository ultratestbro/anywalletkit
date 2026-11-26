import {decodeAbiParameters, decodeFunctionResult, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {refusal, refusalOf, withReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {V4ChainPools, V4PoolKey} from "../v4pools/types.js";
import {V4_MAX_FEE_PIPS, V4_MAX_TICK, V4_MIN_TICK, checkedHooklessKey, checkedMaxFeePips, pairKeyOf, poolIdOf, type V4Key} from "./pool.js";

/**
 * Uniswap v4 pool discovery (UNISWAP-V4-RESEARCH §5.3, decision 5): the chain's pinned hookless pools for the pair set,
 * plus the integrator's `v4ExtraPools`, read through Multicall3 `aggregate3` on the pinned StateView at one block.
 * Only a token the pinned list does not know adds the union grid (a fixed set of fee/tickSpacing keys) over the pairs
 * that touch it. At most two requests: the listed reads plus the grid's `getSlot0`s, then the grid's `getLiquidity` for
 * the keys that turned out initialized.
 *
 * A failed read refuses the whole discovery (`rate_limited` / `upstream_unavailable`): an RPC error, a sub-call with
 * `success = false`, an answer of the wrong size, or a listed pool reading as uninitialized. It never yields a smaller
 * candidate set. Only a successful read of zeros means "no pool". The fee cap applies to every source.
 *
 * Pure over an injected {@link V4EthCall}: no fetch, no clock, no globals.
 */

/** Multicall3, at the same address on every v4 chain (VERIFIED on all 22, research §3.2). */
export const MULTICALL3: Hex = "0xcA11bde05977b3631167028862bE2a173976CA11";

/**
 * The fee/tickSpacing keys tried for a token the pinned list does not know: the 33-key union that catches every
 * catalog ground-truth pool of the 2026-11-25 research (gaps/pool-discovery §4), standard tiers included.
 */
export const V4_UNLISTED_GRID: readonly (readonly [fee: number, tickSpacing: number])[] = Object.freeze([
  [1, 1], [2, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [14, 1], [20, 1], [25, 1], [32, 1], [35, 1], [48, 1], [50, 1],
  [66, 1], [68, 1], [75, 1], [100, 1], [500, 1], [200, 4], [375, 4], [460, 9], [500, 10], [1000, 20], [1500, 30], [2500, 25],
  [2500, 50], [3000, 30], [3000, 60], [9000, 90], [10000, 200], [20000, 400],
].map((k) => Object.freeze(k) as readonly [number, number]));

/** Most hub currencies one discovery takes (pairs = 1 + 2 × hubs). */
export const V4_MAX_HUBS = 6;
/** Most sub-calls in one discovery request. */
const MAX_CALLS = 1_000;

const MC3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const STATE_VIEW_ABI = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const SLOT0_BYTES = 128;
const LIQUIDITY_BYTES = 32;

/** A block tag every read of one quote shares: a hex block number, or "latest" when the provider does not pin one. */
export type V4BlockTag = Hex | "latest";

/**
 * One `eth_call` at a block, supplied by the provider (its endpoints, failover and retry policy). It returns the
 * call's hex result and throws on anything else — ideally with a refusal reason (`rate_limited`, `upstream_unavailable`)
 * attached; an error without one is treated as `upstream_unavailable`.
 */
export type V4EthCall = (call: {to: Hex; data: Hex}, blockTag: V4BlockTag) => Promise<Hex>;

/** StateView's view of one pool at the discovery block. */
export interface V4PoolState {
  sqrtPriceX96: bigint;
  tick: number;
  /** Both directions' protocol fee, 12 bits each (low = zeroForOne), in pips. */
  protocolFee: number;
  lpFee: number;
  liquidity: bigint;
}

/** A live hookless pool: in range, with liquidity, under the fee cap. */
export interface V4Pool {
  key: V4Key;
  id: Hex;
  state: V4PoolState;
  /** Where it came from: the shipped list, the integrator's `v4ExtraPools`, or the unlisted-token grid. */
  source: "listed" | "extra" | "grid";
}

export interface V4DiscoverParams {
  /** The chain's pinned StateView. */
  stateView: Hex;
  /** Swap currencies (0x0 = the native coin). */
  currencyIn: Hex;
  currencyOut: Hex;
  /** Intermediate currencies for two-pool routes (0x0 = native). At most {@link V4_MAX_HUBS}. */
  hubs: readonly Hex[];
  /** The chain's pinned list (UNISWAP_V4_POOLS[chainId]); without one every currency counts as unlisted. */
  list?: V4ChainPools | undefined;
  /** Integrator pools (`v4ExtraPools[chainId]`): hookless only, PoolId recomputed; an invalid entry throws. */
  extraPools?: readonly V4PoolKey[] | undefined;
  /** LP fee cap in pips (1..100000, default 100000 = 10%). */
  maxFeePips?: number | undefined;
  /** Keys for unlisted currencies (default {@link V4_UNLISTED_GRID}). */
  grid?: readonly (readonly [number, number])[] | undefined;
  /** The block every read runs at. */
  blockTag: V4BlockTag;
  /** Multicall3 override (tests). */
  multicall?: Hex | undefined;
}

export interface V4Discovery {
  pools: V4Pool[];
  /** aggregate3 requests sent (0–2). */
  requests: number;
  /** StateView sub-calls read. */
  reads: number;
  /** The unlisted-token grid ran. */
  grid: boolean;
}

interface Candidate {
  key: V4Key;
  id: Hex;
  source: V4Pool["source"];
}

const lc = (a: string) => a.toLowerCase();

/** The pairs a route may use: direct, and currencyIn → hub → currencyOut for each hub. */
export function pairSetOf(currencyIn: Hex, currencyOut: Hex, hubs: readonly Hex[]): Set<string> {
  const a = lc(currencyIn), b = lc(currencyOut);
  const set = new Set<string>([pairKeyOf(currencyIn, currencyOut)]);
  for (const h of hubs) {
    const x = lc(h);
    if (x === a || x === b) continue;
    set.add(pairKeyOf(currencyIn, h));
    set.add(pairKeyOf(h, currencyOut));
  }
  return set;
}

/** The reason a failed discovery read refuses with: the caller's own classification, else `upstream_unavailable`. */
function asReadFailure(e: unknown, what: string): Error {
  if (refusalOf(e)) return e as Error;
  const msg = e instanceof Error ? e.message : String(e);
  return withReason(new Error(`uniswap v4: ${what} failed (${msg}) — refusing rather than quoting from fewer pools`), "upstream_unavailable");
}

/** One aggregate3 at `blockTag`; every sub-call must succeed with exactly `sizes[i]` bytes. */
async function aggregate(ethCall: V4EthCall, multicall: Hex, calls: readonly {to: Hex; data: Hex}[], sizes: readonly number[], blockTag: V4BlockTag): Promise<Hex[]> {
  const data = encodeFunctionData({abi: MC3_ABI, functionName: "aggregate3", args: [calls.map((c) => ({target: c.to, allowFailure: true, callData: c.data}))]});
  let raw: Hex;
  try {
    raw = await ethCall({to: multicall, data}, blockTag);
  } catch (e) {
    throw asReadFailure(e, "the pool discovery read");
  }
  let results: readonly {success: boolean; returnData: Hex}[];
  try {
    results = decodeFunctionResult({abi: MC3_ABI, functionName: "aggregate3", data: raw});
  } catch {
    throw refusal("upstream_unavailable", "uniswap v4: the pool discovery read answered in another shape — refusing rather than quoting from fewer pools");
  }
  if (results.length !== calls.length) throw refusal("upstream_unavailable", `uniswap v4: the pool discovery read returned ${results.length} answers for ${calls.length} reads — refusing`);
  return results.map((r, i) => {
    if (!r.success) throw refusal("upstream_unavailable", `uniswap v4: a pool state read failed (${r.returnData.slice(0, 10)}) — refusing rather than quoting from fewer pools`);
    if ((r.returnData.length - 2) / 2 !== sizes[i]) throw refusal("upstream_unavailable", `uniswap v4: a pool state read answered ${(r.returnData.length - 2) / 2} bytes, not ${sizes[i]} — refusing`);
    return r.returnData;
  });
}

function decodeSlot0(hex: Hex): Omit<V4PoolState, "liquidity"> {
  const [sqrtPriceX96, tick, protocolFee, lpFee] = decodeAbiParameters([{type: "uint160"}, {type: "int24"}, {type: "uint24"}, {type: "uint24"}], hex);
  return {sqrtPriceX96, tick, protocolFee, lpFee};
}
const decodeLiquidity = (hex: Hex): bigint => decodeAbiParameters([{type: "uint128"}], hex)[0];
const slot0Call = (sv: Hex, id: Hex) => ({to: sv, data: encodeFunctionData({abi: STATE_VIEW_ABI, functionName: "getSlot0", args: [id]})});
const liquidityCall = (sv: Hex, id: Hex) => ({to: sv, data: encodeFunctionData({abi: STATE_VIEW_ABI, functionName: "getLiquidity", args: [id]})});

/** Swappable both ways at this state: liquidity in range and the tick more than one spacing inside the price bounds. */
export function isLive(state: Pick<V4PoolState, "liquidity" | "tick">, tickSpacing: number): boolean {
  return state.liquidity > 0n && state.tick - tickSpacing > V4_MIN_TICK && state.tick + tickSpacing < V4_MAX_TICK;
}

/** Discovers the live hookless pools for one swap (see the module comment). */
export async function discoverV4Pools(params: V4DiscoverParams, ethCall: V4EthCall): Promise<V4Discovery> {
  const maxFee = checkedMaxFeePips(params.maxFeePips);
  if (params.hubs.length > V4_MAX_HUBS) throw new Error(`uniswap v4: at most ${V4_MAX_HUBS} hub currencies`);
  const stateView = getAddress(params.stateView);
  if (params.list?.stateView && getAddress(params.list.stateView) !== stateView) throw refusal("vault_mismatch", `uniswap v4: the pinned pool list was read through StateView ${params.list.stateView}, not ${stateView} — refusing`);
  const multicall = getAddress(params.multicall ?? MULTICALL3);
  const pairs = pairSetOf(params.currencyIn, params.currencyOut, params.hubs);
  const seen = new Set<string>();
  const known: Candidate[] = [];
  const add = (c: Candidate) => {
    if (seen.has(c.id)) return;
    seen.add(c.id);
    known.push(c);
  };

  // The shipped list: every entry is re-checked (key rules, hookless, the cap) and its PoolId recomputed.
  if (params.list) {
    for (const p of params.list.pools) {
      if (!pairs.has(pairKeyOf(p.currency0, p.currency1)) || p.fee > maxFee) continue;
      const key = checkedHooklessKey(p, maxFee);
      const id = poolIdOf(key);
      if (id !== lc(p.id)) throw refusal("policy_refused", `uniswap v4: the pinned pool list entry ${p.id} does not match its key — refusing`);
      add({key, id, source: "listed"});
    }
  }
  // Integrator pools: a hooked or malformed one throws (a configuration error is never skipped silently).
  for (const p of params.extraPools ?? []) {
    const key = checkedHooklessKey(p, V4_MAX_FEE_PIPS);
    if (key.fee > maxFee || !pairs.has(pairKeyOf(key.currency0, key.currency1))) continue;
    add({key, id: poolIdOf(key), source: "extra"});
  }

  // The grid, only over pairs that touch a currency the list does not know.
  const listed = new Set((params.list?.tokens ?? []).map(lc));
  const unlisted = (c: string) => !listed.has(lc(c));
  const gridKeys: Candidate[] = [];
  const grid = params.grid ?? V4_UNLISTED_GRID;
  for (const pair of pairs) {
    const [a, b] = pair.split(":") as [Hex, Hex];
    if (!unlisted(a) && !unlisted(b)) continue;
    for (const [fee, tickSpacing] of grid) {
      if (fee > maxFee) continue;
      const key = checkedHooklessKey({currency0: a, currency1: b, fee, tickSpacing}, maxFee);
      const id = poolIdOf(key);
      if (seen.has(id)) continue;
      seen.add(id);
      gridKeys.push({key, id, source: "grid"});
    }
  }

  const calls = [...known.flatMap((c) => [slot0Call(stateView, c.id), liquidityCall(stateView, c.id)]), ...gridKeys.map((c) => slot0Call(stateView, c.id))];
  if (!calls.length) return {pools: [], requests: 0, reads: 0, grid: false};
  if (calls.length > MAX_CALLS) throw new Error(`uniswap v4: ${calls.length} discovery reads is above the ${MAX_CALLS} cap`);
  const sizes = [...known.flatMap(() => [SLOT0_BYTES, LIQUIDITY_BYTES]), ...gridKeys.map(() => SLOT0_BYTES)];
  const first = await aggregate(ethCall, multicall, calls, sizes, params.blockTag);
  let requests = 1;
  let reads = calls.length;

  const pools: V4Pool[] = [];
  const accept = (c: Candidate, s: Omit<V4PoolState, "liquidity">, liquidity: bigint) => {
    // An initialized hookless pool keeps the LP fee of its key for life: anything else is a wrong read, not a fact.
    if (s.lpFee !== c.key.fee) throw refusal("upstream_unavailable", `uniswap v4: pool ${c.id} reads lpFee ${s.lpFee}, not its key's ${c.key.fee} — refusing`);
    const state = {...s, liquidity};
    if (isLive(state, c.key.tickSpacing)) pools.push({key: c.key, id: c.id, state, source: c.source});
  };
  known.forEach((c, i) => {
    const s = decodeSlot0(first[2 * i]!);
    const liquidity = decodeLiquidity(first[2 * i + 1]!);
    if (s.sqrtPriceX96 === 0n) {
      // A pinned pool exists by its Initialize log; zeros mean the node or the StateView pin is wrong. An integrator
      // pool may simply not exist.
      if (c.source === "listed") throw refusal("upstream_unavailable", `uniswap v4: pinned pool ${c.id} reads as uninitialized — refusing`);
      return;
    }
    accept(c, s, liquidity);
  });

  const initialized: {c: Candidate; s: Omit<V4PoolState, "liquidity">}[] = [];
  gridKeys.forEach((c, i) => {
    const s = decodeSlot0(first[2 * known.length + i]!);
    if (s.sqrtPriceX96 !== 0n) initialized.push({c, s});
  });
  if (initialized.length) {
    const second = await aggregate(ethCall, multicall, initialized.map(({c}) => liquidityCall(stateView, c.id)), initialized.map(() => LIQUIDITY_BYTES), params.blockTag);
    requests++;
    reads += initialized.length;
    initialized.forEach(({c, s}, i) => accept(c, s, decodeLiquidity(second[i]!)));
  }
  pools.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return {pools, requests, reads, grid: gridKeys.length > 0};
}
