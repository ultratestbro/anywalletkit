import { describe, expect, it, vi } from 'vitest'
import { parseTransaction } from 'viem'
import { applyPolicies } from '@anywalletkit/kit'
import { UnsafeTransactionError, WalletManagerEvm, assertTxShape, transferTransaction } from '../src/index.js'

// A value string is signed only when the kit's policies read the same number from it: at most 300
// characters and no whitespace. A longer one (leading zeros) reached confirm with no amount and was
// signed in full. Offline, public test mnemonic.
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ALLOWED = '0x00000000000000000000000000000000000a110e'
const fees = { chainId: 1, nonce: 0, gasLimit: 21_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n }
const LONG = '0'.repeat(301) + '1000000000000000000'

describe('wallet-evm: value strings', () => {
  it('a string over 300 characters or with whitespace is refused, raw and through the kit', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const confirm = vi.fn(async (_i: unknown) => true)
    const g = applyPolicies(acc, { confirm, allowlist: { 'eip155:1': [ALLOWED] } }, 'eip155:1')
    for (const value of [LONG, ' 1000000000000000000', '1000000000000000000\n', '﻿1']) {
      expect(() => assertTxShape({ to: ALLOWED, value } as never)).toThrow(UnsafeTransactionError)
      await expect(acc.signTransaction({ to: ALLOWED, value, ...fees } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
      await expect(g.signTransaction({ to: ALLOWED, value, ...fees } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
    expect(() => transferTransaction({ recipient: ALLOWED, amount: LONG })).toThrow(UnsafeTransactionError)
    expect(() => transferTransaction({ recipient: ALLOWED, token: ALLOWED, amount: ' 5' })).toThrow(UnsafeTransactionError)
    m.dispose()
  })

  it('control: a 300-character string and 0x strings sign, and confirm sees the amount', async () => {
    const m = new WalletManagerEvm(SEED, { chainId: 1 })
    const acc = await m.getAccount()
    const confirm = vi.fn(async (_i: { amount?: bigint }) => true)
    const g = applyPolicies(acc, { confirm, allowlist: { 'eip155:1': [ALLOWED] } }, 'eip155:1')
    for (const value of ['0'.repeat(281) + '1000000000000000000', '0xde0b6b3a7640000']) {
      confirm.mockClear()
      const raw = await g.signTransaction({ to: ALLOWED, value, ...fees })
      expect(parseTransaction(raw as `0x${string}`).value).toBe(10n ** 18n)
      expect(confirm.mock.calls[0]![0].amount).toBe(10n ** 18n)
    }
    expect(transferTransaction({ recipient: ALLOWED, amount: '1000' })).toMatchObject({ value: 1000n })
    m.dispose()
  })
})
