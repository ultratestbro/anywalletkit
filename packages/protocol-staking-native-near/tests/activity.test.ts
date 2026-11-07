import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseActivityFixture, type ActivityFixtureJson } from '@anywalletkit/conformance'
import type { ChainTx } from '@anywalletkit/core'
import { MODULE_NAME, NativeStakingProtocolNear, describeNativeNearStakingActivity } from '../src/index.js'
import { ASTRO, NEAR, nearAccount } from './fake-near.js'

const fixture = (name: string) => parseActivityFixture(JSON.parse(readFileSync(new URL(`../fixtures/activity/${name}.json`, import.meta.url), 'utf8')) as ActivityFixtureJson)

describe('describeNativeNearStakingActivity on recorded mainnet transactions', () => {
  it('deposit_and_stake: the attached deposit goes out, named by the config', () => {
    const { tx, own } = fixture('deposit_and_stake')
    const item = describeNativeNearStakingActivity(tx, { own }, { pools: [{ id: ASTRO, name: 'Astro Stakers' }] })
    expect(item).toMatchObject({ kind: 'stake', title: 'Staked NEAR', subtitle: 'NEAR staking · Astro Stakers', counterparty: ASTRO, protocol: MODULE_NAME, assetsIn: [] })
    expect(item!.assetsOut).toEqual([{ token: null, amount: 1_280_210n * 10n ** 21n, symbol: 'NEAR', decimals: 24 }])
    expect(item!.fee).toBe(tx.fee)
  })

  it('unstake: the amount from the pool log reaches the title', () => {
    const { tx, own } = fixture('unstake')
    expect(describeNativeNearStakingActivity(tx, { own })).toMatchObject({ kind: 'unstake', title: 'Requested unstake of 1000 NEAR', subtitle: `NEAR staking · ${ASTRO}` })
    const { tx: all, own: own2 } = fixture('unstake_all')
    expect(describeNativeNearStakingActivity(all, { own: own2 })!.title).toMatch(/^Requested unstake/)
  })

  it('withdraw_all: the NEAR the pool sent back, from the kept receipts, else from its log', () => {
    const { tx, own } = fixture('withdraw_all')
    const amount = 996_196_680_218_689_544_810_998_097n
    expect(describeNativeNearStakingActivity(tx, { own })).toMatchObject({ kind: 'claim', title: 'Withdrew unstaked NEAR', assetsIn: [{ token: null, amount, symbol: 'NEAR', decimals: 24 }] })
    const raw = structuredClone(tx.raw) as { rpc: { receipts?: unknown } }
    delete raw.rpc.receipts
    expect(describeNativeNearStakingActivity({ ...tx, raw }, { own })!.assetsIn).toEqual([{ token: null, amount, symbol: 'NEAR', decimals: 24 }])
    // A nearblocks row shows the pool's transfer instead.
    const me = tx.from
    const viaIndexer: ChainTx = { ...tx, raw: undefined, transfers: [{ token: null, from: ASTRO, to: me, amount }] }
    expect(describeNativeNearStakingActivity(viaIndexer, { own })!.assetsIn).toEqual([{ token: null, amount, symbol: 'NEAR', decimals: 24 }])
  })
})

describe('describeNativeNearStakingActivity: methods, networks, refusals', () => {
  const { tx: base, own } = fixture('unstake')
  const me = base.from
  const call = (programs: string[], to = ASTRO): ChainTx => ({ ...base, raw: undefined, transfers: [], call: { to, method: programs[0]!, programs } })

  it('maps every delegator method; [withdraw_all, unstake] stays an unstake', () => {
    const d = (programs: string[]) => describeNativeNearStakingActivity(call(programs), { own })
    expect(d(['withdraw_all', 'unstake'])).toMatchObject({ kind: 'unstake', title: 'Withdrew and requested unstake' })
    expect(d(['withdraw_all', 'unstake_all'])).toMatchObject({ kind: 'unstake', title: 'Withdrew and requested unstake' })
    expect(d(['deposit'])).toMatchObject({ kind: 'stake', title: 'Deposited NEAR' })
    expect(d(['stake'])).toMatchObject({ kind: 'stake', title: 'Restaked NEAR' })
    expect(d(['stake_all'])).toMatchObject({ kind: 'stake', title: 'Restaked NEAR' })
    expect(d(['withdraw'])).toMatchObject({ kind: 'claim', title: 'Withdrew unstaked NEAR' })
    expect(d(['unstake'])).toMatchObject({ kind: 'unstake', title: 'Requested unstake' })
    for (const m of [['ping'], ['update_reward_fee_fraction'], ['pause_staking'], []]) expect(d(m)).toBeNull()
    // Only the method, no programs list.
    expect(describeNativeNearStakingActivity({ ...call(['x']), call: { to: ASTRO, method: 'deposit_and_stake' } }, { own })!.kind).toBe('stake')
  })

  it('a deposit_and_stake into lst-pool.near (a validator, not a factory pool) is not ours', () => {
    const { tx, own: o } = fixture('deposit_and_stake')
    expect(describeNativeNearStakingActivity({ ...tx, call: { ...tx.call!, to: 'lst-pool.near' } }, { own: o })).toBeNull()
    expect(describeNativeNearStakingActivity({ ...tx, call: { ...tx.call!, to: 'meta-pool.near' } }, { own: o })).toBeNull()
  })

  it('the network comes from the transaction; a pinned network refuses the other one', () => {
    const testnet: ChainTx = { ...call(['deposit_and_stake'], 'kiln.pool.f863973.m0'), chain: 'near:testnet', nativeValue: NEAR, transfers: [{ token: null, from: me, to: 'kiln.pool.f863973.m0', amount: NEAR }] }
    expect(describeNativeNearStakingActivity(testnet, { own })).toMatchObject({ kind: 'stake', assetsOut: [{ token: null, amount: NEAR }] })
    expect(describeNativeNearStakingActivity(testnet, { own }, { network: 'mainnet' })).toBeNull()
    expect(describeNativeNearStakingActivity({ ...call(['deposit_and_stake']), chain: 'near:testnet' }, { own })).toBeNull() // a mainnet pool id on testnet
    expect(describeNativeNearStakingActivity({ ...call(['deposit_and_stake']), chain: 'eip155:1' }, { own })).toBeNull()
  })

  it("someone else's call on a pool is not the wallet's", () => {
    expect(describeNativeNearStakingActivity({ ...call(['deposit_and_stake']), from: 'someone.near' }, { own })).toBeNull()
  })

  it('the module method follows a pinned network and passes the configured names', () => {
    const p = new NativeStakingProtocolNear(nearAccount(), { pools: [{ id: ASTRO, name: 'Astro' }] })
    expect(p.describeActivity(call(['unstake']), { own })!.subtitle).toBe('NEAR staking · Astro')
    const t = new NativeStakingProtocolNear(nearAccount({ chain: 'near:testnet' }), { pools: 'any' })
    expect(t.describeActivity(call(['unstake']), { own })).toBeNull()
  })
})
