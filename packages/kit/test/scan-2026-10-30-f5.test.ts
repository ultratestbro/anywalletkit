import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type Policies, type WriteIntent } from '../src/index.js'

// Scan 2026-10-30 F5: legacy increaseApproval(address,uint256) (0xd73dd623) was not in the kit's
// calldata recipient table, so its spender was never a destination: a blocklisted / non-allowlisted
// spender passed. Now every allowance-raising selector names its spender, and a one-call
// approve / increaseAllowance / increaseApproval is an `approval` intent with its amount.

const TOKEN = `0x${'11'.repeat(20)}`
const DRAINER = `0x${'de'.repeat(20)}`
const word = (v: string) => v.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const call = (sel: string, amount: bigint) => ({ to: TOKEN, value: 0n, data: `${sel}${word(DRAINER)}${word('0x' + amount.toString(16))}` })

async function verdict(policies: Policies, tx: unknown, method: 'sendTransaction' | 'signTransaction' = 'sendTransaction'): Promise<string> {
  const g = applyPolicies(createMockAccount({ chain: 'eip155:1' }), policies, 'eip155:1') as unknown as Record<string, (t: unknown) => Promise<unknown>>
  return g[method]!(tx).then(() => 'passed', (e: { policy?: string; message?: string }) => e.policy ?? String(e.message))
}
async function intentOf(tx: unknown): Promise<WriteIntent> {
  let seen: WriteIntent | undefined
  await applyPolicies(createMockAccount({ chain: 'eip155:1' }), { confirm: (i) => { seen = i; return true } }, 'eip155:1').sendTransaction(tx as never)
  return seen!
}

describe('scan 2026-10-30 F5: every allowance-raising call names its spender', () => {
  for (const [name, sel] of [['approve', '0x095ea7b3'], ['increaseAllowance', '0x39509351'], ['increaseApproval', '0xd73dd623']] as const) {
    it(`${name}: blocklisted spender refused, token-only allowlist refused, both allowlisted passes`, async () => {
      const tx = call(sel, 10n ** 24n)
      for (const method of ['sendTransaction', 'signTransaction'] as const) {
        expect(await verdict({ blocklist: { 'eip155:1': [DRAINER] } }, tx, method)).toBe('blocklist')
        expect(await verdict({ allowlist: { 'eip155:1': [TOKEN] } }, tx, method)).toBe('allowlist')
        expect(await verdict({ allowlist: { 'eip155:1': [TOKEN, DRAINER] } }, tx, method)).toBe('passed')
      }
    })

    it(`${name}: confirm sees an approval of the spender, with the amount`, async () => {
      const i = await intentOf(call(sel, 5n))
      expect(i).toMatchObject({ kind: 'approval', to: DRAINER, token: TOKEN, amount: 5n, unlimited: false, destinationUnknown: false })
      expect(i.destinations).toEqual(expect.arrayContaining([TOKEN, DRAINER]))
      const max = await intentOf(call(sel, 2n ** 256n - 1n))
      expect(max).toMatchObject({ kind: 'approval', unlimited: true })
    })
  }

  it('an increaseApproval inside a batch is still checked', async () => {
    const batch = [{ to: TOKEN, value: 0n, data: '0x' }, call('0xd73dd623', 5n)]
    expect(await verdict({ blocklist: { 'eip155:1': [DRAINER] } }, batch)).toBe('blocklist')
    expect(await verdict({ allowlist: { 'eip155:1': [TOKEN] } }, batch)).toBe('allowlist')
  })
})
