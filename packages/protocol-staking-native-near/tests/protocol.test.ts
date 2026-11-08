import { afterEach, describe, expect, it, vi } from 'vitest'
import { InsufficientFundsError, ReadOnlyAccountError, type ChainTx, type HistorySource } from '@anywalletkit/core'
import { WalletAccountReadOnlyNear, type NearTransaction } from '@anywalletkit/wallet-near'
import {
  DEFAULT_RESERVE, NativeStakingProtocolNear, NearStakingError, epochStartsAt, poolRequestId, sameTransactions, type NativeStakingNearConfig,
} from '../src/index.js'
import { ASTRO, AURORA, FIGMENT, FakeNear, ME, NEAR, TGAS, ZAVODIL, nearAccount } from './fake-near.js'

// The fake node's gas price (10^8) + the 10 % margin, and mainnet's min_gas_purchase_price (10^9).
const GAS_PRICE = 110_000_000n
const PURCHASE_PRICE = 1_000_000_000n
const gasOf = (txs: NearTransaction[]) => txs.reduce((s, tx) => s + WalletAccountReadOnlyNear.gasOf(tx.actions, false), 0n)
const feeOf = (txs: NearTransaction[]) => gasOf(txs) * GAS_PRICE
const upfrontOf = (txs: NearTransaction[]) => gasOf(txs) * PURCHASE_PRICE
const fc = (methodName: string, args: Record<string, unknown>, gas: bigint, deposit = 0n) => ({ functionCall: { methodName, args, gas, deposit } })
/** What `stake` leaves: the upfront gas of the largest exit ([withdraw_all, unstake] of the longest amount, 50 Tgas each), above the 0.02 NEAR default. */
const EXIT_RESERVE = upfrontOf([{ receiverId: ASTRO, actions: [fc('withdraw_all', {}, 50n * TGAS), fc('unstake', { amount: '9'.repeat(39) }, 50n * TGAS)] }])
const STORAGE = 182n * 10n ** 19n

/** Config overrides; `defaultPool: undefined` removes the default. */
function setup(config: { [K in keyof NativeStakingNearConfig]?: NativeStakingNearConfig[K] | undefined } = {}, o: { node?: FakeNear; batch?: boolean; chain?: string; address?: string } = {}) {
  const node = o.node ?? new FakeNear()
  const account = nearAccount({ ...(o.batch ? { batch: true } : {}), ...(o.chain ? { chain: o.chain } : {}), ...(o.address ? { address: o.address } : {}) })
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
    expect(p.gas).toEqual({ stake: 50n * TGAS, unstake: 50n * TGAS, withdraw: 50n * TGAS })
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

  it('a staking-farm pool with a higher fee scheduled for the next epoch is fee-above-max (get_pool_summary)', async () => {
    const node = new FakeNear()
    const FARM = 'farm.pool.near'
    node.addValidator(FARM, { reward: 10n ** 24n })
    node.addPool(FARM, { codeHash: 'AjD4YJaXgpiRdiArqnzyDi7Bkr1gJms9Z2w7Ev5esTKB', fee: { numerator: 1, denominator: 100 } })
    const { p } = setup({ pools: 'any' }, { node })
    expect(await p.getPool(FARM)).toMatchObject({ eligible: true, fee: { numerator: 1, denominator: 100 }, nextFee: { numerator: 1, denominator: 100 }, feePercent: 1 })
    const pool = node.pools.get(FARM)!
    pool.summary = { reward_fee_fraction: { numerator: 1, denominator: 100 }, next_reward_fee_fraction: { numerator: 100, denominator: 100 }, total_staked_balance: 1.0458291324794507e31 }
    const info = await p.getPool(FARM)
    expect(info).toMatchObject({ eligible: false, refusals: ['fee-above-max'], fee: { numerator: 1, denominator: 100 }, nextFee: { numerator: 100, denominator: 100 }, feePercent: 1 })
    expect(info.apr).toBe(0) // the APR looks forward: nothing is left after a 100 % fee
    await refusal(p.quoteStake({ amount: NEAR, pool: FARM }), 'pool-not-allowed')
    // a farm build that does not answer its summary is fee-unknown, even when get_reward_fee_fraction answers
    pool.summary = { missing: true }
    expect((await p.getPool(FARM)).refusals).toEqual(['fee-unknown'])
    pool.summary = { reward_fee_fraction: { numerator: 1, denominator: 100 } }
    expect((await p.getPool(FARM)).refusals).toEqual(['fee-unknown'])
    // a poolv1 pool (core-contracts, no schedule) keeps get_reward_fee_fraction and a null nextFee
    expect(await p.getPool(ASTRO)).toMatchObject({ nextFee: null, eligible: true })
    expect(node.count('query', (q) => q.account_id === ASTRO && q.method_name === 'get_pool_summary')).toBe(0)
  })

  it('positions flag a farm pool whose scheduled fee is above the cap', async () => {
    const node = new FakeNear()
    const FARM = 'farm.pool.near'
    node.addPool(FARM, { codeHash: 'AjD4YJaXgpiRdiArqnzyDi7Bkr1gJms9Z2w7Ev5esTKB' })
    node.pools.get(FARM)!.summary = { reward_fee_fraction: { numerator: 1, denominator: 100 }, next_reward_fee_fraction: { numerator: 50, denominator: 100 } }
    Object.assign(node.delegation(FARM), { staked: NEAR })
    const { p } = setup({ pools: [FARM], defaultPool: undefined }, { node })
    expect((await p.listPositions())[0]!.warnings).toContain('pool-fee-above-max')
  })

  it('a *.pool.near build accepted through codeHashes still gets the scheduled-fee check', async () => {
    const node = new FakeNear()
    const FARM = 'farm.pool.near'
    const NEW_BUILD = 'NewFarmBui1d1111111111111111111111111111111'
    node.addValidator(FARM, { reward: 10n ** 24n })
    node.addPool(FARM, { codeHash: NEW_BUILD, fee: { numerator: 1, denominator: 100 } })
    const pool = node.pools.get(FARM)!
    pool.summary = { reward_fee_fraction: { numerator: 1, denominator: 100 }, next_reward_fee_fraction: { numerator: 100, denominator: 100 } }
    const { p } = setup({ pools: 'any', codeHashes: [NEW_BUILD] }, { node })
    const info = await p.getPool(FARM)
    expect(info).toMatchObject({ codeHashKnown: true, eligible: false, refusals: ['fee-above-max'], nextFee: { numerator: 100, denominator: 100 } })
    await refusal(p.quoteStake({ amount: NEAR, pool: FARM }), 'pool-not-allowed')
    // without a summary the read code is a farm build that cannot show its schedule: fee-unknown, not the plain fee
    pool.summary = { missing: true }
    expect((await p.getPool(FARM)).refusals).toEqual(['fee-unknown'])
    // an extra build on a *.poolv1.near pool keeps the plain fee (core-contracts pools schedule nothing)
    node.accounts.get(ZAVODIL)!.codeHash = NEW_BUILD
    expect(await p.getPool(ZAVODIL)).toMatchObject({ nextFee: null, refusals: [] })
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
    expect(quote.upfront).toBe(upfrontOf(quote.transactions))
    expect(quote.reserve).toBe(EXIT_RESERVE)
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

  it('amount + upfront gas + reserve must fit the available balance (balance − the storage the locked balance does not cover)', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    const upfront = upfrontOf([{ receiverId: ASTRO, actions: [fc('deposit_and_stake', {}, 50n * TGAS, 1n)] }])
    const available = 10n * NEAR - STORAGE
    const max = available - EXIT_RESERVE - upfront
    expect(await p.getMaxStakeable()).toBe(max)
    expect((await p.quoteStake({ amount: max })).maxStakeable).toBe(max)
    const e = await p.quoteStake({ amount: max + 1n }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(InsufficientFundsError)
    expect(e).toMatchObject({ required: max + 1n + upfront + EXIT_RESERVE, available })
    node.accounts.delete(ME) // a fresh implicit account that was never funded
    expect(await p.getMaxStakeable()).toBe(0n)
  })

  it('a locked balance is not part of `amount` and pays for storage first: available = amount − max(0, storage − locked)', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    const upfront = upfrontOf([{ receiverId: ASTRO, actions: [fc('deposit_and_stake', {}, 50n * TGAS, 1n)] }])
    // 50 NEAR liquid next to 40 NEAR locked (a direct stake): all 50 are spendable, the locked 40 cover the storage.
    Object.assign(node.accounts.get(ME)!, { amount: 50n * NEAR, locked: 40n * NEAR })
    expect(await p.getMaxStakeable()).toBe(50n * NEAR - EXIT_RESERVE - upfront)
    expect((await p.quoteStake({ amount: 45n * NEAR })).amount).toBe(45n * NEAR)
    // locked ≥ amount no longer reads as nothing available
    Object.assign(node.accounts.get(ME)!, { amount: NEAR, locked: 5n * NEAR })
    expect(await p.getMaxStakeable()).toBe(NEAR - EXIT_RESERVE - upfront)
    // a locked balance smaller than the storage covers part of it
    Object.assign(node.accounts.get(ME)!, { amount: 10n * NEAR, locked: STORAGE / 2n })
    expect(await p.getMaxStakeable()).toBe(10n * NEAR - STORAGE / 2n - EXIT_RESERVE - upfront)
  })

  it('prepaid gas is bought upfront at min_gas_purchase_price: the fresh-account delivery from the audit fits', async () => {
    // 1Click delivered 1.35527 NEAR to a new implicit account; 1.35345 is spendable after its storage.
    const node = new FakeNear()
    node.accounts.get(ME)!.amount = 1_353_450_000_000_000_000_000_000n + STORAGE
    const { p } = setup({}, { node })
    const max = await p.getMaxStakeable()
    const q = await p.quoteStake({ amount: max })
    // What the node checks when it accepts the transaction: deposit + prepaid gas × max(gas price, purchase price).
    const nodeNeeds = max + gasOf(q.transactions) * PURCHASE_PRICE
    expect(nodeNeeds).toBeLessThanOrEqual(1_353_450_000_000_000_000_000_000n)
    // and what is left still pays for the unstake later (50 Tgas bought at 10^9 = 0.05 NEAR + conversion).
    expect(1_353_450_000_000_000_000_000_000n - nodeNeeds).toBeGreaterThanOrEqual(50n * TGAS * PURCHASE_PRICE)
    expect(q.fee).toBeLessThan(q.upfront)
  })

  it('the purchase price comes from the protocol config, cached; a node that cannot say gets the mainnet value', async () => {
    const node = new FakeNear()
    node.minGasPurchasePrice = '2000000000'
    const { p } = setup({}, { node })
    const q = await p.quoteStake({ amount: NEAR })
    expect(q.upfront).toBe(gasOf(q.transactions) * 2_000_000_000n)
    await p.quoteStake({ amount: NEAR })
    expect(node.count('EXPERIMENTAL_protocol_config')).toBe(1)
    for (const v of [{ throws: 'method not found' }, { missing: true as const }] as const) {
      const n = new FakeNear()
      n.minGasPurchasePrice = v
      const r = await setup({}, { node: n }).p.quoteStake({ amount: NEAR })
      expect(r.upfront).toBe(upfrontOf(r.transactions))
    }
    // A gas price above the floor is what the node charges instead.
    const high = new FakeNear()
    high.gasPrice = '5000000000'
    const h = await setup({}, { node: high }).p.quoteStake({ amount: NEAR })
    expect(h.upfront).toBe(h.fee)
  })

  it('an explicit reserve is honoured above the exit floor, never below it', async () => {
    const { p } = setup({ reserve: 0n })
    expect((await p.quoteStake({ amount: NEAR })).reserve).toBe(EXIT_RESERVE)
    const big = setup({ reserve: NEAR }).p
    expect((await big.quoteStake({ amount: NEAR })).reserve).toBe(NEAR)
    expect(DEFAULT_RESERVE).toBeLessThan(EXIT_RESERVE)
  })

  it('maxFee is checked by the module itself (wallet-selector adapters ignore it); the quoted fee passes', async () => {
    const { p, account } = setup()
    const quote = await p.quoteStake({ amount: NEAR })
    const e = await refusal(p.stake({ amount: NEAR, maxFee: quote.fee - 1n }), 'max-fee-exceeded')
    expect(e.details).toMatchObject({ fee: quote.fee, maxFee: quote.fee - 1n })
    expect(account.sent).toHaveLength(0)
    // wallet-near's own estimate (gas × gas price × 1.1) is what the quote reports, so it passes there too.
    const estimate = gasOf(quote.transactions) * ((100_000_000n * 11n) / 10n)
    expect(quote.fee).toBe(estimate)
    await p.stake({ amount: NEAR, maxFee: quote.fee, expected: quote.transactions })
    expect(account.sent).toHaveLength(1)
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
    const hours = (q.unlock!.earliestAt - node.final.timestamp / 1e6) / 3.6e6
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

  it('refuses an unstake that would leave less than 0.001 NEAR unstaked: the module never offers such a balance as a claim', async () => {
    const { p, node, account } = setup()
    const d = Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 0n, canWithdraw: true })
    const e = await refusal(p.quoteRequestWithdrawal({ amount: 9n * 10n ** 20n }), 'below-minimum')
    expect(e.details).toMatchObject({ minimum: 10n ** 21n, pool: ASTRO, amount: 9n * 10n ** 20n })
    await refusal(p.requestWithdrawal({ amount: 9n * 10n ** 20n }), 'below-minimum')
    expect(account.sent).toHaveLength(0)
    // rounding dust already in the pool counts: together they reach the minimum
    d.unstaked = 2n
    expect((await p.quoteRequestWithdrawal({ amount: 10n ** 21n - 2n })).amount).toBe(10n ** 21n - 2n)
    // next to an unlocked balance the withdraw_all takes that out first, so only the amount stays
    Object.assign(d, { unstaked: 2n * NEAR, canWithdraw: true })
    await refusal(p.quoteRequestWithdrawal({ amount: 9n * 10n ** 20n }), 'below-minimum')
    // part of a dust stake too
    Object.assign(d, { staked: 9n * 10n ** 20n, unstaked: 0n })
    await refusal(p.quoteRequestWithdrawal({ amount: 4n * 10n ** 20n }), 'below-minimum')
    d.staked = 10n ** 21n
    expect((await p.quoteRequestWithdrawal({ amount: 'all' })).amount).toBe(10n ** 21n)
  })

  it('refuses a partial unstake that would leave less than 0.001 NEAR staked; the whole of such a stake still goes out', async () => {
    const { p, node, account } = setup()
    const d = Object.assign(node.delegation(ASTRO), { staked: 15n * 10n ** 20n, unstaked: 0n, canWithdraw: true })
    const e = await refusal(p.requestWithdrawal({ amount: 10n ** 21n }), 'below-minimum')
    expect(e.message).toMatch(/'all'/)
    expect(e.details).toMatchObject({ minimum: 10n ** 21n, pool: ASTRO, amount: 10n ** 21n, staked: 15n * 10n ** 20n })
    expect(account.sent).toHaveLength(0)
    // of 0.0015 NEAR only the whole goes (a smaller part would leave too little unstaked)
    await refusal(p.quoteRequestWithdrawal({ amount: 5n * 10n ** 20n }), 'below-minimum')
    expect((await p.quoteRequestWithdrawal({ amount: 15n * 10n ** 20n })).warnings).toEqual([])
    // exactly 0.001 NEAR left staked is fine
    d.staked = 2n * 10n ** 21n
    expect((await p.quoteRequestWithdrawal({ amount: 10n ** 21n })).amount).toBe(10n ** 21n)
    // a stake below the minimum (made outside the module) next to an unlocked balance: 'all' takes both out
    Object.assign(d, { staked: 5n * 10n ** 20n, unstaked: 10n ** 21n, canWithdraw: true })
    const all = await p.requestWithdrawal({ amount: 'all' })
    expect(all.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('withdraw_all', {}, 50n * TGAS), fc('unstake_all', {}, 50n * TGAS)] }])
    expect(all.warnings.map((w) => w.code)).toEqual(['withdraws-unlocked-first', 'leaves-dust'])
    // after a claim, alone: 'all' and the exact amount both go out, a part of it does not
    Object.assign(d, { staked: 5n * 10n ** 20n, unstaked: 0n })
    const q = await p.quoteRequestWithdrawal({ amount: 'all' })
    expect(q.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('unstake_all', {}, 50n * TGAS)] }])
    expect(q.warnings.map((w) => w.code)).toEqual(['leaves-dust'])
    expect((await p.quoteRequestWithdrawal({ amount: 5n * 10n ** 20n })).warnings.map((w) => w.code)).toEqual(['leaves-dust'])
    await refusal(p.quoteRequestWithdrawal({ amount: 10n ** 20n }), 'below-minimum')
    // in a paused pool too: exits skip the pause check
    node.pools.get(ASTRO)!.paused = true
    expect((await p.quoteRequestWithdrawal({ amount: 'all' })).amount).toBe(5n * 10n ** 20n)
  })

  it('the reserve a stake leaves pays for the largest exit: [withdraw_all, unstake] after the most a stake can send', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    const max = await p.getMaxStakeable()
    const stake = await p.quoteStake({ amount: max })
    // after the stake: the reserve plus the unburnt part of the stake's prepaid gas (27.7 Tgas burnt on mainnet)
    const burnt = 28n * TGAS * 100_000_000n
    node.accounts.get(ME)!.amount = 10n * NEAR - max - burnt
    expect(10n * NEAR - max - burnt - STORAGE).toBeGreaterThan(stake.reserve)
    // part unstaked earlier, unlocked by now; the rest goes in one transaction
    Object.assign(node.delegation(ASTRO), { staked: max - NEAR, unstaked: NEAR, canWithdraw: true })
    const q = await p.quoteRequestWithdrawal({ amount: 'all' })
    expect(q.transactions[0]!.actions.map((a) => ('functionCall' in a ? a.functionCall.methodName : '?'))).toEqual(['withdraw_all', 'unstake_all'])
    expect(q.upfront).toBeLessThanOrEqual(stake.reserve)
  })

  it("'claim-first' when the account cannot pay [withdraw_all, unstake] at once but can pay the claim", async () => {
    const node = new FakeNear()
    const { p, account } = setup({}, { node })
    Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: NEAR, canWithdraw: true })
    const claimUpfront = upfrontOf([{ receiverId: ASTRO, actions: [fc('withdraw_all', {}, 50n * TGAS)] }])
    node.accounts.get(ME)!.amount = STORAGE + claimUpfront + 10n ** 21n
    const e = await refusal(p.requestWithdrawal({ amount: NEAR }), 'claim-first')
    expect(e.message).toMatch(/claimWithdrawals/)
    expect(e.details).toMatchObject({ pool: ASTRO, id: poolRequestId(ASTRO), withdrawable: NEAR, available: claimUpfront + 10n ** 21n })
    expect(account.sent).toHaveLength(0)
    // the claim alone goes out
    expect((await p.quoteClaimWithdrawals()).claims).toEqual([{ id: poolRequestId(ASTRO), pool: ASTRO, amount: NEAR }])
    // below even the claim's gas it is a plain shortfall
    node.accounts.get(ME)!.amount = STORAGE + claimUpfront - 1n
    await expect(p.quoteRequestWithdrawal({ amount: NEAR })).rejects.toBeInstanceOf(InsufficientFundsError)
  })

  it('an unlocked balance is withdrawn first in the same transaction: [withdraw_all, unstake], 100 Tgas', async () => {
    const { p, node } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 2n * NEAR, canWithdraw: true })
    const q = await p.quoteRequestWithdrawal({ amount: NEAR })
    expect(q.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('withdraw_all', {}, 50n * TGAS), fc('unstake', { amount: String(NEAR) }, 50n * TGAS)] }])
    expect(q.upfront).toBe(upfrontOf(q.transactions))
    expect(q).toMatchObject({ withdrawsFirst: 2n * NEAR, resetsTimer: false })
    expect(q.warnings.map((w) => w.code)).toEqual(['withdraws-unlocked-first'])
    const all = await p.quoteRequestWithdrawal({ amount: 'all' })
    expect(all.transactions[0]!.actions.map((a) => ('functionCall' in a ? a.functionCall.methodName : '?'))).toEqual(['withdraw_all', 'unstake_all'])
  })

  it('a locked unstaked balance would restart its timer: refused unless allowTimerReset', async () => {
    const { p, node, account } = setup()
    Object.assign(node.delegation(ASTRO), { staked: 5n * NEAR, unstaked: 2n * NEAR, canWithdraw: false })
    const e = await refusal(p.quoteRequestWithdrawal({ amount: NEAR }), 'timer-reset-refused')
    expect(e.details).toMatchObject({ pool: ASTRO, unstaked: 2n * NEAR, amount: NEAR })
    await refusal(p.requestWithdrawal({ amount: NEAR }), 'timer-reset-refused')
    expect(account.sent).toHaveLength(0)
    const q = await p.quoteRequestWithdrawal({ amount: NEAR, allowTimerReset: true })
    expect(q.transactions[0]!.actions).toHaveLength(1)
    expect(q.resetsTimer).toBe(true)
    expect(q.warnings).toEqual([{ code: 'resets-unbonding-timer', message: expect.stringMatching(/restarts its 4-epoch wait/) as unknown as string }])
  })

  it('the audit case (nima.near): dust stake beside 168.9 locked NEAR is never unstaked, not even with allowTimerReset', async () => {
    const { p } = setup({ defaultPool: undefined }, { node: new FakeNear(), address: 'nima.near' })
    // astro-stakers holds 7·10⁻⁷ NEAR staked and 168.9 NEAR unbonding for nima.near (recorded on mainnet).
    await refusal(p.quoteRequestWithdrawal({ amount: 'all' }), 'pool-required') // dust is not a stake to pick a pool by
    const e = await refusal(p.quoteRequestWithdrawal({ amount: 'all', pool: ASTRO, allowTimerReset: true }), 'timer-reset-refused')
    expect((e.details!.unstaked as bigint) > 168n * NEAR).toBe(true)
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
    const quote = await p.quoteRequestWithdrawal({ amount: NEAR, allowTimerReset: true })
    d.canWithdraw = true
    const e = await refusal(p.requestWithdrawal({ amount: NEAR, allowTimerReset: true, expected: quote.transactions }), 'quote-changed')
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

  it('the account must cover the upfront gas, not just the fee (0.02 NEAR left cannot buy 50 Tgas at 10^9)', async () => {
    const node = new FakeNear()
    const { p } = setup({}, { node })
    Object.assign(node.delegation(ASTRO), { staked: NEAR })
    node.accounts.get(ME)!.amount = STORAGE + DEFAULT_RESERVE
    const e = await p.quoteRequestWithdrawal({ amount: 'all' }).catch((x: unknown) => x)
    expect(e).toBeInstanceOf(InsufficientFundsError)
    expect((e as InsufficientFundsError).required).toBe(upfrontOf([{ receiverId: ASTRO, actions: [fc('unstake_all', {}, 50n * TGAS)] }]))
    // what a stake leaves is enough
    node.accounts.get(ME)!.amount = STORAGE + EXIT_RESERVE
    expect((await p.quoteRequestWithdrawal({ amount: 'all' })).amount).toBe(NEAR)
    // and a claim the same
    Object.assign(node.delegation(ASTRO), { staked: 0n, unstaked: NEAR, canWithdraw: true })
    expect((await p.quoteClaimWithdrawals()).amount).toBe(NEAR)
  })

  it('a pool.near pool upgraded to code its factory allows can still be left; unknown, disallowed code cannot', async () => {
    const node = new FakeNear()
    const { p } = setup({ pools: 'any' }, { node })
    node.addPool('farm.pool.near', { codeHash: 'NewFarmBui1d1111111111111111111111111111111' })
    Object.assign(node.delegation('farm.pool.near'), { staked: 2n * NEAR, unstaked: NEAR, canWithdraw: true })
    expect((await refusal(p.quoteStake({ amount: NEAR, pool: 'farm.pool.near' }), 'pool-not-allowed')).refusals).toContain('unknown-code')
    expect((await refusal(p.quoteRequestWithdrawal({ amount: 'all', pool: 'farm.pool.near' }), 'pool-not-allowed')).refusals).toEqual(['unknown-code'])
    node.factoryAllowed.add('NewFarmBui1d1111111111111111111111111111111')
    expect((await p.quoteRequestWithdrawal({ amount: 'all', pool: 'farm.pool.near' })).amount).toBe(2n * NEAR)
    expect((await p.quoteClaimWithdrawals({ pools: ['farm.pool.near'] })).amount).toBe(NEAR)
    // poolv1 has no such factory view: an unknown build there stays refused
    node.accounts.get(ZAVODIL)!.codeHash = 'NewFarmBui1d1111111111111111111111111111111'
    Object.assign(node.delegation(ZAVODIL), { staked: NEAR })
    await refusal(p.quoteRequestWithdrawal({ amount: 'all', pool: ZAVODIL }), 'pool-not-allowed')
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
    expect(quote.transactions.every((tx) => sameTransactions([tx], [{ receiverId: tx.receiverId, actions: [fc('withdraw_all', {}, 50n * TGAS)] }]))).toBe(true)
    expect(quote.fee).toBe(feeOf(quote.transactions))
    expect(quote.upfront).toBe(upfrontOf(quote.transactions))
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

  it('a discovery outage does not block the listed and touched pools: balances, requests and claims go on, flagged partial', async () => {
    const node = new FakeNear()
    Object.assign(node.delegation(ASTRO), { staked: 2n * NEAR, unstaked: NEAR, canWithdraw: true })
    Object.assign(node.delegation(ZAVODIL), { staked: NEAR }) // only the indexer knows about this one
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}), url: '' })))
    const p = new NativeStakingProtocolNear(nearAccount(), { pools: [ASTRO], provider: node.fetch })
    const b = await p.getStakedBalance()
    expect(b).toMatchObject({ balance: 2n * NEAR, unstaked: NEAR, partial: true })
    expect((await p.getWithdrawalRequests()).partial).toBe(true)
    expect((await p.quoteClaimWithdrawals()).claims.map((c) => c.pool)).toEqual([ASTRO])
    // no guessing which pool to unstake from while the list is incomplete
    const any = new NativeStakingProtocolNear(nearAccount(), { pools: 'any', provider: node.fetch })
    await refusal(any.quoteRequestWithdrawal({ amount: 'all' }), 'pool-required')
    expect((await any.quoteRequestWithdrawal({ amount: 'all', pool: ZAVODIL })).amount).toBe(NEAR)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ pools: [{ pool_id: ZAVODIL }] }), url: '' })))
    expect((await p.getStakedBalance()).partial).toBe(false)
  })

  it('exits do not depend on the validator set or the epoch: unstake and claim go out while those reads fail', async () => {
    const node = new FakeNear()
    let down = true
    const provider: typeof node.fetch = async (method, params) => {
      const q = params as Record<string, unknown> | unknown[]
      if (down && ((method === 'validators' && Array.isArray(q) && q[0] === null) || (method === 'block' && !Array.isArray(q) && q.finality === 'final'))) {
        throw new Error(`${method}: 503 Service Unavailable`)
      }
      return node.fetch(method, params)
    }
    const { p, account } = setup({ provider, defaultPool: undefined }, { node })
    Object.assign(node.delegation(ASTRO), { staked: 3n * NEAR })
    Object.assign(node.delegation(ZAVODIL), { unstaked: 2n * NEAR, canWithdraw: true })
    Object.assign(node.delegation(FIGMENT), { unstaked: NEAR, canWithdraw: false })
    await expect(p.getEpoch()).rejects.toThrow(/503/)
    // unstake: the only staked pool is found, the transaction is built, the unlock is left undated
    const u = await p.requestWithdrawal({ amount: NEAR })
    expect(u).toMatchObject({ pool: ASTRO, unlock: null })
    expect(u.transactions).toEqual([{ receiverId: ASTRO, actions: [fc('unstake', { amount: String(NEAR) }, 50n * TGAS)] }])
    // requests and claims: amounts from get_account, no pool info or unlock estimate
    const w = await p.getWithdrawalRequests()
    expect(w).toMatchObject({ claimableIds: [poolRequestId(ZAVODIL)], claimableAmount: 2n * NEAR, pendingAmount: NEAR })
    expect(w.requests.find((r) => r.pool === FIGMENT)!.unlock).toBeNull()
    const c = await p.claimWithdrawals({ ids: w.claimableIds })
    expect(c.claims).toEqual([{ id: poolRequestId(ZAVODIL), pool: ZAVODIL, amount: 2n * NEAR }])
    expect(account.sent.at(-1)).toEqual({ receiverId: ZAVODIL, actions: [fc('withdraw_all', {}, 50n * TGAS)] })
    await refusal(p.quoteClaimWithdrawals({ ids: [poolRequestId(FIGMENT)] }), 'not-withdrawable')
    const b = await p.getStakedBalance()
    expect(b).toMatchObject({ balance: 3n * NEAR, unstaked: 3n * NEAR, withdrawable: 2n * NEAR })
    expect(b.positions.map((x) => [x.pool, x.poolInfo, x.warnings])).toEqual([[ASTRO, null, []], [FIGMENT, null, []], [ZAVODIL, null, []]])
    // the validator set back, the epoch still down: pool info returns, unlocks stay undated
    down = false
    const fresh = setup({ provider: async (method, params) => {
      if (method === 'block' && (params as Record<string, unknown>).finality === 'final') throw new Error('block: timeout')
      return node.fetch(method, params)
    }, defaultPool: undefined }, { node }).p
    const ps = await fresh.listPositions()
    expect(ps.find((x) => x.pool === ASTRO)!.poolInfo).toMatchObject({ id: ASTRO, inCurrentSet: true, inNextSet: true })
    expect(ps.find((x) => x.pool === FIGMENT)!.unlock).toBeNull()
    expect((await fresh.quoteRequestWithdrawal({ amount: NEAR, pool: ASTRO })).unlock).toBeNull()
  })

  it('without the epoch, nothing-to-claim still says the NEAR is unbonding (no unlock estimate to show)', async () => {
    const node = new FakeNear()
    const { p } = setup({ provider: async (method, params) => {
      if (method === 'block' && (params as Record<string, unknown>).finality === 'final') throw new Error('block: timeout')
      return node.fetch(method, params)
    } }, { node })
    Object.assign(node.delegation(FIGMENT), { unstaked: 2n * NEAR, canWithdraw: false })
    const e = await refusal(p.quoteClaimWithdrawals(), 'nothing-to-claim')
    expect(e.message).toMatch(/still unbonding/)
    expect(e.details).toMatchObject({ soonest: null, epoch: null })
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
    expect(b).toMatchObject({ balance: 4n * NEAR, total: 11n * NEAR, unstaked: 7n * NEAR, withdrawable: 5n * NEAR, wrappedBalance: 0n, rate: 0n, partial: false })
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

    it("an unstake in an epoch's last heights may unlock one epoch later: dated as a two-epoch range", async () => {
      const node = new FakeNear()
      const start = BigInt(node.validators.epoch_start_height)
      Object.assign(node.delegation(ASTRO), { unstaked: 2n * NEAR, canWithdraw: false })
      // The transaction landed 2 heights before this epoch began; its receipt may have run in this epoch.
      const block = start - 2n
      node.epochIds.set(`epoch-${node.validators.epoch_height - 1}`, node.validators.epoch_height - 1)
      const { p } = setup({ history: history([unstakeTx(block, 7)]) }, { node })
      const epoch = await p.getEpoch()
      const [pos] = await p.listPositions()
      expect(pos!.unlock).toEqual({ epoch: null, earliestEpoch: epoch.height + 3n, latestEpoch: epoch.height + 4n, at: null, earliestAt: epochStartsAt(epoch, epoch.height + 3n), latestAt: epochStartsAt(epoch, epoch.height + 4n), source: 'history' })
      expect((await p.getWithdrawalRequests()).requests[0]!.timestamp).toBe(7)
      // Further from the boundary it stays exact.
      const far = setup({ history: history([unstakeTx(start - 10n, 7)]) }, { node }).p
      expect((await far.listPositions())[0]!.unlock).toMatchObject({ epoch: epoch.height + 3n, source: 'history' })
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
