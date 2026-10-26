import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { base58 } from '@scure/base'
import { externalSigner } from '@anywalletkit/core'
import * as near from '../src/index.js'
import { WalletAccountReadOnlyNear, WalletManagerNear } from '../src/index.js'
import { SEED } from './fake-node.js'

// Audit 2026-10-25 round 3, H1: sign() signed any raw bytes, and NEAR signs a transaction over its
// 32-byte sha256 — a dApp asking to "sign a message" of sha256(borsh(AddKey FullAccess)) got a
// valid signature for a transaction that hands the account to the attacker.
const KEY = new Uint8Array(32).fill(0x42)
const PUB = ed25519.getPublicKey(KEY)
const MessageIsTransactionError = (near as unknown as { MessageIsTransactionError?: new () => Error }).MessageIsTransactionError

describe('NEAR sign() never signs a transaction hash', () => {
  it('exports MessageIsTransactionError', () => {
    expect(MessageIsTransactionError).toBeTypeOf('function')
  })

  it('refuses sha256(borsh(tx)) of a full-access AddKey, as bytes or as a 32-byte string; nothing reaches the signer', async () => {
    const asked: Uint8Array[] = []
    const signer = externalSigner({ curve: 'ed25519', publicKey: PUB, sign: async (payload) => { asked.push(payload); return ed25519.sign(payload, KEY) } })
    const a = await new WalletManagerNear(signer).getAccount()
    const tx = {
      signerId: a.address, publicKey: a.publicKey, nonce: 42n, receiverId: a.address, blockHash: new Uint8Array(32).fill(1),
      actions: [{ addKey: { publicKey: { keyType: 'ed25519' as const, data: new Uint8Array(32).fill(7) }, accessKey: { nonce: 0n, permission: { fullAccess: {} } } } }],
    }
    const digest = WalletAccountReadOnlyNear.hashOf(tx as never)
    expect(digest).toHaveLength(32)
    await expect(a.sign(digest)).rejects.toMatchObject({ name: 'MessageIsTransactionError', code: 'message-is-transaction' })
    await expect(a.sign('x'.repeat(32))).rejects.toMatchObject({ name: 'MessageIsTransactionError' })
    await expect(a.sign('é'.repeat(16))).rejects.toMatchObject({ name: 'MessageIsTransactionError' }) // 16 chars, 32 UTF-8 bytes
    expect(asked).toHaveLength(0)
    for (const m of ['hello', 'x'.repeat(31), 'x'.repeat(33), new Uint8Array(64)]) {
      const sig = await a.sign(m)
      expect(ed25519.verify(base58.decode(sig.slice('ed25519:'.length)), typeof m === 'string' ? new TextEncoder().encode(m) : m, PUB)).toBe(true)
    }
  })

  it('signNep413 stays the way to sign an off-chain message (its own 32-byte digest, NEP-413 prefixed)', async () => {
    const m = new WalletManagerNear(SEED)
    const a = await m.getAccount(0)
    const nep = await a.signNep413({ message: 'login', nonce: new Uint8Array(32), recipient: 'intents.near' })
    expect(ed25519.verify(Uint8Array.from(atob(nep.signature), (c) => c.charCodeAt(0)), near.nep413Hash({ message: 'login', nonce: new Uint8Array(32), recipient: 'intents.near' }), a.publicKey.data)).toBe(true)
    m.dispose()
  })
})
