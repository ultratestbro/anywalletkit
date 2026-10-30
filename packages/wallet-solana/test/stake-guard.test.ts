import { describe, expect, it } from 'vitest'
import { AccountRole, getAddressEncoder, type Address, type Instruction } from '@solana/kit'
import { UnsafeTransactionError, WalletAccountReadOnlySolana, describeTransaction } from '../src/index.js'

// Native-staking audit 2026-10-26, finding 1 (HIGH): the default guard never looked at the Stake
// program. A dApp could have the wallet sign Authorize(withdrawer → attacker), Withdraw(→ attacker),
// SetLockup(custodian = attacker) on its stake accounts, or fund a new stake account and
// Initialize it for the attacker — while the token SetAuthority of the same shape was refused.
// Finding 3: the module's own way to take back a seed slot someone pre-funded (AllocateWithSeed)
// was refused, so 0.03 SOL of dust could block staking for good.

const WALLET = 'HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk' as Address
const ATTACKER = 'Hh8QwFUA6MtVu1qAoq12ucvFHNwCcVTV7hpWjeY1Hztb' as Address
const STAKE0 = 'Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS' as Address
const SLOT = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin' as Address
const VOTE = 'DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy' as Address
const STAKE = 'Stake11111111111111111111111111111111111111' as Address
const SYSTEM = '11111111111111111111111111111111' as Address
const CLOCK = 'SysvarC1ock11111111111111111111111111111111' as Address
const RENT = 'SysvarRent111111111111111111111111111111111' as Address
const HISTORY = 'SysvarStakeHistory1111111111111111111111111' as Address

const enc = getAddressEncoder()
const key = (a: Address) => new Uint8Array(enc.encode(a))
const u32 = (v: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b }
const u64 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b }
const str = (s: string) => { const b = new TextEncoder().encode(s); return cat(u64(BigInt(b.length)), b) }
const cat = (...p: Uint8Array[]) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length } return o }
const W = AccountRole.WRITABLE, R = AccountRole.READONLY, WS = AccountRole.WRITABLE_SIGNER, RS = AccountRole.READONLY_SIGNER
const ix = (programAddress: Address, accounts: Array<[Address, AccountRole]>, data: Uint8Array): Instruction => ({ programAddress, accounts: accounts.map(([address, role]) => ({ address, role })), data })

const authorize = (to: Address, kind: 0 | 1) => ix(STAKE, [[STAKE0, W], [CLOCK, R], [WALLET, RS]], cat(u32(1), key(to), u32(kind)))
const authorizeChecked = (to: Address) => ix(STAKE, [[STAKE0, W], [CLOCK, R], [WALLET, RS], [to, RS]], cat(u32(10), u32(1)))
const authorizeWithSeed = (to: Address) => ix(STAKE, [[STAKE0, W], [WALLET, RS], [CLOCK, R]], cat(u32(8), key(to), u32(1), str('seed'), key(SYSTEM)))
const withdraw = (to: Address) => ix(STAKE, [[STAKE0, W], [to, W], [CLOCK, R], [HISTORY, R], [WALLET, RS]], cat(u32(4), u64(5_000_000_000n)))
const setLockup = (custodian: Address | null, ts: bigint | null) => ix(STAKE, [[STAKE0, W], [WALLET, RS]], cat(u32(6),
  ts === null ? new Uint8Array([0]) : cat(new Uint8Array([1]), u64(ts)), new Uint8Array([0]), custodian === null ? new Uint8Array([0]) : cat(new Uint8Array([1]), key(custodian))))
const initialize = (account: Address, staker: Address, withdrawer: Address) => ix(STAKE, [[account, W], [RENT, R]], cat(u32(0), key(staker), key(withdrawer), u64(0n), u64(0n), key(SYSTEM)))
const createWithSeed = (account: Address, lamports: bigint) => ix(SYSTEM, [[WALLET, WS], [account, W]], cat(u32(3), key(WALLET), str('stake:9'), u64(lamports), u64(200n), key(STAKE)))
const allocateWithSeed = (account: Address, owner = STAKE, space = 200n) => ix(SYSTEM, [[account, W], [WALLET, RS]], cat(u32(9), key(WALLET), str('stake:3'), u64(space), key(owner)))
const transfer = (to: Address, lamports: bigint) => ix(SYSTEM, [[WALLET, WS], [to, W]], cat(u32(2), u64(lamports)))
const split = (to: Address) => ix(STAKE, [[STAKE0, W], [to, W], [WALLET, RS]], cat(u32(3), u64(1_000_000_000n)))
const delegate = (account: Address) => ix(STAKE, [[account, W], [VOTE, R], [CLOCK, R], [HISTORY, R], ['StakeConfig11111111111111111111111111111111' as Address, R], [WALLET, RS]], u32(2))
const deactivate = ix(STAKE, [[STAKE0, W], [CLOCK, R], [WALLET, RS]], u32(5))
const merge = ix(STAKE, [[STAKE0, W], [SLOT, W], [CLOCK, R], [HISTORY, R], [WALLET, RS]], u32(7))

interface Guarded { enforce(d: unknown): void }
const account = (config = {}) => new WalletAccountReadOnlySolana(WALLET, config) as unknown as Guarded
const check = (instructions: Instruction[], config = {}) => account(config).enforce(describeTransaction({ version: 0, instructions } as never, { account: WALLET }))
const refused = (instructions: Instruction[]) => { try { check(instructions); return 'signed' } catch (e) { return e instanceof UnsafeTransactionError ? e.code : String(e) } }

describe('the Solana guard reads Stake-program instructions', () => {
  it('refuses handing a stake account to someone else: Authorize / AuthorizeChecked / AuthorizeWithSeed to another key', () => {
    expect(refused([authorize(ATTACKER, 1)])).toBe('sets-authority')
    expect(refused([authorize(ATTACKER, 0)])).toBe('sets-authority')
    expect(refused([authorizeChecked(ATTACKER)])).toBe('sets-authority')
    expect(refused([authorizeWithSeed(ATTACKER)])).toBe('sets-authority')
    expect(refused([authorize(WALLET, 1)])).toBe('signed')
  })

  it('refuses a Withdraw to anyone but the wallet', () => {
    expect(refused([withdraw(ATTACKER)])).toBe('moves-lamports')
    expect(refused([withdraw(WALLET)])).toBe('signed')
  })

  it('refuses a SetLockup that names a foreign custodian or locks the account', () => {
    expect(refused([setLockup(ATTACKER, null)])).toBe('sets-authority')
    expect(refused([setLockup(null, 7_258_118_400n)])).toBe('sets-authority')
    expect(refused([setLockup(null, 0n)])).toBe('signed')
  })

  it('refuses funding a stake account that is initialized for someone else (or not at all)', () => {
    expect(refused([createWithSeed(SLOT, 100_000_000_000n), initialize(SLOT, ATTACKER, ATTACKER)])).toBe('sets-authority')
    expect(refused([createWithSeed(SLOT, 100_000_000_000n), initialize(SLOT, WALLET, ATTACKER)])).toBe('sets-authority')
    // created and left uninitialized: anyone may Initialize it afterwards
    expect(refused([createWithSeed(SLOT, 100_000_000_000n)])).toBe('sets-authority')
    expect(refused([createWithSeed(SLOT, 2_282_880n), initialize(SLOT, WALLET, WALLET), delegate(SLOT)])).toBe('signed')
  })

  it('takes back a pre-funded seed slot (AllocateWithSeed) only for a stake account the wallet initializes or splits into', () => {
    expect(refused([transfer(SLOT, 1_000_000n), allocateWithSeed(SLOT), initialize(SLOT, WALLET, WALLET), delegate(SLOT)])).toBe('signed')
    expect(refused([allocateWithSeed(SLOT), split(SLOT)])).toBe('signed')
    expect(refused([allocateWithSeed(SLOT), initialize(SLOT, ATTACKER, ATTACKER)])).toBe('core-instruction')
    expect(refused([allocateWithSeed(SLOT)])).toBe('core-instruction')
    expect(refused([allocateWithSeed(SLOT, ATTACKER), initialize(SLOT, WALLET, WALLET)])).toBe('core-instruction')
    expect(refused([allocateWithSeed(SLOT, STAKE, 10_000n), initialize(SLOT, WALLET, WALLET)])).toBe('core-instruction')
  })

  it('the staking module\'s own instructions still sign', () => {
    expect(refused([split(SLOT), deactivate, merge, delegate(STAKE0), withdraw(WALLET)])).toBe('signed')
    expect(refused([createWithSeed(SLOT, 2_282_880n), split(SLOT)])).toBe('signed')
  })

  it('an undecodable Stake instruction on the wallet is refused; allowAuthorityChanges lets everything through', () => {
    expect(refused([ix(STAKE, [[STAKE0, W], [WALLET, RS]], new Uint8Array([99, 0, 0, 0]))])).toBe('core-instruction')
    expect(() => check([authorize(ATTACKER, 1), withdraw(ATTACKER)], { allowAuthorityChanges: true })).not.toThrow()
  })

  it('describeTransaction names the Stake instruction and what it sets', () => {
    const d = describeTransaction({ version: 0, instructions: [authorize(ATTACKER, 1), withdraw(ATTACKER)] } as never, { account: WALLET })
    expect(d.items[0]).toMatchObject({ type: 'program-call', instruction: 'Authorize', stake: { name: 'Authorize', newAuthority: ATTACKER, authorityType: 'withdrawer' } })
    expect(d.items[1]).toMatchObject({ instruction: 'Withdraw', stake: { name: 'Withdraw', lamports: 5_000_000_000n } })
  })

  it('an SPL Stake Pool WithdrawStake into the funded slot that names this wallet as user stake authority signs (scan 2026-10-30 follow-up)', () => {
    const POOL_PROGRAM = 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy' as Address
    const TOKEN = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' as Address
    const withdrawStake = (to: Address, authority: Address, { program = POOL_PROGRAM, data = cat(new Uint8Array([24]), u64(1_000_000_000n), u64(1n)) } = {}) =>
      ix(program, [[ATTACKER, W], [VOTE, W], [ATTACKER, R], [STAKE0, W], [to, W], [authority, R], [WALLET, RS], [VOTE, W], [VOTE, W], [VOTE, W], [CLOCK, R], [TOKEN, R], [STAKE, R]], data)
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(SLOT, WALLET), deactivate])).toBe('signed')
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(SLOT, WALLET, { data: cat(new Uint8Array([10]), u64(1n)) })])).toBe('signed')
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(SLOT, ATTACKER)])).toBe('sets-authority')
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(STAKE0, WALLET)])).toBe('sets-authority')
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(SLOT, WALLET, { program: ATTACKER })])).toBe('sets-authority')
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(SLOT, WALLET, { data: new Uint8Array([9]) })])).toBe('sets-authority')
    expect(refused([createWithSeed(SLOT, 2_282_880n), withdrawStake(SLOT, WALLET, { data: cat(new Uint8Array([24]), u64(1n)) })])).toBe('sets-authority')
    const d = describeTransaction({ version: 0, instructions: [withdrawStake(SLOT, WALLET)] } as never, { account: WALLET })
    expect(d.items[0]).toMatchObject({ type: 'program-call', program: POOL_PROGRAM, instruction: 'WithdrawStakeWithSlippage' })
  })

  describe('review round: the wallet\'s position in the instruction does not decide', () => {
    it('the current account layout (no sysvars) and the wallet at another index are judged too', () => {
      // Authorize [stake, authority]; Withdraw [stake, recipient, authority]; AuthorizeChecked [stake, old, new]
      expect(refused([ix(STAKE, [[STAKE0, W], [WALLET, RS]], cat(u32(1), key(ATTACKER), u32(1)))])).toBe('sets-authority')
      expect(refused([ix(STAKE, [[STAKE0, W], [CLOCK, R], [VOTE, R], [WALLET, RS]], cat(u32(1), key(ATTACKER), u32(1)))])).toBe('sets-authority')
      expect(refused([ix(STAKE, [[STAKE0, W], [ATTACKER, W], [WALLET, RS]], cat(u32(4), u64(5_000_000_000n)))])).toBe('moves-lamports')
      expect(refused([ix(STAKE, [[STAKE0, W], [WALLET, RS], [ATTACKER, RS]], cat(u32(10), u32(1)))])).toBe('sets-authority')
      expect(refused([ix(STAKE, [[STAKE0, W], [VOTE, R], [WALLET, RS]], cat(u32(6), new Uint8Array([1]), u64(7_258_118_400n), new Uint8Array([0]), new Uint8Array([0])))])).toBe('sets-authority')
      expect(refused([ix(STAKE, [[STAKE0, W], [WALLET, RS], [ATTACKER, RS]], cat(u32(12), new Uint8Array([0]), new Uint8Array([0])))])).toBe('sets-authority')
      // to the wallet itself, in either layout: signed
      expect(refused([ix(STAKE, [[STAKE0, W], [WALLET, RS]], cat(u32(1), key(WALLET), u32(1)))])).toBe('signed')
      expect(refused([ix(STAKE, [[STAKE0, W], [WALLET, W], [WALLET, RS]], cat(u32(4), u64(1n)))])).toBe('signed')
    })

    it('InitializeChecked in the current layout makes the wallet staker and withdrawer', () => {
      const checked = (staker: Address, withdrawer: Address) => ix(STAKE, [[SLOT, W], [staker, R], [withdrawer, RS]], u32(9))
      expect(refused([createWithSeed(SLOT, 2_282_880n), checked(WALLET, WALLET)])).toBe('signed')
      expect(refused([createWithSeed(SLOT, 2_282_880n), checked(ATTACKER, WALLET)])).toBe('sets-authority')
      const legacy = ix(STAKE, [[SLOT, W], [RENT, R], [WALLET, R], [WALLET, RS]], u32(9))
      expect(refused([createWithSeed(SLOT, 2_282_880n), legacy])).toBe('signed')
    })

    it('a split destination is the wallet\'s only up to its rent: real money into it is refused', () => {
      expect(refused([createWithSeed(SLOT, 2_282_880n), split(SLOT)])).toBe('signed')
      expect(refused([createWithSeed(SLOT, 100_000_000_000n), split(SLOT)])).toBe('sets-authority')
      expect(refused([transfer(SLOT, 100_000_000_000n), allocateWithSeed(SLOT), split(SLOT)])).toBe('core-instruction')
    })
  })
})
