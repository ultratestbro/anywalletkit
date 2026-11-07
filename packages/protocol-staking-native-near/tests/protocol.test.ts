import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsufficientFundsError, ReadOnlyAccountError, type ChainTx, type HistorySource } from '@anywalletkit/core'
import { WalletAccountReadOnlyNear, type NearTransaction } from '@anywalletkit/wallet-near'
import {
  DEFAULT_RESERVE, NativeStakingProtocolNear, NearStakingError, epochStartsAt, poolRequestId, sameTransactions, type NativeStakingNearConfig,
} from '../src/index.js'
import { ASTRO, AURORA, FIGMENT, FakeNear, ME, NEAR, TGAS, ZAVODIL, nearAccount } from './fake-near.js'

const GAS_PRICE = 100_000_000n
const feeOf = (txs: NearTransaction[]) => txs.reduce((s, tx) => s + WalletAccountReadOnlyNear.gasOf(tx.actions, false) * GAS_PRICE, 0n)
const STORAGE = 182n * 10n ** 19n

/** Config overrides; `defaultPool: undefined` removes the default. */
function setup(config: { [K in keyof NativeStakingNearConfig]?: NativeStakingNearConfig[K] | undefined } = {}, o: { node?: FakeNear; batch?: boolean; chain?: string } = {}) {
  const node = o.node ?? new FakeNear()
  const account = nearAccount({ ...(o.batch ? { batch: true } : {}), ...(o.chain ? { chain: o.chain } : {}) })
  const p = new NativeStakingProtocolNear(account, { pools: [ASTRO, FIGMENT, ZAVODIL], defaultPool: ASTRO, provider: node.fetch, discover: false, ...config } as NativeStakingNearConfig)
  return { p, node, account }
}

/** Rejects with a NearStakingError of `code` (and returns it for further checks). */
async function refusal(promise: Promise<unknown>, code: string): Promise<NearStakingError> {
  const e = await promise.then(() => null, (x: unknown) => x)
  expect(e, `expected a '${code}' refusal`).toBeInstanceOf(NearStakingError)
  expect((e as NearStakingError).code).toBe(code)
  return e as NearStakingError
}

const fc = (methodName: string, args: Record<string, unknown>, gas: bigint, deposit = 0n) => ({ functionCall: { methodName, args, gas, deposit } })

afterEach(() => { vi.unstubAllGlobals() })

describe('config', () => {
  const account = nearAccount()
  it('validates numbers, gas, code hashes, discovery and hooks', () => {
    const base = { pools: 'any' as const }
    expect(() => new NativeStakingProtocolNear(account, { ...base, minUptime: 120 })).toThrow(/minUptime/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, concurrency: 0 })).toThrow(/concurrency/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, gas: { stake: 400n * TGAS } })).toThrow(/gas.stake/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, gas: { withdraw: 260n * TGAS } })).toThrow(/one transaction/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, codeHashes: [''] })).toThrow(/codeHashes/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, discover: 'nearblocks' as never })).toThrow(/discover/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, enrich: {} as never })).toThrow(/enrich/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, reserve: 1.5 })).toThrow(/reserve/)
    expect(() => new NativeStakingProtocolNear(account, { ...base, reserve: -1n })).toThrow(/reserve/)
    const p = new NativeStakingProtocolNear(account, base)
    expect(p.reserve).toBe(DEFAULT_RESERVE)
    expect(p.gas).toEqual({ stake: 50n * TGAS, unstake: 50n * TGAS, withdraw: 125n * TGAS })
    expect(p.maxFee).toBe(10)
  })

  it('never touches the network or the chain in the constructor', () => {
    const node = new FakeNear()
    new NativeStakingProtocolNear(nearAccount({ chain: 'eip155:1' }), { pools: 'any', provider: node.fetch })
    expect(node.requests).toHaveLength(0)
  })

  it('refuses reads on another chain or without an RPC', async () => {
    await refusal(setup({}, { chain: 'eip155:1' }).p.getStakedBalance(), 'wrong-chain')
    await refusal(setup({ network: 'mainnet' }, { chain: 'near:testnet' }).p.quoteStake({ amount: NEAR }), 'wrong-chain')
    await refusal(setup({ network: 'testnet' }).p.getMaxStakeable(), 'wrong-chain')
    await refusal(new NativeStakingProtocolNear(nearAccount(), { pools: 'any', discover: false }).getEpoch(), 'no-provider')
  })
})

describe('pool allow-list (getPool)', () => {
  it('a standard pool in both sets with a low fee is eligible, with live code, fee and pause', async () => {
    const info = await setup().p.getPool(ASTRO)
    expect(info).toMatchObject({ id: ASTRO, factory: 'poolv1', details: true, codeHash: 'J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY', codeHashKnown: true, fee: { numerator: 1, denominator: 100 }, feePercent: 1, paused: false, inCurrentSet: true, inNextSet: true, listed: true, eligible: true, refusals: [], aprSource: 'protocol' })
    expect(info.stake).toBeGreaterThan(30_000_000n * NEAR)
    expect(info.uptime).toBeGreaterThan(90)
  })

  it('not-listed when `pools` is a list without the id (the other checks still run)', async () => {
    const info = await setup({ pools: [ASTRO] }).p.getPool(FIGMENT)
    expect(info.refusals).toEqual(['not-listed'])
  })

  it('lst-pool.near and meta-pool.near are refused locally, without a single RPC call', async () => {
    const { p, node } = setup({ pools: 'any' })
    for (const id of ['lst-pool.near', 'meta-pool.near']) {
      const info = await p.getPool(id)
      expect(info).toMatchObject({ eligible: false, factory: null, details: false })
      expect(info.refusals).toEqual(['not-factory-pool'])
    }
    expect(node.requests).toHaveLength(0)
    // lst-pool.near really is in the validator set, charges 5 % and has no is_staking_paused: none of that matters.
    expect(node.validators.current_validators.some((v) => v.account_id === 'lst-pool.near')).toBe(true)
    await refusal(p.quoteStake({ amount: NEAR, pool: 'lst-pool.near' }), 'pool-not-allowed')
    // Vouching for its code does not lift the suffix check either.
    const vouched = setup({ pools: 'any', codeHashes: ['DqKkcbjBiPJju2tqis8G7ayfBePvq9Gn8mjvykNupYxx'] })
    expect((await vouched.p.getPool('lst-pool.near')).refusals).toEqual(['not-factory-pool'])
  })

  it('not-found for a factory id with no account', async () => {
    const info = await setup({ pools: 'any' }).p.getPool('ghost.poolv1.near')
    expect(info.refusals).toEqual(['not-found', 'not-in-current-set', 'not-in-next-set'])
  })

  it('aurora.pool.near (99 % fee) is fee-above-max; the cap compares in integers', async () => {
    const node = new FakeNear()
    node.addValidator('ten.poolv1.near', { reward: 10n ** 24n })
    node.addPool('ten.poolv1.near', { fee: { numerator: 10, denominator: 100 } })
    const { p } = setup({ pools: 'any' }, { node })
    expect((await p.getPool(AURORA)).refusals).toEqual(['fee-above-max'])
    expect((await p.getPool('ten.poolv1.near')).eligible).toBe(true) // exactly 10 % = maxFee
    node.pools.get('ten.poolv1.near')!.fee = { numerator: 1001, denominator: 10000 }
    expect((await p.getPool('ten.poolv1.near')).refusals).toEqual(['fee-above-max'])
    expect((await setup({ pools: 'any', maxFee: 10.01 }, { node }).p.getPool('ten.poolv1.near')).eligible).toBe(true)
  })

  describe('a lying RPC: each lie alone refuses', () => {
    const good = (node: FakeNear, id = 'good.poolv1.near') => {
      node.addValidator(id, { reward: 2n * 10n ** 27n })
      return node.addPool(id)
    }
    it('the baseline pool is eligible', async () => {
      const { p, node } = setup({ pools: 'any' })
      good(node)
      expect((await p.getPool('good.poolv1.near')).eligible).toBe(true)
    })
    it('evil.near listed as a validator with a 1 % fee: not a factory pool, dropped from listPools', async () => {
      const { p, node } = setup({ pools: 'any' })
      node.addValidator('evil.near', { stake: 10n ** 9n * NEAR })
      node.addPool('evil.near')
      expect((await p.getPool('evil.near')).refusals).toEqual(['not-factory-pool'])
      expect((await p.listPools()).some((x) => x.id === 'evil.near')).toBe(false)
      expect(node.touched('evil.near')).toBe(0)
    })
    it('a fake code_hash: unknown-code, and the unknown contract is never called', async () => {
      const { p, node } = setup({ pools: 'any' })
      good(node)
      node.accounts.get('good.poolv1.near')!.codeHash = 'FakeHash1111111111111111111111111111111111111'
      const info = await p.getPool('good.poolv1.near')
      expect(info.refusals).toEqual(['unknown-code'])
      expect(info.codeHashKnown).toBe(false)
      expect(node.count('query', (q) => q.account_id === 'good.poolv1.near' && q.request_type === 'call_function')).toBe(0)
      // An app can vouch for another build.
      expect((await setup({ pools: 'any', codeHashes: ['FakeHash1111111111111111111111111111111111111'] }, { node }).p.getPool('good.poolv1.near')).eligible).toBe(true)
    })
    for (const [label, paused, refusal] of [
      ['is_staking_paused missing', { missing: true }, 'pause-unknown'],
      ['is_staking_paused throwing', { throws: 'Smart contract panicked: nope' }, 'pause-unknown'],
      ['is_staking_paused answering a string', 'false', 'pause-unknown'],
      ['is_staking_paused answering null', null, 'pause-unknown'],
      ['a paused pool', true, 'paused'],
    ] as const) {
      it(`${label}: ${refusal}`, async () => {
        const { p, node } = setup({ pools: 'any' })
        good(node).paused = paused
        expect((await p.getPool('good.poolv1.near')).refusals).toEqual([refusal])
      })
    }
    for (const [label, fee] of [
      ['fee method missing', { missing: true }],
      ['fee method throwing', { throws: 'boom' }],
      ['denominator 0', { numerator: 0, denominator: 0 }],
      ['numerator above denominator', { numerator: 101, denominator: 100 }],
      ['non-integer numerator', { numerator: 1.5, denominator: 100 }],
      ['string fields', { numerator: '1', denominator: '100' }],
    ] as const) {
      it(`${label}: fee-unknown`, async () => {
        const { p, node } = setup({ pools: 'any' })
        good(node).fee = fee
        expect((await p.getPool('good.poolv1.near')).refusals).toEqual(['fee-unknown'])
      })
    }
    it('outside the current set, leaving the next set, low uptime; allowInactive lifts the sets only', async () => {
      const node = new FakeNear()
      good(node)
      node.removeValidator('good.poolv1.near', 'current')
      node.addValidator('leaving.poolv1.near', { next: false })
      node.addPool('leaving.poolv1.near')
      node.addValidator('slow.poolv1.near', { produced: 80, expected: 100 })
      node.addPool('slow.poolv1.near')
      const { p } = setup({ pools: 'any', minUptime: 95 }, { node })
      expect((await p.getPool('good.poolv1.near')).refusals).toEqual(['not-in-current-set'])
      expect((await p.getPool('leaving.poolv1.near')).refusals).toEqual(['not-in-next-set'])
      expect((await p.getPool('slow.poolv1.near')).refusals).toEqual(['low-uptime'])
      expect((await setup({ pools: 'any', minUptime: 75 }, { node }).p.getPool('slow.poolv1.near')).eligible).toBe(true)
      const lax = setup({ pools: 'any', allowInactive: true }, { node }).p
      expect((await lax.getPool('good.poolv1.near')).eligible).toBe(true)
      expect((await lax.getPool('leaving.poolv1.near')).eligible).toBe(true)
    })
  })

  it('getPools caches display reads; writes read fresh', async () => {
    const { p, node } = setup()
    await p.getPools([ASTRO, ASTRO, FIGMENT])
    const views = node.count('query', (q) => q.request_type === 'view_account' && q.account_id === ASTRO)
    expect(views).toBe(1)
    await p.getPools([ASTRO])
    expect(node.count('query', (q) => q.request_type === 'view_account' && q.account_id === ASTRO)).toBe(1)
    node.pools.get(ASTRO)!.paused = true
    expect((await p.getPools([ASTRO]))[0]!.eligible).toBe(true) // still the cached display read
    await refusal(p.quoteStake({ amount: NEAR }), 'pool-not-allowed') // the write reads fresh
  })

  it('listPools: one validators call, factory pools only, by stake, light info', async () => {
    const { p, node } = setup({ pools: [ASTRO, ZAVODIL] })
    const list = await p.listPools()
    expect(node.requests.map((r) => r.method)).toEqual(['validators'])
    expect(list.every((x) => x.factory !== null && x.details === false && x.fee === null && x.codeHash === null && x.paused === null)).toBe(true)
    expect(list.some((x) => x.id === 'lst-pool.near')).toBe(false)
    for (let i = 1; i < list.length; i++) expect(list[i - 1]!.stake >= list[i]!.stake).toBe(true)
    expect(list.find((x) => x.id === FIGMENT)!.refusals).toEqual(['not-listed'])
    expect(list.find((x) => x.id === ASTRO)!.refusals).toEqual([])
    expect(list.find((x) => x.id === ASTRO)!.grossApr).toBeGreaterThan(4)
    expect(list.find((x) => x.id === ASTRO)!.apr).toBeNull()
  })

  it('enrich adds names and an APR; a failing enricher is ignored', async () => {
    const { p } = setup({ enrich: (ids) => Object.fromEntries(ids.map((id) => [id, { name: `N ${id}`, apr: 7 }])) })
    expect(await p.getPool(ASTRO)).toMatchObject({ name: `N ${ASTRO}`, apr: 7, aprSource: 'enrich' })
    const { p: q } = setup({ pools: [{ id: ASTRO, name: 'Astro' }], enrich: () => { throw new Error('down') } })
    expect(await q.getPool(ASTRO)).toMatchObject({ name: 'Astro', aprSource: 'protocol' })
  })
})

describe('stake', () => {
  it('deposit_and_stake of exactly the amount, to the pool, 50 Tgas; the quote is what is sent', async () => {
    const { p, account } = setup()
    const quote = await p.quoteStake({ amount: 2n * NEAR })
    expect(quote.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('deposit_and_stake', {}, 50n * TGAS, 2n * NEAR)] }])
    expect(quote.fee).toBe(feeOf(quote.transactions))
    expect(quote.pool).toMatchObject({ id: ASTRO, details: true, eligible: true })
    expect(quote.apr).toBeCloseTo(quote.pool.apr!, 10)
    expect(account.sent).toHaveLength(0)
    const r = await p.stake({ amount: 2n * NEAR, expected: quote.transactions })
    expect(sameTransactions(quote.transactions, account.sent as NearTransaction[])).toBe(true)
    expect(r).toMatchObject({ amount: 2n * NEAR, hash: r.hashes[0], fee: 500_000_000_000_000_000_000n })
    expect(r.hashes).toHaveLength(1)
    expect(account.calls.filter((c) => /^(getBalance|quoteSendTransaction|signTransaction|transfer)$/.test(c.method))).toEqual([])
  })

  it('stakes only what it is told: an account holding 1000 NEAR stakes the delivered 0.73', async () => {
    const node = new FakeNear()
    node.accounts.get(ME)!.amount = 1000n * NEAR + 73n * 10n ** 22n
    const { p, account } = setup({}, { node })
    await p.stake({ amount: 73n * 10n ** 22n })
    const tx = account.sent[0] as NearTransaction
    expect((tx.actions[0] as { functionCall: { deposit: bigint } }).functionCall.deposit).toBe(73n * 10n ** 22n)
    expect(node.accounts.get(ME)!.amount).toBe(1000n * NEAR + 73n * 10n ** 22n) // nothing else touched
  })

  it('amount + fee + reserve must fit the available balance (balance − locked − storage)', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    const fee = feeOf([{ receiverId: ASTRO, actions: [fc('deposit_and_stake', {}, 50n * TGAS, 1n)] }])
    const available = 10n * NEAR - STORAGE
    const max = available - DEFAULT_RESERVE - fee
    expect(await p.getMaxStakeable()).toBe(max)
    expect((await p.quoteStake({ amount: max })).maxStakeable).toBe(max)
    const e = await p.quoteStake({ amount: max + 1n }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(InsufficientFundsError)
    expect(e).toMatchObject({ required: max + 1n + fee + DEFAULT_RESERVE, available })
    node.accounts.get(ME)!.locked = 5n * NEAR
    expect(await p.getMaxStakeable()).toBe(max - 5n * NEAR)
    node.accounts.delete(ME) // a fresh implicit account that was never funded
    expect(await p.getMaxStakeable()).toBe(0n)
  })

  it('refuses bad amounts, dust, a missing pool choice and an ineligible pool', async () => {
    const { p, node } = setup({ defaultPool: undefined })
    for (const amount of [0n, -1n, 1.5, '1', Number.MAX_SAFE_INTEGER + 2, undefined]) await refusal(p.quoteStake({ amount: amount as never, pool: ASTRO }), 'invalid-amount')
    await refusal(p.quoteStake({ amount: 10n ** 21n - 1n, pool: ASTRO }), 'below-minimum')
    await refusal(p.quoteStake({ amount: NEAR }), 'pool-required')
    node.pools.get(ASTRO)!.paused = true
    const e = await refusal(p.quoteStake({ amount: NEAR, pool: ASTRO }), 'pool-not-allowed')
    expect(e.refusals).toEqual(['paused'])
  })

  it('a pool new to the set (no reward entry) gets the network APR after its fee, with a warning', async () => {
    const { p, node } = setup({ pools: 'any' })
    node.addValidator('fresh.poolv1.near')
    node.addPool('fresh.poolv1.near', { fee: { numerator: 5, denominator: 100 } })
    const q = await p.quoteStake({ amount: NEAR, pool: 'fresh.poolv1.near' })
    expect(q.pool.grossApr).toBeNull()
    expect(q.pool.aprSource).toBe('network')
    expect(q.warnings.map((w) => w.code)).toEqual(['apr-network-fallback'])
    const net = (await p.getNetworkStats()).apr
    expect(q.apr).toBeCloseTo(net * 0.95, 10)
  })

  it("refuses with 'quote-changed' when the fresh plan differs from `expected`, and sends nothing", async () => {
    const { p, account } = setup()
    const quote = await p.quoteStake({ amount: NEAR })
    const e = await refusal(p.stake({ amount: 2n * NEAR, expected: quote.transactions }), 'quote-changed')
    expect(e.details!.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('deposit_and_stake', {}, 50n * TGAS, 2n * NEAR)] }])
    await refusal(p.stake({ amount: NEAR, expected: 'nope' as never }), 'quote-changed')
    expect(account.sent).toHaveLength(0)
  })

  it('a read-only account is refused before any read; the fee cap reaches the account', async () => {
    const node = new FakeNear()
    const ro = new NativeStakingProtocolNear(nearAccount().toReadOnlyAccount(), { pools: [ASTRO], provider: node.fetch, discover: false })
    await expect(ro.stake({ amount: NEAR })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    await expect(ro.requestWithdrawal({ amount: 'all' })).rejects.toBeInstanceOf(ReadOnlyAccountError)
    await expect(ro.claimWithdrawals()).rejects.toBeInstanceOf(ReadOnlyAccountError)
    expect(node.requests).toHaveLength(0)
    const { p, account } = setup()
    const options: unknown[] = []
    const send = account.sendTransaction
    account.sendTransaction = async (tx, o) => { options.push(o); return send(tx, o) }
    await p.stake({ amount: NEAR, maxFee: 10n ** 22n })
    await p.stake({ amount: NEAR })
    expect(options).toEqual([{ maxFee: 10n ** 22n }, undefined])
  })
})

describe('unstake', () => {
  it("'all' sends unstake_all with the staked amount; a number sends unstake with a decimal-string U128", async () => {
    const { p, node, account } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 7n * NEAR })
    const all = await p.quoteRequestWithdrawal({ amount: 'all' })
    expect(all).toMatchObject({ amount: 7n * NEAR, pool: ASTRO, id: poolRequestId(ASTRO), withdrawsFirst: 0n, resetsTimer: false, warnings: [] })
    expect(all.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('unstake_all', {}, 50n * TGAS)] }])
    const part = await p.requestWithdrawal({ amount: 3n * NEAR })
    expect(part.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('unstake', { amount: '3000000000000000000000000' }, 50n * TGAS)] }])
    expect(part.approveHash).toBeNull()
    expect(sameTransactions(part.transactions, account.sent as NearTransaction[])).toBe(true)
  })

  it('the unlock estimate: current + 4, or + 5 when the transaction lands next epoch', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 7n * NEAR })
    const [q, epoch] = await Promise.all([p.quoteRequestWithdrawal({ amount: NEAR }), p.getEpoch()])
    expect(q.unlock).toEqual({ epoch: null, earliestEpoch: epoch.height + 4n, latestEpoch: epoch.height + 5n, at: null, earliestAt: epochStartsAt(epoch, epoch.height + 4n), latestAt: epochStartsAt(epoch, epoch.height + 5n), source: 'estimate' })
    // ~21–28 h from now at a 6.9 h epoch.
    const hours = (q.unlock.earliestAt - node.final.timestamp / 1e6) / 3.6e6
    expect(hours).toBeGreaterThan(20.5)
    expect(hours).toBeLessThan(28)
  })

  it('refuses more than staked, nothing staked, bad amounts', async () => {
    const { p, node } = setup()
    await refusal(p.quoteRequestWithdrawal({ amount: 'all' }), 'nothing-staked')
    Object.assign(node.delegation(ASTRO), { staked: NEAR })
    await refusal(p.quoteRequestWithdrawal({ amount: NEAR + 1n }), 'exceeds-staked')
    await refusal(p.quoteRequestWithdrawal({ amount: 0n }), 'invalid-amount')
    expect((await p.quoteRequestWithdrawal({ amount: NEAR })).amount).toBe(NEAR)
  })

  it('an unlocked balance is withdrawn first in the same transaction: [withdraw_all, unstake], 175 Tgas', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 2n * NEAR, canWithdraw: true })
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    expect(q.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('withdraw_all', {}, 125n * TGAS), fc('unstake', { amount: String(NEAR) }, 50n * TGAS)] }])
    expect(q).toMatchObject({ withdrawsFirst: 2n * NEAR, resetsTimer: false })
    expect(q.warnings.map((w) => w.code)).toEqual(['withdraws-unlocked-first'])
    const all = await p.quoteRequestWithdrawal({ amount: 'all' })
    expect(all.transactions[0]!.actions.map((a) => ('functionCall' in a ? a.functionCall.methodName : '?'))).toEqual(['withdraw_all', 'unstake_all'])
  })

  it('a locked unstaked balance restarts its timer: resetsTimer and a warning that says so', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 2n * NEAR, canWithdraw: false })
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    expect(q.transactions[0]!.actions).toHaveLength(1)
    expect(q.resetsTimer).toBe(true)
    expect(q.warnings).toEqual([{ code: 'resets-unbonding-timer', message: expect.stringMatching(/restarts its 4-epoch wait/) as unknown as string }])
  })

  it('rounding dust left in a pool (1–10 yocto) triggers neither the batch nor a warning', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 2n, canWithdraw: true })
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    expect(q.transactions[0]!.actions).toHaveLength(1)
    expect(q.warnings).toEqual([])
    Object.assign(node.delegation(ASTRO), { canWithdraw: false })
    expect((await p.quoteRequestWithdrawal({ amount: NEAR })).resetsTimer).toBe(false)
    expect((await p.getWithdrawalRequests()).requests).toEqual([])
  })

  it("'quote-changed' when a balance unlocks between the quote and the click", async () => {
    const { p, node, account } = setup()
    const d = Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 2n * NEAR, canWithdraw: false })
    const quote = await p.quoteRequestWithdrawal({ amount: NEAR })
    d.canWithdraw = true
    const e = await refusal(p.requestWithdrawal({ amount: NEAR, expected: quote.transactions }), 'quote-changed')
    expect((e.details!.transactions as NearTransaction[])[0]!.actions).toHaveLength(2)
    expect(account.sent).toHaveLength(0)
  })

  it('picks the only pool with stake when none is named; asks when there are several', async () => {
    const node = new FakeNear()
    const { p } = setup({ defaultPool: undefined }, { node })
    Object.assign(node.delegation(ZAVODIL), { staked: NEAR })
    Object.assign(node.delegation(FIGMENT), { unstaked: NEAR, canWithdraw: false })
    expect((await p.quoteRequestWithdrawal({ amount: 'all' })).pool).toBe(ZAVODIL)
    Object.assign(node.delegation(FIGMENT), { staked: NEAR })
    await refusal(p.quoteRequestWithdrawal({ amount: 'all' }), 'pool-required')
  })

  it('exits are always allowed from a known pool: paused, 100 % fee, out of the set, never listed', async () => {
    const node = new FakeNear()
    const { p } = setup({ pools: [ASTRO] }, { node })
    Object.assign(node.delegation(ZAVODIL), { staked: 4n * NEAR, unstaked: NEAR, canWithdraw: true })
    const pool = node.pools.get(ZAVODIL)!
    pool.paused = true
    pool.fee = { numerator: 100, denominator: 100 }
    node.removeValidator(ZAVODIL)
    expect((await p.getPool(ZAVODIL)).eligible).toBe(false)
    expect((await p.quoteRequestWithdrawal({ amount: 'all', pool: ZAVODIL })).transactions[0]!.receiverId).toBe(ZAVODIL)
    expect((await p.quoteClaimWithdrawals({ pools: [ZAVODIL] })).claims).toEqual([{ id: poolRequestId(ZAVODIL), pool: ZAVODIL, amount: NEAR }])
    pool.paused = { missing: true }
    expect((await p.quoteRequestWithdrawal({ amount: NEAR, pool: ZAVODIL })).amount).toBe(NEAR)
  })

  it('exits keep the factory and code checks', async () => {
    const node = new FakeNear()
    const { p } = setup({ pools: 'any' }, { node })
    expect((await refusal(p.quoteRequestWithdrawal({ amount: 'all', pool: 'lst-pool.near' }), 'pool-not-allowed')).refusals).toEqual(['not-factory-pool'])
    expect(node.touched('lst-pool.near')).toBe(0)
    node.accounts.get(ZAVODIL)!.codeHash = 'Evi1Code11111111111111111111111111111111111'
    expect((await refusal(p.quoteRequestWithdrawal({ amount: 'all', pool: ZAVODIL }), 'pool-not-allowed')).refusals).toEqual(['unknown-code'])
    expect((await refusal(p.quoteRequestWithdrawal({ amount: 'all', pool: 'gone.poolv1.near' }), 'pool-not-allowed')).refusals).toEqual(['not-found'])
  })

  it('the account must cover the fee', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    Object.assign(node.delegation(ASTRO), { staked: NEAR })
    node.accounts.get(ME)!.amount = STORAGE + 1000n
    await expect(p.quoteRequestWithdrawal({ amount: 'all' })).rejects.toBeInstanceOf(InsufficientFundsError)
  })
})

describe('claim', () => {
  it('refuses while unbonding: nothing-to-claim with the soonest unlock, not-withdrawable for an id', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: false })
    const e = await refusal(p.quoteClaimWithdrawals(), 'nothing-to-claim')
    const epoch = await p.getEpoch()
    expect(e.details!.soonest).toMatchObject({ source: 'estimate', earliestEpoch: epoch.height + 1n, latestEpoch: epoch.height + 4n })
    const n = await refusal(p.quoteClaimWithdrawals({ ids: [poolRequestId(ASTRO)] }), 'not-withdrawable')
    expect(n.details).toMatchObject({ pool: ASTRO, unlock: { source: 'estimate' } })
    await refusal(setup().p.quoteClaimWithdrawals(), 'nothing-to-claim')
  })

  it('refuses an id that matches no pool with an unstaked balance', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: true })
    await refusal(p.quoteClaimWithdrawals({ ids: [poolRequestId(FIGMENT)] }), 'unknown-request')
    await refusal(p.quoteClaimWithdrawals({ ids: [123n] }), 'unknown-request')
  })

  it('one withdraw_all per pool, sent with one approval through sendTransactions', async () => {
    const node = new FakeNear()
    const { p, account } = setup({}, { node, batch: true })
    Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: true })
    Object.assign(node.delegation(ZAVODIL), { unstaked: 3n * NEAR, canWithdraw: true })
    Object.assign(node.delegation(FIGMENT), { unstaked: 4n * NEAR, canWithdraw: false })
    const quote = await p.quoteClaimWithdrawals()
    expect(quote.amount).toBe(5n * NEAR)
    expect(quote.claims.map((c) => c.pool).sort()).toEqual([ASTRO, ZAVODIL].sort())
    expect(quote.transactions.every((tx) => sameTransactions([tx], [{ receiverId: tx.receiverId, actions: [fc('withdraw_all', {}, 125n * TGAS)] }]))).toBe(true)
    expect(quote.fee).toBe(feeOf(quote.transactions))
    const r = await p.claimWithdrawals({ expected: quote.transactions })
    expect(account.batches).toHaveLength(1)
    expect(sameTransactions(account.batches[0]!, quote.transactions)).toBe(true)
    expect(account.calls.filter((c) => c.method === 'sendTransaction')).toHaveLength(0)
    expect(r.hashes).toEqual(['BATCH1', 'BATCH2'])
    expect(r.hash).toBe('BATCH1')
  })

  it('without the batch hook: one sendTransaction per pool, in order; a failure carries the hashes sent', async () => {
    const node = new FakeNear()
    const { p, account } = setup({}, { node })
    Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: true })
    Object.assign(node.delegation(ZAVODIL), { unstaked: 3n * NEAR, canWithdraw: true })
    const quote = await p.quoteClaimWithdrawals()
    const r = await p.claimWithdrawals()
    expect(r.hashes).toHaveLength(2)
    expect(sameTransactions(quote.transactions, account.sent as NearTransaction[])).toBe(true)
    let n = 0
    const send = account.sendTransaction
    account.sendTransaction = async (tx, o) => { if (++n === 2) throw new Error('rejected on chain'); return send(tx, o) }
    const e = await p.claimWithdrawals().catch((x: unknown) => x)
    expect(e).toMatchObject({ message: 'rejected on chain', sent: [expect.any(String)] })
  })

  it('claims only the ids asked for, deduplicated', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: true })
    Object.assign(node.delegation(ZAVODIL), { unstaked: 3n * NEAR, canWithdraw: true })
    const q = await p.quoteClaimWithdrawals({ ids: [poolRequestId(ZAVODIL), poolRequestId(ZAVODIL)] })
    expect(q.claims).toEqual([{ id: poolRequestId(ZAVODIL), pool: ZAVODIL, amount: 3n * NEAR }])
  })
})

describe('positions, requests, balances', () => {
  it('reads listed, discovered and passed pools; drops non-factory ids without a read; warns about the pool', async () => {
    const node = new FakeNear()
    const discovered = vi.fn(async () => [FIGMENT, 'lst-pool.near', 'meta-pool.near'])
    const { p } = setup({ pools: [ASTRO], defaultPool: undefined, discover: discovered, maxFee: 5 }, { node })
    Object.assign(node.delegation(ASTRO), { staked: 3n * NEAR })
    Object.assign(node.delegation(FIGMENT), { staked: NEAR, unstaked: NEAR, canWithdraw: true })
    Object.assign(node.delegation(ZAVODIL), { staked: 2n * NEAR })
    node.pools.get(ZAVODIL)!.paused = true
    node.removeValidator(ZAVODIL, 'next')
    const ps = await p.listPositions({ pools: [ZAVODIL] })
    expect(discovered).toHaveBeenCalledWith(ME)
    expect(node.touched('lst-pool.near') + node.touched('meta-pool.near')).toBe(0)
    expect(ps.map((x) => x.pool)).toEqual([ASTRO, FIGMENT, ZAVODIL])
    expect(ps[1]).toMatchObject({ staked: NEAR, unstaked: NEAR, canWithdraw: true, withdrawable: NEAR, unlock: null, warnings: ['pool-fee-above-max'] })
    expect(ps[2]!.warnings).toEqual(['pool-paused', 'pool-leaving-set'])
    expect(ps[0]!.poolInfo).toMatchObject({ id: ASTRO, details: false, fee: { numerator: 1, denominator: 100 }, paused: false })
    node.removeValidator(ZAVODIL)
    const fresh = setup({ pools: [ASTRO], defaultPool: undefined, discover: discovered, maxFee: 5 }, { node }).p
    expect((await fresh.listPositions({ pools: [ZAVODIL] }))[2]!.warnings).toEqual(['pool-paused', 'pool-not-in-set'])
  })

  it("discover: 'fastnear' asks the indexer for the account's pools", async () => {
    const node = new FakeNear()
    Object.assign(node.delegation(ZAVODIL), { staked: NEAR })
    const fetch = vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => ({ account_id: ME, pools: [{ pool_id: ZAVODIL, last_update_block_height: 1 }] }), url }))
    vi.stubGlobal('fetch', fetch)
    const p = new NativeStakingProtocolNear(nearAccount(), { pools: 'any', provider: node.fetch })
    expect((await p.listPositions()).map((x) => x.pool)).toEqual([ZAVODIL])
    expect(fetch.mock.calls[0]![0]).toBe(`https://api.fastnear.com/v1/account/${ME}/staking`)
    fetch.mockImplementation((async () => ({ ok: false, status: 503, json: async () => ({}), url: '' })) as never)
    await expect(p.listPositions()).rejects.toThrow(/HTTP 503/) // never shown as "no stake"
  })

  it('getWithdrawalRequests and getStakedBalance', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    Object.assign(node.delegation(ASTRO), { staked: 3n * NEAR, unstaked: 2n * NEAR, canWithdraw: false })
    Object.assign(node.delegation(ZAVODIL), { staked: NEAR, unstaked: 5n * NEAR, canWithdraw: true })
    const w = await p.getWithdrawalRequests()
    expect(w).toMatchObject({ pendingAmount: 2n * NEAR, claimableAmount: 5n * NEAR, claimableIds: [poolRequestId(ZAVODIL)] })
    expect(w.requests.map((r) => [r.pool, r.amount, r.claimable, r.timestamp])).toEqual([[ASTRO, 2n * NEAR, false, 0], [ZAVODIL, 5n * NEAR, true, 0]])
    expect(w.requests[0]!.unlock).toMatchObject({ source: 'estimate' })
    expect(w.requests[1]!.unlock).toBeNull()
    const b = await p.getStakedBalance()
    expect(b).toMatchObject({ balance: 4n * NEAR, total: 11n * NEAR, unstaked: 7n * NEAR, withdrawable: 5n * NEAR, wrappedBalance: 0n, rate: 0n })
    expect(b.positions).toHaveLength(2)
  })

  describe('unlock dating from history', () => {
    const unstakeTx = (block: bigint, time = 1_794_060_000, extra: Partial<ChainTx> = {}): ChainTx => ({
      chain: 'near:mainnet', hash: `H${block}`, time, status: 'confirmed', address: ME, from: ME, to: ASTRO, nativeValue: 0n, transfers: [],
      call: { to: ASTRO, method: 'unstake', programs: ['unstake'] }, block, ...extra,
    })
    const history = (items: ChainTx[] | Error): HistorySource => ({
      chain: 'near:mainnet',
      listActivity: async () => { if (items instanceof Error) throw items; return { items, cursor: null } as never },
      getTransaction: async () => undefined,
      explorerTxUrl: (h) => h,
    })

    it("dates the unstake: its epoch + 4, source 'history', the request timestamp is the tx time", async () => {
      const node = new FakeNear()
      const start = BigInt(node.validators.epoch_start_height)
      const { p } = setup({ history: history([unstakeTx(start - 10_000n, 1_794_060_000)]) }, { node })
      Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: false })
      const epoch = await p.getEpoch()
      const [pos] = await p.listPositions()
      expect(pos!.unlock).toEqual({ epoch: epoch.height + 3n, earliestEpoch: epoch.height + 3n, latestEpoch: epoch.height + 3n, at: epochStartsAt(epoch, epoch.height + 3n), earliestAt: epochStartsAt(epoch, epoch.height + 3n), latestAt: epochStartsAt(epoch, epoch.height + 3n), source: 'history' })
      expect((await p.getWithdrawalRequests()).requests[0]!.timestamp).toBe(1_794_060_000)
    })

    it('checks the chain for an unstake right before an estimated boundary', async () => {
      const node = new FakeNear()
      const start = BigInt(node.validators.epoch_start_height)
      // The node says that block is already in the current epoch (a skipped height moved the boundary).
      const block = start - 5n
      node.epochIds.set(`epoch-${node.validators.epoch_height - 1}`, node.validators.epoch_height)
      const { p } = setup({ history: history([unstakeTx(block)]) }, { node })
      Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: false })
      expect((await p.listPositions())[0]!.unlock!.epoch).toBe(node.epochHeight + 4n)
      expect(node.count('validators', (q) => typeof q.epoch_id === 'string')).toBe(1)
    })

    it('falls back to the estimate: history failing, no matching tx, a failed or foreign tx, an epoch already reached', async () => {
      const node = new FakeNear()
      const start = BigInt(node.validators.epoch_start_height)
      Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: false })
      for (const h of [
        history(new Error('429')),
        history([]),
        history([unstakeTx(start - 100n, 1, { status: 'failed' })]),
        history([unstakeTx(start - 100n, 1, { from: 'bob.near' })]),
        history([unstakeTx(start - 100n, 1, { call: { to: ZAVODIL, method: 'unstake', programs: ['unstake'] } })]),
        history([unstakeTx(start - 5n * 43_200n)]), // epoch + 4 ≤ current while the pool says locked: history missed a later unstake
      ]) {
        const { p } = setup({ history: h }, { node })
        const [pos] = await p.listPositions()
        expect(pos!.unlock!.source).toBe('estimate')
        expect((await p.getWithdrawalRequests()).requests[0]!.timestamp).toBe(0)
      }
    })

    it('[withdraw_all, unstake] in one transaction counts as the unstake', async () => {
      const node = new FakeNear()
      const start = BigInt(node.validators.epoch_start_height)
      const { p } = setup({ history: history([unstakeTx(start + 10n, 5, { call: { to: ASTRO, method: 'withdraw_all', programs: ['withdraw_all', 'unstake'] } })]) }, { node })
      Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: false })
      expect((await p.listPositions())[0]!.unlock).toMatchObject({ source: 'history', epoch: node.epochHeight + 4n })
    })
  })
})
