/**
 * Decoders for the programs that ship an official Codama client (`@solana-program/*`): System, SPL Token,
 * Token-2022 (every instruction of every extension the client knows — 100 at 0.20), Associated Token, Compute
 * Budget, Stake and Address Lookup Table. One adapter reads them all: the client's `identify…Instruction` names
 * the instruction, its data decoder reads the arguments (no accounts needed), and its parser — when the accounts
 * are there — names the accounts by position.
 */
import { AccountRole, type Address } from '@solana/kit'
import * as addressLookupTable from '@solana-program/address-lookup-table'
import * as computeBudget from '@solana-program/compute-budget'
import * as stake from '@solana-program/stake'
import * as system from '@solana-program/system'
import * as token from '@solana-program/token'
import * as token2022 from '@solana-program/token-2022'
import type { DecodedFields, InstructionDecoder, RawInstruction } from '../types.js'
import { toArgs } from '../values.js'

type Module = Record<string, unknown>
type Parser = (ix: unknown) => { accounts?: Record<string, { address: string } | undefined>; data?: unknown }
type DataDecoder = { decode(data: Uint8Array): unknown }

/** The System program id doubles as the all-zero address; it stands in for an account a lookup table hides. */
const PLACEHOLDER = system.SYSTEM_PROGRAM_ADDRESS as string

function roleOf(a: RawInstruction['accounts'][number]): AccountRole {
  return a.signer ? (a.writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : a.writable ? AccountRole.WRITABLE : AccountRole.READONLY
}

/**
 * Account names from a Codama parser: its `accounts` record lists the instruction's accounts in order. Optional
 * accounts the program omits come back `undefined` and still take their slot, so names are kept only while each
 * named address matches the account at its position; past the record (multisig signers, remaining accounts) slots
 * stay unnamed.
 */
function accountNames(parsed: ReturnType<Parser>, ix: RawInstruction): (string | null)[] {
  const names: (string | null)[] = ix.accounts.map(() => null)
  const entries = Object.entries(parsed.accounts ?? {})
  for (const [i, [name, meta]] of entries.entries()) {
    if (i >= ix.accounts.length) break
    const actual = ix.accounts[i]!.address ?? PLACEHOLDER
    if (meta && meta.address !== actual) return ix.accounts.map(() => null)
    names[i] = name
  }
  return names
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
  return {
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
      const args = toArgs(dataDecoder().decode(ix.data))
      let names: (string | null)[] | undefined
      if (parse) {
        try {
          const parsed = parse({
            programAddress: ix.programAddress as Address,
            accounts: ix.accounts.map((a) => ({ address: (a.address ?? PLACEHOLDER) as Address, role: roleOf(a) })),
            data: ix.data,
          })
          names = accountNames(parsed, ix)
        } catch {
          /* too few accounts: the arguments still stand, the accounts stay unnamed */
        }
      }
      return { name, args, ...(names ? { accountNames: names } : {}) }
    },
  }
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

export const stakeDecoder = codamaDecoder({
  programAddress: STAKE_PROGRAM, programName: 'Stake Program', module: stake as Module,
  instructions: enumNames(stake.StakeInstruction as never), identify: (d) => stake.identifyStakeInstruction(d),
})

export const addressLookupTableDecoder = codamaDecoder({
  programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM, programName: 'Address Lookup Table Program', module: addressLookupTable as Module,
  instructions: enumNames(addressLookupTable.AddressLookupTableInstruction as never), identify: (d) => addressLookupTable.identifyAddressLookupTableInstruction(d),
})

export const officialDecoders: readonly InstructionDecoder[] = [
  systemDecoder, tokenDecoder, token2022Decoder, associatedTokenDecoder, computeBudgetDecoder, stakeDecoder, addressLookupTableDecoder,
]
