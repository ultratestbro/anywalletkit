import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { SignerError, externalSigner, tweakSecp256k1PrivateKey } from '../src/index.js'

// Audit 2026-10-25 round 3, M14: externalSigner checked only the scheme and the signature's length.
// A backend (hardware, MPC, a server) answering with a signature by ANOTHER key — or garbage of the
// right length — was passed on: the chain then rejects the transaction, or, for a recoverable
// signature, the "sender" becomes whatever address the bytes recover to. Each signature is now
// verified against the signer's public key before it leaves.

const digest = sha256(new TextEncoder().encode('anywalletkit'))
const priv = new Uint8Array(32).fill(9)
const other = new Uint8Array(32).fill(7)
const pub = secp256k1.getPublicKey(priv)
const recovered = (key: Uint8Array) => {
  const r = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' })
  const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!
  return out
}

describe('externalSigner verifies what the backend returns', () => {
  it('ecdsa-recoverable: another key, or a wrong recovery id, is refused', async () => {
    const good = externalSigner({ curve: 'secp256k1', publicKey: pub, sign: async () => recovered(priv) })
    expect((await good.sign(digest)).length).toBe(65)
    const wrongKey = externalSigner({ curve: 'secp256k1', publicKey: pub, sign: async () => recovered(other) })
    await expect(wrongKey.sign(digest)).rejects.toThrow(SignerError)
    const flipped = externalSigner({ curve: 'secp256k1', publicKey: pub, sign: async () => { const s = recovered(priv); s[64] = s[64]! ^ 1; return s } })
    await expect(flipped.sign(digest)).rejects.toThrow(/does not verify|recovers to another key/)
  })

  it('ecdsa (compact): another key or garbage is refused', async () => {
    const good = externalSigner({ curve: 'secp256k1', publicKey: pub, schemes: ['ecdsa'], sign: async (p) => secp256k1.sign(p, priv, { prehash: false, format: 'compact' }) })
    expect((await good.sign(digest, { scheme: 'ecdsa' })).length).toBe(64)
    const wrong = externalSigner({ curve: 'secp256k1', publicKey: pub, schemes: ['ecdsa'], sign: async (p) => secp256k1.sign(p, other, { prehash: false, format: 'compact' }) })
    await expect(wrong.sign(digest, { scheme: 'ecdsa' })).rejects.toThrow(/does not verify/)
    const garbage = externalSigner({ curve: 'secp256k1', publicKey: pub, schemes: ['ecdsa'], sign: async () => new Uint8Array(64).fill(1) })
    await expect(garbage.sign(digest, { scheme: 'ecdsa' })).rejects.toThrow(SignerError)
  })

  it('ed25519: verified against the key', async () => {
    const edPriv = new Uint8Array(32).fill(3)
    const edPub = ed25519.getPublicKey(edPriv)
    const msg = new TextEncoder().encode('a solana message')
    const good = externalSigner({ curve: 'ed25519', publicKey: edPub, sign: async (p) => ed25519.sign(p, edPriv) })
    expect((await good.sign(msg)).length).toBe(64)
    const wrong = externalSigner({ curve: 'ed25519', publicKey: edPub, sign: async (p) => ed25519.sign(p, new Uint8Array(32).fill(4)) })
    await expect(wrong.sign(msg)).rejects.toThrow(/does not verify/)
  })

  it('schnorr: against the x-only key, and with a tweak against the tweaked (taproot output) key', async () => {
    const tweak = sha256(new TextEncoder().encode('tap'))
    const good = externalSigner({ curve: 'secp256k1', publicKey: pub, schemes: ['schnorr'], sign: async (p, o) => schnorr.sign(p, o.tweak ? tweakSecp256k1PrivateKey(priv, o.tweak) : priv) })
    expect((await good.sign(digest, { scheme: 'schnorr' })).length).toBe(64)
    expect((await good.sign(digest, { scheme: 'schnorr', tweak })).length).toBe(64)
    // a backend that forgot the tweak signs for the internal key: not valid for the output key
    const untweaked = externalSigner({ curve: 'secp256k1', publicKey: pub, schemes: ['schnorr'], sign: async (p) => schnorr.sign(p, priv) })
    await expect(untweaked.sign(digest, { scheme: 'schnorr', tweak })).rejects.toThrow(/does not verify/)
    const wrong = externalSigner({ curve: 'secp256k1', publicKey: pub, schemes: ['schnorr'], sign: async (p) => schnorr.sign(p, other) })
    await expect(wrong.sign(digest, { scheme: 'schnorr' })).rejects.toThrow(/does not verify/)
  })
})
