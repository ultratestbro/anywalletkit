import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeProtocolModule, type ActivityFixtureJson } from '@anywalletkit/conformance'
import ApprovalsProtocolEvm from '../src/index.js'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))
const load = (sub: string): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

describeProtocolModule('protocol-approvals-evm', {
  type: 'approvals', Protocol: ApprovalsProtocolEvm as never, config: {},
  activity: { fixtures: load('.'), negatives: load('negatives') },
})
