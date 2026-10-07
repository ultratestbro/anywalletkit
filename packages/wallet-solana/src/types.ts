import type { Commitment, Rpc, SolanaRpcApi, Transaction, TransactionMessage } from '@solana/kit'

export type SolanaRpc = Rpc<SolanaRpcApi>

/**
 * Compute-budget policy. `'auto'` (the default whenever a provider is configured)
 * prices the transaction from `getRecentPrioritizationFees` over its writable
 * accounts and sizes the compute-unit limit from a simulation. Explicit values
 * are used verbatim.
 */
export interface PriorityFeeConfig {
  /** Micro-lamports per compute unit. */
  microLamports?: bigint | number | 'auto'
  /** Compute-unit limit. */
  computeUnitLimit?: number | 'auto'
}

export interface SolanaConfig {
  /** RPC url(s) or ready `Rpc` object(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  provider?: string | SolanaRpc | Array<string | SolanaRpc>
  /** Alias of `provider`. */
  rpcUrl?: string | string[]
  commitment?: Commitment
  /** Extra attempts across the provider list after the first failure (default 3). */
  retries?: number
  /** Max fee (lamports, priority fee included) for `transfer`. */
  transferMaxFee?: bigint | number
  /** Max fee (lamports, priority fee included) for `sendTransaction` / `signTransaction`. */
  transactionMaxFee?: bigint | number
  /** CAIP-2 network suffix; default mainnet genesis hash. */
  network?: 'mainnet' | 'devnet' | 'testnet' | string
  /** Compute-budget policy; default `{microLamports: 'auto', computeUnitLimit: 'auto'}` with a provider. `false` = no compute-budget instructions. */
  priorityFee?: PriorityFeeConfig | false
  /** Floor for the auto priority price (micro-lamports/CU, default 0). */
  minPriorityMicroLamports?: bigint | number
  /** Cap for the auto priority price (micro-lamports/CU, default 5_000_000). */
  maxPriorityMicroLamports?: bigint | number
  /** Run `simulateTransaction` before signing a broadcast (default true with a provider). A failed simulation throws before anything is signed. */
  simulate?: boolean
  /** Sign provider transactions whose fee payer is not this wallet (default false). */
  allowForeignFeePayer?: boolean
  /** Allow transfers to the System program / all-zero address (default false). */
  allowBurn?: boolean
}

/** A native SOL transfer. `value` in lamports. */
export interface SolanaNativeTransfer {
  to: string
  value: bigint | number | string
  /** Address lookup tables to compress the v0 message with. */
  lookupTables?: string[]
}

/**
 * Anything `sendTransaction` / `signTransaction` accept: a native transfer, a kit
 * transaction message, a kit `Transaction` (compiled, possibly partially signed)
 * or the base64 wire form a swap / DeFi provider returns.
 */
export type SolanaTransaction = SolanaNativeTransfer | TransactionMessage | Transaction | string

export interface SolanaTransferOptions {
  /** SPL or Token-2022 mint. Omit for native SOL. */
  token?: string
  recipient: string
  amount: bigint | number | string
  /** Address lookup tables to compress the v0 message with. */
  lookupTables?: string[]
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

/** Fee breakdown; `fee` is what the max-fee guards compare against. */
export interface SolanaFeeQuote {
  fee: bigint
  /** Signature fees (5 000 lamports × signers). */
  baseFee: bigint
  /** Compute-budget priority fee in lamports (`limit × price / 1e6`, rounded up). */
  priorityFee: bigint
  /** Micro-lamports per CU actually set, 0 when disabled. */
  microLamports: bigint
  /** Compute-unit limit actually set, undefined when disabled. */
  computeUnitLimit: number | undefined
  /** Token-2022 transfer fee withheld by the mint, in token base units (transfers only). */
  tokenFee?: bigint
}

export type SimulationResult =
  | { ok: true; unitsConsumed: bigint; logs: readonly string[] }
  | { ok: false; error: string; logs: readonly string[] }

export type SolanaWarningCode =
  | 'unknown-program'
  | 'sets-authority'
  | 'closes-account'
  | 'approves-delegate'
  | 'unlimited-approve'
  | 'foreign-fee-payer'
  | 'missing-signers'
  | 'unresolved-lookup-tables'
  | 'burn-address'

export interface SolanaWarning {
  code: SolanaWarningCode
  message: string
}

export type TokenProgramKind = 'token' | 'token-2022'

export type DecodedInstruction =
  | { type: 'sol-transfer'; program: string; from: string; to: string; lamports: bigint }
  | { type: 'create-account'; program: string; payer: string; newAccount: string; lamports: bigint; owner: string }
  | { type: 'token-transfer'; program: string; tokenProgram: TokenProgramKind; source: string; destination: string; authority: string; amount: bigint; mint?: string; decimals?: number; fee?: bigint }
  | { type: 'token-approve'; program: string; tokenProgram: TokenProgramKind; source: string; delegate: string; owner: string; amount: bigint; unlimited: boolean }
  | { type: 'set-authority'; program: string; tokenProgram: TokenProgramKind; account: string; authorityType: number; newAuthority: string | null }
  | { type: 'close-account'; program: string; tokenProgram: TokenProgramKind; account: string; destination: string; owner: string }
  | { type: 'ata-create'; program: string; ata: string; owner: string; mint: string; payer: string; idempotent: boolean }
  | { type: 'compute-budget'; program: string; kind: 'limit' | 'price' | 'other'; value: bigint }
  | { type: 'program-call'; program: string; accounts: readonly string[]; dataLength: number }
  | { type: 'unknown'; program: string | null; accounts: readonly (string | null)[]; dataLength: number }

export type SolanaTransactionKind = 'sol-transfer' | 'spl-transfer' | 'token2022-transfer' | 'ata-create' | 'program-call' | 'mixed' | 'empty'

export interface TransactionDescription {
  kind: SolanaTransactionKind
  version: 'legacy' | 0 | 1
  feePayer: string | undefined
  /** Required signers in message order; `signed` is known only for compiled transactions. */
  signers: Array<{ address: string; signed: boolean | undefined }>
  items: DecodedInstruction[]
  warnings: SolanaWarning[]
}

export const CAIP2_GENESIS: Record<string, string> = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
}
