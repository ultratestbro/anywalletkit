import { describe, expect, it } from 'vitest'
import type { ChainTx, DescribeActivityContext } from '@anywalletkit/core'
import { describeGeneric } from '../src/index.js'

// Audit 2026-10-25 (post-release), M5. Policies read raw `approve(spender, 0)` as an approval: on an
// ERC-20 it resets the allowance, on an ERC-721 it APPROVES `spender` for token #0. History wrote
// "Revoked …" for both, so a user could believe an NFT approval was withdrawn when one was granted.
const OWN = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const DRAINER = '0x00000000000000000000000000000000000Dead1'
const NFT = '0x0000000000000000000000000000000000000Aa7'
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
const ctx: DescribeActivityContext = { own: new Set([OWN, OWN.toLowerCase()]) }
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const approve = (token: string, spender: string, word: bigint, over: Partial<ChainTx> = {}): ChainTx => ({
  chain: 'eip155:8453', hash: `0x${'1'.repeat(64)}`, time: 1, status: 'confirmed', address: OWN, from: OWN, to: token, nativeValue: 0n, transfers: [],
  call: { to: token, selector: '0x095ea7b3', data: `0x095ea7b3${pad(spender)}${pad(word.toString(16))}` }, ...over,
})

describe('history: ambiguous approve(spender, 0)', () => {
  it('on a contract not known as an ERC-20 is an approval of the spender, not a revoke', () => {
    const item = describeGeneric(approve(NFT, DRAINER, 0n), ctx)
    expect(item.kind).toBe('approve')
    expect(item.title).toMatch(/^Approved /)
    expect(item.approval).toEqual({ token: NFT, spender: DRAINER.toLowerCase(), amount: 0n })
    expect(item.counterparty).toBe(DRAINER.toLowerCase())
  })

  it('on a known ERC-20 (the catalog, or a transfer marked erc20) is a revoke; a transfer marked erc721 keeps it an approval', () => {
    expect(describeGeneric(approve(USDC_BASE, DRAINER, 0n), ctx)).toMatchObject({ kind: 'revoke', title: expect.stringMatching(/^Revoked USDC/) })
    const known = approve(NFT, DRAINER, 0n, { transfers: [{ token: NFT, from: OWN, to: DRAINER, amount: 0n, standard: 'erc20', symbol: 'TKN', decimals: 18 }] })
    expect(describeGeneric(known, ctx).kind).toBe('revoke')
    const nft = approve(NFT, DRAINER, 0n, { transfers: [{ token: NFT, from: OWN, to: DRAINER, amount: 1n, standard: 'erc721', tokenId: '0' }] })
    expect(describeGeneric(nft, ctx).kind).toBe('approve')
  })

  it('approve(0x0, id) clears an NFT approval: a revoke whatever the token', () => {
    expect(describeGeneric(approve(NFT, '0x0000000000000000000000000000000000000000', 7n), ctx).kind).toBe('revoke')
  })
})
