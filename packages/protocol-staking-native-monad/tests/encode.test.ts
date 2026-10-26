import { describe, expect, it } from 'vitest'
import { toEventSelector, toFunctionSelector, type AbiEvent, type AbiFunction } from 'viem'
import {
  SELECTORS, STAKING_ABI, TOPICS, activatesAtEpoch, commissionToPercent, normalizeValidators, packWithdrawalId, percentToCommission,
  toValidatorId, toWithdrawId, unpackWithdrawalId, withdrawableAtEpoch, describeRevert, paginate, pool,
} from '../src/index.js'

describe('ABI', () => {
  it('selectors match the ABI and the ones Monad publishes', () => {
    const fn = (name: string) => STAKING_ABI.find((x) => x.type === 'function' && x.name === name) as AbiFunction
    for (const [name, sel] of Object.entries(SELECTORS)) expect(toFunctionSelector(fn(name)), name).toBe(sel)
    expect(toFunctionSelector(fn('getEpoch'))).toBe('0x757991a8')
    expect(toFunctionSelector(fn('getValidator'))).toBe('0x2b6d639a')
    expect(toFunctionSelector(fn('getDelegator'))).toBe('0x573c1ce0')
    expect(toFunctionSelector(fn('getWithdrawalRequest'))).toBe('0x56fa2045')
    expect(toFunctionSelector(fn('getDelegations'))).toBe('0x4fd66050')
    expect(toFunctionSelector(fn('getConsensusValidatorSet'))).toBe('0xfb29b729')
    const ev = (name: string) => STAKING_ABI.find((x) => x.type === 'event' && x.name === name) as AbiEvent
    for (const [name, topic] of Object.entries(TOPICS)) expect(toEventSelector(ev(name)), name).toBe(topic)
  })
  it('no getter is a view (the precompile rejects STATICCALL)', () => {
    for (const item of STAKING_ABI) if (item.type === 'function') expect(['nonpayable', 'payable'], item.name).toContain(item.stateMutability)
  })
})

describe('ids', () => {
  it('withdrawal ids pack (validatorId << 8 | slot) and round-trip, validator ids above 255 included', () => {
    for (const [v, w] of [[1n, 0], [97n, 255], [300n, 7], [2n ** 63n, 128]] as const) {
      const id = packWithdrawalId(v, w)
      expect(unpackWithdrawalId(id)).toEqual({ validatorId: v, withdrawId: w })
    }
    expect(packWithdrawalId(97n, 2)).toBe(97n * 256n + 2n)
    expect(packWithdrawalId(1n, 0)).not.toBe(packWithdrawalId(0x100n >> 8n, 1))
    expect(() => unpackWithdrawalId(5n)).toThrow(/does not name a validator/)
  })
  it('validator ids and slots are checked', () => {
    expect(toValidatorId(97)).toBe(97n)
    expect(() => toValidatorId(0n)).toThrow()
    expect(() => toValidatorId(2n ** 64n)).toThrow()
    expect(() => toValidatorId('97')).toThrow()
    expect(toWithdrawId(255)).toBe(255)
    expect(() => toWithdrawId(256)).toThrow()
    expect(() => toWithdrawId(-1)).toThrow()
  })
})

describe('commission and epochs', () => {
  it('1e18 scale ↔ percent', () => {
    expect(commissionToPercent(5n * 10n ** 16n)).toBe(5)
    expect(commissionToPercent(15n * 10n ** 16n)).toBe(15)
    expect(commissionToPercent(10n ** 18n)).toBe(100)
    expect(commissionToPercent(1234n * 10n ** 14n)).toBe(12.34)
    expect(percentToCommission(5)).toBe(5n * 10n ** 16n)
    expect(() => percentToCommission(101)).toThrow()
  })
  it('a change takes effect at n+1 before the boundary block, n+2 after; withdrawals open one epoch after deactivation', () => {
    expect(activatesAtEpoch({ epoch: 2332n, inEpochDelayPeriod: false })).toBe(2333n)
    expect(activatesAtEpoch({ epoch: 2332n, inEpochDelayPeriod: true })).toBe(2334n)
    // mainnet 2026-10-26: a request with withdrawEpoch 2332 answered "withdrawal not ready" in epoch 2332
    expect(withdrawableAtEpoch(2332n)).toBe(2333n)
  })
})

describe('validators option', () => {
  it('required, ids checked, duplicates dropped, names kept', () => {
    expect(() => normalizeValidators(undefined)).toThrow(/needs `validators`/)
    expect(() => normalizeValidators([])).toThrow(/needs `validators`/)
    expect(normalizeValidators('any')).toBe('any')
    expect(normalizeValidators([97n, { id: 21, name: 'B' }, 97])).toEqual([{ id: 97n }, { id: 21n, name: 'B' }])
  })
})

describe('helpers', () => {
  it('describeRevert finds the precompile reason anywhere in the error chain', () => {
    const nested = Object.assign(new Error('Execution reverted.'), { cause: { details: 'execution reverted: withdrawal not ready' } })
    expect(describeRevert(nested).message).toMatch(/not ready yet/)
    expect(describeRevert(new Error('something else')).message).toBe('something else')
    // a provider that sends only "execution reverted" and the reason as raw UTF-8 data
    expect(describeRevert(Object.assign(new Error('execution reverted'), { data: '0x696e73756666696369656e74207374616b65' })).message).toMatch(/Not enough active stake/)
  })
  it('paginate follows `next` until done, and stops a node that never finishes', async () => {
    const pages: Record<number, readonly [boolean, number, bigint[]]> = { 0: [false, 2, [1n, 2n]], 2: [true, 3, [3n]] }
    expect(await paginate<number>(async (s) => pages[s]!, 0)).toEqual([1n, 2n, 3n])
    await expect(paginate<number>(async (s) => [false, s + 1, [1n]] as const, 0, 3)).rejects.toThrow(/did not finish/)
  })
  it('pool keeps order and the concurrency limit', async () => {
    let inFlight = 0, peak = 0
    const out = await pool([1, 2, 3, 4, 5, 6, 7], 3, async (x) => { inFlight++; peak = Math.max(peak, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return x * 2 })
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14])
    expect(peak).toBe(3)
  })
})
