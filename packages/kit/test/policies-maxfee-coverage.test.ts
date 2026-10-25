import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies } from '../src/index.js'

// Audit 2026-10-25 (post-release), L2: `policies.maxFee` reached sendTransaction / signTransaction /
// transfer only; `approve` (EVM) and `sendSerialized` (Solana) send a transaction too and got no cap.
const TOKEN = '0x000000000000000000000000000000000000Cafe'
const SPENDER = '0x000000000000000000000000000000000000bEEF'

describe('policies.maxFee reaches every write that pays a fee', () => {
  it('approve gets the tightest cap as its WriteOptions; a tighter caller cap stays', async () => {
    const calls: unknown[][] = []
    const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), { approve: async (...args: unknown[]) => { calls.push(args); return { hash: '0x1', fee: 1n } } })
    const guarded = applyPolicies(acc, { maxFee: { eip155: 900n, 'eip155:1': 700n } })
    await guarded.approve({ token: TOKEN, spender: SPENDER, amount: 5n })
    expect(calls.at(-1)).toEqual([{ token: TOKEN, spender: SPENDER, amount: 5n }, { maxFee: 700n }])
    await (guarded as unknown as { approve: (o: unknown, w: unknown) => Promise<unknown> }).approve({ token: TOKEN, spender: SPENDER, amount: 5n }, { maxFee: 10n })
    expect(calls.at(-1)![1]).toEqual({ maxFee: 10n })
    // no cap configured: the call is passed through untouched
    await applyPolicies(acc, {}).approve({ token: TOKEN, spender: SPENDER, amount: 5n })
    expect(calls.at(-1)).toHaveLength(1)
  })

  it('sendSerialized gets it third, after the guard', async () => {
    const calls: unknown[][] = []
    const acc = Object.assign(createMockAccount({ chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }), {
      sendSerialized: async (...args: unknown[]) => { calls.push(args); return { hash: 'sig', fee: 5_000n } },
    })
    const guard = { expect: { maxLamportsOut: 1n } }
    await (applyPolicies(acc, { maxFee: { solana: 20_000n }, confirm: async () => true }) as unknown as { sendSerialized: (b: string, g: unknown) => Promise<unknown> }).sendSerialized('AQID', guard)
    expect(calls.at(-1)).toEqual(['AQID', guard, { maxFee: 20_000n }])
  })
})
