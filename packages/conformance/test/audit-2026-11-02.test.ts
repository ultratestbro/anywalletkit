import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The behaviour suite must prove that a swap plan pays only declared recipients: a recipient inside
// router calldata and a call (with native value) into an undeclared contract are caught, not just
// the plan's own recipient fields and approvals.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'suites')
const run = (file: string) => {
  const r = spawnSync(process.execPath, [join(dir, '../../../node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.ts'), '--root', dir, file], { encoding: 'utf8', timeout: 60_000 })
  return { passed: r.status === 0, output: `${r.stdout}\n${r.stderr}` }
}

describe('describeProtocolBehaviour: who the source call pays', () => {
  it('a module whose router calldata pays the account passes, with the fixture decoding it', () => {
    const r = run('SwapHonest.suite.ts')
    expect(r.passed, r.output).toBe(true)
  })
  it('router calldata without a fixture `decode` fails: opaque calldata is not accepted unread', () => {
    const r = run('SwapNoDecode.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/needs the fixture's `decode`/)
  })
  it('an exact approval to the declared router whose calldata pays another address fails', () => {
    const r = run('SwapRouterPaysOther.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/0x0+e0e01, which is neither own nor declared/)
  })
  it('native value into a contract no fixture declared fails', () => {
    const r = run('SwapStranger.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/contract-unknown/)
    expect(r.output).toMatch(/native-value/)
  })
})
