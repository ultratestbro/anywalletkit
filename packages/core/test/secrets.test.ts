import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { bytesToHex } from '@noble/hashes/utils.js'
import { LocalSigner, SignerError, WalletManager, deriveSecp256k1, seedFromMnemonicSync, type FeeRates, type IWalletAccount, type Signer } from '../src/index.js'

const PHRASE = 'test test test test test test test test test test test junk'
const SEED = seedFromMnemonicSync(PHRASE)
const EVM0 = "m/44'/60'/0'/0/0"
const SEED_HEX = bytesToHex(SEED)
const KEY_HEX = bytesToHex(deriveSecp256k1(SEED, EVM0).privateKey)
const digest = new Uint8Array(32).fill(1)

/** Every way an app or a crash reporter turns an object into text. */
function renderings(o: object): string {
  return [inspect(o, { depth: 10, showHidden: true }), JSON.stringify(o), String(Object.values(o)), Object.keys(o).join()].join('\n')
}
/** Byte arrays show up as comma lists in inspect / JSON: look for a run of the first bytes too. */
function leaks(text: string, bytes: Uint8Array): boolean {
  const hexHit = text.toLowerCase().includes(bytesToHex(bytes))
  const run = Array.from(bytes.slice(0, 8)).join(', ')
  const runJson = Array.from(bytes.slice(0, 8)).map((b, i) => `"${i}":${b}`).join(',')
  return hexHit || text.includes(run) || text.includes(runJson)
}

describe('secrets are never own properties (2026-10-23 audit)', () => {
  it('LocalSigner: no private key or seed in inspect / JSON / Object.values; toJSON is the public view', () => {
    const s = LocalSigner.fromSeed(SEED, 'secp256k1', EVM0)
    const text = renderings(s)
    expect(leaks(text, deriveSecp256k1(SEED, EVM0).privateKey)).toBe(false)
    expect(leaks(text, SEED)).toBe(false)
    expect(text).not.toContain(KEY_HEX)
    expect(text).not.toContain(SEED_HEX)
    expect(JSON.parse(JSON.stringify(s))).toEqual({ kind: 'seed', curve: 'secp256k1', path: EVM0, publicKey: bytesToHex(s.publicKey) })
  })

  it('leafFromSeed keeps only its own key: same public key, cannot derive', async () => {
    const leaf = LocalSigner.leafFromSeed(SEED, 'secp256k1', EVM0)
    expect(bytesToHex(leaf.publicKey)).toBe(bytesToHex(LocalSigner.fromSeed(SEED, 'secp256k1', EVM0).publicKey))
    await expect(leaf.derive('0')).rejects.toThrow(/cannot derive/)
    await expect(leaf.deriveLeaf('0')).rejects.toThrow(/cannot derive/)
    expect(await leaf.sign(digest)).toEqual(await LocalSigner.fromSeed(SEED, 'secp256k1', EVM0).sign(digest))
  })

  it('deriveLeaf gives the same child as derive, without a seed copy', async () => {
    const root = LocalSigner.fromSeed(SEED, 'secp256k1', "m/44'/60'/0'/0")
    const leaf = await root.deriveLeaf('0')
    expect(leaf.path).toBe(EVM0)
    expect(bytesToHex(leaf.publicKey)).toBe(bytesToHex((await root.derive('0')).publicKey))
    await expect(leaf.derive('0')).rejects.toThrow(/cannot derive/)
  })

  it('dispose kills signing and derivation', async () => {
    const s = LocalSigner.fromSeed(SEED, 'secp256k1', EVM0)
    s.dispose()
    await expect(s.sign(digest)).rejects.toBeInstanceOf(SignerError)
    await expect(s.derive('0')).rejects.toBeInstanceOf(SignerError)
  })

  class TestManager extends WalletManager<IWalletAccount> {
    constructor(seedOrSigner: string | Uint8Array | Signer) { super(seedOrSigner, {}) }
    seed() { return this.seedBytes() }
    async getAccount(): Promise<IWalletAccount> { throw new Error('unused') }
    async getAccountByPath(): Promise<IWalletAccount> { throw new Error('unused') }
    async getFeeRates(): Promise<FeeRates> { return { slow: 1n, normal: 1n, fast: 1n } }
  }

  it('WalletManager: the seed is not an own property, from a phrase or from bytes', () => {
    for (const m of [new TestManager(PHRASE), new TestManager(SEED)]) {
      expect(bytesToHex(m.seed())).toBe(SEED_HEX)
      const text = renderings(m)
      expect(leaks(text, SEED)).toBe(false)
      expect(text).not.toContain('test junk')
    }
  })

  it('WalletManager copies seed bytes: the caller zeroizing its own does not touch the manager; dispose zeroizes the copy', () => {
    const mine = SEED.slice()
    const m = new TestManager(mine)
    mine.fill(0)
    expect(bytesToHex(m.seed())).toBe(SEED_HEX)
    const held = m.seed()
    m.dispose()
    expect(held.every((b) => b === 0)).toBe(true)
    expect(() => m.seed()).toThrow(/disposed/)
    expect(() => new TestManager(new Uint8Array(32))).toThrow(/64 bytes/)
  })
})
