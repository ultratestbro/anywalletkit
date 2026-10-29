import { KaminoError } from './errors.js'

export type AmountOption = bigint | number | 'max'

/** Base-unit amount: a positive bigint or safe integer. */
export function toAmount(amount: bigint | number | string | undefined): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new KaminoError("'amount' must be a bigint or a safe integer (in base units), or 'max' where allowed.")
  }
  const value = BigInt(amount)
  if (value <= 0n) throw new KaminoError("'amount' should be greater than zero.")
  return value
}

/** SPL mints keep decimals in a u8. */
export const MAX_DECIMALS = 255
/** |exponent| of a figure in scientific notation, and digits of a figure, the API may report (scan 2026-10-28 F10). */
export const MAX_EXPONENT = 400
export const MAX_DIGITS = 1_000

function checkDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS) throw new KaminoError(`Decimals must be an integer from 0 to ${MAX_DECIMALS}, not ${decimals}.`)
}

/** Base units → the decimal string Kamino's API takes ("1.5" for 1_500_000n at 6 decimals). */
export function toDecimalString(amount: bigint, decimals: number): string {
  checkDecimals(decimals)
  const s = amount.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/**
 * Decimal string → base units, rounded down (the API reports decimals; the chain counts base units).
 * Every figure the API reports — amounts, rates, prices — is non-negative, so a sign is refused: a
 * negative deposit or `tokensPerShare` turned the guard's minimum into permission to drain (scan
 * 2026-10-27 modules, F10/F11).
 */
export function fromDecimalString(value: string | number, decimals: number): bigint {
  checkDecimals(decimals)
  const s = String(value).trim()
  // A few bytes of exponent expanded into a string and BigInt of hundreds of millions of digits,
  // synchronously (scan 2026-10-28 F10): the input, its exponent and the result are bounded first.
  if (s.length > MAX_DIGITS) throw new KaminoError(`Kamino reported a figure of ${s.length} characters; no amount or rate is that long.`)
  if (/^[-+]/.test(s)) throw new KaminoError(`Kamino reported a signed figure (${s.slice(0, 40)}); every amount and rate it reports is positive.`)
  const m = /^(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) throw new KaminoError(`Not a decimal number: ${s.slice(0, 40)}`)
  let [, whole = '', frac = '', exp] = m
  if (exp) {
    // Normalize scientific notation ("4.6e-16") into plain digits.
    const e = Number(exp)
    if (!(Math.abs(e) <= MAX_EXPONENT)) throw new KaminoError(`Kamino reported a figure with exponent ${exp.slice(0, 40)}; more than ${MAX_EXPONENT} either way is no amount or rate.`)
    const digits = whole + frac
    let point = whole.length + e
    if (point <= 0) { whole = '0'; frac = '0'.repeat(-point) + digits }
    else if (point >= digits.length) { whole = digits + '0'.repeat(point - digits.length); frac = '' }
    else { whole = digits.slice(0, point); frac = digits.slice(point) }
  }
  const scaled = ((whole || '0') + (frac + '0'.repeat(decimals)).slice(0, decimals)).replace(/^0+(?=\d)/, '')
  if (scaled.length > MAX_DIGITS) throw new KaminoError(`Kamino reported a figure of ${scaled.length} digits in base units; no amount or rate is that large.`)
  return BigInt(scaled)
}

/** Fixed-point helper: `value` (decimal string) scaled by 1e18. */
export const WAD = 10n ** 18n
export const toWad = (value: string | number): bigint => fromDecimalString(value, 18)
export const mulWad = (a: bigint, wad: bigint): bigint => (a * wad) / WAD
export const divWadUp = (a: bigint, wad: bigint): bigint => (wad === 0n ? 0n : (a * WAD + wad - 1n) / wad)

/** `amount × (10_000 − bps) / 10_000`, rounded down. */
export const lessBps = (amount: bigint, bps: number): bigint => (amount * BigInt(10_000 - bps)) / 10_000n
