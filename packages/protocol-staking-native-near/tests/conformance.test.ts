import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { NativeStakingProtocolNear, poolRequestId } from '../src/index.js'
import { ASTRO, FakeNear, NEAR, ZAVODIL, nearAccount } from './fake-near.js'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

const node = new FakeNear()
node.accounts.get('alice.near')!.amount = 1000n * NEAR
Object.assign(node.delegation(ASTRO), { staked: 50n * NEAR, unstaked: 0n, canWithdraw: true })
Object.assign(node.delegation(ZAVODIL), { staked: 0n, unstaked: 3n * NEAR, canWithdraw: true })

describeProtocolModule('protocol-staking-native-near', {
  type: 'staking',
  Protocol: NativeStakingProtocolNear as never,
  config: { pools: [{ id: ASTRO, name: 'Astro' }, ZAVODIL], defaultPool: ASTRO, provider: node.fetch, discover: false },
  account: () => nearAccount(),
  samples: {
    quoteStake: [{ amount: NEAR }],
    quoteRequestWithdrawal: [{ amount: NEAR }],
    quoteClaimWithdrawals: [{ ids: [poolRequestId(ZAVODIL)] }],
    getWithdrawalRequests: [],
    getStakedBalance: [],
    getApr: [],
    stake: [{ amount: NEAR }],
    requestWithdrawal: [{ amount: NEAR }],
    claimWithdrawals: [{}],
  },
  mustResolve: ['quoteStake', 'quoteRequestWithdrawal', 'quoteClaimWithdrawals', 'getWithdrawalRequests', 'getStakedBalance', 'getApr'],
  activity: { fixtures: load('.'), negatives: load('negatives') },
})
