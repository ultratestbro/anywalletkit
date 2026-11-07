import { describe, expect, it } from 'vitest'
import { NativeStakingProtocolNear, NearStakingError, annualize, epochsPerYear, networkGrossApr, parseValidators, poolGrossApr } from '../src/index.js'
import { ASTRO, AURORA, FIGMENT, FakeNear, NEAR, nearAccount } from './fake-near.js'

const EPOCH_MS = 24_843_556 // the measured epoch in the recording

describe('APR math', () => {
  it('annualizes in bigint fixed point: 10^30-scale amounts stay exact', () => {
    const stake = 33_148_187_825_894_720_921_243_517_292_554n // astro-stakers, 3.3e31 yocto
    const reward = 1_320_000n * 10n ** 21n
    const expected = (Number((reward * 10n ** 18n) / stake) / 1e18) * epochsPerYear(EPOCH_MS) * 100
    expect(annualize(reward, stake, EPOCH_MS)).toBe(expected)
    // A float division of the raw numbers agrees to many digits; the bigint path never sees a value above 2^53 before the division.
    expect(annualize(reward, stake, EPOCH_MS)).toBeCloseTo((1.32e27 / 3.3148187825894720e31) * epochsPerYear(EPOCH_MS) * 100, 8)
    expect(annualize(1n, 0n, EPOCH_MS)).toBe(0)
    expect(epochsPerYear(EPOCH_MS)).toBeCloseTo(1270.3, 1)
  })

  it('network APR over the whole recorded set ≈ 5.0 % (treasury excluded)', () => {
    const net = new FakeNear().rec.validators._network
    const apr = annualize(BigInt(net.rewards), BigInt(net.stake), EPOCH_MS)
    expect(apr).toBeGreaterThan(4.9)
    expect(apr).toBeLessThan(5.2)
  })

  it('treasury.near is never part of the network figure, even listed as a validator', () => {
    const node = new FakeNear()
    const before = networkGrossApr(parseValidators(node.validators), EPOCH_MS)
    node.addValidator('treasury.near', { stake: 1n * NEAR, reward: 10n ** 9n * NEAR })
    const after = networkGrossApr(parseValidators(node.validators), EPOCH_MS)
    expect(after.apr).toBe(before.apr)
    expect(after.validators).toBe(before.validators + 1)
  })

  it('a pool without a reward entry has no gross APR', () => {
    const node = new FakeNear()
    node.addValidator('fresh.poolv1.near')
    const set = parseValidators(node.validators)
    expect(poolGrossApr(set, 'fresh.poolv1.near', EPOCH_MS)).toBeNull()
    expect(poolGrossApr(set, ASTRO, EPOCH_MS)).toBeGreaterThan(4.5)
  })

  it('refuses a malformed validators answer instead of reading zeros', () => {
    const node = new FakeNear()
    expect(() => parseValidators({ ...node.validators, epoch_height: '4946' })).toThrow(/epoch_height/)
    expect(() => parseValidators({ ...node.validators, current_validators: [{ account_id: ASTRO, stake: 1e30 }] })).toThrow(/stake/)
    expect(() => parseValidators({ ...node.validators, validator_reward_paid_prev_epoch: { [ASTRO]: '-1' } })).toThrow(/reward/)
  })
})

describe('getApr', () => {
  const make = (config: Record<string, unknown> = {}) => {
    const node = new FakeNear()
    return new NativeStakingProtocolNear(nearAccount(), { pools: 'any', provider: node.fetch, discover: false, ...config })
  }
  it('astro-stakers (1 % fee) ≈ 5.0 %, figment (10 %) ≈ 4.5 %: the pool reward after its fee', async () => {
    const p = make()
    const astro = await p.getApr({ pool: ASTRO })
    const figment = await p.getApr({ pool: FIGMENT })
    expect(astro).toBeGreaterThan(4.8)
    expect(astro).toBeLessThan(5.2)
    expect(figment).toBeGreaterThan(4.3)
    expect(figment).toBeLessThan(4.7)
    const info = await p.getPool(ASTRO)
    expect(astro).toBeCloseTo(info.grossApr! * 0.99, 10)
  })
  it('the default pool, else the network average after a 10 % fee', async () => {
    const p = make()
    const stats = await p.getNetworkStats()
    expect(await p.getApr()).toBeCloseTo(stats.apr * 0.9, 10)
    expect(await make({ pools: [ASTRO] }).getApr()).toBeCloseTo(await p.getApr({ pool: ASTRO }), 10)
    expect(await p.getApr({ pool: AURORA })).toBeLessThan(0.1) // 99 % fee
  })
  it('refuses when there is no APR to give (a foreign contract)', async () => {
    await expect(make().getApr({ pool: 'lst-pool.near' })).rejects.toBeInstanceOf(NearStakingError)
  })
  it('getNetworkStats: the current set, its stake and the measured epoch', async () => {
    const stats = await make().getNetworkStats()
    expect(stats.validators).toBe(new FakeNear().validators.current_validators.length)
    expect(stats.epochMs).toBe(EPOCH_MS)
    expect(stats.epochsPerYear).toBeCloseTo(epochsPerYear(EPOCH_MS), 10)
    expect(stats.apr).toBeGreaterThan(4.5)
    expect(stats.apr).toBeLessThan(5.5)
  })
})
