import { getAddressEncoder, getU32Encoder, getU64Encoder } from '@solana/kit'
import {
  getAuthorizeCheckedInstructionDataEncoder, getAuthorizeCheckedWithSeedInstructionDataEncoder, getMoveLamportsInstructionDataEncoder, getMoveStakeInstructionDataEncoder,
  getSetLockupCheckedInstructionDataEncoder, getSetLockupInstructionDataEncoder, getWithdrawInstructionDataEncoder, StakeAuthorize,
} from '@solana-program/stake'
import { describe, expect, it } from 'vitest'
import { collectWarnings, decodeInstruction, STAKE_PROGRAM, type DecodedInstruction, type RawAccount } from '../src/index.js'
import { decodeFixture, fixtureBalanceChanges, loadFixture, type Fixture } from './helpers.js'

const CLOCK = 'SysvarC1ock11111111111111111111111111111111'
const RENT = 'SysvarRent111111111111111111111111111111111'
const STAKE_HISTORY = 'SysvarStakeHistory1111111111111111111111111'
const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111'
const STAKE = '9yDmBrxbzEWDQ64a3mYrEB6fFCs7NaZLBQnLSxk2wM7u'
const STAKE_2 = '444MXs4aTkHXWzi2T5d9Ftfhk3H4y4wqHbizqvHd99Ym'
const AUTH = 'HmZNCgfGziqrrssX5yoT5A3un2niSymNRfCL59Cov1Q3'
const NEW_AUTH = '5PxxoU93A4KLr23rXvYrYMFZDAw5DY8XZiyX6NsW7Hkk'
const CUSTODIAN = 'CeEdEeKPmRLTZARiuPqeDRSpA8zNijdoDBGm3xvB7Cs5'

const acct = (address: string | null, signer = false, writable = false): RawAccount => ({ address, signer, writable })
const ix = (data: Uint8Array, accounts: RawAccount[]) => decodeInstruction({ programAddress: STAKE_PROGRAM, accounts, data: new Uint8Array(data) }, 0)
const names = (d: DecodedInstruction) => d.accounts.map((a) => a.name)
const tag = (n: number, ...rest: Uint8Array[]) => new Uint8Array([...getU32Encoder().encode(n), ...rest.flatMap((r) => [...r])])
/** The sets-authority facts one decoded stake instruction yields. */
const authorityFacts = (d: DecodedInstruction) =>
  collectWarnings({ version: 0, feePayer: null, signers: [], lifetime: { kind: 'blockhash', value: null }, accounts: [], lookupTables: [], config: null, instructions: [d] }).filter((w) => w.code === 'sets-authority')

const stakeIxs = (f: Fixture) => decodeFixture(f).instructions.filter((i) => i.programAddress === STAKE_PROGRAM)
const accountOf = (d: DecodedInstruction, name: string) => d.accounts.find((a) => a.name === name)?.address
const solDelta = (f: Fixture, address: string) => fixtureBalanceChanges(f)!.sol.find((s) => s.account === address)?.delta ?? 0n

describe('Stake program: real transactions', () => {
  it.each([
    ['stake/initialize-delegate.json', 'legacy'],
    ['stake/initialize-delegate-v0.json', 'v0'],
  ])('%s: a native staking flow (CreateAccountWithSeed → Initialize → DelegateStake), legacy sysvar layout (%s)', (file) => {
    const f = loadFixture(file)
    const tx = decodeFixture(f)
    const [init, delegate] = stakeIxs(f)
    expect(init!.name).toBe('Initialize')
    expect(init!.args.authorized).toEqual({ staker: tx.feePayer, withdrawer: tx.feePayer })
    expect(init!.args.lockup).toMatchObject({ unixTimestamp: 0n, epoch: 0n })
    expect(names(init!)).toEqual(['stake', 'rentSysvar'])
    expect(init!.accounts[1]!.address).toBe(RENT)
    expect(delegate!.name).toBe('DelegateStake')
    expect(names(delegate!)).toEqual(['stake', 'vote', 'clockSysvar', 'stakeHistorySysvar', 'stakeConfig', 'stakeAuthority'])
    expect(delegate!.accounts.map((a) => a.address).slice(2, 5)).toEqual([CLOCK, STAKE_HISTORY, STAKE_CONFIG])
    expect(accountOf(delegate!, 'stakeAuthority')).toBe(tx.feePayer)
    // The stake account is the one CreateAccountWithSeed funded: its SOL rise equals the funding.
    const stake = accountOf(init!, 'stake')!
    expect(accountOf(delegate!, 'stake')).toBe(stake)
    const create = tx.instructions.find((i) => i.name === 'CreateAccountWithSeed')!
    expect(solDelta(f, stake)).toBe(create.args.amount)
    expect(tx.warnings.filter((w) => w.code === 'sets-authority')).toEqual([])
  })

  it('InitializeChecked (rent sysvar layout) + DelegateStake + Authorize to a new staker, with a sets-authority fact naming it', () => {
    const f = loadFixture('stake/initialize-checked-delegate-authorize.json')
    const tx = decodeFixture(f)
    const [init, delegate, authorize] = stakeIxs(f)
    expect(init!.name).toBe('InitializeChecked')
    expect(init!.args).toEqual({})
    expect(names(init!)).toEqual(['stake', 'rentSysvar', 'stakeAuthority', 'withdrawAuthority'])
    expect(accountOf(init!, 'withdrawAuthority')).toBe(tx.feePayer)
    expect(delegate!.name).toBe('DelegateStake')
    expect(authorize!.name).toBe('Authorize')
    expect(authorize!.args).toEqual({ newAuthority: 'psrStL2hNx4c7hLUUks8SmDngeYriB8pF7uyHFhM8ir', stakeAuthorize: 'staker' })
    expect(names(authorize!)).toEqual(['stake', 'clockSysvar', 'authority'])
    const facts = tx.warnings.filter((w) => w.code === 'sets-authority')
    expect(facts).toHaveLength(1)
    expect(facts[0]!.message).toContain('psrStL2hNx4c7hLUUks8SmDngeYriB8pF7uyHFhM8ir')
    expect(facts[0]!.message).toContain(`staker authority of stake account ${accountOf(init!, 'stake')}`)
  })

  it('Authorize ×2: staker and withdrawer handed to the account that then empties the stake account', () => {
    const f = loadFixture('stake/authorize.json')
    const tx = decodeFixture(f)
    const [a, b] = stakeIxs(f)
    expect([a!.args, b!.args]).toEqual([
      { newAuthority: NEW_AUTH, stakeAuthorize: 'staker' },
      { newAuthority: NEW_AUTH, stakeAuthorize: 'withdrawer' },
    ])
    expect(names(a!)).toEqual(['stake', 'clockSysvar', 'authority'])
    expect(accountOf(a!, 'authority')).toBe(tx.feePayer)
    const facts = tx.warnings.filter((w) => w.code === 'sets-authority')
    expect(facts.map((w) => w.instruction)).toEqual([a!.index, b!.index])
    expect(facts[1]!.message).toMatch(/withdrawer authority .* to 5PxxoU93/)
  })

  it('Deactivate: [stake, clock, stake authority], the signer is the stake authority', () => {
    const f = loadFixture('stake/deactivate.json')
    const [d] = stakeIxs(f)
    expect(d!.name).toBe('Deactivate')
    expect(d!.args).toEqual({})
    expect(names(d!)).toEqual(['stake', 'clockSysvar', 'stakeAuthority'])
    expect(accountOf(d!, 'stakeAuthority')).toBe(decodeFixture(f).feePayer)
  })

  it('Withdraw: lamports = what leaves the stake account = what the recipient gets', () => {
    const f = loadFixture('stake/withdraw.json')
    const [w] = stakeIxs(f)
    expect(w!.name).toBe('Withdraw')
    expect(names(w!)).toEqual(['stake', 'recipient', 'clockSysvar', 'stakeHistorySysvar', 'withdrawAuthority'])
    expect(w!.args.lamports).toBe(62013675n)
    expect(solDelta(f, accountOf(w!, 'recipient')!)).toBe(w!.args.lamports)
    expect(solDelta(f, accountOf(w!, 'stake')!)).toBe(-(w!.args.lamports as bigint))
  })

  it('Split: lamports move from the stake account into the split stake account', () => {
    const f = loadFixture('stake/split.json')
    const [s] = stakeIxs(f)
    expect(s!.name).toBe('Split')
    expect(names(s!)).toEqual(['stake', 'splitStake', 'stakeAuthority'])
    expect(s!.args.lamports).toBe(37_000_000_000n)
    expect(solDelta(f, accountOf(s!, 'splitStake')!)).toBe(s!.args.lamports)
    expect(solDelta(f, accountOf(s!, 'stake')!)).toBe(-(s!.args.lamports as bigint))
  })

  it('Merge (legacy layout): the source drains into the destination', () => {
    const f = loadFixture('stake/merge.json')
    const [m] = stakeIxs(f)
    expect(m!.name).toBe('Merge')
    expect(names(m!)).toEqual(['destinationStake', 'sourceStake', 'clockSysvar', 'stakeHistorySysvar', 'stakeAuthority'])
    const moved = solDelta(f, accountOf(m!, 'destinationStake')!)
    expect(moved).toBeGreaterThan(0n)
    expect(solDelta(f, accountOf(m!, 'sourceStake')!)).toBe(-moved)
  })
})

describe('Stake program: both account layouts', () => {
  const checked = getAuthorizeCheckedInstructionDataEncoder().encode({ stakeAuthorize: StakeAuthorize.Withdrawer }) as Uint8Array

  it('AuthorizeChecked with the clock sysvar ([stake, clock, authority, new, custodian]) and without ([stake, authority, new, custodian])', () => {
    const legacy = ix(checked, [acct(STAKE, false, true), acct(CLOCK), acct(AUTH, true), acct(NEW_AUTH, true), acct(CUSTODIAN, true)])
    expect(names(legacy)).toEqual(['stake', 'clockSysvar', 'authority', 'newAuthority', 'lockupAuthority'])
    expect(legacy.args).toEqual({ stakeAuthorize: 'withdrawer', newAuthority: NEW_AUTH })
    const current = ix(checked, [acct(STAKE, false, true), acct(AUTH, true), acct(NEW_AUTH, true), acct(CUSTODIAN, true)])
    expect(names(current)).toEqual(['stake', 'authority', 'newAuthority', 'lockupAuthority'])
    expect(current.args).toEqual({ stakeAuthorize: 'withdrawer', newAuthority: NEW_AUTH })
    expect(authorityFacts(current)[0]!.message).toBe(`Changes the withdrawer authority of stake account ${STAKE} to ${NEW_AUTH}.`)
  })

  it('AuthorizeChecked whose deciding account is unresolved: the names it decides stay null and the new authority is not guessed', () => {
    const d = ix(checked, [acct(STAKE, false, true), acct(null), acct(AUTH, true), acct(NEW_AUTH, true)])
    expect(d.decoded).toBe(true)
    expect(names(d)).toEqual(['stake', null, null, null])
    expect(d.args).toEqual({ stakeAuthorize: 'withdrawer', newAuthority: null })
    expect(authorityFacts(d)[0]!.message).toContain('to an unresolved account')
  })

  it('AuthorizeCheckedWithSeed: [stake, base, clock, new] and [stake, base, new]', () => {
    const data = getAuthorizeCheckedWithSeedInstructionDataEncoder().encode({ stakeAuthorize: StakeAuthorize.Staker, authoritySeed: 'seed-1', authorityOwner: STAKE_PROGRAM as never }) as Uint8Array
    const legacy = ix(data, [acct(STAKE, false, true), acct(AUTH, true), acct(CLOCK), acct(NEW_AUTH, true)])
    expect(names(legacy)).toEqual(['stake', 'base', 'clockSysvar', 'newAuthority'])
    expect(legacy.args).toEqual({ stakeAuthorize: 'staker', authoritySeed: 'seed-1', authorityOwner: STAKE_PROGRAM, newAuthority: NEW_AUTH })
    const current = ix(data, [acct(STAKE, false, true), acct(AUTH, true), acct(NEW_AUTH, true)])
    expect(names(current)).toEqual(['stake', 'base', 'newAuthority'])
    expect(current.args.newAuthority).toBe(NEW_AUTH)
  })

  it('InitializeChecked: [stake, rent, staker, withdrawer], [stake, staker, withdrawer], and unresolved', () => {
    const data = tag(9)
    expect(names(ix(data, [acct(STAKE_2, false, true), acct(RENT), acct(AUTH), acct(NEW_AUTH, true)]))).toEqual(['stake', 'rentSysvar', 'stakeAuthority', 'withdrawAuthority'])
    expect(names(ix(data, [acct(STAKE_2, false, true), acct(AUTH), acct(NEW_AUTH, true)]))).toEqual(['stake', 'stakeAuthority', 'withdrawAuthority'])
    expect(names(ix(data, [acct(STAKE_2, false, true), acct(null), acct(AUTH), acct(NEW_AUTH, true)]))).toEqual(['stake', null, null, null])
  })

  it('DelegateStake, Withdraw, Deactivate and Merge in the current layout (no sysvars)', () => {
    expect(names(ix(tag(2), [acct(STAKE, false, true), acct(NEW_AUTH), acct(AUTH, true)]))).toEqual(['stake', 'vote', 'stakeAuthority'])
    const w = ix(getWithdrawInstructionDataEncoder().encode({ args: 5n }) as Uint8Array, [acct(STAKE, false, true), acct(AUTH, false, true), acct(AUTH, true), acct(CUSTODIAN, true)])
    expect(names(w)).toEqual(['stake', 'recipient', 'withdrawAuthority', 'lockupAuthority'])
    expect(w.args).toEqual({ lamports: 5n })
    expect(names(ix(tag(5), [acct(STAKE, false, true), acct(AUTH, true)]))).toEqual(['stake', 'stakeAuthority'])
    expect(names(ix(tag(7), [acct(STAKE, false, true), acct(STAKE_2, false, true), acct(AUTH, true)]))).toEqual(['destinationStake', 'sourceStake', 'stakeAuthority'])
  })

  it('MoveStake and MoveLamports: lamports, source and destination', () => {
    const accounts = [acct(STAKE, false, true), acct(STAKE_2, false, true), acct(AUTH, true)]
    const move = ix(getMoveStakeInstructionDataEncoder().encode({ args: 2_000_000_000n }) as Uint8Array, accounts)
    expect(move).toMatchObject({ name: 'MoveStake', args: { lamports: 2_000_000_000n } })
    expect(names(move)).toEqual(['sourceStake', 'destinationStake', 'stakeAuthority'])
    expect(ix(getMoveLamportsInstructionDataEncoder().encode({ args: 7n }) as Uint8Array, accounts)).toMatchObject({ name: 'MoveLamports', args: { lamports: 7n } })
    // The program numbers them 16 and 17 (Redelegate keeps 15); the client's enum counts 15 and 16.
    expect(move.data).toBe('EAAAAACUNXcAAAAA')
    expect(ix(tag(16, getU64Encoder().encode(1n) as Uint8Array), accounts).name).toBe('MoveStake')
    expect(ix(tag(17, getU64Encoder().encode(1n) as Uint8Array), accounts).name).toBe('MoveLamports')
  })
})

describe('Stake program: lockup, deprecated and malformed data', () => {
  it('SetLockup naming a custodian is a sets-authority fact; one changing only the epoch is not', () => {
    const withCustodian = ix(getSetLockupInstructionDataEncoder().encode({ unixTimestamp: null, epoch: 900n, custodian: CUSTODIAN as never }) as Uint8Array, [acct(STAKE, false, true), acct(AUTH, true)])
    expect(withCustodian.args).toEqual({ unixTimestamp: null, epoch: 900n, custodian: CUSTODIAN })
    expect(names(withCustodian)).toEqual(['stake', 'authority'])
    expect(authorityFacts(withCustodian)[0]!.message).toBe(`Sets the lockup custodian of stake account ${STAKE} to ${CUSTODIAN}.`)
    const epochOnly = ix(getSetLockupInstructionDataEncoder().encode({ unixTimestamp: null, epoch: 900n, custodian: null }) as Uint8Array, [acct(STAKE, false, true), acct(AUTH, true)])
    expect(authorityFacts(epochOnly)).toEqual([])
  })

  it('SetLockupChecked takes the new custodian from its third account', () => {
    const data = getSetLockupCheckedInstructionDataEncoder().encode({ unixTimestamp: 1_800_000_000n, epoch: null }) as Uint8Array
    const d = ix(data, [acct(STAKE, false, true), acct(AUTH, true), acct(CUSTODIAN, true)])
    expect(d.args).toEqual({ unixTimestamp: 1_800_000_000n, epoch: null, custodian: CUSTODIAN })
    expect(names(d)).toEqual(['stake', 'authority', 'newLockupAuthority'])
    expect(authorityFacts(d)).toHaveLength(1)
    const noCustodian = ix(data, [acct(STAKE, false, true), acct(AUTH, true)])
    expect(noCustodian.args.custodian).toBeNull()
    expect(authorityFacts(noCustodian)).toEqual([])
  })

  it('Initialize carries the authorities and the full lockup', () => {
    const data = tag(0, getAddressEncoder().encode(AUTH as never) as Uint8Array, getAddressEncoder().encode(NEW_AUTH as never) as Uint8Array, getU64Encoder().encode(1n) as Uint8Array, getU64Encoder().encode(2n) as Uint8Array, getAddressEncoder().encode(CUSTODIAN as never) as Uint8Array)
    expect(ix(data, [acct(STAKE, false, true)]).args).toEqual({ authorized: { staker: AUTH, withdrawer: NEW_AUTH }, lockup: { unixTimestamp: 1n, epoch: 2n, custodian: CUSTODIAN } })
  })

  it('Redelegate (tag 15, disabled) is named, not left undecoded', () => {
    const d = ix(tag(15), [acct(STAKE, false, true), acct(STAKE_2, false, true), acct(NEW_AUTH), acct(STAKE_CONFIG), acct(AUTH, true)])
    expect(d).toMatchObject({ decoded: true, name: 'Redelegate' })
    expect(d.args.deprecated).toMatch(/disabled/)
    expect(names(d)).toEqual(['stake', 'uninitializedStake', 'vote', null, null])
  })

  it('an unknown tag is undecoded; truncated data is undecoded with the error; trailing bytes are ignored like the program does', () => {
    expect(ix(tag(18), [])).toMatchObject({ decoded: false, name: null })
    expect(ix(new Uint8Array([3, 0]), [])).toMatchObject({ decoded: false })
    const truncated = ix(tag(3, new Uint8Array([1, 2])), [acct(STAKE, false, true), acct(STAKE_2, false, true), acct(AUTH, true)])
    expect(truncated.decoded).toBe(false)
    expect(truncated.error).toMatch(/expected 8 bytes/)
    // bincode::deserialize (the program's reader) allows trailing bytes.
    expect(ix(tag(5, new Uint8Array([9, 9])), [acct(STAKE, false, true), acct(AUTH, true)])).toMatchObject({ decoded: true, name: 'Deactivate' })
  })
})
