/**
 * "What am I signing?" — a pure, offline decoder for the transactions this
 * wallet signs: a kit message, a compiled `Transaction` (possibly partially
 * signed) or the base64 wire form a provider returns. System, Token, Token-2022,
 * Associated-Token and Compute-Budget instructions are decoded with the official
 * program parsers; anything else is reported as a program call with a warning.
 * Nothing here touches the network; lookup-table addresses that are not
 * supplied are reported as unresolved rather than guessed.
 */
import {
  AccountRole, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder,
  isSignerRole, type AccountLookupMeta, type AccountMeta, type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { COMPUTE_BUDGET_PROGRAM_ADDRESS, ComputeBudgetInstruction, identifyComputeBudgetInstruction, parseSetComputeUnitLimitInstruction, parseSetComputeUnitPriceInstruction } from '@solana-program/compute-budget'
import { SYSTEM_PROGRAM_ADDRESS, SystemInstruction, identifySystemInstruction, parseCreateAccountInstruction, parseCreateAccountWithSeedInstruction, parseTransferSolInstruction } from '@solana-program/system'
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS, AssociatedTokenInstruction, TOKEN_PROGRAM_ADDRESS, TokenInstruction, identifyAssociatedTokenInstruction, identifyTokenInstruction,
  parseApproveCheckedInstruction, parseApproveInstruction, parseCloseAccountInstruction, parseCreateAssociatedTokenIdempotentInstruction, parseCreateAssociatedTokenInstruction,
  parseSetAuthorityInstruction, parseTransferCheckedInstruction, parseTransferInstruction,
} from '@solana-program/token'
import {
  TOKEN_2022_PROGRAM_ADDRESS, Token2022Instruction, identifyToken2022Instruction,
  parseApproveCheckedInstruction as parseApproveChecked2022, parseApproveInstruction as parseApprove2022, parseCloseAccountInstruction as parseCloseAccount2022,
  parseSetAuthorityInstruction as parseSetAuthority2022, parseTransferCheckedInstruction as parseTransferChecked2022, parseTransferCheckedWithFeeInstruction, parseTransferInstruction as parseTransfer2022,
} from '@solana-program/token-2022'
import { isNativeTransfer, isSignedTransaction, isTransactionMessage } from './guards.js'
import type { DecodedInstruction, SolanaTransaction, SolanaWarning, TokenProgramKind, TransactionDescription } from './types.js'

/** Largest u64; a token approval of this amount is unlimited. */
export const MAX_U64 = 0xffffffffffffffffn
/** The System program id doubles as the all-zero "burn" address. */
export const ZERO_ADDRESS = SYSTEM_PROGRAM_ADDRESS as string

type Resolved = { programAddress: string | null; accounts: Array<{ address: string | null; role: AccountRole }>; data: Uint8Array }

interface Normalized {
  version: 'legacy' | 0 | 1
  feePayer: string | undefined
  signers: Array<{ address: string; signed: boolean | undefined }>
  instructions: Resolved[]
  unresolvedLookups: boolean
}

export interface DescribeContext {
  /** The signing account — enables `foreign-fee-payer` / `missing-signers` checks. */
  account?: string
  /** Resolved lookup tables (`{tableAddress: [addresses]}`) so v0 lookups decode fully. */
  addressesByLookupTableAddress?: Record<string, readonly string[]>
}

function fromMessage(msg: TransactionMessage): Normalized {
  const payer = (msg as { feePayer?: Address | { address: Address } }).feePayer
  const feePayer = typeof payer === 'string' ? payer : payer?.address
  const signers = new Map<string, true>()
  if (feePayer) signers.set(feePayer, true)
  const instructions: Resolved[] = msg.instructions.map((ix: Instruction) => {
    const accounts = ((ix.accounts ?? []) as ReadonlyArray<AccountMeta | AccountLookupMeta>).map((a) => {
      if (isSignerRole(a.role)) signers.set(a.address, true)
      return { address: a.address as string, role: a.role }
    })
    return { programAddress: ix.programAddress as string, accounts, data: (ix.data ?? new Uint8Array()) as Uint8Array }
  })
  return { version: msg.version, feePayer, signers: [...signers.keys()].map((address) => ({ address, signed: undefined })), instructions, unresolvedLookups: false }
}

interface CompiledMessage {
  version: 'legacy' | 0 | 1
  header: { numSignerAccounts: number; numReadonlySignerAccounts: number; numReadonlyNonSignerAccounts: number }
  staticAccounts: Address[]
  instructions: Array<{ programAddressIndex: number; accountIndices?: number[]; data?: Uint8Array }>
  addressTableLookups?: Array<{ lookupTableAddress: Address; writableIndexes: number[]; readonlyIndexes: number[] }>
}

/** The accounts a compiled message loads, in message order, with roles; lookups resolve through `ctx` or come back as `null`. */
export interface CompiledAccounts {
  compiled: CompiledMessage
  accounts: Array<{ address: string | null; role: AccountRole }>
  /** Lookup tables the message references (empty for legacy). */
  tables: Address[]
  unresolved: boolean
}

/**
 * The accounts a compiled transaction loads, in order, with roles. Lookup-table accounts resolve
 * through `ctx` or come back as `null`, with `unresolved` set.
 */
export function resolveCompiledAccounts(tx: Transaction, ctx: DescribeContext = {}): CompiledAccounts {
  const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes) as unknown as CompiledMessage
  const { header, staticAccounts } = compiled
  // Account ordering per the message format: static accounts, then every
  // lookup's writable addresses, then every lookup's readonly addresses.
  const all: Array<{ address: string | null; role: AccountRole }> = staticAccounts.map((address, i) => {
    const signer = i < header.numSignerAccounts
    const writable = signer ? i < header.numSignerAccounts - header.numReadonlySignerAccounts : i < staticAccounts.length - header.numReadonlyNonSignerAccounts
    return { address, role: signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY }
  })
  let unresolved = false
  const lookups = compiled.addressTableLookups ?? []
  const resolve = (table: Address, index: number): string | null => {
    const addr = ctx.addressesByLookupTableAddress?.[table]?.[index]
    if (addr === undefined) unresolved = true
    return addr ?? null
  }
  for (const l of lookups) for (const i of l.writableIndexes) all.push({ address: resolve(l.lookupTableAddress, i), role: AccountRole.WRITABLE })
  for (const l of lookups) for (const i of l.readonlyIndexes) all.push({ address: resolve(l.lookupTableAddress, i), role: AccountRole.READONLY })
  return { compiled, accounts: all, tables: lookups.map((l) => l.lookupTableAddress), unresolved }
}

function fromCompiled(tx: Transaction, ctx: DescribeContext): Normalized {
  const { compiled, accounts: all, unresolved } = resolveCompiledAccounts(tx, ctx)
  const { header, staticAccounts } = compiled
  const at = (i: number) => all[i] ?? { address: null, role: AccountRole.READONLY }
  const instructions: Resolved[] = compiled.instructions.map((ix) => ({
    programAddress: at(ix.programAddressIndex).address,
    accounts: (ix.accountIndices ?? []).map(at),
    data: (ix.data ?? new Uint8Array()) as Uint8Array,
  }))
  const signers = staticAccounts.slice(0, header.numSignerAccounts).map((address) => {
    const sig = tx.signatures[address]
    return { address: address as string, signed: sig !== null && sig !== undefined && (sig as Uint8Array).some((b) => b !== 0) }
  })
  return { version: compiled.version, feePayer: staticAccounts[0], signers, instructions, unresolvedLookups: unresolved }
}

/** Decode a base64 wire transaction into a kit `Transaction`. */
export function decodeWireTransaction(base64: string): Transaction {
  return getTransactionDecoder().decode(getBase64Encoder().encode(base64))
}

const tokenKind = (program: string): TokenProgramKind => (program === TOKEN_2022_PROGRAM_ADDRESS ? 'token-2022' : 'token')
const asIx = (r: Resolved) =>
  ({ programAddress: r.programAddress as Address, accounts: r.accounts.map((a) => ({ address: (a.address ?? ZERO_ADDRESS) as Address, role: a.role })), data: r.data }) as never
const opt = (o: unknown): string | null => (o && typeof o === 'object' && (o as { __option?: string }).__option === 'Some' ? String((o as { value: unknown }).value) : null)

/** System / Token / Token-2022 instruction name from the data alone (no accounts needed); undefined when undecodable or another program. */
function coreInstructionName(program: string, data: Uint8Array): string | undefined {
  try {
    if (program === SYSTEM_PROGRAM_ADDRESS) return SystemInstruction[identifySystemInstruction(data)]
    if (program === TOKEN_PROGRAM_ADDRESS) return TokenInstruction[identifyTokenInstruction(data)]
    if (program === TOKEN_2022_PROGRAM_ADDRESS) return Token2022Instruction[identifyToken2022Instruction(data)]
  } catch {
    /* undecodable */
  }
  return undefined
}

function decodeOne(r: Resolved): DecodedInstruction {
  const program = r.programAddress
  if (program === null || r.accounts.some((a) => a.address === null)) {
    const instruction = program === null ? undefined : coreInstructionName(program, r.data)
    return { type: 'unknown', program, accounts: r.accounts.map((a) => a.address), dataLength: r.data.length, ...(instruction ? { instruction } : {}) }
  }
  const ix = asIx(r)
  try {
    if (program === SYSTEM_PROGRAM_ADDRESS) {
      const t = identifySystemInstruction(r.data)
      if (t === SystemInstruction.TransferSol) {
        const p = parseTransferSolInstruction(ix)
        return { type: 'sol-transfer', program, from: p.accounts.source.address, to: p.accounts.destination.address, lamports: p.data.amount }
      }
      if (t === SystemInstruction.CreateAccount) {
        const p = parseCreateAccountInstruction(ix)
        return { type: 'create-account', program, payer: p.accounts.payer.address, newAccount: p.accounts.newAccount.address, lamports: p.data.lamports, owner: p.data.programAddress }
      }
      if (t === SystemInstruction.CreateAccountWithSeed) {
        // The same money movement as CreateAccount: the payer funds an account the owner program controls.
        const p = parseCreateAccountWithSeedInstruction(ix)
        return { type: 'create-account', program, payer: p.accounts.payer.address, newAccount: p.accounts.newAccount.address, lamports: p.data.amount, owner: p.data.programAddress }
      }
      return { type: 'program-call', program, accounts: r.accounts.map((a) => a.address as string), dataLength: r.data.length, instruction: SystemInstruction[t] }
    } else if (program === TOKEN_PROGRAM_ADDRESS || program === TOKEN_2022_PROGRAM_ADDRESS) {
      return decodeToken(r, ix, program)
    } else if (program === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      const t = identifyAssociatedTokenInstruction(r.data)
      if (t === AssociatedTokenInstruction.CreateAssociatedToken || t === AssociatedTokenInstruction.CreateAssociatedTokenIdempotent) {
        const p = t === AssociatedTokenInstruction.CreateAssociatedToken ? parseCreateAssociatedTokenInstruction(ix) : parseCreateAssociatedTokenIdempotentInstruction(ix)
        return { type: 'ata-create', program, ata: p.accounts.ata.address, owner: p.accounts.owner.address, mint: p.accounts.mint.address, payer: p.accounts.payer.address, idempotent: t === AssociatedTokenInstruction.CreateAssociatedTokenIdempotent }
      }
    } else if (program === COMPUTE_BUDGET_PROGRAM_ADDRESS) {
      const t = identifyComputeBudgetInstruction(r.data)
      if (t === ComputeBudgetInstruction.SetComputeUnitLimit) return { type: 'compute-budget', program, kind: 'limit', value: BigInt(parseSetComputeUnitLimitInstruction(ix).data.units) }
      if (t === ComputeBudgetInstruction.SetComputeUnitPrice) return { type: 'compute-budget', program, kind: 'price', value: parseSetComputeUnitPriceInstruction(ix).data.microLamports }
      return { type: 'compute-budget', program, kind: 'other', value: 0n }
    }
  } catch {
    /* malformed data for a known program → reported as an opaque call below */
  }
  return { type: 'program-call', program, accounts: r.accounts.map((a) => a.address as string), dataLength: r.data.length }
}

function decodeToken(r: Resolved, ix: never, program: string): DecodedInstruction {
  const tokenProgram = tokenKind(program)
  const is2022 = tokenProgram === 'token-2022'
  const t = is2022 ? identifyToken2022Instruction(r.data) : identifyTokenInstruction(r.data)
  // The two programs share instruction numbering for the legacy subset.
  const T = is2022 ? Token2022Instruction : TokenInstruction
  if (t === T.Transfer) {
    const p = is2022 ? parseTransfer2022(ix) : parseTransferInstruction(ix)
    return { type: 'token-transfer', program, tokenProgram, source: p.accounts.source.address, destination: p.accounts.destination.address, authority: p.accounts.authority.address, amount: p.data.amount }
  }
  if (t === T.TransferChecked) {
    const p = is2022 ? parseTransferChecked2022(ix) : parseTransferCheckedInstruction(ix)
    return { type: 'token-transfer', program, tokenProgram, source: p.accounts.source.address, destination: p.accounts.destination.address, authority: p.accounts.authority.address, amount: p.data.amount, mint: p.accounts.mint.address, decimals: p.data.decimals }
  }
  if (is2022 && t === Token2022Instruction.TransferCheckedWithFee) {
    const p = parseTransferCheckedWithFeeInstruction(ix)
    return { type: 'token-transfer', program, tokenProgram, source: p.accounts.source.address, destination: p.accounts.destination.address, authority: p.accounts.authority.address, amount: p.data.amount, mint: p.accounts.mint.address, decimals: p.data.decimals, fee: p.data.fee }
  }
  if (t === T.Approve || t === T.ApproveChecked) {
    const p = t === T.Approve ? (is2022 ? parseApprove2022(ix) : parseApproveInstruction(ix)) : is2022 ? parseApproveChecked2022(ix) : parseApproveCheckedInstruction(ix)
    return { type: 'token-approve', program, tokenProgram, source: p.accounts.source.address, delegate: p.accounts.delegate.address, owner: p.accounts.owner.address, amount: p.data.amount, unlimited: p.data.amount === MAX_U64 }
  }
  if (t === T.SetAuthority) {
    const p = is2022 ? parseSetAuthority2022(ix) : parseSetAuthorityInstruction(ix)
    return { type: 'set-authority', program, tokenProgram, account: p.accounts.owned.address, authorityType: Number(p.data.authorityType), newAuthority: opt(p.data.newAuthority) }
  }
  if (t === T.CloseAccount) {
    const p = is2022 ? parseCloseAccount2022(ix) : parseCloseAccountInstruction(ix)
    return { type: 'close-account', program, tokenProgram, account: p.accounts.account.address, destination: p.accounts.destination.address, owner: p.accounts.owner.address }
  }
  return { type: 'program-call', program, accounts: r.accounts.map((a) => a.address as string), dataLength: r.data.length, instruction: is2022 ? Token2022Instruction[t as Token2022Instruction] : TokenInstruction[t as TokenInstruction] }
}

/** Normalize any accepted input (except a bare `{to, value}` transfer, which is described after building). */
function normalize(tx: SolanaTransaction, ctx: DescribeContext): Normalized {
  if (typeof tx === 'string') return fromCompiled(decodeWireTransaction(tx), ctx)
  if (isSignedTransaction(tx)) return fromCompiled(tx, ctx)
  if (isTransactionMessage(tx)) return fromMessage(tx)
  if (isNativeTransfer(tx)) {
    return {
      version: 0, feePayer: ctx.account, signers: ctx.account ? [{ address: ctx.account, signed: undefined }] : [],
      instructions: [], unresolvedLookups: false,
    }
  }
  throw new Error('Expected a transaction message, a compiled transaction or its base64 wire form.')
}

/**
 * Decode any transaction the account accepts (transfer, message, compiled, base64) for a
 * confirmation screen: kind, instructions and warnings. Pass the signing `account` to get fee-payer
 * and missing-signer warnings.
 */
export function describeTransaction(tx: SolanaTransaction, ctx: DescribeContext = {}): TransactionDescription {
  // A bare transfer has no instructions yet: describe its intent directly.
  if (isNativeTransfer(tx)) {
    const items: DecodedInstruction[] = [{ type: 'sol-transfer', program: SYSTEM_PROGRAM_ADDRESS, from: ctx.account ?? '', to: tx.to, lamports: BigInt(tx.value) }]
    const warnings: SolanaWarning[] = []
    if (tx.to === ZERO_ADDRESS) warnings.push({ code: 'burn-address', message: 'Recipient is the System program (all-zero) address; funds sent there are lost.' })
    return { kind: 'sol-transfer', version: 0, feePayer: ctx.account, signers: ctx.account ? [{ address: ctx.account, signed: undefined }] : [], items, warnings }
  }
  const n = normalize(tx, ctx)
  const items = n.instructions.map(decodeOne)
  const warnings: SolanaWarning[] = []
  const warn = (code: SolanaWarning['code'], message: string) => { if (!warnings.some((w) => w.code === code)) warnings.push({ code, message }) }
  if (n.unresolvedLookups) warn('unresolved-lookup-tables', 'Some accounts come from address lookup tables that were not supplied; those instructions could not be decoded.')
  if (ctx.account && n.feePayer && n.feePayer !== ctx.account) warn('foreign-fee-payer', `Fee payer ${n.feePayer} is not this wallet.`)
  const missing = n.signers.filter((s) => s.signed === false && s.address !== ctx.account).map((s) => s.address)
  if (missing.length) warn('missing-signers', `Still unsigned by ${missing.join(', ')}.`)
  for (const it of items) {
    if (it.type === 'unknown' || it.type === 'program-call') warn('unknown-program', `Instruction for ${it.program ?? 'an unresolved program'} could not be decoded.`)
    if (it.type === 'set-authority') warn('sets-authority', `Changes an authority on ${it.account}.`)
    if (it.type === 'close-account') warn('closes-account', `Closes token account ${it.account}.`)
    if (it.type === 'token-approve') {
      warn('approves-delegate', `Lets ${it.delegate} spend from ${it.source}.`)
      if (it.unlimited) warn('unlimited-approve', `Delegate ${it.delegate} is approved for an unlimited amount.`)
    }
    if ((it.type === 'sol-transfer' && it.to === ZERO_ADDRESS) || (it.type === 'token-transfer' && it.destination === ZERO_ADDRESS)) {
      warn('burn-address', 'A transfer targets the System program (all-zero) address; funds sent there are lost.')
    }
  }
  return { kind: classify(items), version: n.version, feePayer: n.feePayer, signers: n.signers, items, warnings }
}

function classify(items: DecodedInstruction[]): TransactionDescription['kind'] {
  const kinds = new Set<TransactionDescription['kind']>()
  let ata = false
  for (const it of items) {
    switch (it.type) {
      case 'compute-budget': break
      case 'ata-create': ata = true; break
      case 'sol-transfer': kinds.add('sol-transfer'); break
      case 'token-transfer': kinds.add(it.tokenProgram === 'token-2022' ? 'token2022-transfer' : 'spl-transfer'); break
      default: kinds.add('program-call')
    }
  }
  if (kinds.size === 0) return ata ? 'ata-create' : 'empty'
  if (kinds.size === 1) return [...kinds][0]!
  return 'mixed'
}
