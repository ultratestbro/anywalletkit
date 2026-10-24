import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Buffer } from 'buffer'
import { beginCell, loadMessage } from '@ton/core'
import { WalletContractV5R1 } from '@ton/ton'
import { LocalSigner, SignerError, UserRejectedError, externalSigner, seedFromMnemonicSync } from '@anywalletkit/core'
import { TON_BASE_PATH, TON_MNEMONIC_PATH, WalletAccountTon, WalletManagerTon } from '../src/index.js'
import { fakeRpc } from './fake-rpc.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'UQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLtaT' // vector, account 0
const RECIPIENT = 'UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi'
const ENDPOINT = { url: 'http://fake/api/v2/jsonRPC', secretKey: 'k' }
// A key that lives OUTSIDE the SDK (hardware wallet, MPC, backend).
const HW_KEY = new Uint8Array(32).fill(0x42)
const HW_PUB = ed25519.getPublicKey(HW_KEY)

/** A "hardware wallet": signs ed25519 on request, records the contexts it was asked for. */
function hardwareWallet(reject = false) {
  const contexts: string[] = []
  const signer = externalSigner({
    curve: 'ed25519',
    publicKey: HW_PUB,
    sign: async (payload, o) => {
      contexts.push(o.context ?? '')
      if (reject) throw new UserRejectedError()
      return ed25519.sign(payload, HW_KEY)
    },
  })
  return { signer, contexts }
}

/** Signature = last 512 bits of the body, over the hash of the rest (+ refs). Returns the broadcast message. */
function verifyExternal(f: ReturnType<typeof fakeRpc>, pub: Uint8Array) {
  expect(f.sent).toHaveLength(1)
  const msg = loadMessage(f.sent[0]!.beginParse())
  const s = msg.body.beginParse()
  const payload = s.loadBits(s.remainingBits - 512)
  const sig = s.loadBits(512)
  const signing = beginCell().storeBits(payload)
  for (const r of msg.body.refs) signing.storeRef(r)
  const sigBytes = new Uint8Array(beginCell().storeBits(sig).endCell().beginParse().loadBuffer(64))
  expect(ed25519.verify(sigBytes, signing.endCell().hash(), pub)).toBe(true)
  return msg
}

describe('WalletManagerTon with an external signer', () => {
  it('builds the V5R1 account at the signer key and signs the external through it, after the preflight', async () => {
    const { signer, contexts } = hardwareWallet()
    const f = fakeRpc()
    const m = new WalletManagerTon(signer, { tonClient: ENDPOINT, fetch: f.fetch })
    const a = await m.getAccount(0)
    expect(a.path).toBe('external')
    expect(a.signer).toBe(signer)
    expect(await m.getAccount()).toBe(a)
    // the address is what @ton/ton computes for the same public key
    const expected = WalletContractV5R1.create({ workchain: 0, publicKey: Buffer.from(HW_PUB) }).address.toString({ bounceable: false })
    expect(await a.getAddress()).toBe(expected)

    await a.transfer({ recipient: RECIPIENT, amount: 100_000_000n })
    const msg = verifyExternal(f, HW_PUB)
    if (msg.info.type === 'external-in') expect(msg.info.dest.toString({ bounceable: false })).toBe(expected)
    // the signer was asked exactly once, for the external, and only after estimateFee ran on the zero-signed body
    expect(contexts).toEqual(['ton-external'])
    expect(f.calls.indexOf('estimateFee')).toBeLessThan(f.calls.indexOf('sendBoc'))

    const sig = await a.sign('hi')
    expect(ed25519.verify(Uint8Array.from(Buffer.from(sig, 'hex')), new TextEncoder().encode('hi'), HW_PUB)).toBe(true)
    expect(contexts).toEqual(['ton-external', 'ton-message'])
    m.dispose()
  })

  it('refuses other indexes/paths and the wrong curve; a rejected prompt surfaces UserRejectedError before broadcast', async () => {
    const m = new WalletManagerTon(hardwareWallet().signer)
    await expect(m.getAccount(1)).rejects.toThrow(/single account/)
    await expect(m.getAccountByPath("3'")).rejects.toThrow(SignerError)
    expect(await m.getAccountByPath('external')).toBe(await m.getAccount(0))
    const secp = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'secp256k1', "m/44'/60'/0'/0/0")
    await expect(new WalletManagerTon(secp).getAccount()).rejects.toThrow(/ed25519/)

    const f = fakeRpc()
    const a = await new WalletManagerTon(hardwareWallet(true).signer, { tonClient: ENDPOINT, fetch: f.fetch }).getAccount()
    await expect(a.transfer({ recipient: RECIPIENT, amount: 1n })).rejects.toBeInstanceOf(UserRejectedError)
    expect(f.calls).toContain('estimateFee') // preflight ran on the zero-signed body…
    expect(f.sent).toHaveLength(0) // …nothing was broadcast
  })

  it('a derivable SeedSigner at m/44\'/607\' yields the same children as the seed manager; a leaf is index 0 only', async () => {
    const bySeed = new WalletManagerTon(SEED)
    const root = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', TON_BASE_PATH)
    const bySigner = new WalletManagerTon(root)
    for (const i of [0, 1, 5]) {
      expect(await (await bySigner.getAccount(i)).getAddress()).toBe(await (await bySeed.getAccount(i)).getAddress())
    }
    expect((await bySigner.getAccount(1)).path).toBe(`${TON_BASE_PATH}/1'`)
    expect(await bySigner.getAccountByPath("1'")).toBe(await bySigner.getAccount(1))
    await expect(bySigner.getAccountByPath("m/44'/501'/0'/0'")).rejects.toThrow(/cannot provide/)

    const leaf = LocalSigner.fromSeed(seedFromMnemonicSync(SEED), 'ed25519', `${TON_BASE_PATH}/0'`)
    const lm = new WalletManagerTon(leaf)
    const a = await lm.getAccount(0)
    expect(await a.getAddress()).toBe(ADDR0)
    expect(a.path).toBe(`${TON_BASE_PATH}/0'`)
    await expect(lm.getAccount(2)).rejects.toThrow(/single account/)
    bySeed.dispose(); bySigner.dispose(); lm.dispose()
  })

  it('fromTonMnemonic is a LocalSigner leaf at ton-mnemonic', async () => {
    const m = await WalletManagerTon.fromTonMnemonic(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art',
    )
    const a = await m.getAccount()
    expect(a.path).toBe(TON_MNEMONIC_PATH)
    expect(a.signer).toBeInstanceOf(LocalSigner)
    expect(a.signer.kind).toBe('seed')
    expect(await m.getAccountByPath(TON_MNEMONIC_PATH)).toBe(a)
    await expect(m.getAccountByPath("0'")).rejects.toThrow(/single account/)
    m.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
  })

  it('fromPrivateKey keeps the raw-key constructor shape; dispose disposes the signer', async () => {
    const seed = seedFromMnemonicSync(SEED)
    const ref = LocalSigner.fromSeed(seed, 'ed25519', `${TON_BASE_PATH}/0'`)
    const a = WalletAccountTon.fromPrivateKey(ed25519.utils.randomSecretKey(), ref.publicKey, 'x')
    expect(await a.getAddress()).toBe(ADDR0) // address comes from the public key
    expect(a.signer.kind).toBe('seed')
    a.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
    ref.dispose()
  })

  it('manager.dispose() disposes an injected signer', async () => {
    const { signer } = hardwareWallet()
    const m = new WalletManagerTon(signer)
    const a = await m.getAccount()
    m.dispose()
    await expect(a.sign('x')).rejects.toBeInstanceOf(SignerError)
    await expect(signer.getPublicKey()).rejects.toBeInstanceOf(SignerError)
  })
})
