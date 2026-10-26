import '../src/buffer-global.js'
import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Buffer } from 'buffer'
import { Address, internal, toNano } from '@ton/core'
import { externalSigner } from '@anywalletkit/core'
import * as ton from '../src/index.js'
import { WalletManagerTon, v5r1SigningMessage, v5r1WalletId } from '../src/index.js'

// Audit 2026-10-25 round 3, H1: sign() signed any raw bytes, and the wallet contract checks a
// transfer's signature over the 32-byte hash of its signing cell — a dApp asking to "sign a
// message" of those 32 bytes got a valid transfer signature (mode 128 = the whole balance).
const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const HW_KEY = new Uint8Array(32).fill(0x42)
const HW_PUB = ed25519.getPublicKey(HW_KEY)
const MessageIsTransactionError = (ton as unknown as { MessageIsTransactionError?: new () => Error }).MessageIsTransactionError
const te = new TextEncoder()
const u32 = (n: number, le: boolean) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, le); return b }
const u64 = (n: number, le: boolean) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), le); return b }
const cat = (...p: Uint8Array[]) => Uint8Array.from(p.flatMap((x) => [...x]))
const unbase64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'))

/** A legacy Solana message: `key` pays and sends 1 SOL (System transfer) — what a Solana wallet on the same key would sign. */
const solanaTransfer = (key: Uint8Array) => Uint8Array.from([
  1, 0, 1, 2, ...key, ...new Uint8Array(32), ...new Uint8Array(32).fill(9), 1, 1, 2, 0, 0, 12, 2, 0, 0, 0, 0, 0xca, 0x9a, 0x3b, 0, 0, 0, 0,
])

function hardwareWallet() {
  const asked: Uint8Array[] = []
  const signer = externalSigner({ curve: 'ed25519', publicKey: HW_PUB, sign: async (payload) => { asked.push(payload); return ed25519.sign(payload, HW_KEY) } })
  return { signer, asked }
}

function drainHash(): Uint8Array {
  const signing = v5r1SigningMessage({
    walletId: v5r1WalletId(), validUntil: Math.floor(Date.now() / 1000) + 600, seqno: 0,
    messages: [{ message: internal({ to: Address.parse('EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c'), value: toNano('1'), bounce: false }), mode: 128 }],
  })
  return new Uint8Array(signing.hash())
}

describe('TON sign() never signs a transaction hash', () => {
  it('exports MessageIsTransactionError', () => {
    expect(MessageIsTransactionError).toBeTypeOf('function')
  })

  it('refuses the 32-byte signing-cell hash of a V5R1 transfer, as bytes or as a 32-byte string; nothing reaches the signer', async () => {
    const { signer, asked } = hardwareWallet()
    const a = await new WalletManagerTon(signer).getAccount()
    await expect(a.sign(drainHash())).rejects.toMatchObject({ name: 'MessageIsTransactionError', code: 'message-is-transaction' })
    await expect(a.sign('x'.repeat(32))).rejects.toMatchObject({ name: 'MessageIsTransactionError' })
    await expect(a.sign('é'.repeat(16))).rejects.toMatchObject({ name: 'MessageIsTransactionError' }) // 16 chars, 32 UTF-8 bytes
    expect(asked).toHaveLength(0)
    // other lengths are messages, as before
    for (const m of ['hi', 'x'.repeat(31), 'x'.repeat(33), new Uint8Array(64)]) {
      const sig = await a.sign(m)
      expect(ed25519.verify(Uint8Array.from(Buffer.from(sig, 'hex')), typeof m === 'string' ? te.encode(m) : m, HW_PUB)).toBe(true)
    }
  })

  it('refuses bytes naming its key as a Solana signer: one external ed25519 key may be a Solana wallet too (review round)', async () => {
    const { signer, asked } = hardwareWallet()
    const a = await new WalletManagerTon(signer).getAccount()
    await expect(a.sign(solanaTransfer(HW_PUB))).rejects.toMatchObject({ name: 'MessageIsTransactionError' })
    expect(asked).toHaveLength(0)
    expect(await a.sign(solanaTransfer(new Uint8Array(32).fill(5)))).toMatch(/^[0-9a-f]{128}$/) // another key's transaction is just bytes
  })

  it('signTonProof signs the TON Connect ton_proof digest for its own address, and returns the proof object', async () => {
    const m = new WalletManagerTon(SEED)
    const a = await m.getAccount(0)
    const addr = Address.parse(await a.getAddress())
    const proof = await a.signTonProof({ domain: 'app.example', timestamp: 1_700_000_000, payload: 'nonce-1' })
    expect(proof).toMatchObject({ timestamp: 1_700_000_000, domain: { lengthBytes: 11, value: 'app.example' }, payload: 'nonce-1' })
    const inner = cat(te.encode('ton-proof-item-v2/'), new Uint8Array(4), addr.hash, u32(11, true), te.encode('app.example'), u64(1_700_000_000, true), te.encode('nonce-1'))
    const digest = sha256(cat(new Uint8Array([0xff, 0xff]), te.encode('ton-connect'), sha256(inner)))
    expect(ed25519.verify(unbase64(proof.signature), digest, a.publicKey)).toBe(true)
    // a domain counts in bytes, not characters
    expect((await a.signTonProof({ domain: 'пример.рф', timestamp: 1, payload: '' })).domain.lengthBytes).toBe(te.encode('пример.рф').length)
    m.dispose()
  })

  it('signTonConnectData signs the text / binary signData digest and returns the reply', async () => {
    const m = new WalletManagerTon(SEED)
    const a = await m.getAccount(0)
    const addr = Address.parse(await a.getAddress())
    const digestOf = (prefix: string, payload: Uint8Array) => sha256(cat(new Uint8Array([0xff, 0xff]), te.encode('ton-connect/sign-data/'), new Uint8Array(4), addr.hash, u32(11, false), te.encode('app.example'), u64(1_700_000_000, false), te.encode(prefix), u32(payload.length, false), payload))
    const text = await a.signTonConnectData({ domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'text', text: 'hi' } })
    expect(text).toMatchObject({ address: addr.toRawString(), timestamp: 1_700_000_000, domain: 'app.example', payload: { type: 'text', text: 'hi' } })
    expect(ed25519.verify(unbase64(text.signature), digestOf('txt', te.encode('hi')), a.publicKey)).toBe(true)
    const bin = await a.signTonConnectData({ domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'binary', bytes: 'AQID' } })
    expect(ed25519.verify(unbase64(bin.signature), digestOf('bin', new Uint8Array([1, 2, 3])), a.publicKey)).toBe(true)
    // base64 with whitespace decodes as atob would (review round)
    const wrapped = await a.signTonConnectData({ domain: 'app.example', timestamp: 1_700_000_000, payload: { type: 'binary', bytes: 'AQ\nID' } })
    expect(ed25519.verify(unbase64(wrapped.signature), digestOf('bin', new Uint8Array([1, 2, 3])), a.publicKey)).toBe(true)
    expect(() => ton.tonProofDigest({ workchain: 0, hash: addr.hash } as never, { domain: 'app.example', timestamp: 1, payload: '' })).toThrow(/workChain/)
    m.dispose()
  })

  it('refuses malformed TON Connect requests before signing', async () => {
    const { signer, asked } = hardwareWallet()
    const a = await new WalletManagerTon(signer).getAccount()
    await expect(a.signTonConnectData({ domain: 'app.example', timestamp: 1, payload: { type: 'cell', cell: 'te6c' } as never })).rejects.toThrow(/cell payloads are not supported/)
    await expect(a.signTonConnectData({ domain: 'app.example', timestamp: 1, payload: { type: 'binary', bytes: 'not base64!' } })).rejects.toThrow(/base64/)
    await expect(a.signTonProof({ domain: '', timestamp: 1, payload: 'n' })).rejects.toThrow(/domain/)
    await expect(a.signTonProof({ domain: 'app.example', timestamp: -1, payload: 'n' })).rejects.toThrow(/timestamp/)
    await expect(a.signTonProof({ domain: 'app.example', timestamp: 1.5, payload: 'n' })).rejects.toThrow(/timestamp/)
    expect(asked).toHaveLength(0)
  })

  it('every signer request is a 32-byte digest under its own context', async () => {
    const contexts: string[] = []
    const signer = externalSigner({ curve: 'ed25519', publicKey: HW_PUB, sign: async (payload, o) => { contexts.push(`${o.context}:${payload.length}`); return ed25519.sign(payload, HW_KEY) } })
    const a = await new WalletManagerTon(signer).getAccount()
    await a.signTonProof({ domain: 'app.example', timestamp: 1, payload: 'n' })
    await a.signTonConnectData({ domain: 'app.example', timestamp: 1, payload: { type: 'text', text: 'x' } })
    expect(contexts).toEqual(['ton-proof:32', 'ton-sign-data:32'])
  })
})
