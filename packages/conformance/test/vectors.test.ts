import { describe, expect, it } from 'vitest'
import { derivationVectors } from '../src/index.js'

describe('golden vectors are complete', () => {
  it('covers 5 chains × 3 seeds × 2 indexes with address, pubkey and message signature', () => {
    const chains = ['evm', 'btc', 'ton', 'tron', 'solana'] as const
    const seeds = Object.keys(derivationVectors.seeds)
    expect(seeds).toHaveLength(3)
    for (const c of chains) for (const s of seeds) {
      const set = derivationVectors.vectors[c][s]!
      expect(set.accounts.map((a) => a.index)).toEqual([0, 1])
      for (const a of set.accounts) {
        expect(a.address.length).toBeGreaterThan(20)
        expect(a.publicKey).toMatch(/^[0-9a-f]+$/)
        expect(typeof a.signMessage).toBe('string')
      }
    }
  })
  it('pubkey sizes match the curve', () => {
    for (const s of Object.keys(derivationVectors.seeds)) {
      for (const c of ['evm', 'btc', 'tron'] as const) for (const a of derivationVectors.vectors[c][s]!.accounts) expect(a.publicKey).toHaveLength(66)
      for (const c of ['ton', 'solana'] as const) for (const a of derivationVectors.vectors[c][s]!.accounts) expect(a.publicKey).toHaveLength(64)
    }
  })
  it('EVM vectors carry tx and typed-data signatures', () => {
    for (const s of Object.keys(derivationVectors.seeds)) for (const a of derivationVectors.vectors.evm[s]!.accounts) {
      expect(a.signTransaction).toMatch(/^0x02/)
      expect(a.signTypedData).toMatch(/^0x/)
    }
  })
})
