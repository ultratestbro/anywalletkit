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
 * Per-transaction gas caps that are lower than a block: Ethereum's EIP-7825 (2²⁴, since Fusaka) and Monad's 30M
 * ("Transaction gas limit 30M gas", docs.monad.xyz). Elsewhere the block gas limit, read on chain, is the cap.
 */
export const KNOWN_TX_GAS_CAP: Readonly<Record<number, bigint>> = Object.freeze({1: 16_777_216n, 143: 30_000_000n});

/** min(the chain's per-transaction cap, its block gas limit); undefined when neither is known. */
export function gasCapOf(chainId: number, blockGasLimit: bigint | undefined): bigint | undefined {
  const known = Object.prototype.hasOwnProperty.call(KNOWN_TX_GAS_CAP, chainId) ? KNOWN_TX_GAS_CAP[chainId] : undefined;
  if (known === undefined) return blockGasLimit;
  if (blockGasLimit === undefined) return known;
  return known < blockGasLimit ? known : blockGasLimit;
}

/**
 * The gas limit a quote carries, bounded by the chain: `refuse` when the bare need (no headroom) is above the cap — such
 * a transaction can never be mined; else the padded limit, clamped to the cap (never below the need, which is under it).
 */
export function boundGasLimit(need: bigint, padded: bigint, cap: bigint | undefined): {gasLimit: bigint} | {refuse: {need: bigint; cap: bigint}} {
  if (cap === undefined) return {gasLimit: padded};
  if (need > cap) return {refuse: {need, cap}};
  return {gasLimit: padded > cap ? cap : padded};
}
