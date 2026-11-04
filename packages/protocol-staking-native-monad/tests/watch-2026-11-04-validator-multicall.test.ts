import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMockAccount } from '@anywalletkit/conformance'
import { HttpRequestError, RpcRequestError, TimeoutError, decodeFunctionData, parseAbi, type Hex } from 'viem'
import { NativeStakingProtocolMonad, createReadClient, type NativeStakingMonadConfig } from '../src/index.js'
import { MULTICALL_RETRY_MS, VALIDATOR_BATCH } from '../src/protocol.js'
import { isRateLimited, isTransportFailure } from '../src/rpc.js'
import { E, FakeMonad, MON, WALLET } from './fake-monad.js'

// Watch 2026-11-04: every network-stats / APR / 'any' list read sent one getValidator eth_call per
// consensus validator (~194 on mainnet, 6 in flight); the canary's runs drew HTTP 429 from the RPC.
// The set is now read through Multicall3, 67 per eth_call (~6.85M gas, measured), with the old path as the fallback.

const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11'
const AGGREGATE3 = parseAbi(['struct Call3 { address target; bool allowFailure; bytes callData; }', 'function aggregate3(Call3[] calls) payable returns ((bool success, bytes returnData)[])'])

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
  const n = { multicall: 0, single: 0, payloads: new Set<string>(), sizes: [] as number[] }
  const provider = {
    request: async (args: { method: string; params?: unknown }) => {
      if (args.method === 'eth_call') {
        const to = String((args.params as Array<{ to?: string }>)[0]?.to).toLowerCase()
        if (to === MULTICALL3) {
          n.multicall++
          const data = String((args.params as Array<{ data?: string }>)[0]?.data)
          n.payloads.add(data)
          n.sizes.push((decodeFunctionData({ abi: AGGREGATE3, data: data as Hex }).args![0] as unknown[]).length)
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
  it('getNetworkStats reads 194 validators in 3 Multicall3 eth_calls of at most 67 (was 194 single calls)', async () => {
    const node = bigNode()
    const { n, provider } = counted(node)
    const stats = await make(provider).getNetworkStats()
    expect(stats.consensusValidators).toBe(194)
    expect(VALIDATOR_BATCH).toBe(67) // ~102k gas per getValidator on mainnet: ~6.85M per eth_call, under a 10M cap
    expect(n.multicall).toBe(3)
    expect(n.sizes).toEqual([67, 67, 60])
    expect(n.single).toBe(2) // the two getConsensusValidatorSet pages
    expect(singleReads(node)).toBe(194) // every validator still answered, inside the three multicalls
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
    expect(n.multicall).toBe(3)
    await any.getApr()
    await any.listValidators()
    expect(n.multicall).toBe(3) // cached for the minute
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
    expect(singleReads(node)).toBeLessThanOrEqual(67 + 4) // the first chunk, then its fallback stopped at the first failure (4 in flight)
    node.revertOn.delete('getValidator')
    const before = n.multicall
    expect((await any.getNetworkStats()).consensusValidators).toBe(194)
    // The single reads failed too, so the multicall was not to blame: it is used again right away.
    expect(n.multicall - before).toBe(3)
  })
})

describe('watch 2026-11-04: Multicall3 that fails here is skipped for a while', () => {
  afterEach(() => { vi.restoreAllMocks() })

  /** Moves Date.now forward (the validator cache and the skip window run on it). */
  const clock = () => {
    let offset = 0
    const real = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(() => real() + offset)
    return (ms: number) => { offset += ms }
  }

  it('no Multicall3: one failing multicall, then plain reads on every refresh until the window ends', async () => {
    const advance = clock()
    const node = bigNode()
    node.multicall = false
    const { n, provider } = counted(node)
    const any = make(provider)
    expect((await any.getNetworkStats()).consensusValidators).toBe(194)
    expect(n.payloads.size).toBe(1) // the first chunk tried it (viem's custom transport retries that one call); the other two did not
    const first = n.multicall
    advance(61_000) // past the validator cache, inside the skip window
    await any.listValidators()
    expect(n.multicall).toBe(first)
    expect(singleReads(node)).toBe(2 * 194)
    advance(MULTICALL_RETRY_MS)
    await any.listValidators()
    expect(n.multicall).toBeGreaterThan(first) // tried again once the window is over
  })

  it('the withdrawal scan skips it too inside the window', async () => {
    const node = bigNode()
    node.multicall = false
    const { n, provider } = counted(node)
    const any = make(provider)
    await any.getNetworkStats()
    const first = n.multicall
    await any.getWithdrawalRequests({ validator: 1005n })
    expect(n.multicall).toBe(first)
  })

  it('a transport failure (a 502, a timeout) is not remembered: the next chunk tries Multicall3 again', async () => {
    for (const failure of [
      () => new HttpRequestError({ body: { method: 'eth_call' }, status: 502, url: 'https://rpc.example', details: 'Bad Gateway' }),
      () => new TimeoutError({ body: { method: 'eth_call' }, url: 'https://rpc.example' }),
    ]) {
      const node = bigNode()
      let failures = 0
      const { n, provider } = counted(node, () => {
        if (failures++ < 4) throw failure() // the first chunk and viem's retries of it
        return node.request({ method: 'eth_call', params: [{ to: MULTICALL3, data: [...n.payloads].at(-1) }, 'latest'] })
      })
      expect((await make(provider).getNetworkStats()).consensusValidators).toBe(194)
      expect(n.payloads.size).toBe(3) // all three chunks went to Multicall3
      expect(singleReads(node)).toBe(194)
    }
  })
})

describe('watch 2026-11-04: rate-limit detection', () => {
  const body = { jsonrpc: '2.0', id: 429, method: 'eth_call', params: [] }
  it('a request whose JSON-RPC id is 429 is not a rate limit (the id is a counter, and sits in `message`)', () => {
    const errors = [
      new HttpRequestError({ body, status: 500, url: 'https://rpc.example', details: 'Internal Server Error' }),
      new TimeoutError({ body, url: 'https://rpc.example' }),
      new RpcRequestError({ body, error: { code: -32000, message: 'out of gas' }, url: 'https://rpc.example' }),
    ]
    for (const e of errors) {
      expect(e.message).toContain('"id":429')
      expect(isRateLimited(e)).toBe(false)
      expect(isRateLimited(new Error('wrapped', { cause: e }))).toBe(false)
    }
  })

  it('HTTP 429, JSON-RPC 429 / -32007 and the words are', () => {
    expect(isRateLimited(new HttpRequestError({ body, status: 429, url: 'https://rpc.example' }))).toBe(true)
    expect(isRateLimited(new RpcRequestError({ body, error: { code: -32007, message: '50/second request limit reached' }, url: 'https://rpc.example' }))).toBe(true)
    expect(isRateLimited(new RpcRequestError({ body, error: { code: 429, message: 'x' }, url: 'https://rpc.example' }))).toBe(true)
    expect(isRateLimited(new HttpRequestError({ body, url: 'https://rpc.example', details: 'Too Many Requests' }))).toBe(true)
    expect(isRateLimited(new Error('outer', { cause: new HttpRequestError({ body, status: 429, url: 'https://rpc.example' }) }))).toBe(true)
  })

  it('transport failures: timeouts, network errors, 408 and 5xx; not a 4xx answer or a revert', () => {
    expect(isTransportFailure(new TimeoutError({ body, url: 'https://rpc.example' }))).toBe(true)
    expect(isTransportFailure(new HttpRequestError({ body, url: 'https://rpc.example', cause: new Error('fetch failed') }))).toBe(true)
    expect(isTransportFailure(new HttpRequestError({ body, status: 503, url: 'https://rpc.example' }))).toBe(true)
    expect(isTransportFailure(new HttpRequestError({ body, status: 400, url: 'https://rpc.example' }))).toBe(false)
    expect(isTransportFailure(new RpcRequestError({ body, error: { code: 3, message: 'execution reverted' }, url: 'https://rpc.example' }))).toBe(false)
  })
})

const rpcOk = (init?: { body?: string }) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: '0x8f' }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('watch 2026-11-04: URL reads back off on 429', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
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

  it('a 429 is retried 4 times, then fails', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '0' } }) })
    await expect(createReadClient(['https://rpc.example'])!.getChainId()).rejects.toThrow()
    expect(calls).toBe(5)
  })

  it("a long Retry-After is capped at 5 s", async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => (++calls === 1 ? new Response('Too Many Requests', { status: 429, headers: { 'Retry-After': '3600' } }) : rpcOk(init)))
    const read = createReadClient(['https://rpc.example'])!.getChainId()
    await vi.advanceTimersByTimeAsync(4_990)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(20)
    expect(await read).toBe(143)
    expect(calls).toBe(2)
  })

  it('a timeout is retried twice, not 4 times (a hung RPC fails after 3 timeouts, as before)', async () => {
    let calls = 0
    vi.stubGlobal('fetch', (_url: unknown, init?: { signal?: AbortSignal }) => {
      calls++
      return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))))
    })
    await expect(createReadClient(['https://rpc.example'], 50)!.getChainId()).rejects.toThrow(/took too long/)
    expect(calls).toBe(3)
  })

  it('a 500 is retried twice; a JSON-RPC revert is not retried', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => { calls++; return new Response('oops', { status: 500 }) })
    await expect(createReadClient(['https://rpc.example'])!.getChainId()).rejects.toThrow()
    expect(calls).toBe(3)
    calls = 0
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      calls++
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, error: { code: 3, message: 'execution reverted' } }), { status: 200, headers: { 'content-type': 'application/json' } })
    })
    await expect(createReadClient(['https://rpc.example'])!.getChainId()).rejects.toThrow()
    expect(calls).toBe(1)
  })
})
