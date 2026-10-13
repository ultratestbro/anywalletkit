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

/** Base units → the decimal string Kamino's API takes ("1.5" for 1_500_000n at 6 decimals). */
export function toDecimalString(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}

/** Decimal string → base units, rounded down (the API reports decimals; the chain counts base units). */
export function fromDecimalString(value: string | number, decimals: number): bigint {
  const s = String(value).trim()
  const m = /^(-?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(s)
  if (!m) throw new KaminoError(`Not a decimal number: ${s}`)
  let [, sign, whole = '', frac = '', exp] = m
  if (exp) {
    // Normalize scientific notation ("4.6e-16") into plain digits.
    const e = Number(exp)
    const digits = whole + frac
    let point = whole.length + e
    if (point <= 0) { whole = '0'; frac = '0'.repeat(-point) + digits }
    else if (point >= digits.length) { whole = digits + '0'.repeat(point - digits.length); frac = '' }
    else { whole = digits.slice(0, point); frac = digits.slice(point) }
  }
  const scaled = (whole || '0') + (frac + '0'.repeat(decimals)).slice(0, decimals)
  const out = BigInt(scaled.replace(/^0+(?=\d)/, ''))
  return sign ? -out : out
}

/** Fixed-point helper: `value` (decimal string) scaled by 1e18. */
export const WAD = 10n ** 18n
export const toWad = (value: string | number): bigint => fromDecimalString(value, 18)
export const mulWad = (a: bigint, wad: bigint): bigint => (a * wad) / WAD
export const divWadUp = (a: bigint, wad: bigint): bigint => (wad === 0n ? 0n : (a * WAD + wad - 1n) / wad)

/** `amount × (10_000 − bps) / 10_000`, rounded down. */
export const lessBps = (amount: bigint, bps: number): bigint => (amount * BigInt(10_000 - bps)) / 10_000n
