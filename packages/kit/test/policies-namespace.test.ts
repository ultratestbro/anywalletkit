import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { PolicyViolationError, applyPolicies } from '../src/index.js'

// Audit 2026-10-25, finding 3: rules keyed by a namespace (`eip155`) were documented to apply to
// every chain of the family, and were ignored for `eip155:1`.

const DEST = '0x000000000000000000000000000000000000bEEF'
const OTHER = '0x000000000000000000000000000000000000dEaD'
const send = (to = DEST) => ({ to, value: 1n })

describe('policies keyed by namespace', () => {
  it('a namespace rule alone applies to an exact chain', async () => {
    const acc = createMockAccount({ chain: 'eip155:1', fee: 500n })
    await expect(applyPolicies(acc, { maxFee: { eip155: 100n } }).sendTransaction(send())).rejects.toMatchObject({ policy: 'maxFee' })
    await expect(applyPolicies(acc, { blocklist: { eip155: [DEST] } }).sendTransaction(send())).rejects.toThrow(/eip155 blocklist/)
    await expect(applyPolicies(acc, { allowlist: { eip155: [OTHER] } }).sendTransaction(send())).rejects.toThrow(/eip155 allowlist/)
    expect(acc.sent).toHaveLength(0)
    await applyPolicies(acc, { allowlist: { eip155: [DEST] }, maxFee: { eip155: 1_000n } }).sendTransaction(send())
    expect(acc.sent).toHaveLength(1)
  })

  it('namespace and exact id together: every cap, every allowlist, any blocklist', async () => {
    const acc = createMockAccount({ chain: 'eip155:1', fee: 500n })
    // the tighter cap wins, whichever key holds it
    await expect(applyPolicies(acc, { maxFee: { eip155: 1_000n, 'eip155:1': 100n } }).transfer({ recipient: DEST, amount: 1n })).rejects.toThrow(/eip155:1 cap/)
    await expect(applyPolicies(acc, { maxFee: { eip155: 100n, 'eip155:1': 1_000n } }).transfer({ recipient: DEST, amount: 1n })).rejects.toThrow(/eip155 cap/)
    // allowlists intersect: on the exact list only, or on the namespace list only, is not enough
    await expect(applyPolicies(acc, { allowlist: { eip155: [OTHER], 'eip155:1': [DEST] } }).sendTransaction(send())).rejects.toThrow(/eip155 allowlist/)
    await expect(applyPolicies(acc, { allowlist: { eip155: [DEST], 'eip155:1': [OTHER] } }).sendTransaction(send())).rejects.toThrow(/eip155:1 allowlist/)
    // blocklists add up
    const block = { blocklist: { eip155: [OTHER], 'eip155:1': [DEST] } }
    await expect(applyPolicies(acc, block).sendTransaction(send(DEST))).rejects.toThrow(/eip155:1 blocklist/)
    await expect(applyPolicies(acc, block).sendTransaction(send(OTHER))).rejects.toThrow(/eip155 blocklist/)
    expect(acc.sent).toHaveLength(0)
    await applyPolicies(acc, { allowlist: { eip155: [DEST, OTHER], 'eip155:1': [DEST] }, maxFee: { eip155: 1_000n, 'eip155:1': 600n } }).sendTransaction(send())
    expect(acc.sent).toHaveLength(1)
  })

  it('eip155:unknown: namespace rules apply without a chain id; exact rules still need one', async () => {
    const blind = createMockAccount({ chain: 'eip155:unknown', fee: 500n })
    await expect(applyPolicies(blind, { blocklist: { eip155: [DEST] } }).sendTransaction(send())).rejects.toThrow(/eip155 blocklist/)
    await expect(applyPolicies(blind, { maxFee: { eip155: 100n } }).sendTransaction(send())).rejects.toBeInstanceOf(PolicyViolationError)
    // an exact rule in the same family could be the chain this account is on: refuse rather than guess
    await expect(applyPolicies(blind, { blocklist: { eip155: [OTHER], 'eip155:1': [OTHER] } }).sendTransaction(send())).rejects.toMatchObject({ policy: 'chain' })
    // rules of another family cannot apply to this account at all
    await applyPolicies(blind, { blocklist: { solana: [DEST] } }).sendTransaction(send())
    expect(blind.sent).toHaveLength(1)
    // a lazy account learns its chain id, then both its namespace and exact rules apply
    const lazy = Object.assign(createMockAccount({ chain: 'eip155:unknown' }), { getChainId: async () => 1 })
    await expect(applyPolicies(lazy, { blocklist: { eip155: [OTHER], 'eip155:1': [DEST] } }).sendTransaction(send())).rejects.toThrow(/eip155:1 blocklist/)
    await expect(applyPolicies(lazy, { blocklist: { eip155: [DEST] } }).sendTransaction(send())).rejects.toThrow(/eip155 blocklist/)
    expect(lazy.sent).toHaveLength(0)
  })

  it('asked-for chain ≠ account.chain: the namespace rules and both exact ids apply', async () => {
    const acc = createMockAccount({ chain: 'eip155:1', fee: 500n })
    await expect(applyPolicies(acc, { blocklist: { eip155: [DEST] } }, 'eip155:8453').sendTransaction(send())).rejects.toThrow(/eip155 blocklist/)
    await expect(applyPolicies(acc, { allowlist: { eip155: [DEST], 'eip155:8453': [DEST], 'eip155:1': [OTHER] } }, 'eip155:8453').sendTransaction(send())).rejects.toThrow(/eip155:1 allowlist/)
    await expect(applyPolicies(acc, { maxFee: { 'eip155:8453': 100n } }, 'eip155:8453').sendTransaction(send())).rejects.toThrow(/eip155:8453 cap/)
    expect(acc.sent).toHaveLength(0)
  })

  it('revokes: a namespace blocklist still covers the contract a revoke calls', async () => {
    const approved: unknown[] = []
    const acc = Object.assign(createMockAccount({ chain: 'eip155:1' }), { approve: async (o: unknown) => { approved.push(o); return { hash: '0xrevoked', fee: 1n } } })
    const token = '0x0000000000000000000000000000000000000Abc'
    await expect(applyPolicies(acc, { blocklist: { eip155: [token] } }).approve({ token, spender: DEST, amount: 0n })).rejects.toThrow(/eip155 blocklist/)
    // the spender being listed does not stop a revoke
    await applyPolicies(acc, { blocklist: { eip155: [DEST] }, allowlist: { eip155: [OTHER] } }).approve({ token, spender: DEST, amount: 0n })
    expect(approved).toHaveLength(1)
  })
})
