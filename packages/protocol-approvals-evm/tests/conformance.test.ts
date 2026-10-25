import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@anywalletkit/conformance'
import ApprovalsProtocolEvm from '../src/index.js'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

describeProtocolModule('protocol-approvals-evm', {
  // USDT listed with decimals: the module then knows approve(spender, 0) on it is an ERC-20 reset (fixture 2).
  type: 'approvals', Protocol: ApprovalsProtocolEvm as never, config: { tokens: { '0xdac17f958d2ee523a2206206994597c13d831ec7': { symbol: 'USDT', decimals: 6 } } },
  activity: { fixtures: load('.'), negatives: load('negatives') },
})
