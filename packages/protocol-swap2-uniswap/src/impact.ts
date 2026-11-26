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
 * `amountIn × Π rate_i`, with rate = sqrtP² / 2¹⁹² when the hop sells token0, its inverse otherwise. The output is taken
 * as `out + hops` so that floor rounding in the pools can never add to the loss; the ratio is rounded up for the same
 * reason. Undefined when a price is outside (0, 2¹⁶⁰) or the counts do not match.
 */
export function spotValueLossBps(hops: readonly Hop[], sqrtPrices: readonly bigint[], amountIn: bigint, out: bigint): number | undefined {
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
  }
  const paid = (out + BigInt(hops.length)) * den * 10_000n;
  const mid = amountIn * num;
  const ratio = (paid + mid - 1n) / mid; // ⌈(out + hops) / (amountIn × rate)⌉, in bps
  return ratio >= 10_000n ? 0 : bigintToNumber(10_000n - ratio);
}

/** `maxPriceImpactBps`: an integer 1..10000, or unset. */
export function validMaxImpactBps(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10_000;
}

/**
 * The refusal text when the measure G reaches the limit (`/^loses ([\d.]+)% of the value to price impact/` after the
 * provider prefix, as cp0x's refusals.ts reads it): "loses 99.8% of the value to price impact — its pools are too thin
 * for this amount (limit 5%; best route via USDC 0.3% → 0.01%)".
 */
export function impactRefusalText(lossBps: number, limitBps: number, routeLabel: string): string {
  const pct = lossBps >= 9_995 ? "99.9" : (lossBps / 100).toFixed(1);
  return `loses ${pct}% of the value to price impact — its pools are too thin for this amount (limit ${String(limitBps / 100)}%; best route ${routeLabel})`;
}

/**
 * Per-transaction gas-limit caps that are lower than a block: Ethereum's EIP-7825 (2²⁴, since Fusaka) and Monad's 30M
 * ("Transaction gas limit 30M gas", docs.monad.xyz). A transaction's gasLimit above them is invalid, so a padded limit
 * is clamped to them. Elsewhere the block gas limit, read on chain, is the cap.
 */
export const KNOWN_TX_GAS_CAP: Readonly<Record<number, bigint>> = Object.freeze({1: 16_777_216n, 143: 30_000_000n});

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
  /** min(the chain's per-transaction gas-limit cap, its block gas limit). */
  limit?: bigint;
  /** The most gas one transaction's execution may use, when that is not its gasLimit (Arbitrum Nitro). */
  execution?: bigint;
}

const own = (table: Readonly<Record<number, bigint>>, chainId: number) => (Object.prototype.hasOwnProperty.call(table, chainId) ? table[chainId] : undefined);

/** The chain's gas bounds from the known caps and its block gas limit (undefined: the node did not say). */
export function gasBoundsOf(chainId: number, blockGasLimit: bigint | undefined): GasBounds {
  const known = own(KNOWN_TX_GAS_CAP, chainId);
  const limit = known === undefined ? blockGasLimit : blockGasLimit === undefined || known < blockGasLimit ? known : blockGasLimit;
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
