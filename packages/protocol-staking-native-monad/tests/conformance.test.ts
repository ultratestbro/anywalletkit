import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { encodeFunctionData } from 'viem'
import { createMockAccount, describeProtocolModule, parseActivityFixture, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { NativeStakingProtocolMonad, STAKING_ABI, STAKING_PRECOMPILE, describeMonadStakingActivity, packWithdrawalId } from '../src/index.js'
import { FakeMonad, MON, WALLET } from './fake-monad.js'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

const node = new FakeMonad()
Object.assign(node.delegator(97n), { stake: 50n * MON, rewards: MON })
node.withdrawal(97n, 0, 3n * MON, 2330n)
const account = () => {
  const a = createMockAccount({ chain: 'eip155:143', address: WALLET, fee: 10n ** 16n })
  a.getBalance = async () => 1_000n * MON
  return a
}

describeProtocolModule('protocol-staking-native-monad', {
  type: 'staking',
  Protocol: NativeStakingProtocolMonad as never,
  config: { validators: [{ id: 97n, name: 'Ours' }], provider: node, maxWithdrawId: 3 },
  account,
  samples: {
    quoteStake: [{ amount: MON }],
    quoteRequestWithdrawal: [{ amount: MON }],
    quoteClaimWithdrawals: [{ ids: [packWithdrawalId(97n, 0)] }],
    getWithdrawalRequests: [],
    getStakedBalance: [],
    getApr: [],
    stake: [{ amount: MON }],
    requestWithdrawal: [{ amount: MON }],
    claimWithdrawals: [{}],
  },
  mustResolve: ['quoteStake', 'quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr'],
  activity: { fixtures: load('.'), negatives: load('negatives') },
})

describe('activity: details and refusals', () => {
  const base = parseActivityFixture(load('.')[0]!)
  const tx = (data: string, value = 0n) => ({ ...base.tx, nativeValue: value, transfers: [], raw: undefined, call: { to: STAKING_PRECOMPILE, selector: data.slice(0, 10), data } })

  it('names the validator from the config, decodes the unstake amount', () => {
    const p = new NativeStakingProtocolMonad(account(), { validators: [{ id: 97n, name: 'Ours' }] })
    const item = p.describeActivity(tx(encodeFunctionData({ abi: STAKING_ABI, functionName: 'undelegate', args: [97n, 25n * MON, 3] })), { own: base.own })
    expect(item).toMatchObject({ kind: 'unstake', title: 'Requested unstake of 25 MON', subtitle: 'Monad staking · Ours' })
    expect(describeMonadStakingActivity(tx(encodeFunctionData({ abi: STAKING_ABI, functionName: 'compound', args: [5n] })), { own: base.own })?.subtitle).toBe('Monad staking · validator #5')
  })

  it('reads a withdrawal amount from the kept receipt when no transfer shows it', () => {
    const data = encodeFunctionData({ abi: STAKING_ABI, functionName: 'withdraw', args: [97n, 0] })
    const amount = 7n * MON
    const log = {
      address: STAKING_PRECOMPILE,
      topics: ['0x63030e4238e1146c63f38f4ac81b2b23c8be28882e68b03f0887e50d0e9bb18f', `0x${97n.toString(16).padStart(64, '0')}`, `0x${WALLET.slice(2).toLowerCase().padStart(64, '0')}`],
      data: `0x${'0'.repeat(64)}${amount.toString(16).padStart(64, '0')}${(2333n).toString(16).padStart(64, '0')}`,
    }
    const item = describeMonadStakingActivity({ ...tx(data), raw: { tx: { receipt: { logs: [log] } } } }, { own: base.own })
    expect(item?.assetsIn).toEqual([{ token: null, amount, symbol: 'MON', decimals: 18 }])
  })

  it('refuses other chains, other contracts, and other selectors on the precompile', () => {
    const d = encodeFunctionData({ abi: STAKING_ABI, functionName: 'delegate', args: [97n] })
    expect(describeMonadStakingActivity({ ...tx(d), chain: 'eip155:1' }, { own: base.own })).toBeNull()
    expect(describeMonadStakingActivity({ ...tx(d), call: { to: '0x1111111111111111111111111111111111111111', selector: d.slice(0, 10), data: d } }, { own: base.own })).toBeNull()
    expect(describeMonadStakingActivity(tx('0xf145204c' + '00'.repeat(32)), { own: base.own })).toBeNull() // addValidator
  })
})
