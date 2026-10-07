import { describe, expect, it } from 'vitest'
import { NETWORK } from '@scure/btc-signer'
import { UnsafeTransactionError, assertSafe, describeTransaction, parseRawTransaction } from '../src/index.js'
import { ADDR0, ADDR1, fakeBlockbook, hex, mk, prevTx } from './helpers.js'

describe('safety checks', () => {
  it('refuses to sign above the fee-rate ceiling (default 500 sat/vB), and the ceiling is configurable', async () => {
    const f = fakeBlockbook()
    const a = await mk(f.fetchFn).getAccount(0)
    await expect(a.sendTransaction({ to: ADDR1, value: 10_000n, feeRate: 600n })).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'fee-rate-too-high' })
    await expect(a.signTransaction({ to: ADDR1, value: 10_000n, feeRate: 600n })).rejects.toBeInstanceOf(UnsafeTransactionError)
    expect(f.sent).toHaveLength(0)
    const loose = await mk(f.fetchFn, { maxFeeRate: 1_000 }).getAccount(0)
    const desc = await loose.describeTransaction({ to: ADDR1, value: 10_000n, feeRate: 600n })
    expect(desc.warnings).not.toContain('high-fee-rate') // 600 < the raised ceiling
    expect(desc.feeRate).toBeGreaterThanOrEqual(600)
    // the warning itself, at the default ceiling, on a pure description
    const raw = parseRawTransaction(await loose.signTransaction({ to: ADDR1, value: 10_000n, feeRate: 600n }))
    const values = Array.from({ length: raw.inputsLength }, (_, i) => BigInt(f.utxos.find((u) => u.txid === hex(raw.getInput(i).txid!) && u.vout === raw.getInput(i).index)!.value))
    const pure = describeTransaction(raw, values, { network: NETWORK, ownAddress: ADDR0 })
    expect(pure.warnings).toContain('high-fee-rate')
  })

  it('refuses to broadcast caller-supplied raw hex with an absurd fee', async () => {
    const prevA = prevTx([[ADDR0, 100_000n]])
    const f = fakeBlockbook({ utxos: [{ txid: prevA.id, vout: 0, value: '100000', height: 1 }], prevTxs: [prevA] })
    const m = mk(f.fetchFn)
    const generous = await mk(f.fetchFn, { maxFeeRate: 10_000 }).getAccount(0)
    const raw = await generous.signTransaction({ to: ADDR1, value: 10_000n, feeRate: 600n })
    const a = await m.getAccount(0)
    await expect(a.sendTransaction(raw)).rejects.toMatchObject({ code: 'fee-rate-too-high' })
    expect(f.sent).toHaveLength(0)
    const ok = await generous.signTransaction({ to: ADDR1, value: 10_000n, feeRate: 20n })
    const desc = await a.describeTransaction(ok)
    expect(desc.feeRate).toBeGreaterThanOrEqual(20)
    expect(desc.outputs.find((o) => o.role === 'change')?.address).toBe(ADDR0)
    await expect(a.sendTransaction(ok)).resolves.toMatchObject({ fee: desc.fee })
    m.dispose()
  })

  it('describeTransaction / assertSafe are pure and catch foreign outputs and change', () => {
    const tx = prevTx([[ADDR1, 60_000n], [ADDR0, 30_000n], ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 5_000n]])
    const parsed = parseRawTransaction(tx.hex)
    const ctx = { network: NETWORK, ownAddress: ADDR0, intended: { to: ADDR1, value: 60_000n } }
    const desc = describeTransaction(parsed, [100_000n], ctx)
    expect(desc.outputs.map((o) => o.role)).toEqual(['recipient', 'change', 'unknown'])
    expect(desc.fee).toBe(5_000n)
    expect(desc.amount).toBe(65_000n)
    expect(desc.txid).toBeUndefined() // unsigned
    expect(() => assertSafe(desc, ctx)).toThrow(UnsafeTransactionError)
    try { assertSafe(desc, ctx) } catch (e) { expect((e as UnsafeTransactionError).code).toBe('unexpected-output') }
    // wrong amount to the right address → recipient-mismatch
    const wrong = describeTransaction(parsed, [100_000n], { ...ctx, intended: { to: ADDR1, value: 61_000n } })
    try { assertSafe(wrong, { ...ctx, intended: { to: ADDR1, value: 61_000n } }) } catch (e) { expect((e as UnsafeTransactionError).code).toBe('recipient-mismatch') }
    // without an intended spend every non-own output is a recipient and the tx passes
    const free = describeTransaction(parsed, [100_000n], { network: NETWORK, ownAddress: ADDR0 })
    expect(free.outputs.map((o) => o.role)).toEqual(['recipient', 'change', 'recipient'])
    expect(() => assertSafe(free, { network: NETWORK, ownAddress: ADDR0 })).not.toThrow()
    // outputs exceeding inputs
    expect(() => assertSafe(describeTransaction(parsed, [10n], ctx), ctx)).toThrow(UnsafeTransactionError)
  })

  it('flags dust outputs and fees over 10 % of the amount', () => {
    const tx = prevTx([[ADDR1, 200n], [ADDR0, 1_000n]])
    const desc = describeTransaction(parseRawTransaction(tx.hex), [2_000n], { network: NETWORK, ownAddress: ADDR0 })
    expect(desc.warnings).toEqual(expect.arrayContaining(['dust-output', 'fee-over-10pct-of-amount']))
  })
})
