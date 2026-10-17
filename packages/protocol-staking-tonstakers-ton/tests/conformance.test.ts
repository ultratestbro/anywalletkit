import '../src/buffer-global.js'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@forgewallet/conformance'
import TonstakersProtocolTon from '../index.js'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

describeProtocolModule('protocol-staking-tonstakers-ton', {
  type: 'staking', Protocol: TonstakersProtocolTon as never, config: {}, unsupported: ['claimWithdrawals', 'quoteClaimWithdrawals'],
  activity: { fixtures: load('.'), negatives: load('negatives') },
})
