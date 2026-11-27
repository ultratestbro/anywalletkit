/**
 * `Quote.gasEstimate` for Uniswap (protocol-swap2-core's contract): the gas the swap transaction is expected to USE —
 * not its limit, and no approval. It is the quoter's own measure of the route's pools — QuoterV2's / the V4Quoter's
 * `gasEstimate`, already in the answer the quote reads (no extra call) — plus what the transaction spends around them:
 * the intrinsic 21,000 and the calldata, the router's own code, the input's payment, the payout. That second part is a
 * per-flow table measured on the module's own quotes (README "Gas estimate"): each quote simulated with
 * `eth_simulateV1` from a funded account (exact approval first), its gasUsed less the quoter's figure at the same block.
 * Source `"simulated"`: the part that varies with the route is the quoter's measurement of this quote's pools.
 *
 * An ERC-20 output costs the recipient's balance slot: 17,100 more when the recipient holds none of the token yet (a
 * slot written from zero) than when it does. The quote cannot know which, so the table sits halfway (±8,550).
 *
 * Set only where the quote carries a gas limit (the quoter's figure measures the swap) and on the chains whose
 * schedule was measured. Elsewhere — Polygon and Robinhood Chain (measured 10–35k above the table), Celo's v3 routes,
 * zkSync Era and MegaETH (other gas schedules), chains without an endpoint to measure on — the field is left out, never
 * guessed. Every overhead is below the one the quote's gas limit adds (v3: 120,000, + 40,000 for an unwrap, + 10,000
 * for a refund; v4: 150,000, + 140,000 for the SwapProxy), so an estimate never exceeds the limit; `fits` holds it to
 * that anyway.
 */

/** What a v3 swap (SwapRouter02 `multicall`) spends besides the pools QuoterV2 measures, in gas units. */
export interface V3GasOverhead {
  /** ERC-20 in, ERC-20 out, one pool: `transferFrom` of the input in the pool's callback, the output paid out. */
  readonly tokenToToken: bigint;
  /** Native in (the router wraps `value` with WETH9 `deposit` and pays the pool), ERC-20 out, one pool. */
  readonly nativeToToken: bigint;
  /** ERC-20 in, native out (the output kept in the router, `unwrapWETH9`, the coin sent), one pool. */
  readonly tokenToNative: bigint;
  /** Each pool past the first (negative: QuoterV2 counts every hop's payout to itself, the router hands it on). */
  readonly extraPool: bigint;
  /** The `refundETH()` leg (`refundNativeInput`). */
  readonly refund: bigint;
}

/** What a v4 swap spends besides the pools the V4Quoter measures, in gas units (one or two pools alike). */
export interface V4GasOverhead {
  /** Native in through the Universal Router: `execute` with `value`, SETTLE from its ETH, TAKE to the recipient. */
  readonly nativeToToken: bigint;
  /** ERC-20 in through the SwapProxy (its `transferFrom` into the router, SETTLE of the token), ERC-20 out. */
  readonly tokenToToken: bigint;
  /** ERC-20 in through the SwapProxy, the native coin out (the PoolManager pays the recipient). */
  readonly tokenToNative: bigint;
}

/**
 * Ethereum's gas schedule, measured 2026-11-28 on Ethereum, OP Mainnet, BNB Chain, Unichain, World Chain, Base,
 * Arbitrum, Ink, Linea and X Layer (README "Gas estimate": per-chain values, all within ±10k of these but one route).
 */
const ETHEREUM_V3: V3GasOverhead = Object.freeze({tokenToToken: 43_500n, nativeToToken: 41_400n, tokenToNative: 52_400n, extraPool: -8_000n, refund: 1_700n});
const ETHEREUM_V4: V4GasOverhead = Object.freeze({nativeToToken: 79_800n, tokenToToken: 113_000n, tokenToNative: 91_000n});

/**
 * Monad: colder storage and account access cost more, and a transaction is charged its whole gas limit — with
 * `ownGasEstimate` the account's own estimate of the exact call. So Monad's table is measured against `eth_estimateGas`
 * of the module's quotes (its RPC serves no `eth_simulateV1`), what such an account is charged.
 */
const MONAD_V3: V3GasOverhead = Object.freeze({tokenToToken: 83_200n, nativeToToken: 75_300n, tokenToNative: 104_100n, extraPool: -15_000n, refund: 1_700n});
const MONAD_V4: V4GasOverhead = Object.freeze({nativeToToken: 132_000n, tokenToToken: 257_000n, tokenToNative: 197_000n});

const V3_GAS: Readonly<Record<number, V3GasOverhead>> = Object.freeze({
  1: ETHEREUM_V3,
  10: ETHEREUM_V3,
  56: ETHEREUM_V3,
  130: ETHEREUM_V3,
  196: ETHEREUM_V3,
  480: ETHEREUM_V3,
  8453: ETHEREUM_V3,
  42161: ETHEREUM_V3,
  57073: ETHEREUM_V3,
  59144: ETHEREUM_V3,
  143: MONAD_V3,
});

const V4_GAS: Readonly<Record<number, V4GasOverhead>> = Object.freeze({
  1: ETHEREUM_V4,
  10: ETHEREUM_V4,
  56: ETHEREUM_V4,
  130: ETHEREUM_V4,
  196: ETHEREUM_V4,
  480: ETHEREUM_V4,
  5042: ETHEREUM_V4,
  8453: ETHEREUM_V4,
  42161: ETHEREUM_V4,
  42220: ETHEREUM_V4,
  57073: ETHEREUM_V4,
  59144: ETHEREUM_V4,
  143: MONAD_V4,
});

const own = <T,>(table: Readonly<Record<number, T>>, chainId: number): T | undefined => (Object.prototype.hasOwnProperty.call(table, chainId) ? table[chainId] : undefined);

/** At most 10 digits (protocol-swap2-core's canonical gas units). */
const MAX_UNITS = 9_999_999_999n;
const fits = (units: bigint, limit: bigint): bigint | undefined => (units > 0n && units <= limit && units <= MAX_UNITS ? units : undefined);

/** The chains a Uniswap quote carries a gas estimate on, per venue. */
export function uniswapGasEstimateChains(): {v3: number[]; v4: number[]} {
  return {v3: Object.keys(V3_GAS).map(Number), v4: Object.keys(V4_GAS).map(Number)};
}

/**
 * The v3 estimate: QuoterV2's `gasEstimate` for the route (summed over its pools) plus the chain's overhead for the
 * flow. Undefined on a chain without a measured table, and when it would not fit the quote's `gasLimit`.
 */
export function v3GasEstimate(chainId: number, quoterGas: bigint, flow: {nativeIn: boolean; nativeOut: boolean; refund: boolean; pools: bigint}, gasLimit: bigint): bigint | undefined {
  const m = own(V3_GAS, chainId);
  if (m === undefined || flow.pools < 1n) return undefined;
  const base = flow.nativeOut ? m.tokenToNative : flow.nativeIn ? m.nativeToToken : m.tokenToToken;
  return fits(quoterGas + base + m.extraPool * (flow.pools - 1n) + (flow.refund ? m.refund : 0n), gasLimit);
}

/**
 * The v4 estimate: the V4Quoter's `gasEstimate` for the route plus the chain's overhead for the flow (native in through
 * the Universal Router; a token in through the SwapProxy, to a token or to the native coin). Undefined as for v3.
 */
export function v4GasEstimate(chainId: number, quoterGas: bigint, flow: {nativeIn: boolean; nativeOut: boolean}, gasLimit: bigint): bigint | undefined {
  const m = own(V4_GAS, chainId);
  if (m === undefined) return undefined;
  return fits(quoterGas + (flow.nativeIn ? m.nativeToToken : flow.nativeOut ? m.tokenToNative : m.tokenToToken), gasLimit);
}
