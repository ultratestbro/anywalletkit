import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { fakeBlockchair, mk } from './helpers.js'

const RECIPIENT = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'

// A spend's value is read as the kit's policies read it: a bigint, a whole number or a string BigInt
// reads. A list, a valueOf object or 1.4 used to be rounded into zatoshis the policies never saw.
describe('wallet-zcash: spend value shape', () => {
  it('values the policies cannot read are refused before anything is signed', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of [[60_000_000], { valueOf: () => 60_000_000 }, '6e7', 60_000_000.4, true]) {
      await expect(a.signTransaction({ to: RECIPIENT, value } as never)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'malformed-spend' })
      await expect(a.quoteSendTransaction({ to: RECIPIENT, value } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
  })

  it('control: bigint, whole number and integer strings sign', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of [60_000_000n, 60_000_000, '60000000']) {
      await expect(a.signTransaction({ to: RECIPIENT, value })).resolves.toMatch(/^[0-9a-f]+$/)
    }
  })
})
