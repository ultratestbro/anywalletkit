import { describe, expect, it } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { applyPolicies } from '../src/index.js'

// Audit 2026-10-25 round 3, M8 (kit part) and the open item from the post-release round: under
// `policies.maxFee`, Tron's `signRaw`, an app's `revokeDelegation` (EIP-7702) and swap2's
// `sendSerializedTransaction` hook signed with no cap at all. Each now gets the cap as its
// WriteOptions; a write that pays a fee but has nowhere to take a cap (NEAR `signBuilt`, Solana
// `signCompiled` / `signTransactionMessage`) is refused under a cap instead of passing unchecked.

function recorder(chain: string, methods: string[]) {
  const calls: Record<string, unknown[][]> = {}
  const extra = Object.fromEntries(methods.map((m) => [m, async (...args: unknown[]) => { (calls[m] ??= []).push(args); return { hash: '0x1', fee: 1n } }]))
  return { acc: Object.assign(createMockAccount({ chain }), extra), calls }
}
type Callable = Record<string, (...a: unknown[]) => Promise<unknown>>

describe('policies.maxFee reaches signRaw, revokeDelegation and sendSerializedTransaction', () => {
  it('Tron signRaw: the cap as its second argument', async () => {
    const { acc, calls } = recorder('tron:mainnet', ['signRaw'])
    const tx = { txID: 'ab'.repeat(32), raw_data_hex: '0a02' }
    await (applyPolicies(acc, { maxFee: { tron: 30_000_000n }, confirm: () => true }, 'tron:mainnet') as unknown as Callable).signRaw!(tx)
    expect(calls.signRaw!.at(-1)).toEqual([tx, { maxFee: 30_000_000n }])
  })

  it('revokeDelegation: the cap as its only argument', async () => {
    const { acc, calls } = recorder('eip155:1', ['revokeDelegation'])
    await (applyPolicies(acc, { maxFee: { eip155: 10n ** 15n } }, 'eip155:1') as unknown as Callable).revokeDelegation!()
    expect(calls.revokeDelegation!.at(-1)).toEqual([{ maxFee: 10n ** 15n }])
  })

  it("swap2's sendSerializedTransaction: the cap third, after its expectation", async () => {
    const { acc, calls } = recorder('solana:mainnet', ['sendSerializedTransaction'])
    const expectation = { maxLamportsOut: 1n }
    await (applyPolicies(acc, { maxFee: { solana: 20_000n }, confirm: () => true }, 'solana:mainnet') as unknown as Callable).sendSerializedTransaction!('AQID', expectation)
    expect(calls.sendSerializedTransaction!.at(-1)).toEqual(['AQID', expectation, { maxFee: 20_000n }])
  })

  it('a write with nowhere to take a cap is refused under one, not signed unchecked', async () => {
    for (const [chain, method] of [['near:mainnet', 'signBuilt'], ['solana:mainnet', 'signCompiled'], ['solana:mainnet', 'signTransactionMessage']] as const) {
      const { acc, calls } = recorder(chain, [method])
      const capped = applyPolicies(acc, { maxFee: { [chain.split(':')[0]!]: 1n }, confirm: () => true }, chain) as unknown as Callable
      await expect(capped[method]!({ receiverId: 'x.near', actions: [] })).rejects.toMatchObject({ policy: 'maxFee' })
      expect(calls[method]).toBeUndefined()
      // without a cap it signs as before
      await (applyPolicies(acc, { confirm: () => true }, chain) as unknown as Callable)[method]!({ receiverId: 'x.near', actions: [] })
      expect(calls[method]).toHaveLength(1)
    }
  })

  it('off-chain signatures pay no fee: a cap does not refuse them', async () => {
    const { acc, calls } = recorder('eip155:1', ['signTypedData'])
    const typed = { domain: { chainId: 1 }, primaryType: 'Mail', types: { Mail: [{ name: 'x', type: 'uint256' }] }, message: { x: 1 } }
    await (applyPolicies(acc, { maxFee: { eip155: 1n }, confirm: () => true }, 'eip155:1') as unknown as Callable).signTypedData!(typed)
    await (applyPolicies(acc, { maxFee: { eip155: 1n }, confirm: () => true }, 'eip155:1') as unknown as Callable).sign!('hello')
    expect(calls.signTypedData).toHaveLength(1)
  })
})
