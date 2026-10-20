import { describe, expect, it } from 'vitest'
import { getRandomSeedPhrase, isValidSeedPhrase, normalizeMnemonic, parsePath, zeroize, deriveEd25519, seedFromMnemonicSync } from '../src/index.js'

describe('mnemonic + paths', () => {
  it('generates valid 12/24-word phrases', () => {
    expect(getRandomSeedPhrase(12).split(' ')).toHaveLength(12)
    expect(getRandomSeedPhrase(24).split(' ')).toHaveLength(24)
    expect(isValidSeedPhrase(getRandomSeedPhrase())).toBe(true)
  })
  it('normalises whitespace and case', () => {
    expect(normalizeMnemonic('  Abandon  abandon\nabandon ')).toBe('abandon abandon abandon')
    expect(isValidSeedPhrase('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abouts')).toBe(false)
  })
  it('parses hardened and non-hardened segments', () => {
    expect(parsePath("m/44'/60'/0'/0/1")).toEqual([0x8000002c, 0x8000003c, 0x80000000, 0, 1])
    expect(parsePath('m/44h/501h')).toEqual([0x8000002c, 0x800001f5])
    expect(() => parsePath("44'/60'")).toThrow()
  })
  it('refuses non-hardened ed25519 segments', () => {
    const seed = seedFromMnemonicSync('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    expect(() => deriveEd25519(seed, "m/44'/501'/0'/0")).toThrow(/hardened/)
  })
  it('zeroize overwrites buffers', () => {
    const k = new Uint8Array([1, 2, 3])
    zeroize(k, undefined)
    expect(Array.from(k)).toEqual([0, 0, 0])
  })
})
