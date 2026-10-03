import raw from '../vectors/derivation.json'

export type ChainKey = 'evm' | 'btc' | 'ton' | 'tron' | 'solana'

export interface VectorAccount {
  index: number
  path: string
  address: string
  /** Hex. Compressed secp256k1 (33 bytes) or ed25519 (32 bytes). */
  publicKey: string
  /** Chain-conventional encoding of `sign(message)`. */
  signMessage: string
  /** EVM only. */
  signTransaction?: string
  signTypedData?: string
}

export interface ParityVectors {
  generatedAt: string
  message: string
  evmTx: Record<string, unknown>
  evmTypedData: Record<string, unknown>
  seeds: Record<string, string>
  vectors: Record<ChainKey, Record<string, { accounts: VectorAccount[] }>>
}

/** Golden derivation vectors, pinned per chain. */
export const derivationVectors = raw as unknown as ParityVectors
