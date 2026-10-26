import type { WriteOptions } from '@anywalletkit/core'
import type { Commitment, Rpc, SolanaRpcApi, Transaction, TransactionMessage } from '@solana/kit'

/** A `@solana/kit` RPC client. */
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

/**
 * Options for a Solana wallet manager or account: endpoints, network, fee caps, compute budget and
 * the pre-sign checks.
 */
export interface SolanaConfig {
  /** RPC url(s) or ready `Rpc` object(s). A list fails over in order. Omit for an offline (sign-only) wallet. */
  provider?: string | SolanaRpc | Array<string | SolanaRpc>
  /** Alias of `provider`. */
  rpcUrl?: string | string[]
  /** Commitment for reads and confirmations. Default `confirmed`. */
  commitment?: Commitment
  /** Extra attempts across the provider list after the first failure (default 3). */
  retries?: number
  /** Per-request timeout for url providers, in ms (default 15 000). A send that times out is a `BroadcastUnknownError`. */
  timeoutMs?: number
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
  /**
   * Sign transactions that reassign, allocate or create this wallet's account under a program, hand
   * away a nonce / token / metadata / group authority, run a token `Batch`, move lamports to someone
   * else with an instruction that is not a visible transfer (`CloseAccount`, `WithdrawExcessLamports`,
   * `UnwrapLamports`, `WithdrawNonceAccount`, `TransferSolWithSeed`), or carry an undecodable System /
   * Token instruction (default false). Applies to `sendTransaction` / `signTransaction`;
   * `sendSerialized` refuses them regardless.
   */
  allowAuthorityChanges?: boolean
  /**
   * Sign durable-nonce transactions (first instruction `AdvanceNonceAccount`), whose signature never
   * expires: whoever holds it can broadcast it at any later time (default false). Can also be given
   * per call in {@link SolanaWriteOptions}.
   */
  allowDurableNonce?: boolean
}

/** `WriteOptions` plus the per-call opt-ins of this chain. */
export interface SolanaWriteOptions extends WriteOptions {
  /** Sign this durable-nonce transaction (see {@link SolanaConfig.allowDurableNonce}). */
  allowDurableNonce?: boolean
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

/**
 * A native SOL or SPL / Token-2022 transfer. Amount in lamports or the token's base units. A
 * missing recipient token account is created in the same transaction.
 */
export interface SolanaTransferOptions {
  /** SPL or Token-2022 mint. Omit for native SOL. */
  token?: string
  /** Wallet address that receives (not its token account). */
  recipient: string
  /** Amount in lamports or token base units. */
  amount: bigint | number | string
  /** Address lookup tables to compress the v0 message with. */
  lookupTables?: string[]
}

/** Outcome of a landed transaction. */
export interface SolanaReceipt {
  /** Transaction signature (base58). */
  hash: string
  /** 1 confirmed without error, 0 failed. */
  status: 0 | 1
  /** Slot (Solana's block height analogue). */
  blockNumber: bigint
  /** Fee paid, in lamports. */
  fee: bigint
  /** Unix seconds, when the node knows it. */
  blockTime: number | null
  /** The transaction error as the RPC reports it; `null` on success. */
  err: unknown
}

/** Fee breakdown; `fee` is what the max-fee guards compare against. */
export interface SolanaFeeQuote {
  /** Total fee in lamports: base plus priority. */
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

/** Outcome of `simulateTransaction`: compute units used and logs, or the error and logs. */
export type SimulationResult =
  | { ok: true; unitsConsumed: bigint; logs: readonly string[] }
  | { ok: false; error: string; logs: readonly string[] }

/**
 * Problems {@link describeTransaction} flags: a program it does not know, an authority change, a
 * closed account, a delegate approval (unlimited or not), a fee payer that is not the wallet,
 * missing co-signers, lookup tables it could not resolve, or the burn address.
 */
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
  | 'durable-nonce'

/** One flagged problem, with a sentence a wallet can show. */
export interface SolanaWarning {
  /** Machine-readable code. */
  code: SolanaWarningCode
  /** Sentence to show the user. */
  message: string
}

/** The classic SPL Token program or Token-2022. */
export type TokenProgramKind = 'token' | 'token-2022'

/**
 * One instruction of a transaction, decoded where the program is known (System, Token, Token-2022,
 * Associated Token, Compute Budget) and listed raw otherwise.
 */
export type DecodedInstruction =
  | { type: 'sol-transfer'; program: string; from: string; to: string; lamports: bigint }
  | { type: 'create-account'; program: string; payer: string; newAccount: string; lamports: bigint; owner: string }
  | { type: 'token-transfer'; program: string; tokenProgram: TokenProgramKind; source: string; destination: string; authority: string; amount: bigint; mint?: string; decimals?: number; fee?: bigint }
  | { type: 'token-approve'; program: string; tokenProgram: TokenProgramKind; source: string; delegate: string; owner: string; amount: bigint; unlimited: boolean }
  | { type: 'set-authority'; program: string; tokenProgram: TokenProgramKind; account: string; authorityType: number; newAuthority: string | null }
  | { type: 'close-account'; program: string; tokenProgram: TokenProgramKind; account: string; destination: string; owner: string }
  | { type: 'ata-create'; program: string; ata: string; owner: string; mint: string; payer: string; idempotent: boolean }
  | { type: 'compute-budget'; program: string; kind: 'limit' | 'price' | 'other'; value: bigint }
  | { type: 'program-call'; program: string; accounts: readonly string[]; dataLength: number; /** System/Token(-2022)/Stake instruction name when identified (not otherwise decoded). */ instruction?: string; stake?: StakeInstructionDetails; withSeed?: SeedAccountDetails }
  | { type: 'unknown'; program: string | null; accounts: readonly (string | null)[]; dataLength: number; /** System/Token(-2022)/Stake instruction name, identified from the data while some accounts sit in unresolved lookup tables. */ instruction?: string; stake?: StakeInstructionDetails }

/** Stake-program instruction names, by their tag. */
export type StakeInstructionName =
  | 'Initialize' | 'Authorize' | 'DelegateStake' | 'Split' | 'Withdraw' | 'Deactivate' | 'SetLockup' | 'Merge'
  | 'AuthorizeWithSeed' | 'InitializeChecked' | 'AuthorizeChecked' | 'AuthorizeCheckedWithSeed' | 'SetLockupChecked'
  | 'GetMinimumDelegation' | 'DeactivateDelinquent' | 'Redelegate' | 'MoveStake' | 'MoveLamports'

/** A Stake-program instruction, decoded as far as the guard and a review sheet need. */
export interface StakeInstructionDetails {
  name: StakeInstructionName
  /** `Authorize*`: the authority it sets (the new-authority account for the `Checked` forms; absent when unresolved). */
  newAuthority?: string
  authorityType?: 'staker' | 'withdrawer'
  /** `Split`, `Withdraw`, `MoveStake`, `MoveLamports`. */
  lamports?: bigint
  /** `Initialize*`: the authorities it sets (absent when unresolved). */
  staker?: string
  withdrawer?: string
  /** `Initialize` / `SetLockup*`: the lockup it sets — absent fields are left as they are. */
  lockupTimestamp?: bigint
  lockupEpoch?: bigint
  custodian?: string
}

/** System `AllocateWithSeed` / `AssignWithSeed`: the seed account's base, seed and new owner. */
export interface SeedAccountDetails { base: string; seed: string; owner: string; space?: bigint }

/**
 * What a transaction does overall; `mixed` when it does several things, `program-call` when it
 * calls an unknown program.
 */
export type SolanaTransactionKind = 'sol-transfer' | 'spl-transfer' | 'token2022-transfer' | 'ata-create' | 'program-call' | 'mixed' | 'empty'

/** A Solana transaction decoded for a confirmation screen, without any network call. */
export interface TransactionDescription {
  /** What it does overall. */
  kind: SolanaTransactionKind
  /** Message version. */
  version: 'legacy' | 0 | 1
  /** Account that pays the fee. */
  feePayer: string | undefined
  /** Required signers in message order; `signed` is known only for compiled transactions. */
  signers: Array<{ address: string; signed: boolean | undefined }>
  /** Every instruction, decoded where possible. */
  items: DecodedInstruction[]
  /** Problems to show before signing. */
  warnings: SolanaWarning[]
  /**
   * How the transaction expires: `blockhash` (about a minute after it was built) or
   * `durable-nonce` (first instruction AdvanceNonceAccount: the signature never expires).
   */
  lifetime: 'blockhash' | 'durable-nonce'
}

/** CAIP-2 ids of the Solana clusters, by name. */
export const CAIP2_GENESIS: Record<string, string> = {
  mainnet: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  devnet: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  testnet: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z',
}
