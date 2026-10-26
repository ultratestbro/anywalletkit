import { describe, expect, it } from 'vitest'
import { decodeFunctionData, type Hex } from 'viem'
import { createMockAccount } from '@anywalletkit/conformance'
import { NativeStakingProtocolMonad, STAKING_ABI, STAKING_PRECOMPILE, packWithdrawalId, type NativeStakingMonadConfig } from '../src/index.js'
import { E, FakeMonad, MON, WALLET } from './fake-monad.js'

function setup(config: Partial<NativeStakingMonadConfig> = {}, node = new FakeMonad(), chain = 'eip155:143') {
  const account = createMockAccount({ chain, address: WALLET, fee: 30_000_000_000_000_000n })
  account.getBalance = async () => node.balance
  const base = 'validators' in config ? {} : { validators: [{ id: 97n, name: 'Ours' }, 21n], defaultValidator: 97n }
  const p = new NativeStakingProtocolMonad(account, { ...base, provider: node, ...config } as NativeStakingMonadConfig)
  const sent = (i = 0) => {
    const tx = account.sent[i] as { to: string; data: Hex; value: bigint; chainId: number }
    return { ...tx, decoded: decodeFunctionData({ abi: STAKING_ABI, data: tx.data }) }
  }
  return { p, node, account, sent }
}

describe('config: fail-closed', () => {
  const account = createMockAccount({ chain: 'eip155:143', address: WALLET })
  it('refuses to construct without validators, with a bad id, an unlisted default, bad numbers', () => {
    expect(() => new NativeStakingProtocolMonad(account, {} as NativeStakingMonadConfig)).toThrow(/needs `validators`/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [] })).toThrow(/needs `validators`/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [0n] })).toThrow(/not a valid validator id/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [1.5] })).toThrow(/must be a validator id/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [97n], defaultValidator: 21n })).toThrow(/must be one of/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [97n], maxCommission: 120 })).toThrow(/maxCommission/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [97n], chainId: 1 as never })).toThrow(/chainId must be/)
    expect(() => new NativeStakingProtocolMonad(account, { validators: [97n], maxWithdrawId: 256 })).toThrow(/maxWithdrawId/)
  })
  it("'any', duplicates dropped, a single-entry list is its own default", () => {
    expect(new NativeStakingProtocolMonad(account, { validators: 'any' }).validators).toBe('any')
    expect(new NativeStakingProtocolMonad(account, { validators: [97n, 97, { id: 97n, name: 'x' }] }).validators).toEqual([{ id: 97n }])
    expect(new NativeStakingProtocolMonad(account, { validators: [{ id: 12n }] }).defaultValidator).toBe(12n)
    expect(new NativeStakingProtocolMonad(account, { validators: [12n, 13n] }).defaultValidator).toBeUndefined()
  })
})

describe('stake', () => {
  it('delegate(validatorId) with the amount as value, to the precompile, on the account chain', async () => {
    const { p, sent } = setup()
    const r = await p.stake({ amount: 5n * MON })
    expect(r).toMatchObject({ amount: 5n * MON, activatesAtEpoch: 2333n, hash: expect.any(String) })
    expect(r.validator).toMatchObject({ id: 97n, name: 'Ours', commission: 5, active: true, eligible: true })
    const tx = sent()
    expect(tx.to).toBe(STAKING_PRECOMPILE)
    expect(tx.value).toBe(5n * MON)
    expect(tx.chainId).toBe(143)
    expect(tx.data.slice(0, 10)).toBe('0x84994fec')
    expect(tx.decoded).toMatchObject({ functionName: 'delegate', args: [97n] })
  })

  it('after the boundary block the stake activates at n+2', async () => {
    const node = new FakeMonad()
    node.inDelay = true
    expect((await setup({}, node).p.quoteStake({ amount: MON })).activatesAtEpoch).toBe(2334n)
  })

  it('refuses before anything is sent: unlisted, unknown, inactive, commission above the cap, dust, the 10 MON reserve', async () => {
    const node = new FakeMonad()
    const { p, account } = setup({ validators: [97n, 21n, 7n, 404n], defaultValidator: 97n, maxCommission: 8 }, node)
    await expect(p.stake({ amount: MON, validator: 165n })).rejects.toThrow(/not-listed/)
    await expect(p.stake({ amount: MON, validator: 404n })).rejects.toThrow(/not-found/)
    await expect(p.stake({ amount: MON, validator: 7n })).rejects.toThrow(/inactive/)
    await expect(p.stake({ amount: MON, validator: 21n })).rejects.toThrow(/commission 10 % > 8 %/)
    await expect(p.stake({ amount: 10n ** 8n })).rejects.toThrow(/1 gwei/)
    await expect(p.stake({ amount: node.balance - 9n * MON })).rejects.toThrow(/reserve balance/)
    expect(account.sent).toHaveLength(0)
    expect((await setup({ validators: [7n], allowInactive: true }, node).p.quoteStake({ amount: MON })).validator.id).toBe(7n)
  })

  it("'any' needs a validator per call; several listed without a default need one too", async () => {
    await expect(setup({ validators: 'any' }).p.quoteStake({ amount: MON })).rejects.toThrow(/no default/)
    await expect(setup({ validators: [97n, 21n] }).p.quoteStake({ amount: MON })).rejects.toThrow(/defaultValidator/)
    expect((await setup({ validators: 'any' }).p.quoteStake({ amount: MON, validator: 21 })).validator.id).toBe(21n)
  })

  it('chain checks: a non-Monad account, a read RPC on another chain, a pinned chain id', async () => {
    await expect(setup({}, new FakeMonad(), 'eip155:1').p.quoteStake({ amount: MON })).rejects.toThrow(/needs a Monad account/)
    const other = new FakeMonad()
    other.chainId = 10143
    await expect(setup({}, other).p.quoteStake({ amount: MON })).rejects.toThrow(/read RPC is on chain 10143/)
    await expect(setup({ chainId: 10143 }).p.quoteStake({ amount: MON })).rejects.toThrow(/pinned to 10143/)
  })

  it('a simulation revert comes back in plain words', async () => {
    const node = new FakeMonad()
    node.revertOn.set('delegate', 'unknown validator') // the chain changed between the read and the call
    const { p, account } = setup({}, node)
    await expect(p.stake({ amount: MON })).rejects.toThrow('There is no validator with this id.')
    node.revertOn.set('delegate', 'reserve balance violation')
    await expect(p.quoteStake({ amount: MON })).rejects.toThrow(/10 MON reserve/)
    expect(account.sent).toHaveLength(0)
  })
})

describe('positions and withdrawals', () => {
  function staked() {
    const node = new FakeMonad()
    Object.assign(node.delegator(97n), { stake: 100n * MON, rewards: 2n * MON, delta: 5n * MON, deltaEpoch: 2333n })
    Object.assign(node.delegator(21n), { stake: 0n, nextDelta: 3n * MON, nextDeltaEpoch: 2334n })
    node.withdrawal(97n, 0, 10n * MON, 2331n) // opens at 2332: claimable
    node.withdrawal(97n, 1, 4n * MON, 2332n) // opens at 2333
    node.withdrawal(21n, 3, 1n * MON, 2333n)
    return node
  }

  it('listPositions and getStakedBalance: active, activating (n+1 and n+2), rewards apart', async () => {
    const { p } = setup({}, staked())
    const positions = await p.listPositions()
    expect(positions.map((x) => [x.validatorId, x.active, x.activating, x.activatingNext, x.activationEpoch, x.nextActivationEpoch, x.unclaimedRewards])).toEqual([
      [97n, 100n * MON, 5n * MON, 0n, 2333n, null, 2n * MON],
      [21n, 0n, 0n, 3n * MON, null, 2334n, 0n],
    ])
    expect(await p.getStakedBalance()).toEqual({ balance: 100n * MON, wrappedBalance: 0n, rate: 0n, total: 108n * MON, activating: 8n * MON, unclaimedRewards: 2n * MON })
  })

  it('getWithdrawalRequests: every slot of every delegated validator, ids packed, claimable once open', async () => {
    const { p } = setup({ maxWithdrawId: 7 }, staked())
    const w = await p.getWithdrawalRequests()
    expect(w.requests.map((r) => [r.validatorId, r.withdrawId, r.claimable, r.withdrawableAtEpoch])).toEqual([
      [21n, 3, false, 2334n], [97n, 1, false, 2333n], [97n, 0, true, 2332n],
    ])
    expect(w.claimableIds).toEqual([packWithdrawalId(97n, 0)])
    expect(w.claimableAmount).toBe(10n * MON)
    expect(w.pendingAmount).toBe(5n * MON)
    expect((await p.getWithdrawalRequests({ validator: 21n })).requests).toHaveLength(1)
  })

  it('requestWithdrawal: undelegate(id, amount, lowest free slot), no value; claimable two epochs on', async () => {
    const { p, sent } = setup({}, staked())
    const r = await p.requestWithdrawal({ amount: 30n * MON })
    expect(r).toMatchObject({ validatorId: 97n, withdrawId: 2, id: packWithdrawalId(97n, 2), withdrawableAtEpoch: 2334n, approveHash: null })
    expect(sent().value).toBe(0n)
    expect(sent().decoded).toMatchObject({ functionName: 'undelegate', args: [97n, 30n * MON, 2] })
  })

  it('refuses more than the active stake (activating stake named), an occupied explicit slot, and no free slot', async () => {
    const node = staked()
    const { p, account } = setup({ maxWithdrawId: 1 }, node)
    await expect(p.requestWithdrawal({ amount: 101n * MON })).rejects.toThrow(/Only 100 MON is active .* 5 MON is still activating \(epoch 2333\)/)
    await expect(p.requestWithdrawal({ amount: MON, withdrawId: 1 })).rejects.toThrow(/Withdrawal id 1 is in use/)
    await expect(p.requestWithdrawal({ amount: MON })).rejects.toThrow(/All 2 withdrawal slots/)
    await expect(p.requestWithdrawal({ amount: MON, withdrawId: 256 })).rejects.toThrow(/withdrawId must be/)
    expect(account.sent).toHaveLength(0)
  })

  it('unstaking needs no listing (leaving is always allowed) and picks the only position without a default', async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(165n), { stake: 7n * MON })
    const { p } = setup({ validators: [97n, 21n] }, node)
    expect((await p.quoteRequestWithdrawal({ amount: MON })).validatorId).toBe(165n)
  })

  it('claimWithdrawals: one withdraw per request; refuses ones not open; reports what was sent on a failure', async () => {
    const node = staked()
    node.withdrawal(21n, 9, 2n * MON, 2330n) // also open
    const { p, account, sent } = setup({ maxWithdrawId: 9 }, node)
    const r = await p.claimWithdrawals()
    expect(r.claims.map((c) => [c.validatorId, c.withdrawId])).toEqual([[21n, 9], [97n, 0]])
    expect(r.hashes).toHaveLength(2)
    expect(sent(0).decoded).toMatchObject({ functionName: 'withdraw', args: [21n, 9] })
    expect(r.fee).toBe(2n * 30_000_000_000_000_000n)
    await expect(p.quoteClaimWithdrawals({ ids: [packWithdrawalId(97n, 1)] })).rejects.toThrow(/opens at epoch 2333 \(now 2332\)/)
    await expect(p.quoteClaimWithdrawals({ ids: [packWithdrawalId(97n, 5)] })).rejects.toThrow(/no pending withdrawal/)
    let n = 0
    account.sendTransaction = async () => { if (n++ === 1) throw new Error('rpc down'); return { hash: '0xaa', fee: 1n } }
    await expect(p.claimWithdrawals()).rejects.toMatchObject({ message: 'rpc down', sent: ['0xaa'] })
  })

  it('compound and claimRewards: need rewards; compound needs an eligible validator', async () => {
    const node = staked()
    const { p, sent } = setup({}, node)
    const c = await p.compound({ validator: 97n })
    expect(c).toMatchObject({ validatorId: 97n, amount: 2n * MON, activatesAtEpoch: 2333n })
    expect(sent(0).decoded.functionName).toBe('compound')
    const cl = await p.claimRewards({ validator: 97n })
    expect(cl.activatesAtEpoch).toBeNull()
    expect(sent(1).decoded.functionName).toBe('claimRewards')
    await expect(p.quoteClaimRewards({ validator: 21n })).rejects.toThrow(/No rewards/)
    node.delegator(7n).rewards = MON
    await expect(setup({ validators: [97n, 7n], defaultValidator: 97n }, node).p.quoteCompound({ validator: 7n })).rejects.toThrow(/claim the rewards instead/)
    expect((await setup({ validators: [97n, 7n], defaultValidator: 97n }, node).p.quoteClaimRewards({ validator: 7n })).amount).toBe(MON)
  })
})

describe('validators and APR', () => {
  it('listValidators: listed order, live commission (percent), standing, network APR after commission', async () => {
    const { p } = setup({ validators: [{ id: 97n, name: 'Ours' }, 21n, 7n], defaultValidator: 97n, maxCommission: 8 })
    const list = await p.listValidators()
    expect(list.map((v) => [v.id, v.name, v.commission, v.active, v.eligible, v.refusals])).toEqual([
      [97n, 'Ours', 5, true, true, []], [21n, null, 10, true, false, ['commission-above-max']], [7n, null, 0, false, false, ['inactive']],
    ])
    // 18 MON × (year ÷ 0.3 s) ÷ 3.5 B MON staked = 54.06 % in this toy cluster
    const stats = await p.getNetworkStats()
    expect(stats.blockTimeMs).toBeCloseTo(300, 0)
    expect(stats.totalConsensusStake).toBe(3_500_000_000n * MON)
    expect(stats.apr).toBeCloseTo(((18 * (365.25 * 86_400_000 / 300)) / 3_500_000_000) * 100, 6)
    expect(list[0]!.apr).toBeCloseTo(stats.apr * 0.95, 6)
    expect(await p.getApr()).toBeCloseTo(stats.apr * 0.95, 6)
  })

  it("'any': the consensus set by stake, across pages", async () => {
    const list = await setup({ validators: 'any' }).p.listValidators({ limit: 2 })
    expect(list.map((v) => v.id)).toEqual([97n, 21n])
  })

  it('enrich replaces the APR and adds names; a failing hook changes nothing on-chain', async () => {
    const { p } = setup({ enrich: async (ids) => Object.fromEntries(ids.map((id) => [String(id), { apr: 7.5, name: `v${id}`, logo: 'x' }])) })
    expect(await p.getValidator(21n)).toMatchObject({ apr: 7.5, aprSource: 'enrich', name: 'v21', extra: { logo: 'x' } })
    const broken = setup({ enrich: async () => { throw new Error('down') } }).p
    expect((await broken.getValidator(21n)).aprSource).toBe('estimate')
  })

  it('validator reads for display are cached for a minute; getValidator and writes read fresh', async () => {
    const { p, node } = setup()
    await p.listValidators()
    await p.listValidators()
    const reads = () => node.calls.filter((c) => c.fn === 'getValidator' && c.args[0] === 97n).length
    const listed = reads()
    await p.getValidator(97n)
    expect(reads()).toBe(listed + 1)
  })
})

describe('provider list', () => {
  const down = { request: async () => { throw Object.assign(new Error('fetch failed'), { code: -32603 }) } }
  it('a list inherited from the account fails over to the next provider', async () => {
    const node = new FakeMonad()
    const account = Object.assign(createMockAccount({ chain: 'eip155:143', address: WALLET }), { _config: { provider: [down, node] } })
    const p = new NativeStakingProtocolMonad(account, { validators: [97n] })
    expect((await p.getEpoch()).epoch).toBe(2332n)
  })
  it('without any provider, reads fail with a clear error', async () => {
    const p = new NativeStakingProtocolMonad(createMockAccount({ chain: 'eip155:143', address: WALLET }), { validators: [97n] })
    await expect(p.getEpoch()).rejects.toThrow(/needs a Monad RPC/)
  })
})

describe('E helper', () => {
  it('percent to 1e18 scale', () => {
    expect(E(5)).toBe(5n * 10n ** 16n)
  })
})

describe('review 2026-10-26 regressions', () => {
  it('a full exit drops the validator from getDelegations; its withdrawal is still found and claimed', async () => {
    const node = new FakeMonad()
    node.withdrawal(165n, 0, 40n * MON, 2330n) // stake fully undelegated from 165: no DelInfo stake left
    // 'any': not in getDelegations, not listed — found only when the app names the validator
    const any = setup({ validators: 'any' }, node)
    expect((await any.p.getWithdrawalRequests()).requests).toHaveLength(0)
    const named = await any.p.getWithdrawalRequests({ validators: [165n] })
    expect(named.claimableIds).toEqual([packWithdrawalId(165n, 0)])
    const r = await any.p.claimWithdrawals({ validators: [165n] })
    expect(r.claims.map((c) => c.validatorId)).toEqual([165n])
    // listed validators are always looked at
    expect((await setup({ validators: [97n, 165n], defaultValidator: 97n }, node).p.getWithdrawalRequests()).requests).toHaveLength(1)
  })

  it('a validator this instance undelegated from stays in the scan after the full exit', async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(165n), { stake: 5n * MON })
    const { p } = setup({ validators: 'any' }, node)
    const r = await p.requestWithdrawal({ amount: 5n * MON, validator: 165n })
    node.delegator(165n).stake = 0n // the chain applied it
    node.withdrawal(165n, r.withdrawId, 5n * MON, 2333n)
    expect((await p.getWithdrawalRequests()).requests.map((x) => x.validatorId)).toEqual([165n])
  })

  it('the commission check before a delegation reads the validator fresh, not the display cache', async () => {
    const node = new FakeMonad()
    const { p, account } = setup({}, node)
    await p.listValidators() // fills the cache
    node.validators.get(97n)!.commission = E(50) // raised right after
    await expect(p.stake({ amount: MON })).rejects.toThrow(/commission 50 % > 10 %/)
    expect(account.sent).toHaveLength(0)
  })

  it('commission is compared in the 1e18 scale: 10.009 % is above a 10 % cap', async () => {
    const node = new FakeMonad()
    node.validators.get(97n)!.commission = 100_090_000_000_000_000n
    await expect(setup({}, node).p.quoteStake({ amount: MON })).rejects.toThrow(/commission-above-max|commission 10 % > 10 %/)
  })

  it('positions and writes do not pull the ~200 network-stat reads; an inactive validator has no APR', async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(97n), { stake: 5n * MON })
    const { p } = setup({ validators: [97n, 7n], defaultValidator: 97n }, node)
    await p.listPositions()
    await p.quoteStake({ amount: MON })
    expect(node.calls.filter((c) => c.fn === 'getConsensusValidatorSet')).toHaveLength(0)
    expect((await p.getValidator(7n)).apr).toBeNull()
  })

  // Audit 2026-10-25 round 3, NS-6: the default scan was 'gap', which stops 32 empty slots past the
  // last used one, so a pending slot above a run of claimed ones was never found (this test pinned
  // that as expected: slot 200 "only a full scan finds it"). The default now reads every slot in one
  // Multicall3 eth_call; 'gap' stays as an explicit, documented trade-off.
  it('default scan: every slot in one Multicall3 call finds a pending slot far above the last used one', async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(97n), { stake: 5n * MON })
    node.withdrawal(97n, 3, MON, 2330n)
    node.withdrawal(97n, 30, MON, 2330n)
    node.withdrawal(97n, 200, MON, 2330n)
    const w = await setup({}, node).p.getWithdrawalRequests({ validator: 97n })
    expect(w.requests.map((r) => r.withdrawId).sort((a, b) => a - b)).toEqual([3, 30, 200])
    expect(node.multicallCalls).toBe(1)
    // No Multicall3 on the chain: the same answer, one call per slot.
    node.multicall = false
    node.calls.length = 0
    const fallback = await setup({}, node).p.getWithdrawalRequests({ validator: 97n })
    expect(fallback.requests.map((r) => r.withdrawId).sort((a, b) => a - b)).toEqual([3, 30, 200])
    expect(node.calls.filter((c) => c.fn === 'getWithdrawalRequest')).toHaveLength(256)
    node.multicall = true
  })

  it("'gap' (opt-in) reads until 32 empty slots past the last used one; 'full' reads all 256", async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(97n), { stake: 5n * MON })
    node.withdrawal(97n, 3, MON, 2330n)
    node.withdrawal(97n, 30, MON, 2330n) // within 32 empty slots of slot 3: found
    node.withdrawal(97n, 200, MON, 2330n) // far past the window: 'gap' misses it (documented)
    const gap = setup({ withdrawScan: 'gap' }, node)
    const w = await gap.p.getWithdrawalRequests({ validator: 97n })
    expect(w.requests.map((r) => r.withdrawId).sort((a, b) => a - b)).toEqual([3, 30])
    expect(node.calls.filter((c) => c.fn === 'getWithdrawalRequest').length).toBeLessThan(80)
    node.calls.length = 0
    const full = await setup({ withdrawScan: 'full' }, node).p.getWithdrawalRequests({ validator: 97n })
    expect(full.requests.map((r) => r.withdrawId).sort((a, b) => a - b)).toEqual([3, 30, 200])
    expect(node.calls.filter((c) => c.fn === 'getWithdrawalRequest')).toHaveLength(256)
    node.calls.length = 0
    await setup({ withdrawScan: 'gap' }, node).p.getWithdrawalRequests({ validator: 21n }) // nothing there at all
    expect(node.calls.filter((c) => c.fn === 'getWithdrawalRequest').length).toBeLessThanOrEqual(36)
  })

  it('an explicit withdrawId above maxWithdrawId is refused; reserveBalance cannot go under 10 MON', async () => {
    const node = new FakeMonad()
    Object.assign(node.delegator(97n), { stake: 5n * MON })
    await expect(setup({ maxWithdrawId: 7 }, node).p.quoteRequestWithdrawal({ amount: MON, withdrawId: 200 })).rejects.toThrow(/above maxWithdrawId 7/)
    expect(() => setup({ reserveBalance: MON })).toThrow(/10 MON reserve/)
    expect(await setup({}, node).p.getMaxStakeable()).toBe(node.balance - 10n * MON)
  })

  it('the reserve error shows a negative remainder correctly', async () => {
    const node = new FakeMonad()
    node.balance = 5n * MON + MON / 2n
    await expect(setup({}, node).p.quoteStake({ amount: 11n * MON })).rejects.toThrow(/would leave -5\.5 MON/)
  })

  it('an account that does not know its chain yet is asked, not just the read RPC', async () => {
    const node = new FakeMonad()
    const account = createMockAccount({ chain: 'eip155:unknown', address: WALLET })
    Object.assign(account, { getChainId: async () => 1 })
    const p = new NativeStakingProtocolMonad(account, { validators: [97n], provider: node })
    await expect(p.quoteStake({ amount: MON })).rejects.toThrow(/needs a Monad account/)
  })

  it('pool stops starting calls after the first failure', async () => {
    const { pool } = await import('../src/rpc.js')
    let started = 0
    await expect(pool(Array.from({ length: 50 }, (_, i) => i), 3, async (i) => { started++; if (i === 1) throw new Error('down'); await new Promise((r) => setTimeout(r, 2)); return i })).rejects.toThrow('down')
    expect(started).toBeLessThan(10)
  })
})
