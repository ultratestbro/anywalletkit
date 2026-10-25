import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Audit 2026-10-25, finding 14: "reads and quotes never broadcast" swallowed every error and
// looked only at `sent`, so a quote that signed (or called a signing method the mock lacks, and
// failed) passed. The suite runs here against modules it must accept and modules it must reject.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'suites')
const run = (file: string) => {
  const r = spawnSync(process.execPath, [join(dir, '../../../node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.ts'), '--root', dir, file], { encoding: 'utf8', timeout: 60_000 })
  return { passed: r.status === 0, output: `${r.stdout}\n${r.stderr}` }
}

describe('the protocol suite catches signing in reads', () => {
  it('a clean module passes', () => {
    const r = run('Clean.suite.ts')
    expect(r.passed, r.output).toBe(true)
  })
  it('a quote that signs typed data (absent on the mock) fails the suite', () => {
    const r = run('SignsTypedDataInQuote.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/signTypedData/)
  })
  it('a quote that signs and then throws fails the suite', () => {
    const r = run('SignsThenThrows.suite.ts')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/\bsign\b/)
  })
  it('a failing quote is tolerated by default, and fails when the module lists it in mustResolve', () => {
    expect(run('QuoteThrows.suite.ts').passed).toBe(true)
    const strict = run('QuoteThrowsMustResolve.suite.ts')
    expect(strict.passed).toBe(false)
    expect(strict.output).toMatch(/fixture missing/)
    expect(run('CleanMustResolve.suite.ts').passed).toBe(true)
  })
})
