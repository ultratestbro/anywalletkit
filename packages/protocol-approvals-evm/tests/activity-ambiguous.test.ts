import { describe, expect, it } from 'vitest'
import type { ChainTx } from '@anywalletkit/core'
import ApprovalsProtocolEvm, { describeApprovalActivity } from '../src/index.js'

// Audit 2026-10-25 (post-release), M5: `approve(spender, 0)` resets an ERC-20 allowance but
// APPROVES `spender` for token #0 on an ERC-721; history wrote "Revoked …" for both.
const OWN = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const DRAINER = '0x00000000000000000000000000000000000Dead1'
const NFT = '0x0000000000000000000000000000000000000Aa7'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const ctx = { own: new Set([OWN, OWN.toLowerCase()]) }
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const call = (token: string, data: string, over: Partial<ChainTx> = {}): ChainTx => ({
  chain: 'eip155:1', hash: `0x${'2'.repeat(64)}`, time: 1, status: 'confirmed', address: OWN, from: OWN, to: token, nativeValue: 0n, transfers: [],
  call: { to: token, selector: data.slice(0, 10), data }, ...over,
})
const approve = (token: string, spender: string, word: bigint, over: Partial<ChainTx> = {}) => call(token, `0x095ea7b3${pad(spender)}${pad(word.toString(16))}`, over)

describe('approvals activity: ambiguous approve(spender, 0)', () => {
  it('is never a revoke on a token not known as an ERC-20: an approval on a known NFT, unclaimed otherwise', () => {
    // unknown contract: the module does not claim it (the kit's generic description decides, see kit's tests)
    expect(describeApprovalActivity(approve(NFT, DRAINER, 0n), ctx)).toBeNull()
    expect(describeApprovalActivity(approve(NFT, DRAINER, 0n), ctx, { tokens: { [NFT.toLowerCase()]: { symbol: 'APE' } } })).toBeNull()
    // a transfer marked erc721 makes it a known NFT: an approval of the spender for token #0
    const nft = approve(NFT, DRAINER, 0n, { transfers: [{ token: NFT, from: OWN, to: DRAINER, amount: 1n, standard: 'erc721', tokenId: '0' }] })
    expect(describeApprovalActivity(nft, ctx, { tokens: { [NFT.toLowerCase()]: { symbol: 'APE', decimals: 0 } } }))
      .toMatchObject({ kind: 'approve', title: expect.stringMatching(/^Approved APE/), counterparty: DRAINER.toLowerCase() })
    // a non-zero approve is unambiguous and still claimed
    expect(describeApprovalActivity(approve(NFT, DRAINER, 5n), ctx)?.kind).toBe('approve')
  })

  it('is a revoke on a token `tokens` lists with decimals, or one a transfer marks erc20', () => {
    expect(describeApprovalActivity(approve(USDT, DRAINER, 0n), ctx, { tokens: { [USDT.toLowerCase()]: { symbol: 'USDT', decimals: 6 } } }))
      .toMatchObject({ kind: 'revoke', title: expect.stringMatching(/^Revoked USDT/) })
    const marked = approve(USDT, DRAINER, 0n, { transfers: [{ token: USDT, from: OWN, to: DRAINER, amount: 0n, standard: 'erc20' }] })
    expect(describeApprovalActivity(marked, ctx)?.kind).toBe('revoke')
    // the module passes its own `tokens` config
    const protocol = new ApprovalsProtocolEvm(undefined as never, { tokens: { [USDT.toLowerCase()]: { symbol: 'USDT', decimals: 6 } } })
    expect(protocol.describeActivity(approve(USDT, DRAINER, 0n), ctx)?.kind).toBe('revoke')
  })

  it('unambiguous revokes stay revokes: approve(0x0, id), setApprovalForAll(false)', () => {
    expect(describeApprovalActivity(approve(NFT, '0x0000000000000000000000000000000000000000', 7n), ctx)?.kind).toBe('revoke')
    expect(describeApprovalActivity(call(NFT, `0xa22cb465${pad(DRAINER)}${pad('0')}`), ctx)?.kind).toBe('revoke')
    expect(describeApprovalActivity(call(NFT, `0xa22cb465${pad(DRAINER)}${pad('1')}`), ctx)?.kind).toBe('approve')
  })
})
