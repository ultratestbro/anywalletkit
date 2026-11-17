/**
 * Public types of `@anywalletkit/tx-preview-solana`. Everything a decoder returns and everything the preview
 * carries is plain data (strings, numbers, bigints, booleans, arrays, records): it renders on any screen and
 * survives a deep copy. Amounts are bigints in base units, addresses base58 strings, raw bytes base64.
 */

/** A decoded argument: plain data only. */
export type PreviewValue = string | number | bigint | boolean | null | readonly PreviewValue[] | { readonly [key: string]: PreviewValue }

/** An account an instruction names, in instruction order. `address` is `null` when it sits in a lookup table that was not resolved. */
export interface RawAccount {
  readonly address: string | null
  readonly signer: boolean
  readonly writable: boolean
}

/** An instruction as the message carries it, accounts resolved as far as the lookup tables allow. */
export interface RawInstruction {
  readonly programAddress: string
  readonly accounts: readonly RawAccount[]
  readonly data: Uint8Array
}

/** What a decoder recognised in one instruction. */
export interface DecodedFields {
  /** The instruction's name as its program defines it (`TransferChecked`, `SharedAccountsRoute`, `DepositSol`…). */
  readonly name: string
  /** The instruction's arguments, decoded. */
  readonly args?: Readonly<Record<string, PreviewValue>> | undefined
  /** A name per account, by position (`source`, `destination`, `authority`…); `null` or missing for an unnamed slot. */
  readonly accountNames?: readonly (string | null)[] | undefined
  /** Set when the instruction is recognised but only its leading arguments decode (a layout newer than the decoder): why. The rest are `null`. */
  readonly partial?: string | undefined
}

/**
 * Decodes the instructions of one program. Register your own with {@link DecoderRegistry.register}. `decode`
 * returns `null` for data it does not recognise (the instruction is then shown undecoded, raw accounts and data
 * included) and may throw for malformed data (shown undecoded with the error). It must not touch the network.
 */
export interface InstructionDecoder {
  readonly programAddress: string
  /** Human name of the program (`Token-2022 Program`, `Jupiter Aggregator v6`). */
  readonly programName: string
  decode(instruction: RawInstruction): DecodedFields | null
}

/** One instruction of the preview. Undecoded instructions are never dropped: their raw accounts and data stay. */
export interface DecodedInstruction {
  /** Position in the transaction (top level), or in the parent's inner list for an inner instruction. */
  readonly index: number
  readonly programAddress: string
  /** The program's name when a decoder for it is registered, `null` otherwise. */
  readonly programName: string | null
  /** The instruction's name, `null` when not decoded. */
  readonly name: string | null
  /** True when a decoder recognised the data. */
  readonly decoded: boolean
  readonly args: Readonly<Record<string, PreviewValue>>
  readonly accounts: ReadonlyArray<RawAccount & { readonly name: string | null }>
  /** The raw instruction data, base64. */
  readonly data: string
  /** Set when the instruction runs through a proxy that invokes its first account (Mayan's CPI proxy): the proxy's address. */
  readonly via?: string
  /** Why a known program's instruction did not decode (malformed data, too few accounts). */
  readonly error?: string
  /** The instruction is recognised but only partly decoded (a layout newer than the decoder): why. Arguments past that point are `null`. */
  readonly partial?: string
  /**
   * Set on an inner instruction the RPC returned already parsed (its jsonParsed form, raw bytes dropped): `name` and
   * `args` are the RPC's reading (`type` in PascalCase, `info` as is), not this package's.
   */
  readonly parsedByRpc?: true
}

export type PreviewWarningCode =
  | 'unresolved-lookup-tables'
  | 'foreign-fee-payer'
  | 'missing-signers'
  | 'durable-nonce'
  | 'unknown-program'
  | 'undecoded-instruction'
  | 'partially-decoded-instruction'
  | 'sets-authority'
  | 'closes-account'
  | 'approves-delegate'
  | 'unlimited-approve'
  | 'burn-address'
  | 'simulation-failed'
  | 'simulation-unavailable'
  | 'balances-unavailable'

/** A fact about the transaction worth showing. C1 reports what the transaction does; the risk verdict builds on these. */
export interface PreviewWarning {
  readonly code: PreviewWarningCode
  readonly message: string
  /** The top-level instruction it is about, when it is about one. */
  readonly instruction?: number
}

/** One account the message loads, in message order (static keys, then every lookup's writable, then readonly entries). */
export interface MessageAccount {
  readonly address: string | null
  readonly signer: boolean
  readonly writable: boolean
  /** The lookup table it comes from; absent for a static key. */
  readonly lookupTable?: string
}

/** A v1 transaction's config: the compute budget, carried in the message instead of Compute Budget instructions. */
export interface TransactionConfig {
  readonly priorityFeeLamports?: bigint
  readonly computeUnitLimit?: number
  readonly loadedAccountsDataSizeLimit?: number
  readonly heapSize?: number
}

/** Everything the transaction says, decoded offline. */
export interface DecodedTransaction {
  readonly version: 'legacy' | 0 | 1
  readonly feePayer: string | null
  /** Required signers in message order; `signed` is `null` for a message (no signature slots yet). */
  readonly signers: ReadonlyArray<{ readonly address: string; readonly signed: boolean | null }>
  /** `durable-nonce` when the first instruction advances a nonce account: the signature then never expires. */
  readonly lifetime: { readonly kind: 'blockhash' | 'durable-nonce'; readonly value: string | null }
  readonly accounts: readonly MessageAccount[]
  readonly lookupTables: ReadonlyArray<{ readonly address: string; readonly resolved: boolean }>
  /** A v1 transaction's config (priority fee, compute unit limit…); `null` for legacy and v0. */
  readonly config: TransactionConfig | null
  readonly instructions: readonly DecodedInstruction[]
  readonly warnings: readonly PreviewWarning[]
}

/** A SOL balance before and after, lamports. */
export interface SolBalanceChange {
  readonly account: string
  readonly pre: bigint
  readonly post: bigint
  readonly delta: bigint
}

/** A token account's balance before and after, base units. */
export interface TokenBalanceChange {
  readonly account: string
  readonly mint: string
  readonly owner: string | null
  readonly tokenProgram: string | null
  readonly decimals: number
  readonly pre: bigint
  readonly post: bigint
  readonly delta: bigint
}

/** Balance changes of a transaction, from pre/post balances (a simulation's or a confirmed transaction's meta). */
export interface BalanceChanges {
  /** Every account whose SOL balance changes. */
  readonly sol: readonly SolBalanceChange[]
  /** Every token account whose balance changes (or that is created or closed). */
  readonly tokens: readonly TokenBalanceChange[]
  /** The signer's own view: its SOL change (fee included) and its token changes summed per mint. */
  readonly signer: {
    readonly address: string
    readonly sol: bigint
    readonly tokens: ReadonlyArray<{ readonly mint: string; readonly decimals: number; readonly delta: bigint }>
  } | null
}

/** What `simulateTransaction` said. */
export interface SimulationPreview {
  readonly ok: boolean
  /** The transaction error, as the RPC reports it, when `ok` is false. */
  readonly error: PreviewValue
  readonly logs: readonly string[]
  readonly unitsConsumed: bigint | null
  /** The fee the transaction would pay, lamports, when the RPC reports it. */
  readonly fee: bigint | null
  /** `null` when the RPC returned no pre/post balances. */
  readonly balances: BalanceChanges | null
  /** Inner instructions per top-level instruction, decoded, when the RPC returned them. */
  readonly innerInstructions: ReadonlyArray<{ readonly index: number; readonly instructions: readonly DecodedInstruction[] }>
}

/** {@link describeTransaction}'s result: the decoded transaction plus the simulation, when an RPC was given. */
export interface TransactionPreview extends DecodedTransaction {
  readonly simulation: SimulationPreview | null
}
