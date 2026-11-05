import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { ScrvUsdProtocolEvm } from '../src/index.js'
import { CRVUSD, makeScrvUsd } from './fixture.js'

// The suite builds its own mock account on eip155:1 (0x…dEaD), which holds no shares: quoteWithdraw is lenient.
const { chain } = makeScrvUsd()

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

describeProtocolModule('protocol-lending-curve-evm (scrvUSD)', {
  type: 'lending',
  Protocol: ScrvUsdProtocolEvm as never,
  config: { chainId: 1, provider: chain.provider, api: null },
  notImplemented: ['borrow', 'repay', 'quoteBorrow', 'quoteRepay'],
  samples: { quoteSupply: [{ token: CRVUSD, amount: 10n ** 18n }], quoteWithdraw: [{ token: CRVUSD, amount: 10n ** 18n }] },
  mustResolve: ['quoteSupply'],
  activity: { fixtures: load('.'), negatives: load('negatives') },
})
