import { afterEach, describe, expect, it, vi } from 'vitest'
import { HDKey } from '@scure/bip32'
import { deriveEd25519, deriveSecp256k1, parsePath, seedFromMnemonicSync } from '../src/index.js'

const SEED = seedFromMnemonicSync('test test test test test test test test test test test junk')

// Audit 2026-10-25 round 3, L5: parsePath read segments with parseInt: "1.9'", "0x10'", "1e3'" were
// accepted as 1, 0, 1; and the `h` hardened marker worked for ed25519 only (secp256k1 went through
// @scure/bip32's own parser).
describe('parsePath is strict', () => {
  it('refuses segments that are not plain decimal indexes', () => {
    for (const bad of ["m/1.9'", "m/0x10'", "m/1e3'", "m/01'", "m/-1", "m/ 1", "m/1''", "m/2147483648", "m/2147483648'", "m/", "m//0"]) {
      expect(() => parsePath(bad), bad).toThrow(/Bad path segment|must start/)
    }
  })
  it("accepts ' and h alike on both curves", () => {
    expect(parsePath("m/44h/60'/0h/0/0")).toEqual([0x8000002c, 0x8000003c, 0x80000000, 0, 0])
    const a = deriveSecp256k1(SEED, "m/44'/60'/0'/0/0")
    const b = deriveSecp256k1(SEED, 'm/44h/60h/0h/0/0')
    expect(Buffer.from(b.publicKey).toString('hex')).toBe(Buffer.from(a.publicKey).toString('hex'))
    expect(() => deriveSecp256k1(SEED, "m/44'/60'/0x0'/0/0")).toThrow(/Bad path segment/)
  })
})

// L1 (derive part): the BIP-32 master and every intermediate node, and SLIP-10's HMAC outputs, kept
// private key material in memory after the derivation.
describe('derivation wipes what it does not return', () => {
  afterEach(() => vi.restoreAllMocks())

  it('secp256k1: every HDKey node made along the path is wiped; the returned key is intact', () => {
    const nodes: HDKey[] = []
    const fromMaster = HDKey.fromMasterSeed.bind(HDKey)
    vi.spyOn(HDKey, 'fromMasterSeed').mockImplementation((seed, versions) => { const n = fromMaster(seed, versions); nodes.push(n); return n })
    const deriveChild = HDKey.prototype.deriveChild
    vi.spyOn(HDKey.prototype, 'deriveChild').mockImplementation(function (this: HDKey, i: number) { const n = deriveChild.call(this, i); nodes.push(n); return n })
    const k = deriveSecp256k1(SEED, "m/44'/60'/0'/0/0")
    expect(nodes.length).toBe(6) // master + 5 levels
    for (const n of nodes) expect(n.privateKey).toBeNull()
    expect(k.privateKey.some((b) => b !== 0)).toBe(true)
    // same key as the reference derivation
    expect(Buffer.from(k.privateKey).toString('hex')).toBe('ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
  })

  it('ed25519: still the SLIP-10 vector after wiping its buffers', () => {
    // SLIP-10 test vector 1 (seed 000102…0f), m/0'/1'/2'/2'/1000000000'
    const seed = Uint8Array.from(Array.from({ length: 16 }, (_, i) => i))
    const k = deriveEd25519(seed, "m/0'/1'/2'/2'/1000000000'")
    expect(Buffer.from(k.privateKey).toString('hex')).toBe('8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793')
  })
})
