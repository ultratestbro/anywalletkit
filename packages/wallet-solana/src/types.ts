import type { Commitment, Rpc, SolanaRpcApi, Transaction, TransactionMessage } from '@solana/kit'

export type SolanaRpc = Rpc<SolanaRpcApi>

export interface SolanaConfig {
  /** RPC url(s) or ready `Rpc` object(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  provider?: string | SolanaRpc | Array<string | SolanaRpc>
  /** Alias of `provider`. */
  rpcUrl?: string | string[]
  commitment?: Commitment
  /** Extra attempts across the provider list after the first failure (default 3). */
  retries?: number
  /** Max fee (lamports) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (lamports) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** CAIP-2 network suffix; default mainnet genesis hash. */
  network?: 'mainnet' | 'devnet' | 'testnet' | string
}

/** A native SOL transfer. `value` in lamports. */
export interface SolanaNativeTransfer { to: string; value: bigint | number | string }

/** Anything `sendTransaction` / `signTransaction` accept. */
export type SolanaTransaction = SolanaNativeTransfer | TransactionMessage | Transaction

export interface SolanaTransferOptions {
  /** SPL mint. Omit for native SOL. */
  token?: string
  recipient: string
  amount: bigint | number | string
}

export interface SolanaReceipt {
  hash: string
  /** 1 confirmed without error, 0 failed. */
  status: 0 | 1
  /** Slot (Solana's block height analogue). */
  blockNumber: bigint
  fee: bigint
  blockTime: number | null
  err: unknown
}

export const CAIP2_GENESIS: Record<string, string> = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
}
