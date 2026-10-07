import { describe, expect, it } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { sha256 } from '@noble/hashes/sha2.js'
import {
  LocalSigner, SignerError, defaultScheme, externalSigner, isSeedSigner, requireCurve, schemesFor, seedFromMnemonicSync,
} from '../src/index.js'

const SEED = seedFromMnemonicSync('test test test test test test test test test test test junk')
const EVM0 = "m/44'/60'/0'/0/0"
const digest = sha256(new TextEncoder().encode('forgewallet'))

describe('LocalSigner — secp256k1', () => {
  it('ecdsa-recoverable is the default: 65 bytes r‖s‖rec, recovers the public key', async () => {
    const s = LocalSigner.fromSeed(SEED, 'secp256k1', EVM0)
    expect(s.kind).toBe('seed')
    expect(s.schemes).toEqual(['ecdsa-recoverable', 'ecdsa', 'schnorr'])
    const sig = await s.sign(digest)
    expect(sig).toHaveLength(65)
    expect(sig[64]).toBeLessThanOrEqual(1)
    // noble recovers from recovery‖r‖s
    const noble = new Uint8Array(65)
    noble[0] = sig[64]!
    noble.set(sig.subarray(0, 64), 1)
    expect(bytesToHex(secp256k1.recoverPublicKey(noble, digest, { prehash: false }))).toBe(bytesToHex(s.publicKey))
    expect(secp256k1.verify(sig.subarray(0, 64), digest, s.publicKey, { prehash: false })).toBe(true)
  })

  it('ecdsa is 64-byte compact low-S', async () => {
    const s = LocalSigner.fromSeed(SEED, 'secp256k1', EVM0)
    const sig = await s.sign(digest, { scheme: 'ecdsa', context: 'btc-sighash' })
    expect(sig).toHaveLength(64)
    const S = BigInt('0x' + bytesToHex(sig.subarray(32)))
    expect(S <= secp256k1.Point.CURVE().n / 2n).toBe(true)
    expect(secp256k1.verify(sig, digest, s.publicKey, { prehash: false, lowS: true })).toBe(true)
  })

  it('schnorr matches BIP-340 test vector #0', async () => {
    const priv = hexToBytes('0000000000000000000000000000000000000000000000000000000000000003')
    const s = LocalSigner.fromPrivateKey('secp256k1', priv, secp256k1.getPublicKey(priv), 'test')
    const sig = await s.sign(new Uint8Array(32), { scheme: 'schnorr', aux: new Uint8Array(32) })
    expect(bytesToHex(sig).toUpperCase()).toBe(
      'E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0',
    )
    expect(schnorr.verify(sig, new Uint8Array(32), schnorr.getPublicKey(priv))).toBe(true)
  })

  it('rejects ed25519 and non-32-byte digests', async () => {
    const s = LocalSigner.fromSeed(SEED, 'secp256k1', EVM0)
    await expect(s.sign(digest, { scheme: 'ed25519' })).rejects.toBeInstanceOf(SignerError)
    await expect(s.sign(new Uint8Array(31))).rejects.toThrow(/32-byte/)
  })

  it('derives children from a seed signer; a bare-key signer cannot', async () => {
    const root = LocalSigner.fromSeed(SEED, 'secp256k1', "m/44'/60'/0'/0")
    const child = await root.derive('0')
    expect(child.path).toBe(EVM0)
    expect(bytesToHex(child.publicKey)).toBe(bytesToHex(LocalSigner.fromSeed(SEED, 'secp256k1', EVM0).publicKey))
    expect(isSeedSigner(child)).toBe(true)
    const bare = LocalSigner.fromPrivateKey('secp256k1', new Uint8Array(32).fill(7), secp256k1.getPublicKey(new Uint8Array(32).fill(7)), 'x')
    await expect(bare.derive('0')).rejects.toThrow(/cannot derive/)
  })

  it('dispose zeroizes and kills signing (idempotent)', async () => {
    const s = LocalSigner.fromSeed(SEED, 'secp256k1', EVM0)
    s.dispose()
    s.dispose()
    await expect(s.sign(digest)).rejects.toBeInstanceOf(SignerError)
    await expect(s.getPublicKey()).rejects.toBeInstanceOf(SignerError)
  })
})

describe('LocalSigner — ed25519', () => {
  it('matches RFC 8032 test 1 (empty message)', async () => {
    const priv = hexToBytes('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60')
    const pub = ed25519.getPublicKey(priv)
    expect(bytesToHex(pub)).toBe('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a')
    const s = LocalSigner.fromPrivateKey('ed25519', priv, pub, 'test')
    expect(s.schemes).toEqual(['ed25519'])
    const sig = await s.sign(new Uint8Array(0), { context: 'solana-message' })
    expect(bytesToHex(sig)).toBe(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    )
    await expect(s.sign(digest, { scheme: 'ecdsa' })).rejects.toBeInstanceOf(SignerError)
  })

  it('derives SLIP-10 children (hardened only)', async () => {
    const root = LocalSigner.fromSeed(SEED, 'ed25519', "m/44'/501'")
    const child = await root.derive("0'/0'")
    expect(child.path).toBe("m/44'/501'/0'/0'")
    await expect(root.derive('0')).rejects.toThrow(/hardened/)
  })
})

describe('externalSigner + helpers', () => {
  const priv = new Uint8Array(32).fill(9)
  const pub = secp256k1.getPublicKey(priv)

  it('wraps a callback, resolves the scheme, validates the result', async () => {
    const seen: string[] = []
    const s = externalSigner({
      curve: 'secp256k1',
      publicKey: pub,
      schemes: ['ecdsa-recoverable', 'ecdsa'],
      sign: async (payload, o) => {
        seen.push(`${o.scheme}:${o.context ?? ''}`)
        if (o.scheme === 'ecdsa') return secp256k1.sign(payload, priv, { prehash: false, format: 'compact' })
        const r = secp256k1.sign(payload, priv, { prehash: false, format: 'recovered' })
        const out = new Uint8Array(65); out.set(r.subarray(1)); out[64] = r[0]!
        return out
      },
    })
    expect(s.kind).toBe('external')
    expect(isSeedSigner(s)).toBe(false)
    expect(await s.getPublicKey()).toBe(pub)
    const rec = await s.sign(digest, { context: 'evm-tx' })
    expect(rec).toHaveLength(65)
    const compact = await s.sign(digest, { scheme: 'ecdsa' })
    expect(compact).toHaveLength(64)
    expect(seen).toEqual(['ecdsa-recoverable:evm-tx', 'ecdsa:'])
    await expect(s.sign(digest, { scheme: 'schnorr' })).rejects.toBeInstanceOf(SignerError)
  })

  it('rejects malformed results and impossible scheme lists; dispose is idempotent', async () => {
    let disposed = 0
    const bad = externalSigner({ curve: 'secp256k1', publicKey: pub, sign: async () => new Uint8Array(64), dispose: () => { disposed++ } })
    await expect(bad.sign(digest)).rejects.toThrow(/expected 65/)
    const badRec = externalSigner({ curve: 'secp256k1', publicKey: pub, sign: async () => { const o = new Uint8Array(65); o[64] = 27; return o } })
    await expect(badRec.sign(digest)).rejects.toThrow(/recovery id/)
    expect(() => externalSigner({ curve: 'ed25519', publicKey: pub, schemes: ['schnorr'], sign: async () => new Uint8Array(64) })).toThrow(SignerError)
    bad.dispose(); bad.dispose()
    expect(disposed).toBe(1)
    await expect(bad.sign(digest)).rejects.toBeInstanceOf(SignerError)
  })

  it('defaultScheme / schemesFor / requireCurve', () => {
    expect(defaultScheme('secp256k1')).toBe('ecdsa-recoverable')
    expect(defaultScheme('ed25519')).toBe('ed25519')
    expect(schemesFor('ed25519')).toEqual(['ed25519'])
    const s = LocalSigner.fromSeed(SEED, 'ed25519', "m/44'/501'/0'/0'")
    expect(requireCurve(s, 'ed25519')).toBe(s)
    expect(() => requireCurve(s, 'secp256k1')).toThrow(SignerError)
  })
})
