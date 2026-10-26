import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { NativeStakingProtocolSolana, type NativeStakingConfig } from '../src/index.js'
import { createWithSeed } from '../src/address.js'
import { STAKE_PROGRAM, SYSTEM_PROGRAM, SYSVAR_CLOCK, SYSVAR_RENT, SYSVAR_STAKE_HISTORY, STAKE_CONFIG } from '../src/constants.js'
import type { Instruction } from '../src/codec.js'
import { CHAIN, EPOCH, FakeNode, OTHER, OUTSIDER, RENT, SOL, V1, V2, V3, WALLET } from './fake-node.js'

function setup(config: Partial<NativeStakingConfig> = {}, node = new FakeNode()) {
  const account = createMockAccount({ chain: CHAIN, address: WALLET, balance: node.balance, fee: 5000n })
  ;(account as { getBalance: () => Promise<bigint> }).getBalance = async () => node.balance
  const p = new NativeStakingProtocolSolana(account, { validators: [{ voteAccount: V1, name: 'Cats' }, V2, V3], provider: node, ...config } as NativeStakingConfig)
  const sentIxs = (i = 0) => (account.sent[i] as { version: number; instructions: Instruction[] }).instructions
  return { p, node, account, sentIxs }
}
const tag = (ix: Instruction) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getUint32(0, true)
const u64At = (ix: Instruction, at: number) => new DataView(ix.data.buffer, ix.data.byteOffset, ix.data.byteLength).getBigUint64(at, true)
const slot = (i: number, prefix = 'stake:') => createWithSeed(WALLET, `${prefix}${i}`, STAKE_PROGRAM)

describe('config: fail-closed', () => {
  const account = createMockAccount({ chain: CHAIN, address: WALLET })
  it('refuses to construct without validators', () => {
    expect(() => new NativeStakingProtocolSolana(account, {} as NativeStakingConfig)).toThrow(/needs `validators`/)
    expect(() => new NativeStakingProtocolSolana(account, { validators: [] })).toThrow(/needs `validators`/)
  })
  it('refuses a malformed vote account, an unlisted default, a bad commission cap, a seed that cannot fit', () => {
    expect(() => new NativeStakingProtocolSolana(account, { validators: ['not-an-address'] })).toThrow(/not a vote account/)
    expect(() => new NativeStakingProtocolSolana(account, { validators: [V1], defaultValidator: V2 })).toThrow(/must be one of/)
    expect(() => new NativeStakingProtocolSolana(account, { validators: [V1], maxCommission: 101 })).toThrow(/maxCommission/)
    expect(() => new NativeStakingProtocolSolana(account, { validators: [V1], seedPrefix: 'x'.repeat(31) })).toThrow(/seedPrefix is too long/)
    expect(() => new NativeStakingProtocolSolana(account, { validators: [V1], maxAccounts: 101 })).toThrow(/maxAccounts/)
  })
  it("'any' is an explicit choice, and dedupes a repeated list entry", () => {
    expect(new NativeStakingProtocolSolana(account, { validators: 'any' }).validators).toBe('any')
    expect(new NativeStakingProtocolSolana(account, { validators: [V1, { voteAccount: V1, name: 'x' }] }).validators).toEqual([{ voteAccount: V1 }])
  })
})

describe('stake', () => {
  it('one transaction: CreateAccountWithSeed (amount + rent) → Initialize (wallet/wallet, no lockup) → DelegateStake', async () => {
    const { p, sentIxs } = setup()
    const r = await p.stake({ amount: 2n * SOL })
    expect(r.stakeAccount).toBe(slot(0))
    expect(r.seed).toBe('stake:0')
    expect(r.total).toBe(2n * SOL + RENT)
    expect(r.validator.voteAccount).toBe(V1) // first eligible of the list
    expect(r.readyEpoch).toBe(EPOCH + 1n)
    const [create, init, delegate] = sentIxs()
    expect(create!.programAddress).toBe(SYSTEM_PROGRAM)
    expect(tag(create!)).toBe(3)
    expect(create!.accounts.map((a) => [a.address, a.role])).toEqual([[WALLET, 3], [slot(0), 1]])
    expect(init!.programAddress).toBe(STAKE_PROGRAM)
    expect(tag(init!)).toBe(0)
    expect(init!.accounts.map((a) => a.address)).toEqual([slot(0), SYSVAR_RENT])
    expect(init!.data.length).toBe(4 + 32 + 32 + 8 + 8 + 32)
    expect(tag(delegate!)).toBe(2)
    expect(delegate!.accounts.map((a) => [a.address, a.role])).toEqual([[slot(0), 1], [V1, 0], [SYSVAR_CLOCK, 0], [SYSVAR_STAKE_HISTORY, 0], [STAKE_CONFIG, 0], [WALLET, 2]])
  })

  it('uses the next free seed slot', async () => {
    const node = new FakeNode()
    node.seedAccount(0, { stake: 3n * SOL })
    const { p } = setup({}, node)
    expect((await p.quoteStake({ amount: SOL })).stakeAccount).toBe(slot(1))
  })

  it('refuses a validator outside the list, delinquent, or above the commission cap — before anything is sent', async () => {
    const node = new FakeNode()
    node.votes.find((v) => v.votePubkey === V2)!.delinquent = true
    const { p, account } = setup({ maxCommission: 7 }, node)
    await expect(p.stake({ amount: SOL, validator: OUTSIDER })).rejects.toThrow(/not-listed/)
    await expect(p.stake({ amount: SOL, validator: V2 })).rejects.toThrow(/delinquent/)
    await expect(p.stake({ amount: SOL, validator: V3 })).rejects.toThrow(/commission 10 % > 7 %/)
    expect(account.sent).toHaveLength(0)
  })

  it('skips ineligible validators when choosing the default, and says so when none is left', async () => {
    const node = new FakeNode()
    node.votes.find((v) => v.votePubkey === V1)!.delinquent = true
    const { p } = setup({}, node)
    expect((await p.quoteStake({ amount: SOL })).validator.voteAccount).toBe(V2)
    for (const v of node.votes) v.delinquent = true
    await expect(p.quoteStake({ amount: SOL })).rejects.toThrow(/None of the configured validators/)
  })

  it('refuses below the minimum delegation and when the wallet cannot keep its fee reserve', async () => {
    const node = new FakeNode()
    node.balance = SOL + RENT + 1_000_000n
    const { p } = setup({}, node)
    await expect(p.quoteStake({ amount: SOL - 1n })).rejects.toThrow(/minimum delegation/)
    await expect(p.quoteStake({ amount: SOL })).rejects.toThrow(/kept for fees/)
    const relaxed = setup({ feeReserve: 0n }, node).p
    expect((await relaxed.quoteStake({ amount: SOL })).total).toBe(SOL + RENT)
    expect(await p.getMaxStakeable()).toBe(0n)
    node.balance = 5n * SOL
    expect(await p.getMaxStakeable()).toBe(5n * SOL - RENT - 5_000_000n)
  })

  it("'any' mode needs an explicit validator and accepts any voting one", async () => {
    const { p } = setup({ validators: 'any' })
    await expect(p.quoteStake({ amount: SOL })).rejects.toThrow(/no default/)
    expect((await p.quoteStake({ amount: SOL, validator: OUTSIDER })).validator.voteAccount).toBe(OUTSIDER)
  })

  it('all seed slots used → refused', async () => {
    const node = new FakeNode()
    for (let i = 0; i < 3; i++) node.seedAccount(i, {})
    const { p } = setup({ maxAccounts: 3 }, node)
    await expect(p.quoteStake({ amount: SOL })).rejects.toThrow(/All 3 stake account slots/)
  })

  it('explicit compute budget goes first when configured', async () => {
    const { p, sentIxs } = setup({ computeUnitLimit: 20_000, computeUnitPrice: 1000n })
    await p.stake({ amount: SOL })
    expect(sentIxs().slice(0, 2).map((ix) => ix.programAddress)).toEqual(['ComputeBudget111111111111111111111111111111', 'ComputeBudget111111111111111111111111111111'])
  })
})

describe('positions', () => {
  it('statuses from StakeHistory: activating, active, deactivating, inactive; withdrawable and readiness', async () => {
    const node = new FakeNode()
    const activating = node.seedAccount(0, { activationEpoch: EPOCH, stake: 2n * SOL })
    const active = node.seedAccount(1, { activationEpoch: EPOCH - 5n, stake: 3n * SOL })
    const cooling = node.seedAccount(2, { activationEpoch: EPOCH - 5n, deactivationEpoch: EPOCH, stake: 4n * SOL })
    const done = node.seedAccount(3, { activationEpoch: EPOCH - 9n, deactivationEpoch: EPOCH - 2n, stake: 5n * SOL })
    const idle = node.seedAccount(5, { initializedOnly: true }, 2n * SOL)
    const { p } = setup({}, node)
    const list = await p.getStakeAccounts()
    const by = Object.fromEntries(list.map((a) => [a.address, a]))
    expect(by[activating]).toMatchObject({ status: 'activating', effective: 0n, activating: 2n * SOL, readyEpoch: EPOCH + 1n, seedIndex: 0, validatorName: 'Cats' })
    expect(by[active]).toMatchObject({ status: 'active', effective: 3n * SOL, delegated: 3n * SOL, readyEpoch: null, withdrawable: 0n })
    expect(by[cooling]).toMatchObject({ status: 'deactivating', deactivating: 4n * SOL, readyEpoch: EPOCH + 1n })
    expect(by[done]).toMatchObject({ status: 'inactive', delegated: 0n, withdrawable: 5n * SOL + RENT, canWithdraw: true })
    expect(by[idle]).toMatchObject({ kind: 'initialized', status: 'inactive', withdrawable: 2n * SOL })
    expect(by[cooling]!.readyAt).toBeGreaterThan(Date.now())

    const balance = await p.getStakedBalance()
    expect(balance).toMatchObject({ balance: 2n * SOL + 3n * SOL, wrappedBalance: 0n, rate: 0n, activating: 2n * SOL, deactivating: 4n * SOL, claimable: 5n * SOL + RENT + 2n * SOL })
    expect(balance.total).toBe([2n, 3n, 4n, 5n].reduce((s, n) => s + n * SOL + RENT, 0n) + 2n * SOL)

    const q = await p.getWithdrawalRequests()
    expect(q.requests.map((r) => [r.address, r.claimable])).toEqual([[cooling, false], [done, true], [idle, true]])
    expect(q.pendingAmount).toBe(4n * SOL + RENT)
    expect(q.claimableAmount).toBe(5n * SOL + RENT + 2n * SOL)
  })

  it('an account whose withdraw authority is someone else is shown but not claimable; a lockup in force blocks withdrawal', async () => {
    const node = new FakeNode()
    node.seedAccount(0, { withdrawer: OTHER, activationEpoch: 1n, deactivationEpoch: 2n })
    node.seedAccount(1, { activationEpoch: 1n, deactivationEpoch: 2n, lockup: { unixTimestamp: 0n, epoch: EPOCH + 10n, custodian: OTHER } })
    const { p } = setup({}, node)
    const list = await p.getStakeAccounts()
    expect(list.map((a) => a.canWithdraw)).toEqual([false, false])
    expect(list[1]!.lockup?.epoch).toBe(EPOCH + 10n)
    await expect(p.quoteClaimWithdrawals()).rejects.toThrow(/Nothing is claimable/)
  })

  it('discover: also lists accounts other wallets made for this address (by staker and by withdrawer)', async () => {
    const node = new FakeNode()
    node.accounts.set(OUTSIDER, { lamports: 3n * SOL, owner: STAKE_PROGRAM, data: (await import('./fake-node.js')).encodeStakeAccount({ stake: 3n * SOL - RENT }) })
    const plain = setup({}, node).p
    expect(await plain.getStakeAccounts()).toHaveLength(0)
    const found = await setup({ discover: true }, node).p.getStakeAccounts()
    expect(found.map((a) => [a.address, a.seed])).toEqual([[OUTSIDER, null]])
    expect(node.calls.filter((c) => c.method === 'getProgramAccounts').map((c) => (c.params[1] as { filters: Array<{ memcmp?: { offset: number } }> }).filters[1]!.memcmp!.offset)).toEqual([12, 44])
  })

  it('something else parked on a seed address is ignored, and the slot counts as used', async () => {
    const node = new FakeNode()
    node.accounts.set(slot(0), { lamports: 1n, owner: SYSTEM_PROGRAM, data: new Uint8Array() })
    const { p } = setup({}, node)
    expect(await p.getStakeAccounts()).toHaveLength(0)
    expect((await p.quoteStake({ amount: SOL })).stakeAccount).toBe(slot(1))
  })
})

describe('unstake', () => {
  function staked() {
    const node = new FakeNode()
    const a = node.seedAccount(0, { stake: 5n * SOL })
    const b = node.seedAccount(1, { stake: 3n * SOL, voter: V2 })
    const c = node.seedAccount(2, { stake: 2n * SOL })
    return { node, a, b, c }
  }

  it('an exact account match deactivates just that account', async () => {
    const { node, b } = staked()
    const { p, sentIxs } = setup({}, node)
    const r = await p.requestWithdrawal({ amount: 3n * SOL })
    expect(r.steps).toEqual([{ kind: 'deactivate', account: b, amount: 3n * SOL }])
    expect(r.approveHash).toBeNull()
    expect(sentIxs().map(tag)).toEqual([5])
    expect(sentIxs()[0]!.accounts.map((x) => x.address)).toEqual([b, SYSVAR_CLOCK, WALLET])
    expect(r.readyEpoch).toBe(EPOCH + 1n)
  })

  it('whole accounts first (largest that fit), then the rest split off one account into a free slot and deactivated', async () => {
    const { node, a, b } = staked()
    const { p, sentIxs } = setup({}, node)
    const r = await p.requestWithdrawal({ amount: 6n * SOL + SOL / 2n })
    expect(r.steps).toEqual([
      { kind: 'deactivate', account: a, amount: 5n * SOL },
      { kind: 'split', account: b, amount: SOL + SOL / 2n, splitInto: slot(3) },
    ])
    const ixs = sentIxs()
    expect(ixs.map((ix) => [ix.programAddress === STAKE_PROGRAM ? 'stake' : 'system', tag(ix)])).toEqual([['stake', 5], ['system', 3], ['stake', 3], ['stake', 5]])
    expect(u64At(ixs[2]!, 4)).toBe(SOL + SOL / 2n) // Split lamports
    expect(ixs[2]!.accounts.map((x) => x.address)).toEqual([b, slot(3), WALLET])
    expect(ixs[3]!.accounts[0]!.address).toBe(slot(3))
  })

  it('refuses a split below the minimum delegation, or that would leave less than it behind', async () => {
    const { node } = staked()
    const { p, account } = setup({}, node)
    await expect(p.requestWithdrawal({ amount: SOL + SOL / 2n, account: (await p.getStakeAccounts())[2]!.address })).rejects.toThrow(/minimum delegation/)
    await expect(p.requestWithdrawal({ amount: SOL / 2n })).rejects.toThrow(/minimum delegation/)
    await expect(p.requestWithdrawal({ amount: 11n * SOL })).rejects.toThrow(/Only 10 SOL is delegated/)
    expect(account.sent).toHaveLength(0)
  })

  it('filters by validator; refuses an account that is already cooling down or not the wallet’s', async () => {
    const node = new FakeNode()
    const cooling = node.seedAccount(0, { stake: 2n * SOL, deactivationEpoch: EPOCH })
    node.seedAccount(1, { stake: 2n * SOL, voter: V2 })
    const { p } = setup({}, node)
    expect((await p.quoteRequestWithdrawal({ amount: 2n * SOL, validator: V2 })).steps[0]!.kind).toBe('deactivate')
    await expect(p.quoteRequestWithdrawal({ amount: 2n * SOL, validator: V1 })).rejects.toThrow(/no delegated stake/)
    await expect(p.quoteRequestWithdrawal({ amount: 2n * SOL, account: cooling })).rejects.toThrow(/already deactivating/)
    await expect(p.quoteRequestWithdrawal({ amount: 2n * SOL, account: OUTSIDER })).rejects.toThrow(/not one of this wallet/)
  })

  it('unstaking an account that is still activating is immediate (claimable this epoch)', async () => {
    const node = new FakeNode()
    node.seedAccount(0, { stake: 2n * SOL, activationEpoch: EPOCH })
    const { p } = setup({}, node)
    expect((await p.quoteRequestWithdrawal({ amount: 2n * SOL })).readyEpoch).toBe(EPOCH)
  })
})

describe('claim', () => {
  it('withdraws every lamport of fully inactive accounts, at most 10 per transaction', async () => {
    const node = new FakeNode()
    for (let i = 0; i < 12; i++) node.seedAccount(i, { activationEpoch: 1n, deactivationEpoch: 2n, stake: SOL })
    node.seedAccount(12, { stake: SOL }) // active
    const { p, sentIxs } = setup({}, node)
    const r = await p.claimWithdrawals()
    expect(r.accounts).toHaveLength(10)
    expect(r.remaining).toBe(2)
    expect(r.amount).toBe(10n * (SOL + RENT))
    const w = sentIxs()[0]!
    expect(tag(w)).toBe(4)
    expect(u64At(w, 4)).toBe(SOL + RENT)
    expect(w.accounts.map((x) => [x.address, x.role])).toEqual([[slot(0), 1], [WALLET, 1], [SYSVAR_CLOCK, 0], [SYSVAR_STAKE_HISTORY, 0], [WALLET, 2]])
  })

  it('by id or address; refuses one that is still cooling down, with the epoch it opens', async () => {
    const node = new FakeNode()
    const ready = node.seedAccount(0, { activationEpoch: 1n, deactivationEpoch: 2n })
    const cooling = node.seedAccount(1, { deactivationEpoch: EPOCH })
    const { p } = setup({}, node)
    const [a] = await p.getStakeAccounts()
    expect((await p.quoteClaimWithdrawals({ ids: [a!.id] })).accounts).toEqual([ready])
    expect((await p.quoteClaimWithdrawals({ accounts: [ready] })).accounts).toEqual([ready])
    await expect(p.quoteClaimWithdrawals({ accounts: [cooling] })).rejects.toThrow(new RegExp(`deactivating; claimable from epoch ${EPOCH + 1n}`))
    await expect(p.quoteClaimWithdrawals({ ids: [42n] })).rejects.toThrow(/not one of this wallet/)
  })
})

describe('delegate and merge', () => {
  it('delegates an inactive account; reactivates one deactivated this epoch; refuses an active one', async () => {
    const node = new FakeNode()
    const idle = node.seedAccount(0, { activationEpoch: 1n, deactivationEpoch: 2n, stake: 2n * SOL })
    const undo = node.seedAccount(1, { deactivationEpoch: EPOCH, voter: V2, stake: 2n * SOL })
    const active = node.seedAccount(2, { stake: 2n * SOL })
    const old = node.seedAccount(3, { deactivationEpoch: EPOCH - 1n, stake: 2n * SOL })
    node.history = node.history.map(([e, eff, act]) => [e, eff, act, e === EPOCH - 1n ? 400_000_000n * SOL : 1_000_000n * SOL]) // a big cool-down: `old` is still cooling
    const { p, sentIxs } = setup({}, node)
    expect(await p.delegate({ account: idle, validator: V3 })).toMatchObject({ mode: 'delegate', validator: V3 })
    expect(sentIxs(0)[0]!.accounts[1]!.address).toBe(V3)
    expect(await p.quoteDelegate({ account: undo })).toMatchObject({ mode: 'reactivate', validator: V2 })
    await expect(p.quoteDelegate({ account: undo, validator: V1 })).rejects.toThrow(/its own validator/)
    await expect(p.quoteDelegate({ account: active })).rejects.toThrow(/already delegated/)
    await expect(p.quoteDelegate({ account: old })).rejects.toThrow(/cooling down/)
    await expect(p.quoteDelegate({ account: idle, validator: OUTSIDER })).rejects.toThrow(/not-listed/)
  })

  it('merges compatible accounts and refuses the rest', async () => {
    const node = new FakeNode()
    const i1 = node.seedAccount(0, { activationEpoch: 1n, deactivationEpoch: 2n })
    const i2 = node.seedAccount(1, { activationEpoch: 1n, deactivationEpoch: 2n })
    const a1 = node.seedAccount(2, { stake: 2n * SOL })
    const a2 = node.seedAccount(3, { stake: 3n * SOL })
    const a3 = node.seedAccount(4, { stake: 3n * SOL, voter: V2 })
    const { p, sentIxs } = setup({}, node)
    await p.merge({ destination: i1, source: i2 })
    expect(tag(sentIxs(0)[0]!)).toBe(7)
    expect(sentIxs(0)[0]!.accounts.map((x) => x.address)).toEqual([i1, i2, SYSVAR_CLOCK, SYSVAR_STAKE_HISTORY, WALLET])
    expect((await p.quoteMerge({ destination: a1, source: a2 })).source).toBe(a2)
    await expect(p.quoteMerge({ destination: a1, source: a3 })).rejects.toThrow(/cannot be merged/)
    await expect(p.quoteMerge({ destination: a1, source: i1 })).rejects.toThrow(/cannot be merged/)
    await expect(p.quoteMerge({ destination: a1, source: a1 })).rejects.toThrow(/itself/)
  })
})

describe('validators, APR, rewards', () => {
  it('listValidators: configured order, live commission and stake, refusals, inflation APR after commission', async () => {
    const { p } = setup({ maxCommission: 7 })
    const list = await p.listValidators()
    expect(list.map((v) => [v.voteAccount, v.name, v.commission, v.eligible, v.refusals])).toEqual([
      [V1, 'Cats', 5, true, []], [V2, null, 0, true, []], [V3, null, 10, false, ['commission-above-max']],
    ])
    // 3.58 % of 620M SOL over 400M SOL staked = 5.549 %, then less commission.
    expect(list[1]!.apr).toBeCloseTo(5.549, 2)
    expect(list[0]!.apr).toBeCloseTo(5.549 * 0.95, 2)
    expect(list[0]!.aprSource).toBe('estimate')
    expect(list[0]!.epochCredits).toBe(1000n)
    expect(await p.getApr()).toBeCloseTo(5.549 * 0.95, 2)
  })

  it('enrich adds names and replaces the APR; a failing hook leaves the on-chain facts', async () => {
    const { p } = setup({ enrich: async (votes) => Object.fromEntries(votes.map((v) => [v, { apr: 7.1, name: `n-${v.slice(0, 3)}`, score: 9 }])) })
    const v2 = (await p.listValidators())[1]!
    expect(v2).toMatchObject({ apr: 7.1, aprSource: 'enrich', name: 'n-he1', extra: { score: 9 } })
    const broken = setup({ enrich: async () => { throw new Error('down') } }).p
    expect((await broken.getValidator(V2)).apr).toBeCloseTo(5.549, 2)
  })

  it("'any' lists the cluster by stake", async () => {
    const list = await setup({ validators: 'any' }).p.listValidators({ limit: 2 })
    expect(list.map((v) => v.voteAccount)).toEqual([OUTSIDER, V2])
  })

  it('getRewards: per epoch, in batches of 32 addresses; an epoch the node refuses is reported, not dropped', async () => {
    const node = new FakeNode()
    for (let i = 0; i < 34; i++) node.seedAccount(i, { stake: SOL })
    const { p } = setup({ maxAccounts: 40 }, node)
    node.rewards.set(slot(0), 1000n)
    node.rewards.set(slot(33), 500n)
    const r = await p.getRewards({ epochs: 2 })
    expect(r.total).toBe(3000n)
    expect(r.epochs[0]).toMatchObject({ epoch: EPOCH - 1n, amount: 1500n })
    expect(node.calls.filter((c) => c.method === 'getInflationReward').map((c) => (c.params[0] as string[]).length)).toEqual([32, 2, 32, 2])
    node.refuse.add('getInflationReward')
    expect((await p.getRewards({ epochs: 1 })).epochs[0]).toMatchObject({ epoch: EPOCH - 1n, error: expect.stringMatching(/not available/) })
  })

  it('caches the stake parameters and the history within an epoch', async () => {
    const node = new FakeNode()
    const { p } = setup({}, node)
    await p.getStakeAccounts()
    await p.getStakeAccounts()
    const count = (m: string) => node.calls.filter((c) => c.method === m).length
    expect(count('getStakeMinimumDelegation')).toBe(1)
    expect(node.calls.filter((c) => c.method === 'getAccountInfo').length).toBe(1)
    node.epoch += 1n
    node.history = [[EPOCH, 400_000_000n * SOL, 1_000_000n * SOL, 1_000_000n * SOL], ...node.history]
    await p.getStakeAccounts()
    expect(node.calls.filter((c) => c.method === 'getAccountInfo').length).toBe(2)
  })
})

describe('accounts and chains', () => {
  it('refuses a non-Solana account before any network call', async () => {
    const node = new FakeNode()
    const evm = createMockAccount()
    const p = new NativeStakingProtocolSolana(evm, { validators: [V1], provider: node })
    await expect(p.getStakeAccounts()).rejects.toThrow(/needs a Solana account/)
  })
  it('reads go to the account’s own RPC when no provider is given', async () => {
    const node = new FakeNode()
    const account = Object.assign(createMockAccount({ chain: CHAIN, address: WALLET }), { _rpc: node })
    const p = new NativeStakingProtocolSolana(account, { validators: [V1] })
    expect((await p.getEpochInfo()).epoch).toBe(EPOCH)
  })
  it('without any RPC, reads fail with a clear error', async () => {
    const p = new NativeStakingProtocolSolana(createMockAccount({ chain: CHAIN, address: WALLET }), { validators: [V1] })
    await expect(p.getEpochInfo()).rejects.toThrow(/needs a Solana RPC/)
  })
})

describe('review 2026-10-26 regressions', () => {
  it('discover: an account the wallet only manages is not its position and is never unstaked or split', async () => {
    const node = new FakeNode()
    node.seedAccount(0, { stake: 2n * SOL })
    const { encodeStakeAccount } = await import('./fake-node.js')
    node.accounts.set(OUTSIDER, { lamports: 10n * SOL + RENT, owner: STAKE_PROGRAM, data: encodeStakeAccount({ stake: 10n * SOL, withdrawer: OTHER }) })
    const { p, account } = setup({ discover: true }, node)
    const foreign = (await p.getStakeAccounts()).find((a) => a.address === OUTSIDER)!
    expect(foreign).toMatchObject({ owned: false, canManage: true })
    const b = await p.getStakedBalance()
    expect(b.balance).toBe(2n * SOL)
    expect(b.managedOnly).toBe(10n * SOL + RENT)
    // Greedy selection used to deactivate the 2 SOL and split 1 SOL off the foreign 10 SOL.
    await expect(p.quoteRequestWithdrawal({ amount: 3n * SOL })).rejects.toThrow(/Only 2 SOL is delegated/)
    await expect(p.quoteRequestWithdrawal({ amount: SOL, account: OUTSIDER })).rejects.toThrow(/not the wallet's to unstake/)
    await expect(p.quoteDelegate({ account: OUTSIDER })).rejects.toThrow(/not this wallet/)
    expect(account.sent).toHaveLength(0)
  })

  it('undoing an unstake re-checks the validator against the policy', async () => {
    const node = new FakeNode()
    const undo = node.seedAccount(0, { deactivationEpoch: EPOCH, voter: OUTSIDER, stake: 2n * SOL })
    const { p } = setup({}, node)
    await expect(p.quoteDelegate({ account: undo })).rejects.toThrow(/not-listed/)
    node.votes.find((v) => v.votePubkey === V1)!.delinquent = true
    const back = node.seedAccount(1, { deactivationEpoch: EPOCH, voter: V1, stake: 2n * SOL })
    await expect(p.quoteDelegate({ account: back })).rejects.toThrow(/delinquent/)
  })

  it('an activating account is moved only to a validator named in the call', async () => {
    const node = new FakeNode()
    const a = node.seedAccount(0, { activationEpoch: EPOCH, voter: V1, stake: 2n * SOL })
    const { p } = setup({}, node)
    await expect(p.quoteDelegate({ account: a })).rejects.toThrow(/pass `validator`/)
    expect((await p.quoteDelegate({ account: a, validator: V2 })).validator).toBe(V2)
  })

  it('a StakeHistory without the previous epoch is refused and not cached', async () => {
    const node = new FakeNode()
    node.seedAccount(0, { activationEpoch: 1n, deactivationEpoch: EPOCH - 1n, stake: 2n * SOL })
    const fresh = node.history
    node.history = fresh.filter(([e]) => e !== EPOCH - 1n) // a lagging node
    const { p } = setup({}, node)
    await expect(p.getStakeAccounts()).rejects.toThrow(/no entry for epoch 1067/)
    node.history = fresh
    expect((await p.getStakeAccounts())[0]!.status).toBe('inactive')
  })

  it('the planner finds splits the greedy one missed: [4, 2] → 4.5 and [3, 2.5] → 3.5', async () => {
    const node = new FakeNode()
    const four = node.seedAccount(0, { stake: 4n * SOL })
    const two = node.seedAccount(1, { stake: 2n * SOL })
    const r = await setup({}, node).p.quoteRequestWithdrawal({ amount: 4n * SOL + SOL / 2n })
    expect(r.steps.map((s) => [s.kind, s.account, s.amount])).toEqual([['deactivate', two, 2n * SOL], ['split', four, 2n * SOL + SOL / 2n]])
    const node2 = new FakeNode()
    const three = node2.seedAccount(0, { stake: 3n * SOL })
    node2.seedAccount(1, { stake: 2n * SOL + SOL / 2n })
    const r2 = await setup({}, node2).p.quoteRequestWithdrawal({ amount: 3n * SOL + SOL / 2n })
    expect(r2.steps.find((s) => s.kind === 'split')).toMatchObject({ account: three, amount: SOL })
  })

  it('claiming more than 10 ids takes the first 10 and reports the rest', async () => {
    const node = new FakeNode()
    for (let i = 0; i < 12; i++) node.seedAccount(i, { activationEpoch: 1n, deactivationEpoch: 2n, stake: SOL })
    const { p } = setup({}, node)
    const { claimableIds } = await p.getWithdrawalRequests()
    const q = await p.quoteClaimWithdrawals({ ids: claimableIds })
    expect(q.accounts).toHaveLength(10)
    expect(q.remaining).toBe(2)
  })

  it('a seed slot someone pre-funded is taken over with Transfer + AllocateWithSeed', async () => {
    const node = new FakeNode()
    node.accounts.set(slot(0), { lamports: 890_880n, owner: SYSTEM_PROGRAM, data: new Uint8Array() })
    // An empty slot is preferred; with none left the pre-funded one is reclaimed instead of being lost.
    expect((await setup({}, node).p.quoteStake({ amount: SOL })).stakeAccount).toBe(slot(1))
    const { p, sentIxs } = setup({ maxAccounts: 1 }, node)
    const r = await p.stake({ amount: SOL })
    expect(r.stakeAccount).toBe(slot(0))
    const [transfer, allocate, init] = sentIxs()
    expect([transfer!.programAddress, tag(transfer!)]).toEqual([SYSTEM_PROGRAM, 2])
    expect(u64At(transfer!, 4)).toBe(SOL + RENT - 890_880n)
    expect([allocate!.programAddress, tag(allocate!)]).toEqual([SYSTEM_PROGRAM, 9])
    expect(allocate!.accounts.map((a) => [a.address, a.role])).toEqual([[slot(0), 1], [WALLET, 2]])
    expect(tag(init!)).toBe(0)
  })

  it('merging accounts with different lockups in force is refused', async () => {
    const node = new FakeNode()
    const a = node.seedAccount(0, { activationEpoch: 1n, deactivationEpoch: 2n, lockup: { unixTimestamp: 0n, epoch: EPOCH + 5n, custodian: OTHER } })
    const b = node.seedAccount(1, { activationEpoch: 1n, deactivationEpoch: 2n, lockup: { unixTimestamp: 0n, epoch: EPOCH + 9n, custodian: OTHER } })
    await expect(setup({}, node).p.quoteMerge({ destination: a, source: b })).rejects.toThrow(/same lockup/)
  })

  it("getRewards asks getInflationReward for 'confirmed' even when reads use 'processed'", async () => {
    const node = new FakeNode()
    node.seedAccount(0, { stake: SOL })
    await setup({ commitment: 'processed' }, node).p.getRewards({ epochs: 1 })
    const call = node.calls.find((c) => c.method === 'getInflationReward')!
    expect((call.params[1] as { commitment: string }).commitment).toBe('confirmed')
  })
})
