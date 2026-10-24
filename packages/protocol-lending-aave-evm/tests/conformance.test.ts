import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { AaveProtocolEvm } from '../src/index.js'
import { makeMarket, USDT } from './fixture.js'

const { chain } = makeMarket()

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

describeProtocolModule('protocol-lending-aave-evm', {
  type: 'lending',
  Protocol: AaveProtocolEvm as never,
  config: { chainId: 1, market: 'core', provider: chain.provider },
  samples: {
    quoteSupply: [{ token: USDT, amount: 1_000_000n }],
    quoteWithdraw: [{ token: USDT, amount: 1_000_000n }],
    quoteBorrow: [{ token: USDT, amount: 1_000_000n }],
    quoteRepay: [{ token: USDT, amount: 1_000_000n }],
  },
  activity: { fixtures: load('.'), negatives: load('negatives') },
})
