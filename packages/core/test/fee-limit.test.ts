import { describe, expect, it } from 'vitest'
import { feeLimit } from '../src/index.js'

describe('feeLimit: the tighter of the configured cap and a per-call maxFee (audit 2026-10-25, #4)', () => {
  it('takes whichever is set, the smaller when both are', () => {
    expect(feeLimit(undefined)).toBeUndefined()
    expect(feeLimit(undefined, {})).toBeUndefined()
    expect(feeLimit(100)).toBe(100n)
    expect(feeLimit(undefined, { maxFee: 7n })).toBe(7n)
    expect(feeLimit(100n, { maxFee: 7n })).toBe(7n)
    expect(feeLimit(5, { maxFee: 7n })).toBe(5n)
    expect(feeLimit(0n, { maxFee: 7n })).toBe(0n)
  })
})
