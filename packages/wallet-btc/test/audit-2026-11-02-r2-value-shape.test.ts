import { describe, expect, it } from 'vitest'
import { UnsafeTransactionError } from '../src/index.js'
import { ADDR1, fakeBlockbook, mk } from './helpers.js'

// A spend's value is read as the kit's policies read it: a bigint, a whole number or a string BigInt
// reads. A list, a valueOf object, '1e5' or 1.4 used to be rounded into sats the policies never saw.
describe('wallet-btc: spend value shape', () => {
  it('values the policies cannot read are refused before anything is signed or sent', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of [[10_000], { valueOf: () => 10_000 }, '1e5', 10_000.4, '10000.0', true]) {
      await expect(a.sendTransaction({ to: ADDR1, value } as never)).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'malformed-spend' })
      await expect(a.signTransaction({ to: ADDR1, value } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
      await expect(a.quoteSendTransaction({ to: ADDR1, value } as never)).rejects.toBeInstanceOf(UnsafeTransactionError)
    }
    expect(f.sent).toHaveLength(0)
  })

  it('control: bigint, whole number and integer strings are spent; a fractional fee rate is still rounded', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    for (const value of [10_000n, 10_000, '10000', '0x2710']) {
      await expect(a.quoteSendTransaction({ to: ADDR1, value })).resolves.toMatchObject({ fee: expect.any(BigInt) })
    }
    await expect(a.quoteSendTransaction({ to: ADDR1, value: 10_000n, feeRate: 1.6 })).resolves.toMatchObject({ fee: expect.any(BigInt) })
    await expect(a.sendTransaction({ to: ADDR1, value: '10000' })).resolves.toMatchObject({ hash: expect.any(String) })
  })
})
