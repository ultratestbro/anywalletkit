import { describe, expect, it } from 'vitest'
import { waitForDelivery } from '../src/swap.ts'

// Audit 2026-10-25 round 3, M31: the docs' waitForDelivery sent claimSwap2 on EVERY poll that said
// 'action-required' (the provider keeps saying it until it sees the mint: a second, third … claim
// transaction, each paying gas) and looped forever when the swap never settled.

const fake = (statuses: string[]) => {
  const claims: string[] = []
  const polled: string[] = []
  let i = 0
  return {
    claims, polled,
    swaps: {
      getSwap2Status: async (id: string) => { polled.push(id); return { status: statuses[Math.min(i++, statuses.length - 1)]!, transactions: [] } },
      claimSwap2: async (id: string) => { claims.push(id); return { hash: '0xc1a1', chain: 'eip155:8453', id: `${id}.0xc1a1` } },
    },
  }
}
const account = async () => ({}) as never

describe('waitForDelivery', () => {
  it('claims once, then follows the id the claim returned until the swap settles', async () => {
    const f = fake(['pending', 'action-required', 'action-required', 'action-required', 'completed'])
    const out = await waitForDelivery(f.swaps as never, 'awk1.cctp.1.0xsrc', account, { intervalMs: 1 })
    expect(out.status).toBe('completed')
    expect(f.claims).toEqual(['awk1.cctp.1.0xsrc'])
    expect(f.polled.slice(2).every((id) => id === 'awk1.cctp.1.0xsrc.0xc1a1')).toBe(true)
  })

  it('gives up after the overall deadline', async () => {
    const f = fake(['pending'])
    await expect(waitForDelivery(f.swaps as never, 'awk1.lifi.1', account, { intervalMs: 1, timeoutMs: 30 })).rejects.toThrow(/not settled within/)
  })
})
