import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { WalletManagerTon } from '../src/index.js'
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
