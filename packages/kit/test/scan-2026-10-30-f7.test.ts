import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies } from '../src/index.js'
import { canonicalAddress } from '../src/destinations.js'

// Scan 2026-10-30 F7: Solana base58 is case-sensitive, and the allowlist folded case: a recipient whose
// spelling differs from an allowlisted key only in letter case (a different public key) passed. Now only
// namespaces whose addresses are case-insensitive are folded; base58 is compared exactly.
const ALPH = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function b58(s: string): Uint8Array {
  let n = 0n
  for (const c of s) { const i = ALPH.indexOf(c); if (i < 0) throw new Error('bad'); n = n * 58n + BigInt(i) }
  const out: number[] = []
  while (n > 0n) { out.unshift(Number(n & 0xffn)); n >>= 8n }
  for (const c of s) { if (c === '1') out.unshift(0); else break }
  return Uint8Array.from(out)
}
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const ALLOWED = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' // 32-byte key
// flip the case of one letter whose other-case form is also in the alphabet and still decodes to 32 bytes
function caseVariant(a: string): string {
  for (let i = 0; i < a.length; i++) {
    const c = a[i]!
    const f = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
    if (f === c || !ALPH.includes(f)) continue
    const v = a.slice(0, i) + f + a.slice(i + 1)
    if (b58(v).length === 32) return v
  }
  throw new Error('no variant')
}
const VARIANT = caseVariant(ALLOWED)

describe('scan 2026-10-30 F7: case-sensitive addresses are compared exactly', () => {
  it('the variant is a different, valid 32-byte public key', () => {
    expect(VARIANT).not.toBe(ALLOWED)
    expect(b58(VARIANT).length).toBe(32)
    expect(hex(b58(VARIANT))).not.toBe(hex(b58(ALLOWED)))
  })

  it('the allowlist refuses a case variant of an allowlisted Solana key', async () => {
    const acc = createMockAccount({ chain: 'solana:mainnet' })
    const p = applyPolicies(acc, { allowlist: { solana: [ALLOWED] } })
    let refused = false
    try { await p.transfer({ recipient: VARIANT, amount: 1n }) } catch (e) { refused = (e as { policy?: string }).policy === 'allowlist' }
    expect({ refused, sentTo: acc.sent.map((s) => (s as { recipient?: string; to?: string }).recipient ?? (s as { to?: string }).to) }).toEqual({ refused: true, sentTo: [] })
  })

  it('control: the exact allowlisted key still passes', async () => {
    const acc = createMockAccount({ chain: 'solana:mainnet' })
    await applyPolicies(acc, { allowlist: { solana: [ALLOWED] } }).transfer({ recipient: ALLOWED, amount: 1n })
    expect(acc.sent).toHaveLength(1)
  })

  it('EVM shares canonicalAddress, and must stay case-insensitive', async () => {
    const DEST = '0x000000000000000000000000000000000000bEEF'
    expect(canonicalAddress('eip155:1', DEST)).toBe(canonicalAddress('eip155:1', DEST.toLowerCase()))
    const acc = createMockAccount({ chain: 'eip155:1' })
    await applyPolicies(acc, { allowlist: { eip155: [DEST] } }).transfer({ recipient: DEST.toLowerCase(), amount: 1n })
    expect(acc.sent).toHaveLength(1)
  })

  it('a blocklisted Solana key does not block its case variant, and still blocks itself', async () => {
    const acc = createMockAccount({ chain: 'solana:mainnet' })
    const p = applyPolicies(acc, { blocklist: { solana: [ALLOWED] } })
    await expect(p.transfer({ recipient: ALLOWED, amount: 1n })).rejects.toMatchObject({ policy: 'blocklist' })
    await p.transfer({ recipient: VARIANT, amount: 1n })
    expect(acc.sent).toHaveLength(1)
  })

  it('per namespace: what folds and what does not', () => {
    // Bitcoin / Zcash bech32: one case, either one
    expect(canonicalAddress('bip122:000000000019d6689c085ae165831e93', 'BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ')).toBe('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    expect(canonicalAddress('bitcoin', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    expect(canonicalAddress('bip122:x', 'TB1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KXPJZSX')).toBe('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx')
    expect(canonicalAddress('zcash:x', 'U1ACDE')).toBe('u1acde')
    // mixed case is not bech32: kept as given
    expect(canonicalAddress('bip122:x', 'bc1QAR0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe('bc1QAR0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')
    // base58 is exact on Bitcoin and Zcash
    expect(canonicalAddress('bip122:x', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')).toBe('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2')
    expect(canonicalAddress('zcash:x', 't1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU')).toBe('t1Rv4exT7bqhZqi2j7xz8bUHDMxwosrjADU')
    // Solana exact; EVM, NEAR, Aptos, Starknet lowercase; Tron and TON canonical as before
    expect(canonicalAddress('solana:mainnet', ALLOWED)).toBe(ALLOWED)
    expect(canonicalAddress('near:mainnet', 'Alice.NEAR')).toBe('alice.near')
    expect(canonicalAddress('aptos:1', '0xABC')).toBe('0xabc')
    expect(canonicalAddress('starknet:SN_MAIN', '0xABC')).toBe('0xabc')
    expect(canonicalAddress('tron:mainnet', 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe(canonicalAddress('tron:mainnet', '41a614f803b6fd780986a42c78ec9c7f77e6ded13c'))
    // an unknown namespace is compared exactly
    expect(canonicalAddress('stellar:pubnet', 'GABC')).toBe('GABC')
  })

  it('a Bitcoin allowlist matches a bech32 address in either case', async () => {
    const acc = createMockAccount({ chain: 'bip122:000000000019d6689c085ae165831e93' })
    await applyPolicies(acc, { allowlist: { bitcoin: ['BC1QAR0SRRR7XFKVY5L643LYDNW9RE59GTZZWF5MDQ'] } }).transfer({ recipient: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', amount: 1n })
    expect(acc.sent).toHaveLength(1)
  })
})
