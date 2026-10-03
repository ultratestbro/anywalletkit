/**
 * Key-material parity with the golden vectors, for every chain, straight from core —
 * before any chain package exists. The vectors were recorded against the 
 * wallet managers (see packages/conformance/vectors/derivation.json). If this
 * test is red, users would get DIFFERENT addresses from the same seed.
 */
import { describe, expect, it } from 'vitest'
import { bytesToHex } from '@noble/hashes/utils.js'
import vectors from '../../conformance/vectors/derivation.json'
import { deriveEd25519, deriveSecp256k1, seedFromMnemonicSync, isValidSeedPhrase } from '../src/index.js'

type Account = { index: number; path: string; address: string; publicKey: string }
type Chain = Record<string, { accounts: Account[] }>
const v = vectors.vectors as unknown as Record<'evm' | 'btc' | 'ton' | 'tron' | 'solana', Chain>

const secp = ['evm', 'btc', 'tron'] as const
const ed = ['ton', 'solana'] as const

describe('key-material parity', () => {
  for (const [seedName, mnemonic] of Object.entries(vectors.seeds)) {
    const seed = seedFromMnemonicSync(mnemonic)
    it(`${seedName}: is a valid seed phrase`, () => expect(isValidSeedPhrase(mnemonic)).toBe(true))

    for (const chain of secp) {
      for (const acc of v[chain][seedName]!.accounts) {
        it(`${seedName} ${chain} #${acc.index} secp256k1 pubkey at ${acc.path}`, () => {
          expect(bytesToHex(deriveSecp256k1(seed, acc.path).publicKey)).toBe(acc.publicKey)
        })
      }
    }
    for (const chain of ed) {
      for (const acc of v[chain][seedName]!.accounts) {
        it(`${seedName} ${chain} #${acc.index} ed25519 pubkey at ${acc.path}`, () => {
          expect(bytesToHex(deriveEd25519(seed, acc.path).publicKey)).toBe(acc.publicKey)
        })
      }
    }
  }
})
