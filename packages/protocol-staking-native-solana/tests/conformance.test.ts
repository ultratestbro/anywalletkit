import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createMockAccount, describeProtocolModule, parseActivityFixture, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { NativeStakingProtocolSolana, describeNativeStakeActivity } from '../src/index.js'
import { CHAIN, FakeNode, SOL, V1, V2, WALLET } from './fake-node.js'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

const node = new FakeNode()
node.seedAccount(0, { stake: 3n * SOL }) // active
node.seedAccount(1, { stake: 2n * SOL, activationEpoch: 1n, deactivationEpoch: 2n }) // claimable
const account = () => {
  const a = createMockAccount({ chain: CHAIN, address: WALLET, fee: 5000n })
  a.getBalance = async () => 10n * SOL
  return a
}

describeProtocolModule('protocol-staking-native-solana', {
  type: 'staking',
  Protocol: NativeStakingProtocolSolana as never,
  config: { validators: [{ voteAccount: V1, name: 'Cats' }, V2], provider: node },
  account,
  samples: {
    quoteStake: [{ amount: SOL }],
    quoteRequestWithdrawal: [{ amount: 3n * SOL }],
    quoteClaimWithdrawals: [{}],
    getWithdrawalRequests: [],
    getStakedBalance: [],
    getApr: [],
    stake: [{ amount: SOL }],
    requestWithdrawal: [{ amount: SOL }],
    claimWithdrawals: [{}],
  },
  mustResolve: ['quoteStake', 'quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr'],
  activity: { fixtures: load('.'), negatives: load('negatives') },
})

describe('activity: fallbacks and labels', () => {
  const [stakeFixture] = load('.').filter((f) => f.expect.kind === 'stake' && f.note?.includes('WithSeed'))
  const { tx, own } = parseActivityFixture(stakeFixture!)

  it('names the validator from the configured list', () => {
    const p = new NativeStakingProtocolSolana(account(), { validators: [{ voteAccount: 'CatzoSMUkTRidT5DwBxAC2pEtnwMBTpkCepHkFgZDiqb', name: 'Cats' }] })
    expect(p.describeActivity(tx, { own })?.subtitle).toBe('Native staking · Cats')
    expect(describeNativeStakeActivity(tx, { own })?.subtitle).toBe('Native staking · Catz…Diqb')
  })

  it('without parsed instructions: the Stake instruction tag in call.data decides', () => {
    const bare = { ...tx, raw: undefined, call: { ...tx.call!, data: '8QwQj' } } // Deactivate
    expect(describeNativeStakeActivity(bare, { own })?.kind).toBe('unstake')
    expect(describeNativeStakeActivity({ ...bare, call: { ...bare.call, data: '5Nvj78GVF7LRqAZV' } }, { own })?.kind).toBe('claim')
  })

  it('without parsed instructions or data: the SOL movement decides', () => {
    const bare = { ...tx, raw: undefined, call: { to: tx.call!.to, programs: tx.call!.programs ?? [] } }
    expect(describeNativeStakeActivity(bare, { own })?.kind).toBe('stake')
  })

  it('refuses other chains and transactions led by another program', () => {
    expect(describeNativeStakeActivity({ ...tx, chain: 'eip155:1' }, { own })).toBeNull()
    expect(describeNativeStakeActivity({ ...tx, call: { ...tx.call!, to: 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy' } }, { own })).toBeNull()
  })

  it('a stake-pool transaction that touches the Stake program first is not this module\'s; a lone Split is not an unstake', () => {
    const pool = { ...tx, call: { ...tx.call!, programs: [...(tx.call!.programs ?? []), 'SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy'] } }
    expect(describeNativeStakeActivity(pool, { own })).toBeNull()
    const split = { ...tx, raw: undefined, call: { to: tx.call!.to, programs: ['Stake11111111111111111111111111111111111111'], data: '4HSo5Vwt1cCH26sq' } }
    expect(describeNativeStakeActivity(split, { own })?.kind).toBe('contract')
  })
})
