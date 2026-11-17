/**
 * The native Stake program. The official client (`@solana-program/stake`) reads the data, but names several
 * arguments `arg0`, `arg1`… and knows only the current account layouts; this decoder gives every argument its
 * meaning and names the accounts of both layouts the program accepts (see the program's `processor.rs`: the
 * legacy one with sysvar accounts, `[stake, clock, authority, new]`, and the current one without,
 * `[stake, authority, new]`). The program picks the layout from one account (the Clock sysvar, or Rent for
 * `InitializeChecked`); when that account sits in an unresolved lookup table, the accounts it decides stay
 * unnamed rather than guessed.
 */
import * as stake from '@solana-program/stake'
import type { DecodedFields, InstructionDecoder, PreviewValue, RawInstruction } from '../types.js'
import { toArgs } from '../values.js'

export const STAKE_PROGRAM = stake.STAKE_PROGRAM_ADDRESS as string

const SYSVAR_CLOCK = 'SysvarC1ock11111111111111111111111111111111'
const SYSVAR_RENT = 'SysvarRent111111111111111111111111111111111'

/** Instruction tags as the program numbers them (bincode u32). `Redelegate` (15) is deprecated and absent from the client. */
const NAMES = [
  'Initialize', 'Authorize', 'DelegateStake', 'Split', 'Withdraw', 'Deactivate', 'SetLockup', 'Merge',
  'AuthorizeWithSeed', 'InitializeChecked', 'AuthorizeChecked', 'AuthorizeCheckedWithSeed', 'SetLockupChecked',
  'GetMinimumDelegation', 'DeactivateDelinquent', 'Redelegate', 'MoveStake', 'MoveLamports',
] as const
type StakeName = (typeof NAMES)[number]

/**
 * Accounts by position: `head` always; then, when `branch` is set, the account right after `head` decides the
 * layout: `legacy` names from there on when it is the sysvar, `current` otherwise.
 */
interface Layout {
  readonly head: readonly string[]
  readonly branch?: { readonly sysvar: string; readonly legacy: readonly string[]; readonly current: readonly string[] }
}

const LAYOUTS: Record<StakeName, Layout> = {
  Initialize: { head: ['stake'], branch: { sysvar: SYSVAR_RENT, legacy: ['rentSysvar'], current: [] } },
  Authorize: { head: ['stake'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'authority', 'lockupAuthority'], current: ['authority', 'lockupAuthority'] } },
  DelegateStake: { head: ['stake', 'vote'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'stakeHistorySysvar', 'stakeConfig', 'stakeAuthority'], current: ['stakeAuthority'] } },
  Split: { head: ['stake', 'splitStake', 'stakeAuthority'] },
  Withdraw: { head: ['stake', 'recipient'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'stakeHistorySysvar', 'withdrawAuthority', 'lockupAuthority'], current: ['withdrawAuthority', 'lockupAuthority'] } },
  Deactivate: { head: ['stake'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'stakeAuthority'], current: ['stakeAuthority'] } },
  SetLockup: { head: ['stake', 'authority'] },
  Merge: { head: ['destinationStake', 'sourceStake'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'stakeHistorySysvar', 'stakeAuthority'], current: ['stakeAuthority'] } },
  AuthorizeWithSeed: { head: ['stake', 'base'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'lockupAuthority'], current: ['lockupAuthority'] } },
  InitializeChecked: { head: ['stake'], branch: { sysvar: SYSVAR_RENT, legacy: ['rentSysvar', 'stakeAuthority', 'withdrawAuthority'], current: ['stakeAuthority', 'withdrawAuthority'] } },
  AuthorizeChecked: { head: ['stake'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'authority', 'newAuthority', 'lockupAuthority'], current: ['authority', 'newAuthority', 'lockupAuthority'] } },
  AuthorizeCheckedWithSeed: { head: ['stake', 'base'], branch: { sysvar: SYSVAR_CLOCK, legacy: ['clockSysvar', 'newAuthority', 'lockupAuthority'], current: ['newAuthority', 'lockupAuthority'] } },
  SetLockupChecked: { head: ['stake', 'authority', 'newLockupAuthority'] },
  GetMinimumDelegation: { head: [] },
  DeactivateDelinquent: { head: ['stake', 'delinquentVote', 'referenceVote'] },
  // Disabled since 2.1; its stake-authority slot moved between versions, so only the fixed head is named.
  Redelegate: { head: ['stake', 'uninitializedStake', 'vote'] },
  MoveStake: { head: ['sourceStake', 'destinationStake', 'stakeAuthority'] },
  MoveLamports: { head: ['sourceStake', 'destinationStake', 'stakeAuthority'] },
}

/** Names by position for the layout the accounts select; past the layout (extra signers) slots stay unnamed. */
function accountNames(layout: Layout, ix: RawInstruction): (string | null)[] {
  const names: (string | null)[] = ix.accounts.map(() => null)
  layout.head.forEach((n, i) => { if (i < names.length) names[i] = n })
  const b = layout.branch
  const at = layout.head.length
  if (!b || at >= ix.accounts.length) return names
  const decider = ix.accounts[at]!.address
  // Unresolved deciding account: the layout is unknown, so every name it decides stays null (never a guess).
  if (decider === null) return names
  const rest = decider === b.sysvar ? b.legacy : b.current
  rest.forEach((n, i) => { if (at + i < names.length) names[at + i] = n })
  return names
}

const authorizeName = (v: unknown): PreviewValue => (v === stake.StakeAuthorize.Staker ? 'staker' : v === stake.StakeAuthorize.Withdrawer ? 'withdrawer' : null)

/** The address of the account named `name`, `null` when absent or unresolved. */
const named = (ix: RawInstruction, names: readonly (string | null)[], name: string): string | null => {
  const i = names.indexOf(name)
  return i < 0 ? null : ix.accounts[i]?.address ?? null
}

type Data = Record<string, unknown>
const dataOf = (decoder: { decode(d: Uint8Array): unknown }, data: Uint8Array): Data => decoder.decode(data) as Data

/** Arguments with meaningful names (the client's are `arg0`, `arg1`, `args`). */
function argsOf(name: StakeName, ix: RawInstruction, names: readonly (string | null)[]): Record<string, PreviewValue> {
  const d = ix.data
  switch (name) {
    case 'Initialize': {
      const v = dataOf(stake.getInitializeInstructionDataDecoder(), d)
      return toArgs({ authorized: v.arg0, lockup: v.arg1 })
    }
    case 'Authorize': {
      const v = dataOf(stake.getAuthorizeInstructionDataDecoder(), d)
      return { newAuthority: v.arg0 as string, stakeAuthorize: authorizeName(v.arg1) }
    }
    case 'AuthorizeWithSeed': {
      const v = dataOf(stake.getAuthorizeWithSeedInstructionDataDecoder(), d)
      return { newAuthority: v.newAuthorizedPubkey as string, stakeAuthorize: authorizeName(v.stakeAuthorize), authoritySeed: v.authoritySeed as string, authorityOwner: v.authorityOwner as string }
    }
    // The Checked forms carry the new authority as a signing account, not in the data.
    case 'AuthorizeChecked': {
      const v = dataOf(stake.getAuthorizeCheckedInstructionDataDecoder(), d)
      return { stakeAuthorize: authorizeName(v.stakeAuthorize), newAuthority: named(ix, names, 'newAuthority') }
    }
    case 'AuthorizeCheckedWithSeed': {
      const v = dataOf(stake.getAuthorizeCheckedWithSeedInstructionDataDecoder(), d)
      return { stakeAuthorize: authorizeName(v.stakeAuthorize), authoritySeed: v.authoritySeed as string, authorityOwner: v.authorityOwner as string, newAuthority: named(ix, names, 'newAuthority') }
    }
    case 'Split': return { lamports: dataOf(stake.getSplitInstructionDataDecoder(), d).args as bigint }
    case 'Withdraw': return { lamports: dataOf(stake.getWithdrawInstructionDataDecoder(), d).args as bigint }
    case 'MoveStake': return { lamports: dataOf(stake.getMoveStakeInstructionDataDecoder(), d).args as bigint }
    case 'MoveLamports': return { lamports: dataOf(stake.getMoveLamportsInstructionDataDecoder(), d).args as bigint }
    // Each lockup field is optional: `null` leaves it as it is.
    case 'SetLockup': return toArgs(dataOf(stake.getSetLockupInstructionDataDecoder(), d))
    case 'SetLockupChecked': {
      const v = toArgs(dataOf(stake.getSetLockupCheckedInstructionDataDecoder(), d))
      return { ...v, custodian: named(ix, names, 'newLockupAuthority') }
    }
    case 'Redelegate': return { deprecated: 'Redelegate is disabled: the program rejects it.' }
    default: {
      // No arguments, but the tag still has to be one the client reads.
      const decoder = (stake as unknown as Record<string, (() => { decode(d: Uint8Array): unknown }) | undefined>)[`get${name}InstructionDataDecoder`]
      if (decoder) decoder().decode(d)
      return {}
    }
  }
}

export const stakeDecoder: InstructionDecoder = {
  programAddress: STAKE_PROGRAM,
  programName: 'Stake Program',
  decode(ix): DecodedFields | null {
    if (ix.data.length < 4) return null
    // bincode u32 tag, little-endian; the program ignores trailing bytes (bincode's default), so do we.
    const tag = (ix.data[0]! | (ix.data[1]! << 8) | (ix.data[2]! << 16)) + ix.data[3]! * 0x1000000
    const name = NAMES[tag]
    if (!name) return null
    const names = accountNames(LAYOUTS[name], ix)
    return { name, args: argsOf(name, ix, names), accountNames: names }
  },
}
