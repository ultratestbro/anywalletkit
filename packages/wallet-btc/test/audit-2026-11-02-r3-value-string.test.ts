import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { ADDR1, fakeBlockbook, mk } from './helpers.js'

// A spend value string is spent only when the kit's policies read the same number from it: at most 300
// characters and no whitespace. A longer one (leading zeros) reached confirm with no amount.
describe('wallet-btc: spend value strings', () => {
  it('a string over 300 characters or with whitespace is refused before anything is signed or sent', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of ['0'.repeat(301) + '10000', ' 10000 ', '10000\n', '﻿10000']) {
      await expect(a.sendTransaction({ to: ADDR1, value })).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'malformed-spend' })
      await expect(a.signTransaction({ to: ADDR1, value })).rejects.toBeInstanceOf(UnsafeTransactionError)
      await expect(a.quoteSendTransaction({ to: ADDR1, value })).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
    await expect(a.transfer({ recipient: ADDR1, amount: '0'.repeat(301) + '10000' })).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(f.sent).toHaveLength(0)
  })

  it('control: a 300-character string and a 0x string are spent', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of ['0'.repeat(295) + '10000', '0x2710']) {
      await expect(a.quoteSendTransaction({ to: ADDR1, value })).resolves.toMatchObject({ fee: expect.any(BigInt) })
    }
    await expect(a.sendTransaction({ to: ADDR1, value: '0'.repeat(295) + '10000' })).resolves.toMatchObject({ hash: expect.any(String) })
  })
})
