import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { Address, Cell } from '@ton/core'
import { WalletManagerTon, describeTransaction } from '../src/index.js'
import { fakeRpc } from './fake-rpc.js'

// Audit 2026-10-25 round 3, M11: the send mode of a message was not shown, and the drain guard
// (mode 128 carries the whole remaining balance, mode 32 destroys the account) worked only through a
// tonapi emulation: with `simulate: false`, or an emulation that does not report risk, such a
// message was signed. It is now shown per message and refused locally unless
// `allowDrainingTransactions`; the emulation check stays.
// L8: a jetton transfer's recipient skipped the network (test-only flag) and workchain checks a
// native transfer has.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const ENDPOINT = { url: 'http://fake/api/v2/jsonRPC' }
const account = (config: Record<string, unknown> = {}) => new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: fakeRpc().fetch, simulate: false, ...config }).getAccount(0)

describe('send modes are shown and the drain modes refused without emulation (M11)', () => {
  it('describe shows each message mode and warns for 128 and 32', () => {
    const d = describeTransaction([{ to: RECIPIENT, value: 1n }, { to: RECIPIENT, value: 1n, sendMode: 128 }, { to: RECIPIENT, value: 1n, sendMode: 160 }])
    expect(d.items.map((i) => i.mode)).toEqual([3, 130, 162])
    const codes = d.warnings.map((w) => `${w.code}@${w.index}`)
    expect(codes).toContain('carries-all-balance@1')
    expect(codes).toContain('carries-all-balance@2')
    expect(codes).toContain('destroys-account@2')
    expect(codes.some((c) => c.endsWith('@0'))).toBe(false)
  })

  for (const [name, sendMode] of [['128 (the whole balance)', 128], ['32 (destroy when empty)', 32], ['160', 160]] as const) {
    it(`mode ${name} is refused with simulate: false; allowDrainingTransactions signs it`, async () => {
      await expect((await account()).sendTransaction({ to: RECIPIENT, value: 1n, sendMode })).rejects.toMatchObject({ name: 'UnsafeTransactionError', code: 'drain' })
      await expect((await account({ allowDrainingTransactions: true })).sendTransaction({ to: RECIPIENT, value: 1n, sendMode })).resolves.toBeDefined()
    })
  }

  it('a prebuilt signed body carrying mode 128 is refused too', async () => {
    const body = Cell.fromBase64(await (await account({ allowDrainingTransactions: true })).signTransaction({ to: RECIPIENT, value: 1n, sendMode: 128 }))
    await expect((await account()).sendTransaction(body)).rejects.toMatchObject({ code: 'drain' })
    expect((describeTransaction(body).items[0]!.mode ?? 0) & 128).toBe(128)
  })
})

describe("a jetton recipient gets the native transfer's network and workchain checks (L8)", () => {
  it('a test-only address on a mainnet wallet, and an exotic workchain, are refused', async () => {
    const testnet = Address.parse(RECIPIENT).toString({ testOnly: true, bounceable: false })
    await expect((await account()).transfer({ token: USDT, recipient: testnet, amount: 1n })).rejects.toMatchObject({ code: 'network-mismatch' })
    const exotic = `5:${'ab'.repeat(32)}`
    await expect((await account()).transfer({ token: USDT, recipient: exotic, amount: 1n })).rejects.toMatchObject({ code: 'exotic-workchain' })
    await expect((await account()).transfer({ token: USDT, recipient: RECIPIENT, amount: 1n })).resolves.toBeDefined()
  })
})
