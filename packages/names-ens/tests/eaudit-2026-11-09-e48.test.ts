// Extension audit 2026-11-09, E48: an ENS recipient was resolved through a single RPC, and the signing-time
// re-check asked the same endpoint again — one malicious operator could answer with its own address twice.
// With `clients` / `rpcUrls`, every forward resolution asks two (or more) independent endpoints and is
// refused unless they agree.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { assertNameUnchanged } from '@anywalletkit/core'
import type { PublicClient } from 'viem'
import { EnsNameError, ensResolver } from '../src/index.js'

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
const ATTACKER = '0x2222222222222222222222222222222222222222'

function fakeClient(records: Record<string, string | null>, opts: { fail?: boolean } = {}) {
  const calls: string[] = []
  const client = {
    getEnsAddress: vi.fn(async ({ name, coinType }: { name: string; coinType?: bigint }) => {
      calls.push(`addr ${name} ${coinType ?? 60n}`)
      if (opts.fail) throw new Error('socket hang up')
      return records[`${name}:${coinType ?? 60n}`] ?? null
    }),
    getEnsName: vi.fn(async () => null),
    getEnsText: vi.fn(async () => null),
  } as unknown as PublicClient
  return { client, calls }
}

afterEach(() => vi.unstubAllGlobals())

describe('E48: ENS through two independent RPC endpoints', () => {
  it('agreeing endpoints resolve; both are asked', async () => {
    const a = fakeClient({ 'bob.eth:60': VITALIK.toLowerCase() })
    const b = fakeClient({ 'bob.eth:60': VITALIK })
    const r = ensResolver({ clients: [a.client, b.client] })
    expect((await r.resolve('bob.eth', 'eip155:1')).address).toBe(VITALIK)
    expect(a.calls).toEqual(['addr bob.eth 60'])
    expect(b.calls).toEqual(['addr bob.eth 60'])
  })

  it('two endpoints that disagree → refusal (lookup-failed, reason rpc-disagreement)', async () => {
    const a = fakeClient({ 'bob.eth:60': ATTACKER })
    const b = fakeClient({ 'bob.eth:60': VITALIK })
    const r = ensResolver({ clients: [a.client, b.client] })
    const err = await r.resolve('bob.eth', 'eip155:1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(EnsNameError)
    expect(err).toMatchObject({ code: 'lookup-failed', reason: 'rpc-disagreement' })
    // A disagreement is not cached: nothing comes back from the cache later.
    await expect(r.resolve('bob.eth', 'eip155:1')).rejects.toMatchObject({ reason: 'rpc-disagreement' })
  })

  it('one endpoint has an address, the other says the name does not exist → refusal', async () => {
    const a = fakeClient({ 'bob.eth:60': ATTACKER })
    const b = fakeClient({})
    await expect(ensResolver({ clients: [a.client, b.client] }).resolve('bob.eth', 'eip155:1')).rejects.toMatchObject({ code: 'lookup-failed', reason: 'rpc-disagreement' })
    await expect(ensResolver({ clients: [b.client, a.client] }).resolve('bob.eth', 'eip155:1')).rejects.toMatchObject({ code: 'lookup-failed', reason: 'rpc-disagreement' })
  })

  it('both agree the name does not exist → not-found; one endpoint down → lookup-failed (fail closed)', async () => {
    const a = fakeClient({})
    const b = fakeClient({})
    await expect(ensResolver({ clients: [a.client, b.client] }).resolve('nobody.eth', 'eip155:1')).rejects.toMatchObject({ code: 'not-found' })
    const up = fakeClient({ 'bob.eth:60': VITALIK })
    const down = fakeClient({}, { fail: true })
    await expect(ensResolver({ clients: [up.client, down.client] }).resolve('bob.eth', 'eip155:1')).rejects.toMatchObject({ code: 'lookup-failed' })
  })

  it('the signing-time re-check (fresh) goes to the other endpoint too, never to the cache', async () => {
    const recA: Record<string, string | null> = { 'bob.eth:60': VITALIK }
    const recB: Record<string, string | null> = { 'bob.eth:60': VITALIK }
    const a = fakeClient(recA)
    const b = fakeClient(recB)
    const r = ensResolver({ clients: [a.client, b.client], cacheTtlMs: 60 * 60_000 })
    const typed = await r.resolve('bob.eth', 'eip155:1')
    expect(b.calls.length).toBe(1)
    await expect(assertNameUnchanged(r, 'bob.eth', 'eip155:1', typed.address)).resolves.toMatchObject({ address: VITALIK })
    expect(b.calls.length).toBe(2) // the re-check asked the second operator, not only the first
    // The first endpoint turns malicious after the form resolved: the re-check refuses, it does not "confirm" the attacker.
    recA['bob.eth:60'] = ATTACKER
    await expect(assertNameUnchanged(r, 'bob.eth', 'eip155:1', typed.address)).rejects.toMatchObject({ reason: 'rpc-disagreement' })
  })

  it('rpcUrls builds one client per URL and asks each', async () => {
    const hosts: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      hosts.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).host)
      throw new TypeError('offline')
    }))
    const r = ensResolver({ rpcUrls: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'] })
    await expect(r.resolve('bob.eth', 'eip155:1')).rejects.toMatchObject({ code: 'lookup-failed' })
    expect(new Set(hosts)).toEqual(new Set(['ethereum-rpc.publicnode.com', 'eth.drpc.org']))
  })

  it('refuses a cross-check that is not one: fewer than two URLs, the same host twice, or mixed with rpcUrl/client', () => {
    expect(() => ensResolver({ rpcUrls: ['https://eth.drpc.org'] })).toThrow(/two/)
    expect(() => ensResolver({ rpcUrls: ['https://eth.drpc.org/a', 'https://ETH.drpc.org/b'] })).toThrow(/different/)
    expect(() => ensResolver({ rpcUrls: ['https://eth.drpc.org', 'https://ethereum-rpc.publicnode.com'], rpcUrl: 'https://x.example' })).toThrow()
    const one = fakeClient({})
    expect(() => ensResolver({ clients: [one.client] })).toThrow(/two/)
    expect(() => ensResolver({ clients: [one.client, one.client] })).toThrow(/different/)
  })

  it('the single-URL API is unchanged', async () => {
    const a = fakeClient({ 'bob.eth:60': VITALIK })
    expect((await ensResolver({ client: a.client }).resolve('bob.eth', 'eip155:1')).address).toBe(VITALIK)
  })
})
