import { describe, expect, it } from 'vitest'
import { bigintToNumber, bigintToUnits } from '../src/numbers.js'

describe('bigintToNumber', () => {
  it('is exact below 2^53 and correctly rounded above (string path), both signs', () => {
    expect(bigintToNumber(0n)).toBe(0)
    expect(bigintToNumber(-1n)).toBe(-1)
    expect(bigintToNumber(2n ** 53n - 1n)).toBe(9007199254740991)
    expect(bigintToNumber(2n ** 53n)).toBe(9007199254740992)
    expect(bigintToNumber(2n ** 64n)).toBe(18446744073709551616)
    expect(bigintToNumber(4n * 10n ** 25n)).toBe(4e25)
    expect(bigintToNumber(-(4n * 10n ** 25n))).toBe(-4e25)
    expect(bigintToNumber((1n << 256n) - 1n)).toBeCloseTo(1.157920892373162e77, -65)
    for (const v of [123456789012345678901234567890n, 10n ** 27n, 7n * 10n ** 18n + 1n]) expect(bigintToNumber(v)).toBe(Number(v))
  })
  it('bigintToUnits divides by 10^decimals', () => {
    expect(bigintToUnits(10n ** 20n, 18)).toBe(100)
    expect(bigintToUnits(1_500_000n, 6)).toBe(1.5)
    expect(bigintToUnits(-(10n ** 20n), 18)).toBe(-100)
  })
})
