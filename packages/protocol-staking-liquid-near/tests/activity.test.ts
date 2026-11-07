import { describe, expect, it } from 'vitest'
import { parseActivityFixture } from '@anywalletkit/conformance'
import type { ChainTx } from '@anywalletkit/core'
import { LiquidStakingProtocolNear, MODULE_NAME, describeLiquidNearStakingActivity } from '../src/index.js'
import { fixture, loadFixtures } from './fixtures.js'

const RNEAR = 'lst.rhealab.near'
const LINEAR = 'linear-protocol.near'

/** A synthetic NEAR transaction from `me` calling `methods` on `to`. */
function call(to: string, methods: string[], o: Partial<ChainTx> = {}): ChainTx {
  return {
    chain: 'near:mainnet', hash: 'H1', time: 1_794_000_000, status: 'confirmed', address: 'me.near', from: 'me.near', to,
    nativeValue: 0n, transfers: [], call: { to, method: methods[0]!, programs: methods }, ...o,
  }
}
const own = new Set(['me.near'])

describe('recorded mainnet transactions', () => {
  it('every fixture is described with the module, a family subtitle and the contract as counterparty', () => {
    for (const f of loadFixtures('.')) {
      const { tx, own: mine } = parseActivityFixture(f)
      const item = describeLiquidNearStakingActivity(tx, { own: mine })
      expect(item, f.note).not.toBeNull()
      expect(item!.protocol).toBe(MODULE_NAME)
      expect(item!.subtitle).toMatch(/^(LiNEAR|Rhea rNEAR) liquid staking$/)
      expect(item!.fee).toBe(tx.fee)
    }
  })

  it('rNEAR stake: NEAR out, rNEAR in, with symbols and decimals', () => {
    const { tx, own: mine } = parseActivityFixture(fixture('rnear-deposit_and_stake.json'))
    const item = describeLiquidNearStakingActivity(tx, { own: mine })!
    expect(item).toMatchObject({ kind: 'stake', title: 'Staked NEAR for rNEAR', subtitle: 'Rhea rNEAR liquid staking', counterparty: RNEAR })
    expect(item.assetsOut).toEqual([{ token: null, amount: 1_639_910_570_742_824_242_408_482n, symbol: 'NEAR', decimals: 24 }])
    expect(item.assetsIn).toEqual([{ token: RNEAR, amount: 1_534_909_765_973_083_758_154_606n, symbol: 'rNEAR', decimals: 24 }])
  })

  it('a withdrawal mapped from the RPC has no receipt transfers: the amount comes from the contract event', () => {
    const { tx, own: mine } = parseActivityFixture(fixture('linear-withdraw_all.json'))
    expect(tx.transfers).toEqual([])
    expect(describeLiquidNearStakingActivity(tx, { own: mine })!.assetsIn).toEqual([{ token: null, amount: 808_384_430_210_821_134_393_176n, symbol: 'NEAR', decimals: 24 }])
    // Someone else's withdraw event in the same outcome is not ours.
    const other = parseActivityFixture(fixture('rnear-withdraw_all.json'))
    expect(describeLiquidNearStakingActivity({ ...other.tx, from: 'me.near' }, { own })!.assetsIn).toEqual([])
  })

  it('negatives: token transfers, a lone storage_deposit, Meta Pool, the operator bot', () => {
    const notes = loadFixtures('negatives').map((f) => {
      const { tx, own: mine } = parseActivityFixture(f)
      expect(describeLiquidNearStakingActivity(tx, { own: mine }), f.note).toBeNull()
      return f.note
    })
    expect(notes.join(' | ')).toMatch(/ft_transfer_call.*storage_deposit|storage_deposit.*ft_transfer_call|Meta Pool/)
  })
})

describe('classification', () => {
  it('methods → kind and title', () => {
    const d = (to: string, methods: string[]) => describeLiquidNearStakingActivity(call(to, methods), { own })
    expect(d(LINEAR, ['deposit_and_stake'])).toMatchObject({ kind: 'stake', title: 'Staked NEAR for LINEAR', subtitle: 'LiNEAR liquid staking' })
    expect(d(LINEAR, ['storage_deposit', 'deposit_and_stake'])).toMatchObject({ kind: 'stake' })
    expect(d(RNEAR, ['stake_all'])).toMatchObject({ kind: 'stake', title: 'Restaked NEAR for rNEAR' })
    expect(d(RNEAR, ['unstake'])).toMatchObject({ kind: 'unstake', title: 'Requested unstake' })
    expect(d(RNEAR, ['withdraw_all', 'unstake_all'])).toMatchObject({ kind: 'unstake', title: 'Withdrew and requested unstake' })
    expect(d(LINEAR, ['withdraw'])).toMatchObject({ kind: 'claim', title: 'Withdrew unstaked NEAR' })
    for (const m of [['storage_deposit'], ['ft_transfer'], ['ft_transfer_call'], ['ping'], ['epoch_update_rewards'], ['storage_unregister']]) expect(d(LINEAR, m), m.join()).toBeNull()
  })

  it('the attached deposit is the NEAR out when the source reported no transfer', () => {
    const item = describeLiquidNearStakingActivity(call(LINEAR, ['deposit_and_stake'], { nativeValue: 5n }), { own })!
    expect(item.assetsOut).toEqual([{ token: null, amount: 5n, symbol: 'NEAR', decimals: 24 }])
  })

  it('refuses other chains, other contracts, transactions the wallet did not send, and missing calls', () => {
    expect(describeLiquidNearStakingActivity(call(LINEAR, ['deposit_and_stake'], { chain: 'eip155:1' }), { own })).toBeNull()
    expect(describeLiquidNearStakingActivity(call('meta-pool.near', ['deposit_and_stake']), { own })).toBeNull()
    expect(describeLiquidNearStakingActivity(call('lst-pool.near', ['deposit_and_stake']), { own })).toBeNull()
    expect(describeLiquidNearStakingActivity(call(LINEAR, ['deposit_and_stake'], { from: 'bot.near' }), { own })).toBeNull()
    const { call: _, ...noCall } = call(LINEAR, ['deposit_and_stake'])
    expect(describeLiquidNearStakingActivity(noCall as ChainTx, { own })).toBeNull()
  })

  it('per network: testnet LiNEAR is known on testnet only; rNEAR has no testnet contract', () => {
    const t = (to: string) => describeLiquidNearStakingActivity(call(to, ['deposit_and_stake'], { chain: 'near:testnet' }), { own })
    expect(t('linear-protocol.testnet')).toMatchObject({ kind: 'stake' })
    expect(t(LINEAR)).toBeNull()
    expect(t(RNEAR)).toBeNull()
    expect(describeLiquidNearStakingActivity(call('linear-protocol.testnet', ['deposit_and_stake']), { own })).toBeNull()
  })

  it('a configured family contract is recognized by the protocol instance, with its name', () => {
    const p = new LiquidStakingProtocolNear({ chain: 'near:mainnet', getAddress: async () => 'me.near' } as never, { pool: { contract: 'lst.example.near', symbol: 'xNEAR', name: 'Example', codeHashes: ['h'] } })
    expect(p.describeActivity(call('lst.example.near', ['unstake_all']), { own })).toMatchObject({ kind: 'unstake', subtitle: 'Example liquid staking', counterparty: 'lst.example.near' })
    expect(describeLiquidNearStakingActivity(call('lst.example.near', ['unstake_all']), { own })).toBeNull()
  })

  it('a failed transaction keeps its status', () => {
    expect(describeLiquidNearStakingActivity(call(RNEAR, ['withdraw_all'], { status: 'failed' }), { own })).toMatchObject({ kind: 'claim', status: 'failed' })
  })
})
