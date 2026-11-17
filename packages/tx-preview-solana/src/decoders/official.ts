/**
 * Decoders for the programs that ship an official Codama client (`@solana-program/*`): System, SPL Token,
 * Token-2022 (every instruction of every extension the client knows — 100 at 0.20), Associated Token, Compute
 * Budget and Address Lookup Table. One adapter reads them all: the client's `identify…Instruction` names the
 * instruction, its data decoder reads the arguments (no accounts needed), and its parser — when the accounts are
 * there — names them. Stake uses the same client for the data but names arguments and accounts itself (`stake.ts`).
 */
import { AccountRole, type Address } from '@solana/kit'
import * as addressLookupTable from '@solana-program/address-lookup-table'
import * as computeBudget from '@solana-program/compute-budget'
import * as stake from '@solana-program/stake'
import * as system from '@solana-program/system'
import * as token from '@solana-program/token'
import * as token2022 from '@solana-program/token-2022'
import type { DecodedFields, InstructionDecoder, PreviewValue, RawInstruction } from '../types.js'
import { toArgs, toBase64 } from '../values.js'
import { stakeDecoder } from './stake.js'

type Module = Record<string, unknown>
type Parser = (ix: unknown) => { accounts?: Record<string, { address: string } | undefined>; data?: unknown }
type DataDecoder = { decode(data: Uint8Array): unknown }

/** The System program id doubles as the all-zero address; it stands in for an account a lookup table hides. */
const PLACEHOLDER = system.SYSTEM_PROGRAM_ADDRESS as string

function roleOf(a: RawInstruction['accounts'][number]): AccountRole {
  return a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY
}

/**
 * Account names from a Codama parser. Its `accounts` record hands back the very meta objects it was given, so each
 * name lands on the slot whose meta it returned. Matching by position would be wrong: an optional account omitted
 * from the list (the `omitted` strategy, Token-2022's confidential proofs) comes back `undefined` without taking a
 * slot, and every name after it would shift onto the wrong account. An optional account passed as the program id
 * placeholder comes back `undefined` too and its slot stays unnamed; so do multisig signers and remaining accounts.
 */
function accountNames(parsed: ReturnType<Parser>, metas: readonly object[]): (string | null)[] {
  const names: (string | null)[] = metas.map(() => null)
  for (const [name, meta] of Object.entries(parsed.accounts ?? {})) {
    const at = meta ? metas.indexOf(meta) : -1
    if (at >= 0 && names[at] === null) names[at] = name
  }
  return names
}

const BATCH_TAG = 255

/**
 * Token and Token-2022 `Batch` (tag 255) runs several instructions of the same program in one, each taking the next
 * `numberOfAccounts` accounts. A batch can carry an `Approve` or a `SetAuthority` like any other instruction, so it
 * is opened up: `args.instructions` lists each inner one decoded (name, args, named accounts).
 */
function expandBatch(decoder: InstructionDecoder, ix: RawInstruction, entries: unknown): PreviewValue[] {
  const list = Array.isArray(entries) ? (entries as Array<{ numberOfAccounts?: unknown; instructionData?: unknown }>) : []
  const out: PreviewValue[] = []
  let offset = 0
  for (const e of list) {
    const count = typeof e.numberOfAccounts === 'number' ? e.numberOfAccounts : 0
    const data = e.instructionData instanceof Uint8Array ? e.instructionData : new Uint8Array()
    const accounts = ix.accounts.slice(offset, offset + count)
    offset += count
    let fields: DecodedFields | null = null
    let error: string | undefined
    // A batch inside a batch is refused by the program; it is not opened again here either.
    if (data[0] !== BATCH_TAG) {
      try { fields = decoder.decode({ programAddress: ix.programAddress, accounts, data }) } catch (err) { error = err instanceof Error ? err.message : String(err) }
    }
    out.push({
      name: fields?.name ?? null,
      args: (fields?.args ?? {}) as PreviewValue,
      accounts: accounts.map((a, i) => ({ address: a.address, signer: a.signer, writable: a.writable, name: fields?.accountNames?.[i] ?? null })),
      data: toBase64(data),
      ...(error ? { error } : {}),
    })
  }
  return out
}

/** A decoder over one Codama client: `identify` picks the instruction, the client's own codecs do the rest. */
export function codamaDecoder(options: {
  programAddress: string
  programName: string
  module: Module
  /** The client's instruction enum (`TokenInstruction`), value → name. */
  instructions: Record<number, string>
  identify: (data: Uint8Array) => number
  /** Data the client cannot identify but the program accepts (the ATA program's empty-data `Create`). */
  fallback?: (ix: RawInstruction) => DecodedFields | null
}): InstructionDecoder {
  const { programAddress, programName, module, instructions, identify, fallback } = options
  const decoder: InstructionDecoder = {
    programAddress,
    programName,
    decode(ix) {
      let kind: number
      try {
        kind = identify(ix.data)
      } catch {
        return fallback?.(ix) ?? null
      }
      const name = instructions[kind]
      if (!name) return null
      const dataDecoder = module[`get${name}InstructionDataDecoder`] as (() => DataDecoder) | undefined
      const parse = module[`parse${name}Instruction`] as Parser | undefined
      if (!dataDecoder) return { name }
      const raw = dataDecoder().decode(ix.data)
      if (name === 'Batch') return { name, args: { instructions: expandBatch(decoder, ix, (raw as { data?: unknown }).data) } }
      const args = toArgs(raw)
      let names: (string | null)[] | undefined
      if (parse) {
        try {
          const metas = ix.accounts.map((a) => ({ address: (a.address ?? PLACEHOLDER) as Address, role: roleOf(a) }))
          names = accountNames(parse({ programAddress: ix.programAddress as Address, accounts: metas, data: ix.data }), metas)
        } catch {
          /* too few accounts: the arguments still stand, the accounts stay unnamed */
        }
      }
      return { name, args, ...(names ? { accountNames: names } : {}) }
    },
  }
  return decoder
}

/** Enum value → name for a TypeScript numeric enum. */
function enumNames(e: Record<string, string | number>): Record<number, string> {
  const out: Record<number, string> = {}
  for (const [k, v] of Object.entries(e)) if (typeof v === 'number') out[v] = k
  return out
}

/** The original `Create` carries no data at all (the program reads no tag then); Mayan's routes still send it that way. */
const ataCreateWithoutData = (ix: RawInstruction): DecodedFields | null =>
  ix.data.length === 0 ? { name: 'CreateAssociatedToken', args: {}, accountNames: ['payer', 'ata', 'owner', 'mint', 'systemProgram', 'tokenProgram'].slice(0, ix.accounts.length) } : null

export const SYSTEM_PROGRAM = system.SYSTEM_PROGRAM_ADDRESS as string
export const TOKEN_PROGRAM = token.TOKEN_PROGRAM_ADDRESS as string
export const TOKEN_2022_PROGRAM = token2022.TOKEN_2022_PROGRAM_ADDRESS as string
export const ASSOCIATED_TOKEN_PROGRAM = token.ASSOCIATED_TOKEN_PROGRAM_ADDRESS as string
export const COMPUTE_BUDGET_PROGRAM = computeBudget.COMPUTE_BUDGET_PROGRAM_ADDRESS as string
export const STAKE_PROGRAM = stake.STAKE_PROGRAM_ADDRESS as string
export const ADDRESS_LOOKUP_TABLE_PROGRAM = addressLookupTable.ADDRESS_LOOKUP_TABLE_PROGRAM_ADDRESS as string

export const systemDecoder = codamaDecoder({
  programAddress: SYSTEM_PROGRAM, programName: 'System Program', module: system as Module,
  instructions: enumNames(system.SystemInstruction as never), identify: (d) => system.identifySystemInstruction(d),
})

export const tokenDecoder = codamaDecoder({
  programAddress: TOKEN_PROGRAM, programName: 'Token Program', module: token as Module,
  instructions: enumNames(token.TokenInstruction as never), identify: (d) => token.identifyTokenInstruction(d),
})

export const token2022Decoder = codamaDecoder({
  programAddress: TOKEN_2022_PROGRAM, programName: 'Token-2022 Program', module: token2022 as Module,
  instructions: enumNames(token2022.Token2022Instruction as never), identify: (d) => token2022.identifyToken2022Instruction(d),
})

export const associatedTokenDecoder = codamaDecoder({
  programAddress: ASSOCIATED_TOKEN_PROGRAM, programName: 'Associated Token Account Program', module: token as Module,
  instructions: enumNames(token.AssociatedTokenInstruction as never), identify: (d) => token.identifyAssociatedTokenInstruction(d),
  fallback: ataCreateWithoutData,
})

export const computeBudgetDecoder = codamaDecoder({
  programAddress: COMPUTE_BUDGET_PROGRAM, programName: 'Compute Budget Program', module: computeBudget as Module,
  instructions: enumNames(computeBudget.ComputeBudgetInstruction as never), identify: (d) => computeBudget.identifyComputeBudgetInstruction(d),
})

// The Stake program has its own decoder (named arguments, both account layouts the program accepts): stake.ts.
export { stakeDecoder }

export const addressLookupTableDecoder = codamaDecoder({
  programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM, programName: 'Address Lookup Table Program', module: addressLookupTable as Module,
  instructions: enumNames(addressLookupTable.AddressLookupTableInstruction as never), identify: (d) => addressLookupTable.identifyAddressLookupTableInstruction(d),
})

export const officialDecoders: readonly InstructionDecoder[] = [
  systemDecoder, tokenDecoder, token2022Decoder, associatedTokenDecoder, computeBudgetDecoder, stakeDecoder, addressLookupTableDecoder,
]
