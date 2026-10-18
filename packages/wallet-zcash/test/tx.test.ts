import { describe, expect, it } from 'vitest'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { CURRENT_BRANCH_ID, MAINNET_UPGRADES, branchIdForHeight, conventionalFee, outputSize, parseP2pkhScriptSig, parseTx, serializeTx, sighashAll, txid } from '../src/index.js'
import { FIXTURES, fixture, hex } from './helpers.js'

describe('v5 transparent transactions (ZIP-225 / ZIP-244) against mined mainnet transactions', () => {
  for (const hash of FIXTURES) {
    const f = fixture(hash)
    it(`${hash.slice(0, 8)}: parse → serialize round-trips the raw bytes`, () => {
      const tx = parseTx(f.hex)
      expect(hex(serializeTx(tx))).toBe(f.hex)
      expect(tx.consensusBranchId).toBe(0x37a5165b) // NU6.3 — mined after block 3 428 143
      expect(tx.inputs.length).toBe(f.inputs.length)
      expect(tx.outputs.map((o) => [o.value, hex(o.script)])).toEqual(f.outputs.map((o) => [BigInt(o.value), o.script_hex]))
    })

    it(`${hash.slice(0, 8)}: ZIP-244 txid matches the chain`, () => {
      expect(txid(parseTx(f.hex))).toBe(hash)
    })

    it(`${hash.slice(0, 8)}: ZIP-244 SIGHASH_ALL verifies every input's on-chain signature`, () => {
      const tx = parseTx(f.hex)
      const spent = f.inputs.map((i) => ({ value: BigInt(i.value), script: hexToBytes(i.script_hex) }))
      for (let i = 0; i < tx.inputs.length; i++) {
        const sig = parseP2pkhScriptSig(tx.inputs[i]!.scriptSig)!
        expect(sig.hashType).toBe(0x01)
        const digest = sighashAll(tx, i, spent)
        expect(secp256k1.verify(sig.signature, digest, sig.publicKey, { prehash: false, format: 'der' })).toBe(true)
        // a different amount → a different digest → the signature no longer verifies
        const tampered = spent.map((s, k) => (k === i ? { ...s, value: s.value + 1n } : s))
        expect(secp256k1.verify(sig.signature, sighashAll(tx, i, tampered), sig.publicKey, { prehash: false, format: 'der' })).toBe(false)
      }
    })

    it(`${hash.slice(0, 8)}: the fee it paid is the ZIP-317 conventional fee`, () => {
      const tx = parseTx(f.hex)
      const inSizes = tx.inputs.map((i) => 36 + 1 + i.scriptSig.length + 4)
      expect(conventionalFee(inSizes, tx.outputs.map((o) => outputSize(o.script)))).toBe(BigInt(f.fee))
    })
  }

  it('refuses non-v5 and shielded transactions', () => {
    // v4 Sapling header (0x80000004, vgid 0x892f2085)
    expect(() => parseTx('0400008085202f8900000000000000000000000000000000000000000000000000')).toThrow(/Only v5/)
    // v5 with one Orchard action claimed
    expect(() => parseTx('050000800a27a7265b16a5370000000000000000' + '00' + '00' + '00' + '00' + '01')).toThrow(/Orchard/)
  })

  it('picks the consensus branch id from the height', () => {
    expect(branchIdForHeight(undefined)).toBe(CURRENT_BRANCH_ID)
    expect(branchIdForHeight(3_428_143)).toBe(0x37a5165b)
    expect(branchIdForHeight(3_428_142)).toBe(0x4dec4df0)
    expect(branchIdForHeight(3_000_000)).toBe(0xc8e71055)
    expect(branchIdForHeight(1_700_000)).toBe(0xc2d6d0b4)
    expect(MAINNET_UPGRADES.map((u) => u.name)).toEqual(['NU5', 'NU6', 'NU6.1', 'NU6.3'])
  })
})
