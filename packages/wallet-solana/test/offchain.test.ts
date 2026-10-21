import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  appendTransactionMessageInstructions, compileTransaction, compressTransactionMessageUsingAddressLookupTables, createNoopSigner, createTransactionMessage,
  getTransactionEncoder, pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Blockhash, type Transaction,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  MessageIsTransactionError, SOLANA_OFFCHAIN_MESSAGE_PREFIX, WalletManagerSolana, classifySolanaMessage, isSolanaTransactionPayload,
} from '../src/index.js'

const SEED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDR0 = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address // account 0
const ATTACKER = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address
const TABLE = 'AddressLookupTab1e1111111111111111111111111' as Address
const LOOKED_UP = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const BLOCKHASH = '9sHcv6xwn9YkB8nxTUGKDwPwNnmqVp5oAXxU8Fdkm4J6' as Blockhash

type Version = 'legacy' | 0 | 1
function compiled(version: Version, { payer = ADDR0, from = ADDR0, to = ATTACKER, lookup = false } = {}): Transaction {
  let msg = pipe(
    createTransactionMessage({ version }),
    (m) => setTransactionMessageFeePayer(payer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 100n }, m),
    (m) => appendTransactionMessageInstructions([getTransferSolInstruction({ source: createNoopSigner(from), destination: to, amount: 1_000_000_000n })], m),
  ) as never
  if (lookup) msg = compressTransactionMessageUsingAddressLookupTables(msg, { [TABLE]: [to] }) as never
  return compileTransaction(msg) as Transaction
}
const messageBytes = (tx: Transaction) => Uint8Array.from(tx.messageBytes as unknown as Uint8Array)
const wireBytes = (tx: Transaction) => Uint8Array.from(getTransactionEncoder().encode(tx) as Uint8Array)
const random = (n: number) => { const u = new Uint8Array(n); crypto.getRandomValues(u); return u }

async function account() {
  return new WalletManagerSolana(SEED).getAccount(0)
}

describe('isSolanaTransactionPayload', () => {
  it('detects a legacy compiled message that names the key as a required signer', () => {
    const bytes = messageBytes(compiled('legacy'))
    expect(bytes[0]! & 0x80).toBe(0)
    expect(isSolanaTransactionPayload(bytes, ADDR0)).toBe(true)
  })

  it('detects a v0 compiled message, with and without address-table lookups', () => {
    const plain = messageBytes(compiled(0))
    expect(plain[0]).toBe(0x80)
    expect(isSolanaTransactionPayload(plain, ADDR0)).toBe(true)
    const withLookup = messageBytes(compiled(0, { lookup: true, to: LOOKED_UP }))
    expect(withLookup.length).toBeGreaterThan(plain.length - 32) // lookup section present
    expect(isSolanaTransactionPayload(withLookup, ADDR0)).toBe(true)
  })

  it('detects a v1 compiled message and its wire form', () => {
    const tx = compiled(1)
    expect(messageBytes(tx)[0]).toBe(0x81)
    expect(isSolanaTransactionPayload(messageBytes(tx), ADDR0)).toBe(true)
    expect(isSolanaTransactionPayload(wireBytes(tx), ADDR0)).toBe(true)
    expect(isSolanaTransactionPayload(messageBytes(compiled(1, { payer: ATTACKER, from: ATTACKER, to: ADDR0 })), ADDR0)).toBe(false)
  })

  it('detects a full wire transaction (signatures + message)', () => {
    expect(isSolanaTransactionPayload(wireBytes(compiled('legacy')), ADDR0)).toBe(true)
    expect(isSolanaTransactionPayload(wireBytes(compiled(0)), ADDR0)).toBe(true)
  })

  it('accepts the signer as a 32-byte public key', async () => {
    const a = await account()
    expect(isSolanaTransactionPayload(messageBytes(compiled(0)), a.publicKey)).toBe(true)
  })

  it('allows a transaction message in which our key is NOT a required signer', () => {
    // we are only the (writable, non-signer) destination
    const bytes = messageBytes(compiled(0, { payer: ATTACKER, from: ATTACKER, to: ADDR0 }))
    expect(isSolanaTransactionPayload(bytes, ADDR0)).toBe(false)
    expect(isSolanaTransactionPayload(messageBytes(compiled('legacy', { payer: ATTACKER, from: ATTACKER, to: ADDR0 })), ADDR0)).toBe(false)
  })

  // Note: a v0 message missing its final lookup-count byte still decodes in kit (the count reads as 0),
  // so it is refused too — a harmless over-refusal on bytes nobody signs as a message.
  it('allows a transaction message with trailing bytes (not an exact decode)', () => {
    for (const tx of [compiled('legacy'), compiled(0)]) {
      const m = messageBytes(tx)
      const padded = new Uint8Array(m.length + 1)
      padded.set(m)
      expect(isSolanaTransactionPayload(padded, ADDR0)).toBe(false)
    }
  })

  it('never matches 32/64-byte nonces, UTF-8 text, the off-chain header or empty input', () => {
    for (let i = 0; i < 500; i++) {
      expect(isSolanaTransactionPayload(random(32), ADDR0)).toBe(false)
      expect(isSolanaTransactionPayload(random(64), ADDR0)).toBe(false)
    }
    expect(isSolanaTransactionPayload(new TextEncoder().encode('Sign in to example.com\nNonce: 8f3a'), ADDR0)).toBe(false)
    const off = new Uint8Array([...SOLANA_OFFCHAIN_MESSAGE_PREFIX, 0, ...new TextEncoder().encode('hello')])
    expect(isSolanaTransactionPayload(off, ADDR0)).toBe(false)
    expect(isSolanaTransactionPayload(new Uint8Array(), ADDR0)).toBe(false)
  })
})

describe('classifySolanaMessage', () => {
  it('sorts payloads into transaction / offchain / text / binary', () => {
    expect(classifySolanaMessage(messageBytes(compiled(0)), ADDR0)).toBe('transaction')
    expect(classifySolanaMessage(new Uint8Array([...SOLANA_OFFCHAIN_MESSAGE_PREFIX, 0, 1, 2]), ADDR0)).toBe('offchain')
    expect(classifySolanaMessage(new TextEncoder().encode('héllo wörld ✓ 🚀\n'), ADDR0)).toBe('text')
    expect(classifySolanaMessage(new Uint8Array([0xff, 0xfe, 0x00, 0x01]), ADDR0)).toBe('binary')
    expect(classifySolanaMessage(new Uint8Array(32), ADDR0)).toBe('binary') // NUL bytes are not readable text
    expect(classifySolanaMessage(new Uint8Array([0xc0, 0x80]), ADDR0)).toBe('binary') // overlong
    expect(classifySolanaMessage(new Uint8Array([0xed, 0xa0, 0x80]), ADDR0)).toBe('binary') // surrogate
    expect(classifySolanaMessage(new Uint8Array([0xe2, 0x9c]), ADDR0)).toBe('binary') // truncated
    // a transaction message where we are not a signer is just binary (allowed, with a warning)
    expect(classifySolanaMessage(messageBytes(compiled(0, { payer: ATTACKER, from: ATTACKER, to: ADDR0 })), ADDR0)).toBe('binary')
  })
})

describe('WalletAccountSolana.sign', () => {
  it('refuses a legacy / v0 / wire transaction with MessageIsTransactionError and never calls the signer', async () => {
    const a = await account()
    let calls = 0
    const orig = a.signer.sign.bind(a.signer)
    ;(a.signer as { sign: typeof orig }).sign = async (...args) => { calls++; return orig(...args) }
    for (const bytes of [messageBytes(compiled('legacy')), messageBytes(compiled(0)), messageBytes(compiled(0, { lookup: true, to: LOOKED_UP })), wireBytes(compiled(0))]) {
      const err = await a.sign(bytes).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(MessageIsTransactionError)
      expect((err as Error).message).toMatch(/use signTransaction/)
    }
    expect(calls).toBe(0)
    ;(a.signer as { sign: typeof orig }).sign = orig
  })

  it('still signs text, nonces, off-chain-header messages, foreign transactions and trailing-byte payloads raw (no envelope)', async () => {
    const a = await account()
    const m = messageBytes(compiled(0))
    const trailing = new Uint8Array(m.length + 1)
    trailing.set(m)
    const payloads: Uint8Array[] = [
      new TextEncoder().encode('hello'),
      random(32),
      random(64),
      new Uint8Array([...SOLANA_OFFCHAIN_MESSAGE_PREFIX, 0, ...new TextEncoder().encode('hi')]),
      messageBytes(compiled(0, { payer: ATTACKER, from: ATTACKER, to: ADDR0 })),
      trailing,
    ]
    for (const p of payloads) {
      const sig = Uint8Array.from(Buffer.from(await a.sign(p), 'hex'))
      expect(ed25519.verify(sig, p, a.publicKey)).toBe(true)
    }
    const text = Uint8Array.from(Buffer.from(await a.sign('hello'), 'hex'))
    expect(ed25519.verify(text, new TextEncoder().encode('hello'), a.publicKey)).toBe(true)
  })
})
