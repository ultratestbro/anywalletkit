import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@anywalletkit/conformance'
import { MorphoMarketProtocolEvm, MorphoVaultProtocolEvm } from '../src/index.js'
import { MARKET_ID, makeMorpho, USDC, VAULT } from './fixture.js'

// The suite builds its own mock account on eip155:1; the fixture's Morpho and v1.0 factory addresses are the same on Ethereum.
const { chain } = makeMorpho()
chain.chainId = 1

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)
// Both classes share the recognizer (MorphoBase), so both must pass every recorded fixture.
const activity = { fixtures: load('.'), negatives: load('negatives') }

describeProtocolModule('protocol-lending-morpho-evm (vault)', {
  type: 'lending',
  Protocol: MorphoVaultProtocolEvm as never,
  config: { chainId: 1, vault: VAULT, provider: chain.provider, api: null },
  notImplemented: ['borrow', 'repay', 'quoteBorrow', 'quoteRepay'],
  samples: { quoteSupply: [{ token: USDC, amount: 1_000_000n }], quoteWithdraw: [{ token: USDC, amount: 1_000_000n }] },
  activity,
})

describeProtocolModule('protocol-lending-morpho-evm (market)', {
  type: 'lending',
  Protocol: MorphoMarketProtocolEvm as never,
  config: { chainId: 1, market: MARKET_ID, provider: chain.provider, api: null },
  samples: {
    quoteSupply: [{ token: USDC, amount: 1_000_000n }],
    quoteWithdraw: [{ token: USDC, amount: 1_000_000n }],
    quoteBorrow: [{ token: USDC, amount: 1_000_000n }],
    quoteRepay: [{ token: USDC, amount: 1_000_000n }],
  },
  activity,
})
