import { describe, expect, it } from 'vitest'
import { addressFromPublicKey, addressFromScript, decodeAddress, encodeAddress, hash160, scriptFor, scriptKind } from '../src/index.js'
import { hex } from './helpers.js'

// Live mainnet vectors (Blockchair address dashboards, 2026-10-18): address ↔ scriptPubKey.
const LIVE = [
  { address: 't1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua', script: '76a91413bbd8bc8df03a5a9cda88103f583aa8bc043e2488ac' },
  { address: 't1P2rQC3My1Ps4gks6ihnf7Zm6MzcwTENjE', script: '76a9143898635cac98262fce2d990ee099d45cc775173e88ac' },
  { address: 't1Yvb326jbDwmKCYKHNQHRrx6RZKC1dRXkw', script: '76a914a51a52f9c1d6da295422655017880bb0900e696e88ac' },
]

describe('transparent addresses', () => {
  it('decodes live t1 addresses to their scriptPubKey and back', () => {
    for (const v of LIVE) {
      const d = decodeAddress(v.address, 'mainnet')
      expect(d.kind).toBe('p2pkh')
      expect(hex(d.script)).toBe(v.script)
      expect(addressFromScript(d.script, 'mainnet')).toBe(v.address)
      expect(encodeAddress('p2pkh', d.hash, 'mainnet')).toBe(v.address)
    }
  })

  it('knows the t3 (P2SH) prefix and script shape', () => {
    const d = decodeAddress('t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd', 'mainnet')
    expect(d.kind).toBe('p2sh')
    expect(hex(d.script.slice(0, 2))).toBe('a914')
    expect(d.script[22]).toBe(0x87)
    expect(scriptKind(d.script)).toBe('p2sh')
    expect(addressFromScript(d.script, 'mainnet')).toBe('t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd')
  })

  it('derives a P2PKH address from a compressed key (hash160)', () => {
    const pub = Uint8Array.from([0x02, ...new Uint8Array(32).fill(1)])
    const a = addressFromPublicKey(pub, 'mainnet')
    expect(a.startsWith('t1')).toBe(true)
    expect(hex(decodeAddress(a, 'mainnet').hash)).toBe(hex(hash160(pub)))
    expect(addressFromPublicKey(pub, 'testnet').startsWith('tm')).toBe(true)
  })

  it('refuses shielded, unified, foreign-network and malformed addresses by name', () => {
    expect(() => decodeAddress('u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf', 'mainnet')).toThrow(/Unified/)
    expect(() => decodeAddress('zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly', 'mainnet')).toThrow(/Sapling/)
    expect(() => decodeAddress('t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ua', 'testnet')).toThrow(/mainnet address/)
    expect(() => decodeAddress('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu', 'mainnet')).toThrow(/Invalid Zcash address/)
    expect(() => decodeAddress('t1KfwsnwJeNRVjQGBDZhwKskpQbih2qx5Ub', 'mainnet')).toThrow(/Invalid Zcash address/)
    expect(scriptKind(scriptFor('p2pkh', new Uint8Array(20)))).toBe('p2pkh')
    expect(addressFromScript(Uint8Array.of(0x6a, 0x01, 0x00), 'mainnet')).toBeUndefined()
  })
})
