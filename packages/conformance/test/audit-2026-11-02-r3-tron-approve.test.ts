import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A Tron call carrying TRC-20 approve / increaseAllowance calldata is held to the same approval rules
// as an EVM plan: the declared spender only, and no more than the input.

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'suites')
const run = (file: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(dir, '../../../node_modules/vitest/vitest.mjs'), 'run', '--config', join(dir, 'vitest.config.ts'), '--root', dir, file, ...args], { encoding: 'utf8', timeout: 60_000 })
  return { passed: r.status === 0, output: `${r.stdout}\n${r.stderr}` }
}

describe('describeProtocolBehaviour: TRC-20 approvals in a Tron call', () => {
  it('approve or increaseAllowance to an undeclared spender fails', () => {
    const r = run('TronApproveStranger.suite.ts', '-t', 'pays only own')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/approves 0x74472e7d35395a6b5add427eecb7f4b62ad2b071, which is not a declared spender/)
    expect(r.output).toMatch(/Tests\s+2 failed/)
  })
  it('an approval of the declared spender beyond the input (unlimited or input + 1) fails', () => {
    const r = run('TronApproveUnlimited.suite.ts', '-t', 'pays only own')
    expect(r.passed).toBe(false)
    expect(r.output).toMatch(/exceeds the input/)
    expect(r.output).toMatch(/Tests\s+2 failed/)
  })
  it('control: approve / increaseAllowance of exactly the input to the declared spender passes', () => {
    const r = run('TronApproveExact.suite.ts', '-t', 'pays only own')
    expect(r.passed, r.output).toBe(true)
  })
})
