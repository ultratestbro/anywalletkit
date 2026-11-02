import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { ADDR0, ADDR1, fakeBlockbook, mk } from './helpers.js'

// A spend is one plain `{ to, value }`: a list whose elements name another recipient than its own `to` is refused.
describe('wallet-btc: spend shape', () => {
  it('a list (with or without named fields) and a class instance are refused before anything is signed or sent', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    const shaped = Object.assign([{ to: ADDR0, value: 10_000n }], { to: ADDR1, value: 10_000n })
    class Spend { to = ADDR1; value = 10_000n }
    for (const bad of [shaped, [{ to: ADDR1, value: 10_000n }], new Spend()]) {
      await expect(a.sendTransaction(bad as never)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'malformed-spend' })
      await expect(a.signTransaction(bad as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
      await expect(a.quoteSendTransaction(bad as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
    expect(f.sent).toHaveLength(0)
    // control: the plain spend goes out
    await expect(a.sendTransaction({ to: ADDR1, value: 10_000n })).resolves.toMatchObject({ hash: expect.any(String) })
  })
})
