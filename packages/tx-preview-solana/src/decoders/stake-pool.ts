/**
 * The SPL Stake Pool program (`SPoo1…`): Jito and every other pool deployed on it. The full instruction enum of
 * `program/src/instruction.rs` (solana-program/stake-pool): borsh, a u8 tag, then the variant's fields. The
 * program reads it with `try_from_slice`, which takes the exact length only, so trailing bytes throw here too.
 * Accounts are named per the source's account docs; optional trailing accounts (a deposit or withdraw authority)
 * are named when present, and `UpdateValidatorListBalance` names its validator/transient pairs.
 */
import { addDecoderSizePrefix, getAddressDecoder, getU32Decoder, getU64Decoder, getU8Decoder, getUtf8Decoder, type Decoder } from '@solana/kit'
import type { DecodedFields, InstructionDecoder, PreviewValue, RawInstruction } from '../types.js'

export const SPL_STAKE_POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'

const u8 = getU8Decoder()
const u32 = getU32Decoder()
const u64 = getU64Decoder()
const address = getAddressDecoder()
// borsh String: u32 length, then UTF-8 bytes.
const string = addDecoderSizePrefix(getUtf8Decoder(), u32)

/** A borsh reader over the instruction data, after the tag. Every read throws on short data. */
class Reader {
  private offset = 1
  constructor(private readonly data: Uint8Array) {}
  read<T>(decoder: Decoder<T>): T {
    const [value, next] = decoder.read(this.data, this.offset)
    this.offset = next
    return value
  }
  u8(): number { return this.read(u8) }
  u32(): number { return this.read(u32) }
  u64(): bigint { return this.read(u64) as bigint }
  address(): string { return this.read(address) }
  string(): string { return this.read(string) }
  /** borsh bool: exactly 0 or 1. */
  bool(): boolean {
    const b = this.u8()
    if (b > 1) throw new Error(`invalid bool ${b}`)
    return b === 1
  }
  /** borsh Option: 0 = None, 1 = Some. */
  option<T>(read: () => T): T | null {
    const t = this.u8()
    if (t > 1) throw new Error(`invalid Option tag ${t}`)
    return t === 1 ? read() : null
  }
  /** A fieldless borsh enum (u8 index) by name. */
  variant(names: readonly string[], what: string): string {
    const i = this.u8()
    const name = names[i]
    if (name === undefined) throw new Error(`invalid ${what} ${i}`)
    return name
  }
  /** `Fee { denominator: u64, numerator: u64 }`. */
  fee(): { denominator: bigint; numerator: bigint } {
    return { denominator: this.u64(), numerator: this.u64() }
  }
  end(): void {
    if (this.offset !== this.data.length) throw new Error(`${this.data.length - this.offset} unexpected trailing bytes`)
  }
}

type Args = Record<string, PreviewValue>

const FEE_TYPES = ['SolReferral', 'StakeReferral', 'Epoch', 'StakeWithdrawal', 'SolDeposit', 'StakeDeposit', 'SolWithdrawal'] as const

/** `FeeType`: the two referral variants carry a percentage (u8), the rest a `Fee`. */
function feeType(r: Reader): Args {
  const kind = r.variant(FEE_TYPES, 'FeeType')
  return kind === 'SolReferral' || kind === 'StakeReferral' ? { kind, percent: r.u8() } : { kind, ...r.fee() }
}

const DEPOSIT_STAKE_ACCOUNTS = [
  'stakePool', 'validatorList', 'depositAuthority', 'withdrawAuthority', 'depositStake', 'validatorStake', 'reserveStake',
  'userPoolTokenAccount', 'managerFeeAccount', 'referrerPoolTokenAccount', 'poolMint', 'clockSysvar', 'stakeHistorySysvar', 'tokenProgram', 'stakeProgram',
]
const WITHDRAW_STAKE_ACCOUNTS = [
  'stakePool', 'validatorList', 'withdrawAuthority', 'stakeToSplit', 'stakeToReceive', 'userStakeAuthority', 'userTransferAuthority',
  'userPoolTokenAccount', 'managerFeeAccount', 'poolMint', 'clockSysvar', 'tokenProgram', 'stakeProgram',
]
const DEPOSIT_SOL_ACCOUNTS = [
  'stakePool', 'withdrawAuthority', 'reserveStake', 'lamportsFrom', 'userPoolTokenAccount', 'managerFeeAccount', 'referrerPoolTokenAccount',
  'poolMint', 'systemProgram', 'tokenProgram', 'solDepositAuthority',
]
const WITHDRAW_SOL_ACCOUNTS = [
  'stakePool', 'withdrawAuthority', 'userTransferAuthority', 'userPoolTokenAccount', 'reserveStake', 'lamportsTo', 'managerFeeAccount',
  'poolMint', 'clockSysvar', 'stakeHistorySysvar', 'stakeProgram', 'tokenProgram', 'solWithdrawAuthority',
]
const METADATA_FIELDS = (r: Reader): Args => ({ name: r.string(), symbol: r.string(), uri: r.string() })

/** One variant: its name, its fields in order, and its accounts by position. */
interface Variant {
  readonly name: string
  readonly args?: (r: Reader) => Args
  readonly accounts: readonly string[]
}

/** Indexed by tag; verified against `StakePoolInstruction` in program/src/instruction.rs. */
const VARIANTS: readonly Variant[] = [
  /* 0 */ {
    name: 'Initialize',
    args: (r) => ({ fee: r.fee(), withdrawalFee: r.fee(), depositFee: r.fee(), referralFee: r.u8(), maxValidators: r.u32() }),
    accounts: ['stakePool', 'manager', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'poolMint', 'managerFeeAccount', 'tokenProgram', 'depositAuthority'],
  },
  /* 1 */ {
    name: 'AddValidatorToPool',
    args: (r) => ({ validatorStakeSeed: r.u32() }),
    accounts: ['stakePool', 'staker', 'reserveStake', 'withdrawAuthority', 'validatorList', 'validatorStake', 'validatorVote', 'rentSysvar', 'clockSysvar', 'stakeHistorySysvar', 'stakeConfig', 'systemProgram', 'stakeProgram'],
  },
  /* 2 */ {
    name: 'RemoveValidatorFromPool',
    accounts: ['stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'validatorStake', 'transientStake', 'clockSysvar', 'stakeProgram'],
  },
  /* 3 */ {
    name: 'DecreaseValidatorStake',
    args: (r) => ({ lamports: r.u64(), transientStakeSeed: r.u64() }),
    accounts: ['stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'validatorStake', 'transientStake', 'clockSysvar', 'rentSysvar', 'systemProgram', 'stakeProgram'],
  },
  /* 4 */ {
    name: 'IncreaseValidatorStake',
    args: (r) => ({ lamports: r.u64(), transientStakeSeed: r.u64() }),
    accounts: ['stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'transientStake', 'validatorStake', 'validatorVote', 'clockSysvar', 'rentSysvar', 'stakeHistorySysvar', 'stakeConfig', 'systemProgram', 'stakeProgram'],
  },
  /* 5 */ {
    name: 'SetPreferredValidator',
    args: (r) => ({ validatorType: r.variant(['Deposit', 'Withdraw'], 'PreferredValidatorType'), validatorVoteAddress: r.option(() => r.address()) }),
    accounts: ['stakePool', 'staker', 'validatorList'],
  },
  /* 6 */ {
    name: 'UpdateValidatorListBalance',
    args: (r) => ({ startIndex: r.u32(), noMerge: r.bool() }),
    accounts: ['stakePool', 'withdrawAuthority', 'validatorList', 'reserveStake', 'clockSysvar', 'stakeHistorySysvar', 'stakeProgram'],
  },
  /* 7 */ {
    name: 'UpdateStakePoolBalance',
    accounts: ['stakePool', 'withdrawAuthority', 'validatorList', 'reserveStake', 'managerFeeAccount', 'poolMint', 'tokenProgram'],
  },
  /* 8 */ { name: 'CleanupRemovedValidatorEntries', accounts: ['stakePool', 'validatorList'] },
  /* 9 */ { name: 'DepositStake', accounts: DEPOSIT_STAKE_ACCOUNTS },
  /* 10 */ { name: 'WithdrawStake', args: (r) => ({ poolTokensIn: r.u64() }), accounts: WITHDRAW_STAKE_ACCOUNTS },
  /* 11 */ { name: 'SetManager', accounts: ['stakePool', 'manager', 'newManager', 'newManagerFeeAccount'] },
  /* 12 */ { name: 'SetFee', args: (r) => ({ fee: feeType(r) }), accounts: ['stakePool', 'manager'] },
  /* 13 */ { name: 'SetStaker', accounts: ['stakePool', 'managerOrStaker', 'newStaker'] },
  /* 14 */ { name: 'DepositSol', args: (r) => ({ lamportsIn: r.u64() }), accounts: DEPOSIT_SOL_ACCOUNTS },
  /* 15 */ {
    name: 'SetFundingAuthority',
    args: (r) => ({ fundingType: r.variant(['StakeDeposit', 'SolDeposit', 'SolWithdraw'], 'FundingType') }),
    // Without a third account the authority is unset.
    accounts: ['stakePool', 'manager', 'newAuthority'],
  },
  /* 16 */ { name: 'WithdrawSol', args: (r) => ({ poolTokensIn: r.u64() }), accounts: WITHDRAW_SOL_ACCOUNTS },
  /* 17 */ {
    name: 'CreateTokenMetadata',
    args: METADATA_FIELDS,
    accounts: ['stakePool', 'manager', 'withdrawAuthority', 'poolMint', 'payer', 'tokenMetadata', 'metadataProgram', 'systemProgram'],
  },
  /* 18 */ { name: 'UpdateTokenMetadata', args: METADATA_FIELDS, accounts: ['stakePool', 'manager', 'withdrawAuthority', 'tokenMetadata', 'metadataProgram'] },
  /* 19 */ {
    name: 'IncreaseAdditionalValidatorStake',
    args: (r) => ({ lamports: r.u64(), transientStakeSeed: r.u64(), ephemeralStakeSeed: r.u64() }),
    accounts: ['stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'ephemeralStake', 'transientStake', 'validatorStake', 'validatorVote', 'clockSysvar', 'stakeHistorySysvar', 'stakeConfig', 'systemProgram', 'stakeProgram'],
  },
  /* 20 */ {
    name: 'DecreaseAdditionalValidatorStake',
    args: (r) => ({ lamports: r.u64(), transientStakeSeed: r.u64(), ephemeralStakeSeed: r.u64() }),
    accounts: ['stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'validatorStake', 'ephemeralStake', 'transientStake', 'clockSysvar', 'stakeHistorySysvar', 'systemProgram', 'stakeProgram'],
  },
  /* 21 */ {
    name: 'DecreaseValidatorStakeWithReserve',
    args: (r) => ({ lamports: r.u64(), transientStakeSeed: r.u64() }),
    accounts: ['stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'validatorStake', 'transientStake', 'clockSysvar', 'stakeHistorySysvar', 'systemProgram', 'stakeProgram'],
  },
  /* 22 */ {
    // Deprecated: the stake program's Redelegate it relies on is disabled.
    name: 'Redelegate',
    args: (r) => ({ lamports: r.u64(), sourceTransientStakeSeed: r.u64(), ephemeralStakeSeed: r.u64(), destinationTransientStakeSeed: r.u64() }),
    accounts: [
      'stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'sourceValidatorStake', 'sourceTransientStake', 'ephemeralStake',
      'destinationTransientStake', 'destinationValidatorStake', 'destinationValidatorVote', 'clockSysvar', 'stakeHistorySysvar', 'stakeConfig', 'systemProgram', 'stakeProgram',
    ],
  },
  /* 23 */ { name: 'DepositStakeWithSlippage', args: (r) => ({ minimumPoolTokensOut: r.u64() }), accounts: DEPOSIT_STAKE_ACCOUNTS },
  /* 24 */ { name: 'WithdrawStakeWithSlippage', args: (r) => ({ poolTokensIn: r.u64(), minimumLamportsOut: r.u64() }), accounts: WITHDRAW_STAKE_ACCOUNTS },
  /* 25 */ { name: 'DepositSolWithSlippage', args: (r) => ({ lamportsIn: r.u64(), minimumPoolTokensOut: r.u64() }), accounts: DEPOSIT_SOL_ACCOUNTS },
  /* 26 */ { name: 'WithdrawSolWithSlippage', args: (r) => ({ poolTokensIn: r.u64(), minimumLamportsOut: r.u64() }), accounts: WITHDRAW_SOL_ACCOUNTS },
]

function accountNames(v: Variant, ix: RawInstruction): (string | null)[] {
  return ix.accounts.map((_, i) => {
    if (i < v.accounts.length) return v.accounts[i]!
    // UpdateValidatorListBalance: after the fixed accounts, N (validator stake, transient stake) pairs.
    if (v.name === 'UpdateValidatorListBalance') return (i - v.accounts.length) % 2 === 0 ? 'validatorStake' : 'transientStake'
    return null
  })
}

export const stakePoolDecoder: InstructionDecoder = {
  programAddress: SPL_STAKE_POOL_PROGRAM,
  programName: 'SPL Stake Pool',
  decode(ix): DecodedFields | null {
    if (ix.data.length === 0) return null
    const v = VARIANTS[ix.data[0]!]
    if (!v) return null
    const r = new Reader(ix.data)
    const args = v.args ? v.args(r) : {}
    r.end()
    return { name: v.name, args, accountNames: accountNames(v, ix) }
  },
}
