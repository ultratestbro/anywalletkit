import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { fakeBlockchair, mk } from './helpers.js'

const RECIPIENT = 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua'

// A spend is one plain `{ to, value }`: a list whose elements name another recipient than its own `to` is refused.
describe('wallet-zcash: spend shape', () => {
  it('a list (with or without named fields) and a class instance are refused before anything is signed', async () => {
    const f = fakeBlockchair()
    const a = await mk(f.fetchFn).getAccount(0)
    const own = await a.getAddress()
    const shaped = Object.assign([{ to: own, value: 60_000_000n }], { to: RECIPIENT, value: 60_000_000n })
    class Spend { to = RECIPIENT; value = 60_000_000n }
    for (const bad of [shaped, [{ to: RECIPIENT, value: 60_000_000n }], new Spend()]) {
      await expect(a.signTransaction(bad as never)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'malformed-spend' })
      await expect(a.quoteSendTransaction(bad as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
    // control: the plain spend signs
    await expect(a.signTransaction({ to: RECIPIENT, value: 60_000_000n })).resolves.toMatch(/^[0-9a-f]+$/)
  })
})
