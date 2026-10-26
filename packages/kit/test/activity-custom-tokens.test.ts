import { describe, expect, it } from 'vitest'
import type { ChainTx } from '@anywalletkit/core'
import { describeGeneric } from '../src/index.js'

// Audit 2026-10-25 round 3, open item "approvals history": an ERC-20 outside the swap2-assets
// catalog (a custom token the user added) was "Approved 0x1234…", and approve(spender, 0) on it was
// not recognised as a revoke. GenericDescribeOptions.tokens supplies the app's own list.
const OWN = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const LDO = '0x1234567890AbcdEF1234567890aBcdef12345678' // a custom token: not in the swap2-assets catalog
const SPENDER = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const pad = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const approveTx = (amount: bigint): ChainTx => ({
  chain: 'eip155:1', hash: `0x${'ab'.repeat(32)}`, time: 1, status: 'confirmed', address: OWN, from: OWN, to: LDO, nativeValue: 0n, transfers: [],
  call: { to: LDO, selector: '0x095ea7b3', data: `0x095ea7b3${pad(SPENDER)}${pad(amount.toString(16))}` },
})
const tokens = (chain: string, token: string) => (chain === 'eip155:1' && token.toLowerCase() === LDO.toLowerCase() ? { symbol: 'MYT', decimals: 18 } : undefined)
const ctx = { own: new Set([OWN, OWN.toLowerCase()]) }

describe('approvals of tokens from the app list', () => {
  it('the title names the token; approve(x, 0) is a revoke', () => {
    expect(describeGeneric(approveTx(5n), ctx).title).toMatch(/^Approved 0x1234/i) // without the list: an address
    expect(describeGeneric(approveTx(5n), ctx, { tokens }).title).toMatch(/^Approved MYT/)
    const revoke = describeGeneric(approveTx(0n), ctx, { tokens })
    expect(revoke.kind).toBe('revoke')
    expect(revoke.title).toMatch(/^Revoked MYT/)
  })
})
