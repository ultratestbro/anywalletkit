import { getAddressEncoder, getU32Encoder, getU64Encoder } from '@solana/kit'
import { describe, expect, it } from 'vitest'
import { decodeInstruction, decodeTransaction, SPL_STAKE_POOL_PROGRAM, type DecodedInstruction, type RawAccount } from '../src/index.js'
import { decodeFixture, fixtureBalanceChanges, loadFixture, type Fixture } from './helpers.js'

const JITO_POOL = 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb'
const JITOSOL = 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'
const JITO_RESERVE = 'BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL'
const VOTE = 'masvNDXtxVVMrYSV84RMry97JyHXAFcdfTZJ5VzpSYR'

const poolIxs = (f: Fixture) => decodeFixture(f).instructions.filter((i) => i.programAddress === SPL_STAKE_POOL_PROGRAM)
const accountOf = (d: DecodedInstruction, name: string) => d.accounts.find((a) => a.name === name)?.address
const solDelta = (f: Fixture, address: string) => fixtureBalanceChanges(f)!.sol.find((s) => s.account === address)?.delta ?? 0n
const tokenDelta = (f: Fixture, account: string) => fixtureBalanceChanges(f)!.tokens.find((t) => t.account === account)?.delta ?? 0n

const u64 = (v: bigint) => getU64Encoder().encode(v) as Uint8Array
const bytes = (...parts: Array<number | Uint8Array>) => new Uint8Array(parts.flatMap((p) => (typeof p === 'number' ? [p] : [...p])))
const accounts = (n: number): RawAccount[] => Array.from({ length: n }, (_, i) => ({ address: `Acct${String(i).padStart(2, '0')}111111111111111111111111111111111111`.slice(0, 44), signer: false, writable: false }))
const ix = (data: Uint8Array, n = 0) => decodeInstruction({ programAddress: SPL_STAKE_POOL_PROGRAM, accounts: accounts(n), data }, 0)
const names = (d: DecodedInstruction) => d.accounts.map((a) => a.name)

describe('SPL Stake Pool: real transactions', () => {
  it('Jito DepositSol: lamports in = what the reserve gains, the user gets the minted JitoSOL, every account named', () => {
    const f = loadFixture('stake-pool/jito-deposit-sol.json')
    const tx = decodeFixture(f)
    const [d] = poolIxs(f)
    expect(d!.name).toBe('DepositSol')
    expect(d!.args).toEqual({ lamportsIn: 15_000_000n })
    expect(names(d!)).toEqual(['stakePool', 'withdrawAuthority', 'reserveStake', 'lamportsFrom', 'userPoolTokenAccount', 'managerFeeAccount', 'referrerPoolTokenAccount', 'poolMint', 'systemProgram', 'tokenProgram'])
    expect(accountOf(d!, 'stakePool')).toBe(JITO_POOL)
    expect(accountOf(d!, 'poolMint')).toBe(JITOSOL)
    expect(accountOf(d!, 'reserveStake')).toBe(JITO_RESERVE)
    expect(solDelta(f, JITO_RESERVE)).toBe(d!.args.lamportsIn)
    // The wallet funds a one-off signer that deposits: its transfer is the deposit; the user's SOL drop is that,
    // the fee and a tip transfer.
    const transfers = tx.instructions.filter((i) => i.name === 'TransferSol')
    expect(transfers[0]!.args.amount).toBe(d!.args.lamportsIn)
    expect(accountOf(transfers[0]!, 'destination')).toBe(accountOf(d!, 'lamportsFrom'))
    const signer = fixtureBalanceChanges(f)!.signer!
    const tip = transfers[1]!.args.amount as bigint
    expect(-signer.sol - BigInt(f.meta.fee) - tip).toBe(d!.args.lamportsIn)
    // Pool tokens minted to the user = the token delta of the user's pool-token account.
    const minted = tokenDelta(f, accountOf(d!, 'userPoolTokenAccount')!)
    expect(minted).toBeGreaterThan(0n)
    expect(signer.tokens).toEqual([{ mint: JITOSOL, decimals: 9, delta: minted }])
  })

  it('Jito UpdateValidatorListBalance + WithdrawSol: crank args and validator/transient pairs; pool tokens burned = the user\'s JitoSOL drop', () => {
    const f = loadFixture('stake-pool/jito-update-withdraw-sol.json')
    const tx = decodeFixture(f)
    const [update, withdraw] = poolIxs(f)
    expect(update!.name).toBe('UpdateValidatorListBalance')
    expect(update!.args).toEqual({ startIndex: 125, noMerge: false })
    expect(names(update!).slice(0, 7)).toEqual(['stakePool', 'withdrawAuthority', 'validatorList', 'reserveStake', 'clockSysvar', 'stakeHistorySysvar', 'stakeProgram'])
    expect(names(update!).slice(7)).toEqual(Array.from({ length: 5 }, () => ['validatorStake', 'transientStake']).flat())
    expect(withdraw!.name).toBe('WithdrawSol')
    expect(names(withdraw!)).toEqual([
      'stakePool', 'withdrawAuthority', 'userTransferAuthority', 'userPoolTokenAccount', 'reserveStake', 'lamportsTo', 'managerFeeAccount',
      'poolMint', 'clockSysvar', 'stakeHistorySysvar', 'stakeProgram', 'tokenProgram',
    ])
    expect(accountOf(withdraw!, 'stakePool')).toBe(JITO_POOL)
    expect(accountOf(withdraw!, 'lamportsTo')).toBe(tx.feePayer)
    const burned = withdraw!.args.poolTokensIn as bigint
    expect(tokenDelta(f, accountOf(withdraw!, 'userPoolTokenAccount')!)).toBe(-burned)
    // The transfer authority is the delegate the preceding Approve set, for exactly the burned amount.
    const approve = tx.instructions.find((i) => i.name === 'Approve')!
    expect(accountOf(approve, 'delegate')).toBe(accountOf(withdraw!, 'userTransferAuthority'))
    expect(approve.args.amount).toBe(burned)
    expect(fixtureBalanceChanges(f)!.signer!.sol).toBeGreaterThan(0n)
  })

  it('Jito UpdateStakePoolBalance: the crank, no arguments', () => {
    const [u] = poolIxs(loadFixture('stake-pool/jito-update-pool-balance.json'))
    expect(u).toMatchObject({ name: 'UpdateStakePoolBalance', args: {} })
    expect(names(u!)).toEqual(['stakePool', 'withdrawAuthority', 'validatorList', 'reserveStake', 'managerFeeAccount', 'poolMint', 'tokenProgram'])
    expect(accountOf(u!, 'poolMint')).toBe(JITOSOL)
  })

  it('WithdrawStake: pool tokens burned = the user\'s token drop; the split lands in the new stake account the user controls', () => {
    const f = loadFixture('stake-pool/withdraw-stake.json')
    const tx = decodeFixture(f)
    const [w] = poolIxs(f)
    expect(w!.name).toBe('WithdrawStake')
    expect(names(w!)).toEqual([
      'stakePool', 'validatorList', 'withdrawAuthority', 'stakeToSplit', 'stakeToReceive', 'userStakeAuthority', 'userTransferAuthority',
      'userPoolTokenAccount', 'managerFeeAccount', 'poolMint', 'clockSysvar', 'tokenProgram', 'stakeProgram',
    ])
    expect(tokenDelta(f, accountOf(w!, 'userPoolTokenAccount')!)).toBe(-(w!.args.poolTokensIn as bigint))
    expect(accountOf(w!, 'userStakeAuthority')).toBe(tx.feePayer)
    const create = tx.instructions.find((i) => i.name === 'CreateAccount')!
    expect(accountOf(create, 'newAccount')).toBe(accountOf(w!, 'stakeToReceive'))
    const split = -solDelta(f, accountOf(w!, 'stakeToSplit')!)
    expect(solDelta(f, accountOf(w!, 'stakeToReceive')!)).toBe(split + (create.args.lamports as bigint))
  })

  it('IncreaseAdditionalValidatorStake: lamports and seeds; the reserve funds the transient stake with lamports + the rent reserve', () => {
    const f = loadFixture('stake-pool/increase-additional-validator-stake.json')
    const [d] = poolIxs(f)
    expect(d!.args).toEqual({ lamports: 3_323_744_193n, transientStakeSeed: 58n, ephemeralStakeSeed: 59n })
    expect(names(d!)).toEqual([
      'stakePool', 'staker', 'withdrawAuthority', 'validatorList', 'reserveStake', 'ephemeralStake', 'transientStake', 'validatorStake', 'validatorVote',
      'clockSysvar', 'stakeHistorySysvar', 'stakeConfig', 'systemProgram', 'stakeProgram',
    ])
    const funded = solDelta(f, accountOf(d!, 'transientStake')!)
    expect(solDelta(f, accountOf(d!, 'reserveStake')!)).toBe(-funded)
    expect(funded - (d!.args.lamports as bigint)).toBe(1_666_240n)
  })

  it('SetPreferredValidator: the enum by name and the optional vote address', () => {
    const [d] = poolIxs(loadFixture('stake-pool/set-preferred-validator.json'))
    expect(d).toMatchObject({ name: 'SetPreferredValidator', args: { validatorType: 'Withdraw', validatorVoteAddress: VOTE } })
    expect(names(d!)).toEqual(['stakePool', 'staker', 'validatorList'])
  })
})

describe('SPL Stake Pool: every instruction, exact lengths', () => {
  const fee = (d: bigint, n: bigint) => bytes(u64(d), u64(n))

  it.each([
    [0, bytes(0, fee(100n, 5n), fee(1000n, 1n), fee(1000n, 0n), 50, getU32Encoder().encode(2000) as Uint8Array), 'Initialize',
      { fee: { denominator: 100n, numerator: 5n }, withdrawalFee: { denominator: 1000n, numerator: 1n }, depositFee: { denominator: 1000n, numerator: 0n }, referralFee: 50, maxValidators: 2000 }],
    [1, bytes(1, getU32Encoder().encode(7) as Uint8Array), 'AddValidatorToPool', { validatorStakeSeed: 7 }],
    [2, bytes(2), 'RemoveValidatorFromPool', {}],
    [3, bytes(3, u64(10n), u64(1n)), 'DecreaseValidatorStake', { lamports: 10n, transientStakeSeed: 1n }],
    [4, bytes(4, u64(10n), u64(1n)), 'IncreaseValidatorStake', { lamports: 10n, transientStakeSeed: 1n }],
    [5, bytes(5, 0, 0), 'SetPreferredValidator', { validatorType: 'Deposit', validatorVoteAddress: null }],
    [6, bytes(6, getU32Encoder().encode(0) as Uint8Array, 1), 'UpdateValidatorListBalance', { startIndex: 0, noMerge: true }],
    [7, bytes(7), 'UpdateStakePoolBalance', {}],
    [8, bytes(8), 'CleanupRemovedValidatorEntries', {}],
    [9, bytes(9), 'DepositStake', {}],
    [10, bytes(10, u64(5n)), 'WithdrawStake', { poolTokensIn: 5n }],
    [11, bytes(11), 'SetManager', {}],
    [12, bytes(12, 2, fee(100n, 4n)), 'SetFee', { fee: { kind: 'Epoch', denominator: 100n, numerator: 4n } }],
    [12, bytes(12, 0, 50), 'SetFee', { fee: { kind: 'SolReferral', percent: 50 } }],
    [13, bytes(13), 'SetStaker', {}],
    [14, bytes(14, u64(1n)), 'DepositSol', { lamportsIn: 1n }],
    [15, bytes(15, 2), 'SetFundingAuthority', { fundingType: 'SolWithdraw' }],
    [16, bytes(16, u64(1n)), 'WithdrawSol', { poolTokensIn: 1n }],
    [17, bytes(17, getU32Encoder().encode(4) as Uint8Array, ...'Jito'.split('').map((c) => c.charCodeAt(0)), getU32Encoder().encode(7) as Uint8Array, ...'JitoSOL'.split('').map((c) => c.charCodeAt(0)), getU32Encoder().encode(0) as Uint8Array), 'CreateTokenMetadata', { name: 'Jito', symbol: 'JitoSOL', uri: '' }],
    [18, bytes(18, getU32Encoder().encode(1) as Uint8Array, 65, getU32Encoder().encode(1) as Uint8Array, 66, getU32Encoder().encode(1) as Uint8Array, 67), 'UpdateTokenMetadata', { name: 'A', symbol: 'B', uri: 'C' }],
    [19, bytes(19, u64(10n), u64(1n), u64(2n)), 'IncreaseAdditionalValidatorStake', { lamports: 10n, transientStakeSeed: 1n, ephemeralStakeSeed: 2n }],
    [20, bytes(20, u64(10n), u64(1n), u64(2n)), 'DecreaseAdditionalValidatorStake', { lamports: 10n, transientStakeSeed: 1n, ephemeralStakeSeed: 2n }],
    [21, bytes(21, u64(10n), u64(1n)), 'DecreaseValidatorStakeWithReserve', { lamports: 10n, transientStakeSeed: 1n }],
    [22, bytes(22, u64(10n), u64(1n), u64(2n), u64(3n)), 'Redelegate', { lamports: 10n, sourceTransientStakeSeed: 1n, ephemeralStakeSeed: 2n, destinationTransientStakeSeed: 3n }],
    [23, bytes(23, u64(9n)), 'DepositStakeWithSlippage', { minimumPoolTokensOut: 9n }],
    [24, bytes(24, u64(100n), u64(99n)), 'WithdrawStakeWithSlippage', { poolTokensIn: 100n, minimumLamportsOut: 99n }],
    [25, bytes(25, u64(100n), u64(90n)), 'DepositSolWithSlippage', { lamportsIn: 100n, minimumPoolTokensOut: 90n }],
    [26, bytes(26, u64(100n), u64(95n)), 'WithdrawSolWithSlippage', { poolTokensIn: 100n, minimumLamportsOut: 95n }],
  ] as const)('tag %i → %s', (_tag, data, name, args) => {
    const d = ix(data)
    expect(d).toMatchObject({ decoded: true, name })
    expect(d.args).toEqual(args)
    // One byte more is what borsh's try_from_slice refuses: undecoded, with the error.
    const longer = ix(bytes(data, 0))
    expect(longer.decoded).toBe(false)
    expect(longer.error).toMatch(/trailing/)
  })

  it('SetPreferredValidator with Some(vote) reads the address', () => {
    expect(ix(bytes(5, 1, 1, getAddressEncoder().encode(VOTE as never) as Uint8Array)).args).toEqual({ validatorType: 'Withdraw', validatorVoteAddress: VOTE })
  })

  it('the slippage forms and the optional authorities name the same accounts as the plain forms', () => {
    expect(names(ix(bytes(24, u64(1n), u64(1n)), 13))).toEqual(names(ix(bytes(10, u64(1n)), 13)))
    expect(names(ix(bytes(25, u64(1n), u64(1n)), 11))).toEqual([
      'stakePool', 'withdrawAuthority', 'reserveStake', 'lamportsFrom', 'userPoolTokenAccount', 'managerFeeAccount', 'referrerPoolTokenAccount',
      'poolMint', 'systemProgram', 'tokenProgram', 'solDepositAuthority',
    ])
    expect(names(ix(bytes(26, u64(1n), u64(1n)), 13)).at(-1)).toBe('solWithdrawAuthority')
    expect(names(ix(bytes(23, u64(1n)), 15))).toEqual(names(ix(bytes(9), 15)))
    expect(names(ix(bytes(23, u64(1n)), 16)).at(-1)).toBeNull()
  })

  it('malformed data: short reads, a bad bool / option / enum index throw; an unknown tag or empty data is undecoded without error', () => {
    expect(ix(bytes(10, 1, 2, 3)).error).toMatch(/expected 8 bytes/)
    expect(ix(bytes(24, u64(1n))).error).toMatch(/u64/)
    expect(ix(bytes(6, getU32Encoder().encode(0) as Uint8Array, 2)).error).toMatch(/invalid bool/)
    expect(ix(bytes(5, 0, 2)).error).toMatch(/invalid Option/)
    expect(ix(bytes(15, 3)).error).toMatch(/invalid FundingType/)
    expect(ix(bytes(12, 7, 1)).error).toMatch(/invalid FeeType/)
    expect(ix(bytes(17, getU32Encoder().encode(40) as Uint8Array, 65)).decoded).toBe(false)
    expect(ix(bytes(27))).toMatchObject({ decoded: false, name: null })
    expect(ix(bytes(27)).error).toBeUndefined()
    expect(ix(new Uint8Array())).toMatchObject({ decoded: false, name: null })
  })

  it('a malformed stake-pool instruction in a transaction shows as undecoded with its error', () => {
    const f = loadFixture('stake-pool/jito-deposit-sol.json')
    const tx = decodeTransaction(f.wire, { lookupTables: f.lookupTables as never })
    const at = tx.instructions.findIndex((i) => i.programAddress === SPL_STAKE_POOL_PROGRAM)
    const raw = tx.instructions[at]!
    const broken = decodeInstruction({ programAddress: raw.programAddress, accounts: raw.accounts, data: bytes(14, u64(1n), 0) }, at)
    expect(broken).toMatchObject({ decoded: false, programName: 'SPL Stake Pool', error: '1 unexpected trailing bytes' })
    expect(broken.accounts.map((a) => a.address)).toEqual(raw.accounts.map((a) => a.address))
  })
})
