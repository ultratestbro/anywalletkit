import type { SignerCurve } from '@forgewallet/core'

/** The chains a keyring account spans. */
export type ChainKey = 'evm' | 'solana' | 'ton' | 'tron' | 'btc' | 'near' | 'zcash'

export interface ChainSpec {
  curve: SignerCurve
  /**
   * Where the seed signer handed to the chain manager sits. The manager derives
   * `getAccount(i)` below it, so the result is the same as building the manager
   * from the mnemonic (TON's manager wants its own base path exactly).
   */
  root: string
  /** Account `i`'s path, as the chain manager derives it (documentation and vectors). */
  accountPath: (index: number) => string
  /** Which wallets derive the same account `i` from the same BIP-39 seed. */
  compatibleWith: string
}

/**
 * Per-chain derivation. The index is the part that changes per account; every
 * other segment is fixed. Golden vectors for i = 0..4 live in test/vectors.test.ts.
 */
export const CHAIN_SPECS: Readonly<Record<ChainKey, ChainSpec>> = Object.freeze({
  evm: { curve: 'secp256k1', root: 'm', accountPath: (i) => `m/44'/60'/0'/0/${i}`, compatibleWith: 'MetaMask, Rabby, Trust Wallet, Rainbow' },
  solana: { curve: 'ed25519', root: 'm', accountPath: (i) => `m/44'/501'/${i}'/0'`, compatibleWith: 'Phantom, Solflare, Backpack' },
  ton: { curve: 'ed25519', root: "m/44'/607'", accountPath: (i) => `m/44'/607'/${i}'`, compatibleWith: 'Trust Wallet (BIP-39 seeds; Tonkeeper uses TON-native 24 words — import those as a tonMnemonic source)' },
  tron: { curve: 'secp256k1', root: 'm', accountPath: (i) => `m/44'/195'/0'/0/${i}`, compatibleWith: 'TronLink, Trust Wallet' },
  btc: { curve: 'secp256k1', root: 'm', accountPath: (i) => `m/84'/0'/0'/0/${i}`, compatibleWith: 'native SegWit (BIP-84) wallets: Sparrow, Electrum, Trust Wallet (address index i)' },
  near: { curve: 'ed25519', root: 'm', accountPath: (i) => `m/44'/397'/${i}'`, compatibleWith: 'MyNearWallet, Meteor (implicit accounts)' },
  zcash: { curve: 'secp256k1', root: 'm', accountPath: (i) => `m/44'/133'/0'/0/${i}`, compatibleWith: 'transparent (t1…) receivers of Zashi, YWallet, Ledger, Trezor (BIP-44 coin 133, address index i)' },
})

export const CHAIN_KEYS = Object.keys(CHAIN_SPECS) as ChainKey[]

export function isChainKey(value: string): value is ChainKey {
  return Object.prototype.hasOwnProperty.call(CHAIN_SPECS, value)
}
