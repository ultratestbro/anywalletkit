import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { NativeStakingProtocolMonad, createReadClient, type NativeStakingMonadConfig } from '../src/index.js'
import { E, FakeMonad, MON, WALLET } from './fake-monad.js'

// Watch 2026-11-04: every network-stats / APR / 'any' list read sent one getValidator eth_call per
// consensus validator (~194 on mainnet, 6 in flight); the canary's runs drew HTTP 429 from the RPC.
// The set is now read through Multicall3, 100 per eth_call, with the old path as the fallback.

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'

/** A mainnet-sized node: 194 consensus validators, pages of 100 like the precompile. */
function bigNode(): FakeMonad {
  const node = new FakeMonad()
  node.pageSize = 100
  for (let i = 0; i < 191; i++) {
    node.addValidator(BigInt(1000 + i), { commission: E(i % 20), consensusStake: BigInt(10_000_000 + ((i * 7919) % 50_000_000)) * MON })
  }
  return node
}

/** Counts eth_calls on the way to the node, split into Multicall3 calls and the rest. */
function counted(node: FakeMonad, onMulticall?: () => unknown) {
  const n = { multicall: 0, single: 0, payloads: new Set<string>() }
  const provider = {
    request: async (args: { method: string; params?: unknown }) => {
      if (args.method === 'eth_call') {
        const to = String((args.params as Array<{ to?: string }>)[0]?.to).toLowerCase()
        if (to === MULTICALL3) {
          n.multicall++
          n.payloads.add(String((args.params as Array<{ data?: string }>)[0]?.data))
          if (onMulticall) return onMulticall()
        } else n.single++
      }
      return node.request(args)
    },
  }
  return { n, provider }
}

function make(provider: unknown, config: Partial<NativeStakingMonadConfig> = {}) {
  const account = createMockAccount({ chain: 'eip155:143', address: WALLET })
  return new NativeStakingProtocolMonad(account, { validators: 'any', provider, ...config } as NativeStakingMonadConfig)
}

const singleReads = (node: FakeMonad) => node.calls.filter((c) => c.fn === 'getValidator').length

describe('watch 2026-11-04: validator-set reads through Multicall3', () => {
  it('getNetworkStats reads 194 validators in 2 Multicall3 eth_calls (was 194 single calls)', async () => {
    const node = bigNode()
    const { n, provider } = counted(node)
    const stats = await make(provider).getNetworkStats()
    expect(stats.consensusValidators).toBe(194)
    expect(n.multicall).toBe(2)
    expect(n.single).toBe(2) // the two getConsensusValidatorSet pages
    expect(singleReads(node)).toBe(194) // every validator still answered, inside the two multicalls
  })

  it('the same answers with and without Multicall3 (an EIP-1193 provider that has none falls back)', async () => {
    const run = async (multicall: boolean) => {
      const node = bigNode()
      node.multicall = multicall
      const { n, provider } = counted(node)
      const any = make(provider)
      const stats = await any.getNetworkStats()
      const list = await any.listValidators()
      const listed = make(provider, { validators: [{ id: 97n, name: 'Ours' }, 1005n, 7n, 4242n], defaultValidator: 97n })
      const listedRows = await listed.listValidators()
      const apr = await listed.getApr()
      return { result: { stats, list, listedRows, apr }, n }
    }
    const fast = await run(true)
    const slow = await run(false)
    expect(fast.result).toEqual(slow.result)
    expect(fast.result.list).toHaveLength(194)
    expect(fast.result.listedRows.map((v) => [v.id, v.eligible, v.refusals])).toEqual([[97n, true, []], [1005n, true, []], [7n, false, ['inactive']], [4242n, false, ['not-found']]])
    // Without Multicall3 each validator is one eth_call, as before.
    expect(slow.n.single).toBeGreaterThan(194)
    expect(fast.n.single).toBeLessThan(12)
  })

  it("one APR read in 'any' mode fans out once: listValidators and its network stats share the multicalls", async () => {
    const node = bigNode()
    const { n, provider } = counted(node)
    const any = make(provider)
    await any.listValidators({ limit: 5 })
    expect(n.multicall).toBe(2)
    await any.getApr()
    await any.listValidators()
    expect(n.multicall).toBe(2) // cached for the minute
  })

  it('a rate-limited multicall fails as it is, without 194 single reads behind it', async () => {
    const node = bigNode()
    const limited = () => { throw Object.assign(new Error('Too Many Requests'), { code: 429 }) }
    const { n, provider } = counted(node, limited)
    await expect(make(provider).getNetworkStats()).rejects.toThrow()
    expect(n.multicall).toBeGreaterThan(0)
    expect(singleReads(node)).toBe(0)
    expect(n.single).toBe(2) // only the consensus pages
  })

  it('a failed chunk stops the next one, and the failure is not cached', async () => {
    const node = bigNode()
    node.revertOn.set('getValidator', 'boom')
    const { n, provider } = counted(node)
    const any = make(provider)
    await expect(any.getNetworkStats()).rejects.toThrow()
    expect(n.payloads.size).toBe(1) // only the first chunk went out (the transport retries it); the second never did
    expect(singleReads(node)).toBeLessThanOrEqual(100 + 4) // the first chunk, then its fallback stopped at the first failure (4 in flight)
    node.revertOn.delete('getValidator')
    expect((await any.getNetworkStats()).consensusValidators).toBe(194)
  })
})

describe('watch 2026-11-04: URL reads back off on 429', () => {
  afterEach(() => { vi.unstubAllGlobals() })
  it('two 429s, then 200: the read succeeds after waiting 400 + 800 ms', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      calls++
      if (calls <= 2) return new Response('Too Many Requests', { status: 429 })
      const { id } = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: '0x8f' }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    const t0 = Date.now()
    expect(await createReadClient(['https://rpc.example'])!.getChainId()).toBe(143)
    expect(calls).toBe(3)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1150)
  })
})
