/**
 * BigInt → Number that does not depend on the engine's multi-limb conversion.
 *
 * Hermes (React Native 0.81 line, Linux x64 build at least) converts bigints of 64 bits and more
 * wrongly: `Number(2n ** 64n)` comes back as 3·2^64 and `Number(4n * 10n ** 25n)` as 1.17e26 — a
 * ray-scaled Aave rate or an 18-decimal token amount gives an APY or a USD value that is simply
 * false. Below 2^53 every engine converts exactly, so that path stays native; above it the value
 * goes through its decimal string, which every engine parses with a correctly rounded strtod.
 */
const EXACT = 1n << 53n

/**
 * Convert a bigint to a Number, correct on every engine including Hermes. Use it for display and
 * pricing; never for amounts you sign.
 */
export function bigintToNumber(value: bigint): number {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  // eslint-disable-next-line anywalletkit/no-number-bigint -- guarded: below 2^53 Number() is exact on every engine
  const n = magnitude < EXACT ? Number(magnitude) : Number(magnitude.toString())
  return negative ? -n : n
}

/** `value / 10^decimals` as a Number (display, pricing, ratios — never for signing). */
export function bigintToUnits(value: bigint, decimals: number): number {
  return bigintToNumber(value) / 10 ** decimals
}

/**
 * The smallest allowance treated as unlimited across the SDK: type(uint128).max. It is far above
 * any token's supply in base units, and every "infinite approval" sentinel in use (uint256,
 * uint160, uint128 max, 2^255) reaches it.
 */
export const UNLIMITED_ALLOWANCE = (1n << 128n) - 1n

/** True for an allowance a spender can treat as unlimited (≥ type(uint128).max). */
export function isUnlimitedAllowance(amount: bigint): boolean {
  return amount >= UNLIMITED_ALLOWANCE
}
