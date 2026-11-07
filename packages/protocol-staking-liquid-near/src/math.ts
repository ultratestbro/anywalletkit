import { bigintToNumber } from '@anywalletkit/core'
import { PRICE_SCALE } from './constants.js'

// Share math of the LiNEAR contract family, in the contract's own rounding (internal.rs), and the
// price-based APR. Everything is bigint; floats appear only in the final percent.

/** Tokens `deposit_and_stake(amount)` mints: amount × totalShares / totalStaked, rounded down. */
export function sharesForNear(amount: bigint, totals: { totalShares: bigint; totalStaked: bigint }): bigint {
  if (totals.totalStaked <= 0n) return 0n
  return (amount * totals.totalShares) / totals.totalStaked
}

/**
 * NEAR that `shares` tokens are worth: shares × totalStaked / totalShares, rounded down. Passing this
 * to `unstake(amount)` burns at most `shares` (the contract rounds the burnt shares up from it).
 */
export function nearForShares(shares: bigint, totals: { totalShares: bigint; totalStaked: bigint }): bigint {
  if (totals.totalShares <= 0n) return 0n
  return (shares * totals.totalStaked) / totals.totalShares
}

/** `shares` valued at `price` (yoctoNEAR per whole token, {@link PRICE_SCALE} = 1:1), rounded down. */
export function valueAtPrice(shares: bigint, price: bigint): bigint {
  return (shares * price) / PRICE_SCALE
}

const YEAR_MS = 31_557_600_000n // 365.25 days
const FIXED = 10n ** 12n

/**
 * Annualized price growth in percent: (p1 / p0 − 1) × year / Δt × 100, simple (not compounded),
 * computed in 10^12 fixed point. 0 when the inputs cannot give a figure (no time passed, no price).
 */
export function aprFromPrices(p0: bigint, p1: bigint, t0Ms: number, t1Ms: number): number {
  const dt = BigInt(Math.round(t1Ms - t0Ms))
  if (p0 <= 0n || p1 <= 0n || dt <= 0n) return 0
  const scaled = ((p1 - p0) * YEAR_MS * 100n * FIXED) / (p0 * dt)
  return bigintToNumber(scaled) / bigintToNumber(FIXED)
}
