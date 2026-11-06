/**
 * Routes over the curated pool allowlist: a token graph built from the pools the package pins (coins, and the
 * underlying coins of metapools that allow `exchange_underlying`), plus the router's own pseudo-hops — swap_type 8
 * between the native coin and the pinned wrapped native, and on router v1.2 swap_type 9 between crvUSD and scrvUSD.
 * Routes cross at most {@link MAX_ROUTE_POOLS} pools. A token a route hands its funds through between two hops must be
 * one the swap2-assets catalog lists on the chain by address, or the native coin / the pinned wrapped native
 * ({@link intermediateAllowed}); a pool's other coins, which the route does not touch, may be anything the allowlist
 * admitted. `exchange_underlying` (swap_type 2) runs on a metapool only while its base pool is allowlisted too.
 *
 * `checkRoute` is the same rule set read back from router arguments: what the provider builds, `curveVerifyQuote`
 * (on the client, for a remote quote) and `preflightDeposit` all pass through it.
 */
import {getAddress} from "viem";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import type {RouterArgs} from "./abi.js";
import {CURVE_DENIED_POOLS, MAX_ROUTE_POOLS, MAX_ROUTE_STEPS, ZERO_ADDRESS, type CurveDeployment} from "./deployments.js";
import type {CurveChainPools, CurvePool, Hex} from "./pools/types.js";

/** One router step: a pool swap, the native ↔ wrapped-native hop (8) or the ERC-4626 hop (9). */
export type CurveStep =
  | {kind: "pool"; pool: CurvePool; swapType: 1 | 2; i: number; j: number; tokenIn: Hex; tokenOut: Hex}
  | {kind: "wrap"; weth: Hex; tokenIn: Hex; tokenOut: Hex}
  | {kind: "erc4626"; vault: Hex; deposit: boolean; tokenIn: Hex; tokenOut: Hex};

export interface CurveRoute {
  steps: readonly CurveStep[];
  /** Human description for the review / logs, e.g. "3pool", "wrap → TricryptoUSDT". */
  label: string;
}

/** Most candidate routes priced for one quote (three JSON-RPC batches of ten). */
export const MAX_QUOTE_CANDIDATES = 30;
/** Partial paths explored before the search gives up (an allowlist far larger than any curated one). */
const MAX_EXPLORED = 20_000;

const lc = (a: string) => a.toLowerCase();
const STABLE_POOL_TYPES = new Set([1, 10]);

/**
 * Whether a route may hand the swap through `token` between two hops on `chainId`: the router's native sentinel, the
 * pinned wrapped native, or a token the swap2-assets catalog lists on that chain, matched by address. The source and
 * the destination follow the engine's listed / unlisted token policy instead (as for every provider).
 */
export function intermediateAllowed(chainId: number, deployment: CurveDeployment, token: string): boolean {
  const t = lc(token);
  if (t === lc(deployment.eth)) return true;
  if (t === lc(deployment.weth)) return t !== lc(ZERO_ADDRESS);
  if (!/^0x[0-9a-f]{40}$/.test(t) || t === lc(ZERO_ADDRESS)) return false;
  const listed = ccAssetByToken(`eip155:${chainId}`, t);
  return !!listed?.contract && lc(listed.contract) === t;
}

/**
 * Whether `exchange_underlying` (swap_type 2) may run on `pool`, given the chain's allowlisted pools `index`: only on a
 * metapool that names its base pool, with that base pool itself allowlisted (and not denied), and `underlying` the
 * meta coins followed by the base pool's coins. Never on a lending pool (no base pool): its underlying route deposits
 * into the lending venue, which a `get_dy` view never touches (Aave v2 on Polygon has every reserve frozen).
 */
export function underlyingAllowed(pool: CurvePool, index: ReadonlyMap<string, CurvePool>): boolean {
  const under = pool.underlying;
  if (!under || under.length < 2 || !pool.swapTypes.includes(2)) return false;
  if (!pool.basePool) return false;
  const base = index.get(lc(pool.basePool));
  if (!base || base === pool) return false;
  const meta = pool.coins.length - 1;
  if (under.length !== meta + base.coins.length) return false;
  return under.every((c, k) => lc(c) === lc(k < meta ? pool.coins[k]! : base.coins[k - meta]!));
}

/** Pool types the router family can execute: `[4][5]` routers speak only to NG pools (stable-ng, twocrypto-ng, tricrypto-ng). */
export function poolTypeAllowed(family: CurveDeployment["family"], poolType: number): boolean {
  return family === "ng5" ? [1, 2, 3, 10, 20, 30].includes(poolType) : [10, 20, 30].includes(poolType);
}

interface Graph {
  edges: Map<string, CurveStep[]>;
  byAddress: Map<string, CurvePool>;
}

const graphs = new WeakMap<CurveChainPools, WeakMap<CurveDeployment, Graph>>();

/** Allowlisted pools by address (lowercase), denied pools left out. */
export function poolIndex(chainId: number, deployment: CurveDeployment, table: CurveChainPools | undefined): Map<string, CurvePool> {
  return graphFor(chainId, deployment, table).byAddress;
}

function graphFor(chainId: number, deployment: CurveDeployment, table: CurveChainPools | undefined): Graph {
  if (!table) return {edges: new Map(), byAddress: new Map()};
  let perDeployment = graphs.get(table);
  if (!perDeployment) graphs.set(table, (perDeployment = new WeakMap()));
  let g = perDeployment.get(deployment);
  if (g) return g;
  g = {edges: new Map(), byAddress: new Map()};
  const denied = CURVE_DENIED_POOLS[chainId];
  const eth = lc(deployment.eth);
  const add = (s: CurveStep) => {
    const k = lc(s.tokenIn);
    const list = g!.edges.get(k);
    if (list) list.push(s);
    else g!.edges.set(k, [s]);
  };
  for (const pool of table.chainId === chainId ? table.pools : []) {
    const key = lc(pool.address);
    if (denied?.has(key) || g.byAddress.has(key) || !poolTypeAllowed(deployment.family, pool.poolType)) continue;
    if (!/^0x[0-9a-fA-F]{40}$/.test(pool.address) || pool.coins.length < 2 || pool.coins.length > 8) continue;
    // A `[4][5]` router never forwards the native coin to a pool: a pool listing it would take nothing.
    if (deployment.family === "lite4" && [...pool.coins, ...(pool.underlying ?? [])].some((c) => lc(c) === eth)) continue;
    g.byAddress.set(key, pool);
  }
  // Edges once every pool is indexed: a metapool's underlying edges need its base pool's entry.
  for (const pool of g.byAddress.values()) {
    const pairs = new Set<string>();
    if (pool.swapTypes.includes(1)) {
      pool.coins.forEach((a, i) => pool.coins.forEach((b, j) => {
        if (i === j || lc(a) === lc(b)) return;
        pairs.add(`${lc(a)}>${lc(b)}`);
        add({kind: "pool", pool, swapType: 1, i, j, tokenIn: getAddress(a), tokenOut: getAddress(b)});
      }));
    }
    const under = pool.underlying;
    if (under && underlyingAllowed(pool, g.byAddress) && (deployment.family === "ng5" || pool.poolType === 10)) {
      under.forEach((a, i) => under.forEach((b, j) => {
        if (i === j || lc(a) === lc(b) || pairs.has(`${lc(a)}>${lc(b)}`)) return;
        add({kind: "pool", pool, swapType: 2, i, j, tokenIn: getAddress(a), tokenOut: getAddress(b)});
      }));
    }
  }
  if (lc(deployment.weth) !== lc(ZERO_ADDRESS)) {
    add({kind: "wrap", weth: getAddress(deployment.weth), tokenIn: getAddress(deployment.eth), tokenOut: getAddress(deployment.weth)});
    add({kind: "wrap", weth: getAddress(deployment.weth), tokenIn: getAddress(deployment.weth), tokenOut: getAddress(deployment.eth)});
  }
  const v = erc4626Of(deployment);
  if (v) {
    add({kind: "erc4626", vault: getAddress(v.vault), deposit: true, tokenIn: getAddress(v.asset), tokenOut: getAddress(v.vault)});
    add({kind: "erc4626", vault: getAddress(v.vault), deposit: false, tokenIn: getAddress(v.vault), tokenOut: getAddress(v.asset)});
  }
  perDeployment.set(deployment, g);
  return g;
}

/** The ERC-4626 hop a deployment may use: only a `[5][5]` router at v1.2 (v1.1 reverts "Bad swap type"). */
function erc4626Of(d: CurveDeployment): {vault: Hex; asset: Hex} | undefined {
  return d.erc4626 && d.family === "ng5" && d.version === "1.2.0" ? d.erc4626 : undefined;
}

const minTvl = (r: readonly CurveStep[]) => r.reduce((m, s) => (s.kind === "pool" ? Math.min(m, s.pool.tvlUsd) : m), Number.POSITIVE_INFINITY);
const poolCount = (r: readonly CurveStep[]) => r.filter((s) => s.kind === "pool").length;

/**
 * Candidate routes tokenIn → tokenOut: at most {@link MAX_ROUTE_POOLS} pools and {@link MAX_ROUTE_STEPS} steps, no
 * token or pool twice, at most one wrap and one ERC-4626 hop. Ranked fewest pools first, then by the thinnest pool's
 * TVL, and cut to `limit`. `truncated` says the cut (or the search budget) dropped some.
 */
export function findRoutes(chainId: number, deployment: CurveDeployment, table: CurveChainPools | undefined, tokenIn: Hex, tokenOut: Hex, limit = MAX_QUOTE_CANDIDATES): {routes: CurveRoute[]; truncated: boolean} {
  const g = graphFor(chainId, deployment, table);
  const want = lc(tokenOut);
  const found: CurveStep[][] = [];
  let explored = 0;
  let exhausted = false;
  const walk = (at: string, path: CurveStep[], seenTokens: Set<string>, seenPools: Set<string>) => {
    if (exhausted) return;
    for (const s of g.edges.get(at) ?? []) {
      if (++explored > MAX_EXPLORED) { exhausted = true; return; }
      const next = lc(s.tokenOut);
      if (seenTokens.has(next)) continue;
      if (next !== want && !intermediateAllowed(chainId, deployment, next)) continue;
      if (s.kind === "pool" && (seenPools.has(lc(s.pool.address)) || poolCount(path) >= MAX_ROUTE_POOLS)) continue;
      if (s.kind !== "pool" && path.some((p) => p.kind === s.kind)) continue;
      const steps = [...path, s];
      if (next === want) {
        if (poolCount(steps) > 0 || steps.some((x) => x.kind === "erc4626")) found.push(steps);
        continue;
      }
      if (steps.length >= MAX_ROUTE_STEPS) continue;
      seenTokens.add(next);
      if (s.kind === "pool") seenPools.add(lc(s.pool.address));
      walk(next, steps, seenTokens, seenPools);
      seenTokens.delete(next);
      if (s.kind === "pool") seenPools.delete(lc(s.pool.address));
    }
  };
  walk(lc(tokenIn), [], new Set([lc(tokenIn)]), new Set());
  found.sort((a, b) => poolCount(a) - poolCount(b) || minTvl(b) - minTvl(a) || a.length - b.length);
  return {routes: found.slice(0, limit).map((steps) => ({steps, label: labelOf(steps)})), truncated: exhausted || found.length > limit};
}

function labelOf(steps: readonly CurveStep[]): string {
  return steps.map((s) => (s.kind === "pool" ? `${s.pool.name}${s.swapType === 2 ? " (underlying)" : ""}` : s.kind === "wrap" ? (s.tokenOut === s.weth ? "wrap" : "unwrap") : s.deposit ? "scrvUSD deposit" : "scrvUSD redeem")).join(" → ");
}

/** The router's `_route` / `_swap_params` for a route, in the deployment's ABI family. */
export function routeArgs(family: CurveDeployment["family"], route: CurveRoute): RouterArgs {
  if (route.steps.length < 1 || route.steps.length > MAX_ROUTE_STEPS) throw new Error(`curve: a route has 1–${MAX_ROUTE_STEPS} steps`);
  const path: Hex[] = [route.steps[0]!.tokenIn];
  const params: bigint[][] = [];
  for (const s of route.steps) {
    const swap = s.kind === "pool" ? s.pool.address : s.kind === "wrap" ? s.weth : s.vault;
    path.push(getAddress(swap), s.tokenOut);
    const row = s.kind === "pool"
      ? [BigInt(s.i), BigInt(s.j), BigInt(s.swapType), BigInt(s.pool.poolType), BigInt((s.swapType === 2 ? s.pool.underlying! : s.pool.coins).length)]
      : s.kind === "wrap" ? [0n, 0n, 8n, 0n, 0n] : [s.deposit ? 0n : 1n, 0n, 9n, 0n, 0n];
    params.push(family === "ng5" ? row : row.slice(0, 4));
  }
  while (path.length < 11) path.push(ZERO_ADDRESS);
  const cols = family === "ng5" ? 5 : 4;
  while (params.length < 5) params.push(new Array<bigint>(cols).fill(0n));
  return {route: path, params};
}

/** Pool addresses a route's router arguments cross, in order. */
export function routePools(args: RouterArgs): Hex[] {
  const out: Hex[] = [];
  for (let k = 0; k < 5; k++) {
    const swap = args.route[2 * k + 1];
    const t = args.params[k]?.[2];
    if (!swap || lc(swap) === lc(ZERO_ADDRESS)) break;
    if (t === 1n || t === 2n) out.push(swap);
  }
  return out;
}

/**
 * Whether router arguments are a route this module would build on `chainId`: from `tokenIn` to `tokenOut`, every pool
 * hop through an allowlisted (and not denied) pool whose pinned coins at `i`/`j` are the hop's tokens, with the pool's
 * own pool type, an allowed swap type (1, or 2 for a metapool listing it whose base pool is allowlisted too) and its
 * coin count; every token between two hops a catalog token, the native coin or the pinned wrapped native; swap_type 8 only through
 * the pinned wrapped native between it and the native sentinel; swap_type 9 only on a v1.2 router through its pinned
 * ERC-4626 vault; no other swap type; at most {@link MAX_ROUTE_POOLS} pools, {@link MAX_ROUTE_STEPS} steps, no pool
 * twice, and nothing after the route's end. The reason it is not, or null.
 */
export function checkRoute(chainId: number, deployment: CurveDeployment, table: CurveChainPools | undefined, args: RouterArgs, tokenIn: string, tokenOut: string): string | null {
  const cols = deployment.family === "ng5" ? 5 : 4;
  if (args.route.length !== 11 || args.params.length !== 5 || args.params.some((r) => r.length !== cols)) return `the route is not address[11] with uint256[${cols}][5]`;
  const index = poolIndex(chainId, deployment, table);
  const zero = lc(ZERO_ADDRESS);
  const eth = lc(deployment.eth);
  const weth = lc(deployment.weth);
  const v = erc4626Of(deployment);
  let steps = 0;
  while (steps < 5 && lc(args.route[2 * steps + 1]!) !== zero) steps++;
  if (steps === 0) return "the route has no step";
  if (steps > MAX_ROUTE_STEPS) return `the route has ${steps} steps, more than ${MAX_ROUTE_STEPS}`;
  for (let k = 2 * steps + 1; k < 11; k++) if (lc(args.route[k]!) !== zero) return "the route names addresses after its end";
  for (let k = steps; k < 5; k++) if (args.params[k]!.some((x) => x !== 0n)) return "the swap params carry rows after the route's end";
  if (lc(args.route[0]!) !== lc(tokenIn)) return `the route starts at ${args.route[0]}, not the source token`;
  if (lc(args.route[2 * steps]!) !== lc(tokenOut)) return `the route ends at ${args.route[2 * steps]}, not the destination token`;
  for (let k = 1; k < steps; k++) {
    if (!intermediateAllowed(chainId, deployment, args.route[2 * k]!)) return `step ${k} hands the swap through ${args.route[2 * k]}, a token the catalog does not list on this chain`;
  }
  const pools = new Set<string>();
  let wraps = 0;
  let vaults = 0;
  for (let k = 0; k < steps; k++) {
    const a = lc(args.route[2 * k]!);
    const swap = lc(args.route[2 * k + 1]!);
    const b = lc(args.route[2 * k + 2]!);
    const row = args.params[k]!;
    const type = row[2]!;
    if (a === b) return `step ${k + 1} trades a token for itself`;
    if (type === 1n || type === 2n) {
      if (CURVE_DENIED_POOLS[chainId]?.has(swap)) return `step ${k + 1} crosses ${args.route[2 * k + 1]}, a pool this module refuses (fake coin, drained in 2023, or over a dead venue)`;
      const pool = index.get(swap);
      if (!pool) return `step ${k + 1} crosses ${args.route[2 * k + 1]}, which is not in the pool allowlist`;
      if (pools.has(swap)) return `the route crosses ${args.route[2 * k + 1]} twice`;
      pools.add(swap);
      if (!pool.swapTypes.includes(type === 1n ? 1 : 2)) return `step ${k + 1} uses swap_type ${type}, which pool ${pool.name} does not allow`;
      if (row[3] !== BigInt(pool.poolType)) return `step ${k + 1} names pool_type ${row[3]}, not pool ${pool.name}'s ${pool.poolType}`;
      if (type === 2n && deployment.family === "lite4" && pool.poolType !== 10) return `step ${k + 1}: exchange_underlying is for stable-ng metapools on this router`;
      if (type === 2n && !underlyingAllowed(pool, index)) return `step ${k + 1}: exchange_underlying on pool ${pool.name} needs its base pool in the allowlist`;
      const list = type === 1n ? pool.coins : pool.underlying;
      if (!list) return `step ${k + 1}: pool ${pool.name} lists no underlying coins`;
      const i = row[0]!, j = row[1]!;
      if (i >= BigInt(list.length) || j >= BigInt(list.length) || i === j) return `step ${k + 1}: coin indexes ${i}/${j} are not two coins of pool ${pool.name}`;
      // i, j < list.length (≤ 8) here: Number() of the decimal string is exact.
      if (lc(list[Number(i.toString())]!) !== a || lc(list[Number(j.toString())]!) !== b) return `step ${k + 1}: pool ${pool.name}'s coins ${i}/${j} are not the hop's tokens`;
      if (deployment.family === "ng5" && row[4] !== BigInt(list.length)) return `step ${k + 1} names ${row[4]} coins, not pool ${pool.name}'s ${list.length}`;
      if (deployment.family === "lite4" && (a === eth || b === eth)) return `step ${k + 1}: this router does not pass the native coin to pools`;
      if (STABLE_POOL_TYPES.has(pool.poolType) && (i > 127n || j > 127n)) return `step ${k + 1}: coin index out of range`;
    } else if (type === 8n) {
      if (weth === zero) return "this chain's router has no wrapped native";
      if (swap !== weth) return `step ${k + 1} wraps through ${args.route[2 * k + 1]}, not the pinned wrapped native`;
      if (!((a === eth && b === weth) || (a === weth && b === eth))) return `step ${k + 1}: swap_type 8 is only native ↔ the pinned wrapped native here`;
      if (row.some((x, c) => c !== 2 && x !== 0n)) return `step ${k + 1}: a wrap carries no other swap params`;
      if (++wraps > 1) return "the route wraps more than once";
    } else if (type === 9n) {
      if (!v) return `swap_type 9 (ERC-4626) is not available on ${deployment.label}'s router ${deployment.version}`;
      if (swap !== lc(v.vault)) return `step ${k + 1}: ERC-4626 hop through ${args.route[2 * k + 1]}, not the pinned vault`;
      const deposit = row[0] === 0n && a === lc(v.asset) && b === lc(v.vault);
      const redeem = row[0] === 1n && a === lc(v.vault) && b === lc(v.asset);
      if (!deposit && !redeem) return `step ${k + 1}: the ERC-4626 hop is not a deposit of the vault's asset or a redeem of its shares`;
      if (row.some((x, c) => c > 0 && c !== 2 && x !== 0n)) return `step ${k + 1}: an ERC-4626 hop carries no other swap params`;
      if (++vaults > 1) return "the route crosses the vault more than once";
    } else {
      return `step ${k + 1} uses swap_type ${type}, which this module never builds`;
    }
  }
  if (pools.size > MAX_ROUTE_POOLS) return `the route crosses ${pools.size} pools, more than ${MAX_ROUTE_POOLS}`;
  if (pools.size === 0 && vaults === 0) return "the route crosses no pool";
  return null;
}
