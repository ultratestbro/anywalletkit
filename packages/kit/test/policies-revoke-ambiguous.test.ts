import { describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, applyPolicies } from '../src/index.js'

// Audit 2026-10-25, #5. Raw `approve(address,uint256)` with a zero second word is a revoke on an
// ERC-20 (allowance → 0) but a GRANT on an ERC-721 (approve `to` for token #0). The calldata alone
// cannot tell them apart, so it must not be read as a revoke that skips the spender's listing.
const DRAINER = '0x00000000000000000000000000000000000Dead1'
const NFT = '0x0000000000000000000000000000000000000Aa7'
const pad = (hex: string) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0')
const approveRaw = (spender: string, word: bigint) => ({ to: NFT, value: 0n, data: `0x095ea7b3${pad(spender)}${pad(word.toString(16))}` })

describe('ambiguous approve(spender, 0) calldata is not a revoke', () => {
  it('a blocklisted spender cannot be approved for NFT #0 through raw calldata', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const guarded = applyPolicies(acc, { blocklist: { 'eip155:1': [DRAINER] }, confirm: async () => true })
    await expect(guarded.sendTransaction(approveRaw(DRAINER, 0n))).rejects.toBeInstanceOf(PolicyViolationError)
    expect(acc.sent).toHaveLength(0)
  })

  it('a spender outside the allowlist cannot be approved for NFT #0 through raw calldata', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const guarded = applyPolicies(acc, { allowlist: { 'eip155:1': [NFT] }, confirm: async () => true })
    await expect(guarded.sendTransaction(approveRaw(DRAINER, 0n))).rejects.toBeInstanceOf(PolicyViolationError)
    // nor hidden inside a batch next to a genuine revoke
    const off = { to: NFT, value: 0n, data: `0xa22cb465${pad(DRAINER)}${pad('0')}` }
    await expect(guarded.sendTransaction([off, approveRaw(DRAINER, 0n)] as never)).rejects.toBeInstanceOf(PolicyViolationError)
    expect(acc.sent).toHaveLength(0)
  })

  it('confirm is told it is an approval of the spender, not a revoke', async () => {
    const confirm = vi.fn(async () => true)
    const acc = createMockAccount({ chain: 'eip155:1' })
    await applyPolicies(acc, { confirm }).sendTransaction(approveRaw(DRAINER, 0n))
    expect(confirm).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'approval', to: DRAINER.toLowerCase(), token: NFT, amount: 0n, unlimited: false }))
  })

  it('unambiguous revokes still skip the spender\'s listing: setApprovalForAll(false), approve(0x0, id), explicit approve({amount: 0})', async () => {
    const approved: unknown[] = []
    const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), { approve: async (o: unknown) => { approved.push(o); return { hash: '0xrevoked', fee: 1n } } })
    const guarded = applyPolicies(acc, { blocklist: { 'eip155:1': [DRAINER] }, allowlist: { 'eip155:1': ['0x0000000000000000000000000000000000000001'] }, confirm: async () => true })
    await guarded.sendTransaction({ to: NFT, value: 0n, data: `0xa22cb465${pad(DRAINER)}${pad('0')}` })
    await guarded.sendTransaction({ to: NFT, value: 0n, data: `0x095ea7b3${pad('0')}${pad('7')}` })
    await guarded.approve({ token: NFT, spender: DRAINER, amount: 0n })
    expect(acc.sent).toHaveLength(2)
    expect(approved).toHaveLength(1)
  })

  it('any raw approve / setApprovalForAll(true) is checked on its spender, alone or in a batch, and on the contract', async () => {
    const acc = createMockAccount({ chain: 'eip155:1' })
    const seen: unknown[] = []
    const guarded = applyPolicies(acc, { allowlist: { 'eip155:1': [NFT] }, confirm: async (i) => { seen.push(i); return true } })
    const max = (1n << 256n) - 1n
    await expect(guarded.sendTransaction(approveRaw(DRAINER, max))).rejects.toBeInstanceOf(PolicyViolationError)
    const operatorOn = { to: NFT, value: 0n, data: `0xa22cb465${pad(DRAINER)}${pad('1')}` }
    await expect(guarded.sendTransaction(operatorOn)).rejects.toBeInstanceOf(PolicyViolationError)
    await expect(guarded.sendTransaction([{ to: NFT, value: 0n, data: '0x' }, approveRaw(DRAINER, 5n)] as never)).rejects.toBeInstanceOf(PolicyViolationError)
    expect(acc.sent).toHaveLength(0)
    // allowed spender: goes through, and confirm sees an unlimited approval
    const ok = applyPolicies(acc, { allowlist: { 'eip155:1': [NFT, DRAINER] }, confirm: async (i) => { seen.push(i); return true } })
    await ok.sendTransaction(approveRaw(DRAINER, max))
    expect(seen.at(-1)).toMatchObject({ kind: 'approval', unlimited: true, destinations: [NFT, DRAINER.toLowerCase()] })
    // the contract called is still checked
    await expect(applyPolicies(acc, { blocklist: { 'eip155:1': [NFT] } }).sendTransaction(approveRaw(DRAINER, 1n))).rejects.toBeInstanceOf(PolicyViolationError)
  })
})
