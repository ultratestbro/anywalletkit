import {getAddress, type Hex} from "viem";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * The price-impact measures behind `maxPriceImpactBps` (UNISWAP-V4-RESEARCH §5.2 U0, §7.2; gaps/impact-gate §4) and the
 * gas bound that is always on. Pure arithmetic: the provider reads the chain, this file only computes.
 */

/** One pool a route crosses, in the direction of the swap. */
export interface Hop {
  tokenIn: `0x${string}`;
  tokenOut: `0x${string}`;
  /** The v3 pool fee (hundredths of a bip). */
  fee: number;
}

/** The pools of a v3 route: one for `exactInputSingle`, or each `token, fee, token` step of an `exactInput` path. */
export function hopsOf(tokenIn: Hex, tokenOut: Hex, single: {fee: number} | undefined, path: Hex | undefined): Hop[] {
  if (single) return [{tokenIn: getAddress(tokenIn), tokenOut: getAddress(tokenOut), fee: single.fee}];
  const hex = (path ?? "0x").slice(2);
  const hops: Hop[] = [];
  for (let at = 0; at + 86 <= hex.length; at += 46) {
    hops.push({
      tokenIn: getAddress(`0x${hex.slice(at, at + 40)}`),
      fee: parseInt(hex.slice(at + 40, at + 46), 16),
      tokenOut: getAddress(`0x${hex.slice(at + 46, at + 86)}`),
    });
  }
  return hops;
}

/**
 * The 1/1000 probe's impact, as 0.4.11 computes `priceImpactBps`: the full-size rate's shortfall against the probe's
 * rate on the same route, in bps, floored at 0. Pool fees are paid on both sides of the ratio, so they cancel.
 */
export function probeImpactBps(amountIn: bigint, out: bigint, probeIn: bigint, probeOut: bigint): number {
  const ratioBps = (out * probeIn * 10_000n) / (probeOut * amountIn); // (out/amountIn) ÷ (probeOut/probeIn), in bps
  return Math.max(0, bigintToNumber(10_000n - ratioBps));
}

const Q192 = 1n << 192n;
const SQRT_PRICE_MAX = 1n << 160n;

/**
 * Spot value loss, fees included ("gross"): how much less than the pools' mid prices the route pays, in bps, 0..10000.
 * `sqrtPrices[i]` is hop i's `slot0().sqrtPriceX96` (token1 per token0, Q64.96). The mid output is
 * `amountIn × Π rate_i`, with rate = sqrtP² / 2¹⁹² when the hop sells token0, its inverse otherwise. The loss is the
 * output's exact shortfall against it, rounded down to a whole bp (so `loss ≥ limit` holds exactly when the true loss
 * reaches the limit). Floor rounding in the pools counts: it is value the recipient does not get, and on a dust output
 * (3 raw units in, 2 out) it is most of the loss. Undefined when a price is outside (0, 2¹⁶⁰) or the counts do not match.
 */
export function spotValueLossBps(hops: readonly Hop[], sqrtPrices: readonly bigint[], amountIn: bigint, out: bigint): number | undefined {
  return valueLossBps(hops, sqrtPrices, amountIn, out, false);
}

/**
 * The same loss net of the pools' fees: against the mid output after each hop's fee (`× (1 − fee)` per pool), so what
 * is left is the price impact alone (and the pools' floor rounding). It tells a quote whose pools are too thin from one
 * that reaches a limit only with its fees (U0C-2, U0-LIVE-2); the gate itself goes by the gross loss.
 */
export function spotImpactNetOfFeesBps(hops: readonly Hop[], sqrtPrices: readonly bigint[], amountIn: bigint, out: bigint): number | undefined {
  return valueLossBps(hops, sqrtPrices, amountIn, out, true);
}

function valueLossBps(hops: readonly Hop[], sqrtPrices: readonly bigint[], amountIn: bigint, out: bigint, netOfFees: boolean): number | undefined {
  if (hops.length === 0 || hops.length !== sqrtPrices.length || amountIn <= 0n || out < 0n) return undefined;
  let num = 1n;
  let den = 1n;
  for (let i = 0; i < hops.length; i++) {
    const p = sqrtPrices[i]!;
    if (p <= 0n || p >= SQRT_PRICE_MAX) return undefined;
    const sq = p * p;
    // token0 is the lower address; selling token0 for token1 is the price itself.
    if (BigInt(hops[i]!.tokenIn) < BigInt(hops[i]!.tokenOut)) {
      num *= sq;
      den *= Q192;
    } else {
      num *= Q192;
      den *= sq;
    }
    if (netOfFees) {
      const fee = hops[i]!.fee;
      if (!Number.isInteger(fee) || fee < 0 || fee >= 1_000_000) return undefined;
      num *= BigInt(1_000_000 - fee); // the pool keeps `fee` (hundredths of a bip) of the input
      den *= 1_000_000n;
    }
  }
  const paid = out * den * 10_000n;
  const mid = amountIn * num;
  const ratio = (paid + mid - 1n) / mid; // ⌈out / (amountIn × rate)⌉, in bps
  return ratio >= 10_000n ? 0 : bigintToNumber(10_000n - ratio);
}

/** `maxPriceImpactBps`: an integer 1..10000, or unset. */
export function validMaxImpactBps(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000;
}

/**
 * The refusal text when the measure G (fees included) reaches the limit. Both forms start as cp0x's refusals.ts reads
 * it, `/^loses ([\d.]+)% of the value to price impact/` after the provider prefix:
 * - the price impact alone reaches the limit (the probe, or the spot loss net of the pools' fees): "loses 99.8% of the
 *   value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)";
 * - only the pools' fees bring it there (`poolFee` given: a deep pool, a limit at or under its fee): "loses 1.0% of the
 *   value to price impact and pool fees — the route's fees (1%) bring it to the limit; its price impact alone is under
 *   it (limit 1%; best route direct 1%)" — never "too thin" for a pool that is not (U0C-2, U0-LIVE-2).
 */
export function impactRefusalText(lossBps: number, limitBps: number, routeLabel: string, poolFee?: string): string {
  const pct = lossBps >= 9_995 ? "99.9" : (lossBps / 100).toFixed(1);
  const tail = `(limit ${String(limitBps / 100)}%; best route ${routeLabel})`;
  if (poolFee !== undefined) {
    return `loses ${pct}% of the value to price impact and pool fees — the route's fees (${poolFee}) bring it to the limit; its price impact alone is under it ${tail}`;
  }
  return `loses ${pct}% of the value to price impact — its pools are too thin for this amount ${tail}`;
}

/**
 * Per-transaction gas-limit caps that are lower than a block: a transaction's gasLimit above them is invalid (the node
 * refuses it), so a padded limit is clamped to them and a need above them refused.
 * - 2²⁴ = 16,777,216 (EIP-7825): Ethereum since Fusaka; OP Mainnet, BNB Chain, Unichain, World Chain, Base, Ink and
 *   Linea also enforce it.
 * - 2²⁵ = 33,554,432: Polygon PoS.
 * - 30M: Monad ("Transaction gas limit 30M gas", docs.monad.xyz).
 * The 2²⁴ and 2²⁵ caps were read live, read-only, on 2026-11-26 (scripts/verify-live.mjs): `eth_estimateGas` of an
 * endless loop (a code override) reports the allowance a transaction can have — "gas required exceeds allowance
 * (16777216)" — against block gas limits of 30M–2B, while the same nodes' `eth_call` runs 100M (so not an RPC gas cap).
 * Monad's node does not name its allowance: its 30M is the documented limit, not one read live.
 * Elsewhere the block gas limit, read on chain, is the cap (less KNOWN_BLOCK_GAS_RESERVE).
 */
export const KNOWN_TX_GAS_CAP: Readonly<Record<number, bigint>> = Object.freeze({
  1: 16_777_216n,
  10: 16_777_216n,
  56: 16_777_216n,
  130: 16_777_216n,
  480: 16_777_216n,
  8453: 16_777_216n,
  57073: 16_777_216n,
  59144: 16_777_216n,
  137: 33_554_432n,
  143: 30_000_000n,
});

/**
 * Gas every block spends before any user transaction, kept below the block gas limit when that limit is the cap: on
 * OP-stack chains each block opens with the L1-info deposit (type 0x7e, gasLimit 1,000,000, about 46k used), so a
 * transaction whose gasLimit is the whole block never fits what is left and is never included — it waits in the pool
 * and holds the account's later nonces. Read live on 2026-11-26 on every chain listed (the latest block's first
 * transaction); it binds where no per-transaction cap is lower: Celo (30M block) and X Layer.
 */
export const KNOWN_BLOCK_GAS_RESERVE: Readonly<Record<number, bigint>> = Object.freeze({
  10: 1_000_000n,
  130: 1_000_000n,
  196: 1_000_000n,
  480: 1_000_000n,
  8453: 1_000_000n,
  42220: 1_000_000n,
  57073: 1_000_000n,
});

/**
 * The block gas limit of a chain whose reserve binds (KNOWN_BLOCK_GAS_RESERVE, no lower per-transaction cap), taken
 * until its own block has been read: before the read is in (or after it failed), a padded limit in the block's last
 * 1M gas would otherwise go out unbounded and never be included (U0-SEC-R3-3). Read live on 2026-11-26 (Celo 30M, X
 * Layer 210M); `scripts/verify-live.mjs` checks it. The chain's own block, once read, replaces it.
 */
export const KNOWN_BLOCK_GAS_LIMIT: Readonly<Record<number, bigint>> = Object.freeze({
  196: 210_000_000n,
  42220: 30_000_000n,
});

/**
 * Arbitrum Nitro chains: the most gas one transaction can spend on execution. Their block header carries a 2⁵⁰
 * placeholder; `ArbGasInfo(0x…6C).getMaxTxGasLimit()` read 32,000,000 on Arbitrum One (42161) and Robinhood Chain
 * (4663), read-only on 2026-11-26 (`getGasAccountingParams()` = 7M, 32M, 32M). Nitro holds any gas above it back from
 * execution, but the transaction's gasLimit also pays the L1 posting gas, so the limit may be higher: a swap whose
 * execution need is above it is refused, and the padded limit is never clamped to it. zkSync Era (324) also reports a
 * 2⁵⁰ header; its per-transaction limit is not known here (an open question), so only that header applies.
 */
export const KNOWN_EXECUTION_GAS_CAP: Readonly<Record<number, bigint>> = Object.freeze({42161: 32_000_000n, 4663: 32_000_000n});

/** What bounds one transaction's gas on a chain: its gasLimit (`limit`, clamped to) and the gas execution may use (refused above). */
export interface GasBounds {
  /** min(the chain's per-transaction gas-limit cap, its block gas limit less the block's own reserve). */
  limit?: bigint;
  /** The most gas one transaction's execution may use, when that is not its gasLimit (Arbitrum Nitro). */
  execution?: bigint;
}

const own = (table: Readonly<Record<number, bigint>>, chainId: number) => (Object.prototype.hasOwnProperty.call(table, chainId) ? table[chainId] : undefined);

/** The chain's gas bounds from the known caps and its block gas limit (undefined: the node did not say — KNOWN_BLOCK_GAS_LIMIT then). */
export function gasBoundsOf(chainId: number, blockGasLimit: bigint | undefined): GasBounds {
  const known = own(KNOWN_TX_GAS_CAP, chainId);
  const reserve = own(KNOWN_BLOCK_GAS_RESERVE, chainId) ?? 0n;
  const blockLimit = blockGasLimit ?? own(KNOWN_BLOCK_GAS_LIMIT, chainId);
  const block = blockLimit === undefined ? undefined : blockLimit > reserve ? blockLimit - reserve : 0n;
  const limit = known === undefined ? block : block === undefined || known < block ? known : block;
  const execution = own(KNOWN_EXECUTION_GAS_CAP, chainId);
  return {...(limit !== undefined ? {limit} : {}), ...(execution !== undefined ? {execution} : {})};
}

/**
 * The share of the bare need (quoter gas + router overhead + unwrap/refund) a transaction is taken to need, in percent.
 * EIP-150 forwards at most 63/64 of the gas left into a call, and the pool's swap runs two calls deep (the multicall's
 * delegatecall, then `pool.swap`): (64/63)² ≈ 1.032 before the router's own work. Live, the least gas a swap ran in was
 * 2.1% over the bare need on Ethereum (USDC → LINK, 16.48M → 16.83M) and 3.5% on Monad (62,000 MON → AUSD, 10.90M →
 * 11.28M); a cap within 5% of the bare need would send a limit the swap runs out of, mined and paid for.
 */
export const GAS_NEED_PCT = 105n;

/** The gas a swap with this bare need is taken to need on chain: GAS_NEED_PCT of it, rounded up. */
export function gasNeedOf(bare: bigint): bigint {
  return (bare * GAS_NEED_PCT + 99n) / 100n;
}

/**
 * The gas limit a quote carries, bounded by the chain (always on). `refuse` when the need (gasNeedOf(bare)) is above
 * the gasLimit cap or the execution cap: such a transaction can never complete. Else the padded limit, clamped to the
 * gasLimit cap (never to the execution cap, which leaves out L1 gas), and never below the need.
 */
export function boundGasLimit(bare: bigint, padded: bigint, bounds: GasBounds): {gasLimit: bigint} | {refuse: {need: bigint; cap: bigint}} {
  const need = gasNeedOf(bare);
  const caps = [bounds.limit, bounds.execution].filter((c): c is bigint => c !== undefined);
  const cap = caps.length === 0 ? undefined : caps.reduce((a, b) => (a < b ? a : b));
  if (cap !== undefined && need > cap) return {refuse: {need, cap}};
  const clamped = bounds.limit !== undefined && padded > bounds.limit ? bounds.limit : padded;
  return {gasLimit: clamped < need ? need : clamped};
}
