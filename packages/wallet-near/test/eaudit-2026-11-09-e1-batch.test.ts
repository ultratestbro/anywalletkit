import { describe, expect, it } from 'vitest'
import { describeTransaction, type NearAction } from '../src/index.js'

// extension audit 2026-11-09 E1: in a multi-action transaction every ft_transfer overwrote `to` / `amount`, so a
// sheet showed only the last one; FunctionCall deposits were never part of the amount and a batch had no warning.
const USDT = 'usdt.tether-token.near'
const ft = (receiver: string, amount: string): NearAction => ({ functionCall: { methodName: 'ft_transfer', args: { receiver_id: receiver, amount }, gas: 30n * 10n ** 12n, deposit: 1n } })
const ALL = 5_000_000n * 10n ** 24n

describe('E1: every NEAR action is described, outflows are summed', () => {
  it('two ft_transfer (everything to the attacker, 1 unit to a friend): both outflows, no single to/amount, batch warning', () => {
    const d = describeTransaction({ receiverId: USDT, actions: [ft('attacker.near', '999000000'), ft('friend.near', '1')] }, { signerId: 'me.near' })
    expect(d.kind).toBe('batch')
    expect(d.tokenOutflows).toEqual([{ token: USDT, to: 'attacker.near', amount: 999_000_000n }, { token: USDT, to: 'friend.near', amount: 1n }])
    expect(d.actions).toHaveLength(2)
    expect(d.actions[0]).toMatchObject({ type: 'function-call', method: 'ft_transfer', receiverId: 'attacker.near', amount: 999_000_000n, token: USDT, deposit: 1n })
    expect(d.actions[1]).toMatchObject({ type: 'function-call', method: 'ft_transfer', receiverId: 'friend.near', amount: 1n, deposit: 1n })
    expect(d.nativeOutflow).toBe(2n)
    // the old single-recipient fields no longer name the last transfer
    expect(d.to).not.toBe('friend.near')
    expect(d.amount).toBeUndefined()
    expect(d.warnings.map((w) => w.code)).toContain('batch')
    expect(d.warnings.find((w) => w.code === 'batch')!.message).toMatch(/attacker\.near/)
  })

  it('Transfer of all NEAR + ft_transfer 1: the NEAR is the native outflow, the token outflow is the 1 unit', () => {
    const d = describeTransaction({ receiverId: USDT, actions: [{ transfer: { deposit: ALL } }, ft('friend.near', '1')] })
    expect(d.kind).toBe('batch')
    expect(d.nativeOutflow).toBe(ALL + 1n)
    expect(d.tokenOutflows).toEqual([{ token: USDT, to: 'friend.near', amount: 1n }])
    expect(d.actions[0]).toMatchObject({ type: 'transfer', deposit: ALL, receiverId: USDT })
    expect(d.amount).toBeUndefined()
    expect(d.warnings.map((w) => w.code)).toContain('batch')
  })

  it('FunctionCall{deposit: all} + ft_transfer 1: the deposit is in the native outflow and is warned about', () => {
    const d = describeTransaction({ receiverId: 'shop.near', actions: [{ functionCall: { methodName: 'buy', args: {}, gas: 30n * 10n ** 12n, deposit: ALL } }, ft('friend.near', '1')] })
    expect(d.nativeOutflow).toBe(ALL + 1n)
    expect(d.actions[0]).toMatchObject({ type: 'function-call', method: 'buy', deposit: ALL })
    const codes = d.warnings.map((w) => w.code)
    expect(codes).toContain('batch')
    expect(codes).toContain('deposit')
    expect(d.warnings.find((w) => w.code === 'deposit')!.message).toMatch(/shop\.near\.buy/)
  })

  it('a single call with a deposit to a non-token method is warned about; storage_deposit and the 1-yocto ft_transfer are not', () => {
    expect(describeTransaction({ receiverId: 'wrap.near', actions: [{ functionCall: { methodName: 'near_deposit', args: {}, deposit: 10n ** 24n } }] }).warnings.map((w) => w.code)).toContain('deposit')
    expect(describeTransaction({ receiverId: USDT, actions: [{ functionCall: { methodName: 'storage_deposit', args: { account_id: 'friend.near' }, deposit: 125n * 10n ** 19n } }] }).warnings.map((w) => w.code)).not.toContain('deposit')
    const one = describeTransaction({ receiverId: USDT, actions: [ft('friend.near', '5')] })
    expect(one.warnings.map((w) => w.code)).not.toContain('deposit')
  })

  it('backward compatible: a single ft_transfer (with or without storage_deposit) and a plain NEAR transfer keep to / amount / token', () => {
    const one = describeTransaction({ receiverId: USDT, actions: [ft('friend.near', '5')] })
    expect(one).toMatchObject({ kind: 'ft-transfer', to: 'friend.near', amount: 5n, token: USDT, deposit: 1n, nativeOutflow: 1n })
    expect(one.tokenOutflows).toEqual([{ token: USDT, to: 'friend.near', amount: 5n }])
    expect(one.warnings).toEqual([])
    const reg = describeTransaction({ receiverId: USDT, actions: [{ functionCall: { methodName: 'storage_deposit', args: { account_id: 'friend.near' }, deposit: 125n * 10n ** 19n } }, ft('friend.near', '5')] })
    expect(reg).toMatchObject({ kind: 'ft-transfer', to: 'friend.near', amount: 5n, token: USDT })
    expect(reg.warnings.map((w) => w.code)).not.toContain('batch')
    const near = describeTransaction({ receiverId: 'friend.near', actions: [{ transfer: { deposit: 7n } }] })
    expect(near).toMatchObject({ kind: 'near-transfer', to: 'friend.near', amount: 7n, nativeOutflow: 7n, tokenOutflows: [] })
  })

  it('two transfers to the same recipient on one token are one outflow', () => {
    const d = describeTransaction({ receiverId: USDT, actions: [ft('friend.near', '2'), ft('friend.near', '3')] })
    expect(d.tokenOutflows).toEqual([{ token: USDT, to: 'friend.near', amount: 5n }])
  })
})
