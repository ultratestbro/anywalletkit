import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Buffer } from 'buffer'
import { WalletManagerTon, canonicalBocCell } from '../src/index.js'
import { fakeRpc } from './fake-rpc.js'

// 2026-10-27 key/signing scan: the exploit inputs from the report, refused before anything is signed.

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const SELF = 'UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT' // account 0
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi' // account 1
const ATTACKER = `0:${'bb'.repeat(32)}`
const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const ENDPOINT = { url: 'http://fake/api/v2/jsonRPC', secretKey: 'k' }

describe('scan 2026-10-27 G2 (F3, F9): jetton transfer() response destination and attached TON', () => {
  it('a responseDestination other than the wallet is refused unless the caller opts in', async () => {
    const f = fakeRpc()
    const m = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch })
    const a = await m.getAccount(0)
    await expect(a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, attachedValue: 200_000_000n, responseDestination: ATTACKER })).rejects.toMatchObject({ code: 'foreign-response-destination' })
    await expect(a.quoteTransfer({ token: USDT, recipient: RECIPIENT, amount: 1n, responseDestination: ATTACKER })).rejects.toMatchObject({ code: 'foreign-response-destination' })
    expect(f.sent).toHaveLength(0)
    await a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, responseDestination: SELF })
    await a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, responseDestination: ATTACKER, allowForeignResponseDestination: true })
    expect(f.sent).toHaveLength(2)
    m.dispose()
  })

  it('attachedValue above the cap (default 1 TON, config maxJettonAttachedValue) is refused', async () => {
    const f = fakeRpc()
    const m = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch })
    const a = await m.getAccount(0)
    await expect(a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, attachedValue: 500_000_000_000n })).rejects.toMatchObject({ code: 'attached-value' })
    await expect(a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, forwardTonAmount: 2_000_000_000n })).rejects.toMatchObject({ code: 'attached-value' })
    expect(f.sent).toHaveLength(0)
    await a.transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, attachedValue: 500_000_000n })
    expect(f.sent).toHaveLength(1)
    m.dispose()
    // The cap is the config's: a tighter one refuses what the default allows.
    const narrow = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch, maxJettonAttachedValue: 100_000_000n })
    await expect((await narrow.getAccount(0)).transfer({ token: USDT, recipient: RECIPIENT, amount: 1n, attachedValue: 500_000_000n })).rejects.toMatchObject({ code: 'attached-value' })
    expect(f.sent).toHaveLength(1)
    narrow.dispose()
  })
})

const TRANSFER_TO_ATTACKER = 'te6ccgEBAQEAVwAAqg+KfqUAAAAAAAAAB0O5rKAIAXd3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3AC7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7uwgI='
const WITH_HASHES = 'te6ccgEBAQEAeQAQqgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPin6lAAAAAAAAAAdDuaygCAF3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dwAu7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7u7sIC'
const JETTON_WALLET = `0:${'ee'.repeat(32)}`

describe('scan 2026-10-27 G3 (F2, F4): wallet-ton signs only a body the policies could read', () => {
  it('a bodyBoc whose cells store their hashes (with_hashes) is refused; the plain one is signed', async () => {
    const f = fakeRpc()
    const m = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch })
    const a = await m.getAccount(0)
    await expect(a.sendTransaction({ to: JETTON_WALLET, value: 50_000_000n, bodyBoc: WITH_HASHES })).rejects.toMatchObject({ code: 'non-canonical-boc' })
    await expect(a.signTransaction({ to: JETTON_WALLET, value: 50_000_000n, bodyBoc: WITH_HASHES })).rejects.toMatchObject({ code: 'non-canonical-boc' })
    expect(f.sent).toHaveLength(0)
    await a.sendTransaction({ to: JETTON_WALLET, value: 50_000_000n, bodyBoc: TRANSFER_TO_ATTACKER })
    expect(f.sent).toHaveLength(1)
    m.dispose()
  })

  it('a body that is neither a string nor a Cell is refused, not replaced by bodyBoc', async () => {
    const f = fakeRpc()
    const m = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch })
    const a = await m.getAccount(0)
    const fake = { bits: { length: 0, at: () => false } }
    await expect(a.sendTransaction({ to: JETTON_WALLET, value: 50_000_000n, body: fake as never, bodyBoc: TRANSFER_TO_ATTACKER })).rejects.toMatchObject({ code: 'body' })
    expect(f.sent).toHaveLength(0)
    m.dispose()
  })
})

describe('scan 2026-10-27 G4 (F18): only strict raw or CRC-checked friendly TON addresses are paid', () => {
  it('+0:, a leading space, 0.0: and a suffix are refused for a message, a transfer and a jetton recipient', async () => {
    const f = fakeRpc()
    const m = new WalletManagerTon(SEED, { tonClient: ENDPOINT, fetch: f.fetch })
    const a = await m.getAccount(0)
    const hex = 'ab'.repeat(32)
    for (const to of [`+0:${hex}`, ` 0:${hex}`, `0.0:${hex}`, `0:${hex}:x`]) {
      await expect(a.sendTransaction({ to, value: 1n })).rejects.toMatchObject({ code: 'address' })
      await expect(a.transfer({ recipient: to, amount: 1n })).rejects.toMatchObject({ code: 'address' })
      await expect(a.transfer({ token: USDT, recipient: to, amount: 1n })).rejects.toMatchObject({ code: 'address' })
    }
    // A friendly address with a broken checksum is refused too.
    await expect(a.transfer({ recipient: RECIPIENT.slice(0, -1) + (RECIPIENT.endsWith('i') ? 'j' : 'i'), amount: 1n })).rejects.toThrow()
    expect(f.sent).toHaveLength(0)
    await a.transfer({ recipient: `0:${hex}`, amount: 1n })
    expect(f.sent).toHaveLength(1)
    m.dispose()
  })

  it('a real STON.fi jetton-swap body whose serializer orders cells differently from @ton/core is accepted', () => {
    // Recorded live from the Omniston API on 2026-10-10: 39 cells, does not round-trip through @ton/core byte for byte.
    const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../protocol-swap2-omniston/tests/fixtures/live-2026-10-10.json'), 'utf8')
    const bocs = [...new Set(fixture.match(/b5ee9c72[0-9a-fA-F]{20,}/g) ?? [])]
    expect(bocs.length).toBeGreaterThan(0)
    for (const hex of bocs) {
      const b64 = Buffer.from(hex, 'hex').toString('base64')
      const cell = canonicalBocCell(b64)
      expect(Buffer.from(cell.toBoc({ idx: false, crc32: true })).equals(Buffer.from(hex, 'hex'))).toBe(false)
      expect(cell.beginParse().loadUint(32)).toBe(0x0f8a7ea5)
    }
  })
})
