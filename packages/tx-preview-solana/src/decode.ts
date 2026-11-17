/**
 * Offline decoding: any transaction form → message accounts (lookup tables resolved as far as the caller allows),
 * signers, lifetime and every instruction run through the decoder registry. Nothing here touches the network.
 */
import {
  AccountRole, compileTransaction, decompileTransactionConfig, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, isSignerRole, isWritableRole,
  type AccountLookupMeta, type AccountMeta, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { SYSTEM_PROGRAM } from './decoders/official.js'
import { defaultRegistry } from './defaults.js'
import type { DecoderRegistry } from './registry.js'
import type { DecodedInstruction, DecodedTransaction, MessageAccount, PreviewWarning, RawAccount, RawInstruction, TransactionConfig } from './types.js'
import { toBase64 } from './values.js'
import { collectWarnings } from './warnings.js'

/** What {@link decodeTransaction} accepts: base64 wire, wire bytes, a kit `Transaction` or a kit transaction message. */
export type TransactionInput = string | Uint8Array | Transaction | TransactionMessage

/** Lookup table address → its addresses, in table order. */
export type LookupTables = Readonly<Record<string, readonly string[]>>

export interface DecodeOptions {
  /** Resolved address lookup tables, so a v0 message's lookups decode fully (`fetchLookupTables` reads them). */
  readonly lookupTables?: LookupTables | undefined
  /** Decoders to use. Default {@link defaultRegistry}; add your own with `defaultRegistry.with([...])`. */
  readonly registry?: DecoderRegistry | undefined
  /** The account that will sign: enables the fee-payer and missing-signer facts. */
  readonly signer?: string | undefined
}

/**
 * Mayan's CPI proxy (swap-sdk `CPI_PROXY_PROGRAM_ID`) invokes its FIRST account with the remaining accounts and the
 * same data, signer privileges included: an instruction to it is decoded as the instruction it runs.
 */
export const MAYAN_CPI_PROXY_PROGRAM = 'D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa'

interface CompiledMessage {
  version: 'legacy' | 0 | 1
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number }
  staticAccounts: Address[]
  lifetimeToken: string
  /** legacy and v0 */
  instructions?: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>
  addressTableLookups?: Array<{ lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }>
  /** v1: instructions split into headers and payloads, the compute budget moved into the message config. */
  instructionHeaders?: Array<{ programAccountIndex: number }>
  instructionPayloads?: Array<{ instructionAccountIndices?: number[]; instructionData?: Uint8Array }>
  configMask?: number
  configValues?: unknown[]
}

/** Instructions of a compiled message, any version, as program + account indices + data. */
function compiledInstructions(compiled: CompiledMessage): Array<{ programIndex: number; accountIndices: readonly number[]; data: Uint8Array }> {
  if (compiled.instructions) return compiled.instructions.map((ix) => ({ programIndex: ix.programAddressIndex, accountIndices: ix.accountIndices ?? [], data: (ix.data ?? new Uint8Array()) as Uint8Array }))
  const headers = compiled.instructionHeaders ?? []
  const payloads = compiled.instructionPayloads ?? []
  return headers.map((h, i) => ({ programIndex: h.programAccountIndex, accountIndices: payloads[i]?.instructionAccountIndices ?? [], data: (payloads[i]?.instructionData ?? new Uint8Array()) as Uint8Array }))
}

/** A v1 message's config (priority fee, compute unit limit, heap size, loaded-data limit). */
function compiledConfig(compiled: CompiledMessage): TransactionConfig | null {
  if (compiled.version !== 1 || compiled.configMask === undefined) return null
  try {
    return decompileTransactionConfig(compiled.configMask as never, (compiled.configValues ?? []) as never) as TransactionConfig
  } catch {
    return null
  }
}

/** The parts of a transaction decoding needs, whatever form it came in. */
export interface NormalizedTransaction {
  readonly version: 'legacy' | 0 | 1
  readonly feePayer: string | null
  readonly signers: ReadonlyArray<{ address: string; signed: boolean | null }>
  readonly lifetimeToken: string | null
  readonly accounts: readonly MessageAccount[]
  readonly lookupTables: ReadonlyArray<{ address: string; writableIndexes: readonly number[]; readonlyIndexes: readonly number[]; resolved: boolean }>
  /** Top-level instructions, accounts as indices into `accounts`. */
  readonly instructions: ReadonlyArray<{ programIndex: number; accountIndices: readonly number[]; data: Uint8Array }>
  /** The transaction, compiled, when it came compiled or could be compiled (simulation sends it). */
  readonly transaction: Transaction | null
  /** A v1 message's config; `null` for legacy and v0 (their compute budget is in Compute Budget instructions). */
  readonly config: TransactionConfig | null
}

function isTransaction(v: unknown): v is Transaction {
  return !!v && typeof v === 'object' && 'messageBytes' in v && 'signatures' in v
}

function isMessage(v: unknown): v is TransactionMessage {
  return !!v && typeof v === 'object' && 'instructions' in v && 'version' in v
}

/** Decode a base64 wire transaction (or its bytes) into a kit `Transaction`. */
export function decodeWireTransaction(wire: string | Uint8Array): Transaction {
  const bytes = typeof wire === 'string' ? getBase64Encoder().encode(wire) : wire
  return getTransactionDecoder().decode(bytes) as Transaction
}

/** The lookup tables a compiled v0 transaction references (to fetch before decoding). */
export function lookupTableAddresses(input: TransactionInput): string[] {
  if (isMessage(input)) return []
  const tx = isTransaction(input) ? input : decodeWireTransaction(input)
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as CompiledMessage
  return [...new Set((compiled.addressTableLookups ?? []).map((l) => l.lookupTableAddress as string))]
}

function fromTransaction(tx: Transaction, tables: LookupTables): NormalizedTransaction {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as CompiledMessage
  const { header, staticAccounts } = compiled
  // Message account order: static keys, then every lookup's writable entries, then every lookup's readonly entries.
  const accounts: MessageAccount[] = staticAccounts.map((address, i) => {
    const signer = i < header.numSignerAccounts
    const writable = signer ? i < header.numSignerAccounts - header.numReadonlySignerAccounts : i < staticAccounts.length - header.numReadonlyNonSignerAccounts
    return { address, signer, writable }
  })
  const lookups = compiled.addressTableLookups ?? []
  const resolvedTables = lookups.map((l) => {
    const list = tables[l.lookupTableAddress]
    const resolved = !!list && [...l.writableIndexes, ...l.readonlyIndexes].every((i) => typeof list[i] === 'string')
    return { address: l.lookupTableAddress as string, writableIndexes: l.writableIndexes, readonlyIndexes: l.readonlyIndexes, resolved }
  })
  for (const writable of [true, false]) {
    for (const l of lookups) {
      for (const i of writable ? l.writableIndexes : l.readonlyIndexes) {
        accounts.push({ address: tables[l.lookupTableAddress]?.[i] ?? null, signer: false, writable, lookupTable: l.lookupTableAddress })
      }
    }
  }
  const signers = staticAccounts.slice(0, header.numSignerAccounts).map((address) => {
    const sig = tx.signatures[address]
    return { address: address as string, signed: sig !== null && sig !== undefined && (sig as Uint8Array).some((b) => b !== 0) }
  })
  return {
    version: compiled.version,
    feePayer: staticAccounts[0] ?? null,
    signers,
    lifetimeToken: compiled.lifetimeToken ?? null,
    accounts,
    lookupTables: resolvedTables,
    instructions: compiledInstructions(compiled),
    transaction: tx,
    config: compiledConfig(compiled),
  }
}

/** A message that cannot be compiled yet (no fee payer or no lifetime): its instructions already carry the accounts. */
function fromMessage(msg: TransactionMessage): NormalizedTransaction {
  const payer = (msg as { feePayer?: Address | { address: Address } }).feePayer
  const feePayer = (typeof payer === 'string' ? payer : payer?.address) ?? null
  const accounts: MessageAccount[] = []
  const index = new Map<string, number>()
  const add = (address: string, role: AccountRole): number => {
    const at = index.get(address)
    if (at !== undefined) {
      const prev = accounts[at]!
      accounts[at] = { ...prev, signer: prev.signer || isSignerRole(role), writable: prev.writable || isWritableRole(role) }
      return at
    }
    accounts.push({ address, signer: isSignerRole(role), writable: isWritableRole(role) })
    index.set(address, accounts.length - 1)
    return accounts.length - 1
  }
  if (feePayer) add(feePayer, AccountRole.WRITABLE_SIGNER)
  const instructions = msg.instructions.map((ix: Instruction) => {
    const accountIndices = ((ix.accounts ?? []) as ReadonlyArray<AccountMeta | AccountLookupMeta>).map((a) => add(a.address, a.role))
    return { programIndex: add(ix.programAddress, AccountRole.READONLY), accountIndices, data: (ix.data ?? new Uint8Array()) as Uint8Array }
  })
  const lifetime = (msg as { lifetimeConstraint?: { blockhash?: string; nonce?: string } }).lifetimeConstraint
  return {
    version: msg.version,
    feePayer,
    signers: accounts.filter((a) => a.signer).map((a) => ({ address: a.address!, signed: null })),
    lifetimeToken: lifetime?.blockhash ?? lifetime?.nonce ?? null,
    accounts,
    lookupTables: [],
    instructions,
    transaction: null,
    config: null,
  }
}

/** Any accepted input → its normalized parts. A message with a fee payer and a lifetime is compiled first. */
export function normalizeTransaction(input: TransactionInput, tables: LookupTables = {}): NormalizedTransaction {
  if (typeof input === 'string' || input instanceof Uint8Array) return fromTransaction(decodeWireTransaction(input), tables)
  if (isTransaction(input)) return fromTransaction(input, tables)
  if (isMessage(input)) {
    const m = input as TransactionMessage & { feePayer?: unknown; lifetimeConstraint?: unknown }
    if (m.feePayer && m.lifetimeConstraint) {
      try {
        const normalized = fromTransaction(compileTransaction(m as never) as Transaction, tables)
        // A compiled message has signature slots but nothing signed yet: report "not signed", not "unsigned by".
        return { ...normalized, signers: normalized.signers.map((s) => ({ ...s, signed: null })) }
      } catch {
        /* not compilable as is: decode the instructions directly */
      }
    }
    return fromMessage(input)
  }
  throw new TypeError('tx-preview-solana: expected a base64 wire transaction, its bytes, a kit Transaction or a transaction message')
}

/** One instruction through the registry; never throws. */
export function decodeInstruction(ix: RawInstruction, index: number, registry: DecoderRegistry = defaultRegistry): DecodedInstruction {
  let target = ix
  let via: string | undefined
  if (ix.programAddress === MAYAN_CPI_PROXY_PROGRAM && ix.accounts.length > 0 && ix.accounts[0]!.address) {
    via = ix.programAddress
    target = { programAddress: ix.accounts[0]!.address, accounts: ix.accounts.slice(1), data: ix.data }
  }
  const decoder = registry.get(target.programAddress)
  const base = {
    index,
    programAddress: target.programAddress,
    programName: decoder?.programName ?? null,
    data: toBase64(target.data),
    ...(via ? { via } : {}),
  }
  const unnamed = target.accounts.map((a) => ({ ...a, name: null }))
  if (!decoder) return { ...base, name: null, decoded: false, args: {}, accounts: unnamed }
  try {
    const fields = decoder.decode(target)
    if (!fields || typeof fields.name !== 'string') return { ...base, name: null, decoded: false, args: {}, accounts: unnamed }
    const names = fields.accountNames ?? []
    return {
      ...base,
      name: fields.name,
      decoded: true,
      args: fields.args ?? {},
      accounts: target.accounts.map((a, i) => ({ ...a, name: names[i] ?? null })),
      ...(fields.partial ? { partial: fields.partial } : {}),
    }
  } catch (error) {
    return { ...base, name: null, decoded: false, args: {}, accounts: unnamed, error: error instanceof Error ? error.message : String(error) }
  }
}

/** The raw instruction at message indices. */
export function rawInstruction(accounts: readonly MessageAccount[], programIndex: number, accountIndices: readonly number[], data: Uint8Array): RawInstruction {
  const at = (i: number): RawAccount => {
    const a = accounts[i]
    return a ? { address: a.address, signer: a.signer, writable: a.writable } : { address: null, signer: false, writable: false }
  }
  return { programAddress: accounts[programIndex]?.address ?? '', accounts: accountIndices.map(at), data }
}

/** System `AdvanceNonceAccount` (u32 4) as the first instruction makes the transaction durable-nonce: it never expires. */
function advancesNonce(ix: DecodedInstruction | undefined): boolean {
  return !!ix && ix.via === undefined && ix.programAddress === SYSTEM_PROGRAM && ix.name === 'AdvanceNonceAccount'
}

/**
 * Decode a transaction offline: every instruction through the registry (undecodable ones kept with their raw
 * accounts and data), lookup tables resolved from `options.lookupTables`, plus the facts a review screen shows.
 */
export function decodeTransaction(input: TransactionInput, options: DecodeOptions = {}): DecodedTransaction {
  const n = normalizeTransaction(input, options.lookupTables)
  return decodeNormalized(n, options)
}

export function decodeNormalized(n: NormalizedTransaction, options: DecodeOptions = {}): DecodedTransaction {
  const registry = options.registry ?? defaultRegistry
  const instructions = n.instructions.map((ix, i) => decodeInstruction(rawInstruction(n.accounts, ix.programIndex, ix.accountIndices, ix.data), i, registry))
  const lifetime = { kind: advancesNonce(instructions[0]) ? 'durable-nonce' as const : 'blockhash' as const, value: n.lifetimeToken }
  const decoded: Omit<DecodedTransaction, 'warnings'> = {
    version: n.version,
    feePayer: n.feePayer,
    signers: n.signers,
    lifetime,
    accounts: n.accounts,
    lookupTables: n.lookupTables.map((t) => ({ address: t.address, resolved: t.resolved })),
    config: n.config,
    instructions,
  }
  const warnings: PreviewWarning[] = collectWarnings(decoded, options.signer)
  return { ...decoded, warnings }
}
