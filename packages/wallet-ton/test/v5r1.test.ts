/** Byte-for-byte parity of our V5R1 implementation with @ton/ton's WalletContractV5R1 (test-only dependency). */
import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Buffer } from 'buffer'
import { Address, SendMode, beginCell, internal, toNano } from '@ton/core'
import { WalletContractV5R1 } from '@ton/ton'
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto'
import { deriveEd25519, seedFromMnemonicSync } from '@anywalletkit/core'
import {
  WalletManagerTon, v5r1Address, v5r1PackSigned, v5r1SigningMessage, v5r1StateInit, v5r1WalletId, parseV5R1Body, describeTransaction, MAX_ACTIONS,
} from '../src/index.js'

const SEEDS = [
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'test test test test test test test test test test test junk',
  'legal winner thank year wave sausage worth useful legal winner thank yellow',
]
const RECIPIENT = Address.parse('UQAockb65N9NqreZHrYfhipG94Q_gZYTBkV0mvaopLEEzOgi')

function keyFor(seed: string, index: number) {
  return deriveEd25519(seedFromMnemonicSync(seed), `m/44'/607'/${index}'`)
}

describe('V5R1 parity with @ton/ton', () => {
  it('state init and address equal WalletContractV5R1.create for 3 seeds × 2 indexes', () => {
    for (const seed of SEEDS) for (const index of [0, 1]) {
      const { publicKey } = keyFor(seed, index)
      const ref = WalletContractV5R1.create({ workchain: 0, publicKey: Buffer.from(publicKey) })
      const init = v5r1StateInit(publicKey)
      expect(init.code!.equals(ref.init.code)).toBe(true)
      expect(init.data!.equals(ref.init.data)).toBe(true)
      expect(v5r1Address(publicKey).equals(ref.address)).toBe(true)
    }
  })

  it('wallet_id matches for mainnet/testnet and subwallets', () => {
    for (const [networkGlobalId, subwalletNumber] of [[-239, 0], [-3, 0], [-239, 7]] as const) {
      const ref = WalletContractV5R1.create({ publicKey: Buffer.alloc(32, 1), walletId: { networkGlobalId, context: { workchain: 0, walletVersion: 'v5r1', subwalletNumber } } })
      const data = ref.init.data.beginParse()
      data.loadUint(1); data.loadUint(32)
      expect(BigInt(data.loadInt(32))).toBe(v5r1WalletId({ networkGlobalId, subwalletNumber }))
    }
  })

  it('signed external body equals @ton/ton createTransfer for 1 and 3 messages (same key, seqno, timeout)', async () => {
    const { privateKey, publicKey } = keyFor(SEEDS[0]!, 0)
    const ref = WalletContractV5R1.create({ workchain: 0, publicKey: Buffer.from(publicKey) })
    const sign = (hash: Uint8Array) => ed25519.sign(hash, privateKey)
    const timeout = 1_900_000_000
    for (const n of [1, 3]) {
      const messages = Array.from({ length: n }, (_, i) => internal({ to: RECIPIENT, value: toNano('0.1') + BigInt(i), bounce: false, body: `m${i}` }))
      const theirs = await ref.createTransfer({
        seqno: 7, timeout, sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS, messages,
        signer: async (cell) => Buffer.from(sign(cell.hash())),
      })
      const signing = v5r1SigningMessage({ walletId: v5r1WalletId(), validUntil: timeout, seqno: 7, messages: messages.map((message) => ({ message })) })
      const ours = v5r1PackSigned(signing, sign(signing.hash()))
      expect(ours.toBoc().toString('hex')).toBe(theirs.toBoc().toString('hex'))
      const parsed = parseV5R1Body(ours)!
      expect(parsed.messages).toHaveLength(n)
      expect(parsed.seqno).toBe(7)
      expect(parsed.validUntil).toBe(timeout)
      expect(parsed.signed).toBe(true)
    }
  })

  it('refuses more than 255 messages, like the contract', () => {
    const messages = Array.from({ length: MAX_ACTIONS + 1 }, () => ({ message: internal({ to: RECIPIENT, value: 1n }) }))
    expect(() => v5r1SigningMessage({ walletId: v5r1WalletId(), validUntil: 1, seqno: 0, messages })).toThrow(/255/)
  })

  it('describe decodes a prebuilt body (seqno/valid_until/messages)', () => {
    const { privateKey, publicKey } = keyFor(SEEDS[0]!, 0)
    void publicKey
    const signing = v5r1SigningMessage({ walletId: v5r1WalletId(), validUntil: 123, seqno: 9, messages: [{ message: internal({ to: RECIPIENT, value: 5n, bounce: false, body: 'hi' }) }] })
    const d = describeTransaction(v5r1PackSigned(signing, ed25519.sign(signing.hash(), privateKey)))
    expect(d.external).toMatchObject({ seqno: 9, validUntil: 123, signed: true })
    expect(d.items[0]).toMatchObject({ kind: 'ton-transfer', value: 5n, comment: 'hi', bounceable: false })
  })
})

describe('TON-native mnemonic import', () => {
  it('yields the single V5R1 account Tonkeeper-style wallets show for that mnemonic', async () => {
    const words = await mnemonicNew(24)
    const ref = await mnemonicToPrivateKey(words)
    const expected = WalletContractV5R1.create({ workchain: 0, publicKey: ref.publicKey }).address.toString({ bounceable: false })
    const m = await WalletManagerTon.fromTonMnemonic(words)
    const a = await m.getAccount(0)
    expect(await a.getAddress()).toBe(expected)
    expect(a.path).toBe('ton-mnemonic')
    expect(a.index).toBeUndefined()
    expect(await m.getAccount(0)).toBe(a)
    await expect(m.getAccount(1)).rejects.toThrow(/single account/)
    // signs with the same key @ton/crypto derived
    const sig = await a.sign('x')
    expect(ed25519.verify(Uint8Array.from(Buffer.from(sig, 'hex')), new TextEncoder().encode('x'), new Uint8Array(ref.publicKey))).toBe(true)
    m.dispose()
    await expect(a.sign('x')).rejects.toThrow(/disposed/)
  })

  it('rejects anything but 24 words', async () => {
    await expect(WalletManagerTon.fromTonMnemonic('a b c')).rejects.toThrow(/24 words/)
  })
})

describe('address/wallet-id sanity', () => {
  it('the same key on a non-default subwallet is a different address', () => {
    const pub = Buffer.alloc(32, 9)
    expect(v5r1Address(pub).equals(v5r1Address(pub, { walletId: v5r1WalletId({ subwalletNumber: 1 }) }))).toBe(false)
    const raw = beginCell().endCell()
    void raw
  })
})
