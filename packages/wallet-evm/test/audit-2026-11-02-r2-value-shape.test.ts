import { describe, expect, it, vi } from 'vitest'
import { parseTransaction } from 'viem'
import { applyPolicies } from '@anywalletkit/kit'
import { UnsafeTransactionError, WalletManagerEvm, assertTxShape } from '../src/index.js'

// `value` is signed only in a shape the policies read the same way: a bigint, a whole number or a
// string BigInt reads. A list or an object with valueOf would reach confirm with no amount and be
// signed in full. Offline, public test mnemonic.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ALLOWED = '0x00000000000000000000000000000000000a110e'
const fees = { chainId: 1, nonce: 0, gasLimit: 21_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }

describe('wallet-evm: value shapes', () => {
  it('a list, a valueOf object, a String object, a boolean and a fraction are refused, raw and through the kit (after confirm too)', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const confirm = vi.fn(async (_i: unknown) => true)
    const g = applyPolicies(acc, { confirm, allowlist: { 'eip155:1': [ALLOWED] } }, 'eip155:1')
    for (const value of [[10n ** 18n], { valueOf: () => 10n ** 18n }, new String('1000000000000000000'), true, 1.5]) {
      expect(() => assertTxShape({ to: ALLOWED, value } as never)).toThrow(UnsafeTransactionError)
      await expect(acc.signTransaction({ to: ALLOWED, value, ...fees } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
      await expect(g.signTransaction({ to: ALLOWED, value, ...fees } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
    m.dispose()
  })

  it('control: bigint, whole number, decimal and 0x strings sign, and the intent carries the amount', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const confirm = vi.fn(async (_i: { amount?: bigint }) => true)
    const g = applyPolicies(acc, { confirm, allowlist: { 'eip155:1': [ALLOWED] } }, 'eip155:1')
    for (const value of [10n ** 18n, 1_000_000, '1000000000000000000', '0xde0b6b3a7640000', undefined]) {
      confirm.mockClear()
      const raw = await g.signTransaction({ to: ALLOWED, ...(value !== undefined ? { value } : {}), ...fees })
      const signed = parseTransaction(raw as `0x${string}`).value ?? 0n
      expect(signed).toBe(value === undefined ? 0n : BigInt(value))
      if (value !== undefined) expect(confirm.mock.calls[0]![0].amount).toBe(signed)
    }
    m.dispose()
  })
})
