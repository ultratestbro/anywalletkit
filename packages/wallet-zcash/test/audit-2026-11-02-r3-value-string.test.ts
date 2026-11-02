import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { fakeBlockchair, mk } from './helpers.js'

const RECIPIENT = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'

// A spend value string is signed only when the kit's policies read the same number from it: at most 300
// characters and no whitespace. A longer one (leading zeros) reached confirm with no amount.
describe('wallet-zcash: spend value strings', () => {
  it('a string over 300 characters or with whitespace is refused before anything is signed', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of ['0'.repeat(301) + '60000000', ' 60000000 ', '60000000\t', '﻿60000000']) {
      await expect(a.signTransaction({ to: RECIPIENT, value })).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'malformed-spend' })
      await expect(a.quoteSendTransaction({ to: RECIPIENT, value })).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
  })

  it('control: a 300-character string signs', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    await expect(a.signTransaction({ to: RECIPIENT, value: '0'.repeat(292) + '60000000' })).resolves.toMatch(/^[0-9a-f]+$/)
  })
})
