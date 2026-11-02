import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The behaviour suite's other plan shapes: a Tron/TON call is held to the declared contracts like an
// EVM one, and unreadable calldata, an unparsed permit and typed orders fail as the README says.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'suites')
const run = (file: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(dir, '../../../node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.ts'), '--root', dir, file, ...args], { encoding: 'utf8', timeout: 60_000 })
  return { passed: r.status === 0, output: `${r.stdout}\n${r.stderr}` }
}

describe('describeProtocolBehaviour: plan shapes beyond EVM router calls', () => {
  it('a Tron call with native value into an undeclared contract fails, even with an honest decode', () => {
    const r = run('NonEvmStranger.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/calls TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7 with native value, which is not declared/)
  })
  it('control: the same Tron call into the declared router passes', () => {
    const r = run('NonEvmDeclared.suite.ts')
    expect(r.passed, r.output).toBe(true)
  })
  it('calldata nobody can read fails with calldata-undecodable', () => {
    const r = run('CalldataUndecodable.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/calldata-undecodable/)
  })
  it('an unparsed permit fails with approval-unparsed', () => {
    const r = run('PermitUnparsed.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/approval-unparsed/)
  })
  it('a typed order without decode fails', () => {
    const r = run('TypedNoDecode.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/a typed-order plan needs the fixture's `decode`/)
  })
  it('a typed order paying another address fails', () => {
    const r = run('TypedPaysOther.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/0x0+e0e01, which is neither own nor declared/)
  })
  it('control: a typed order paying the account passes the review check (the mock has no order submission to compare)', () => {
    const r = run('TypedHonest.suite.ts', '-t', 'pays only own')
    expect(r.passed, r.output).toBe(true)
  })
})
