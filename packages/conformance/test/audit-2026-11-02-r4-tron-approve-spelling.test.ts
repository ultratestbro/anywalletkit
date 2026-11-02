import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// TRC-20 approval calldata in a Tron call is recognised however it is spelled: the increaseApproval
// selector, an upper-case 0X prefix, and calldata that is not hex at all fails instead of skipping the check.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'suites')
const run = (file: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(dir, '../../../node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.ts'), '--root', dir, file, ...args], { encoding: 'utf8', timeout: 60_000 })
  // CI colours vitest's summary; the counts are matched on plain text.
  return { passed: r.status === 0, output: `${r.stdout}\n${r.stderr}`.replace(/\u001b\[[0-9;]*m/g, '') }
}

describe('describeProtocolBehaviour: TRC-20 approval spellings in a Tron call', () => {
  it('increaseApproval, a 0X-prefixed approve to an undeclared spender, and non-hex calldata all fail', () => {
    const r = run('TronApproveSpelling.suite.ts', '-t', 'pays only own')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/approves 0x74472e7d35395a6b5add427eecb7f4b62ad2b071, which is not a declared spender/)
    expect(r.output).toMatch(/calldata that is not hex/)
    expect(r.output).toMatch(/Tests\s+3 failed/)
  })
  it('control: increaseApproval and a 0X-prefixed approve of exactly the input to the declared spender pass', () => {
    const r = run('TronApproveSpellingExact.suite.ts', '-t', 'pays only own')
    expect(r.passed, r.output).toBe(true)
  })
})
