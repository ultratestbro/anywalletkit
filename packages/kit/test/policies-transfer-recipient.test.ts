import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies, type WriteIntent } from '../src/index.js'

// Audit 2026-10-25 round 3, M4: `transfer` pays `recipient` (every chain package reads that field
// and nothing else), but the intent showed `to ?? recipient`: `transfer({ recipient: DRAINER,
// to: ALLOWED })` reached `confirm` as a transfer to ALLOWED.

const ALLOWED = '0x000000000000000000000000000000000000beef'
const DRAINER = '0x000000000000000000000000000000000000dead'

async function seen(chain: string, options: Record<string, unknown>): Promise<WriteIntent> {
  let intent: WriteIntent | undefined
  const g = applyPolicies(createMockAccount({ chain }), { confirm: (i) => { intent = i; return true } }, chain)
  await g.transfer(options as never)
  return intent!
}

describe('transfer: the recipient the chain package pays is the one judged and shown', () => {
  for (const chain of ['eip155:1', 'solana:mainnet', 'tron:mainnet', 'ton:mainnet', 'near:mainnet', 'bip122:000000000019d6689c085ae165831e93']) {
    it(`${chain}: intent.to is the recipient; a different \`to\` makes the destination unknown`, async () => {
      const both = await seen(chain, { recipient: DRAINER, to: ALLOWED, amount: 1n })
      expect(both.to).toBe(DRAINER)
      expect(both.destinations).toEqual([DRAINER])
      expect(both.destinationUnknown).toBe(true)
      const plain = await seen(chain, { recipient: DRAINER, amount: 1n })
      expect(plain).toMatchObject({ to: DRAINER, destinations: [DRAINER], destinationUnknown: false })
      const same = await seen(chain, { recipient: DRAINER, to: DRAINER, amount: 1n })
      expect(same).toMatchObject({ to: DRAINER, destinationUnknown: false })
    })
  }

  it('an allowlist holding both addresses still refuses the ambiguous call; a blocklist without confirm refuses it', async () => {
    const both = { recipient: DRAINER, to: ALLOWED, amount: 1n }
    const allow = applyPolicies(createMockAccount(), { allowlist: { eip155: [ALLOWED, DRAINER] } }, 'eip155:1')
    await expect(allow.transfer(both as never)).rejects.toMatchObject({ policy: 'allowlist' })
    const block = applyPolicies(createMockAccount(), { blocklist: { eip155: ['0x0000000000000000000000000000000000000001'] } }, 'eip155:1')
    await expect(block.transfer(both as never)).rejects.toMatchObject({ policy: 'blocklist' })
    const fine = applyPolicies(createMockAccount(), { allowlist: { eip155: [DRAINER] } }, 'eip155:1')
    await expect(fine.transfer({ recipient: DRAINER, amount: 1n })).resolves.toBeDefined()
  })
})
