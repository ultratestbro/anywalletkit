import { describe, expect, it, vi } from 'vitest'
import { NameError, assertNameUnchanged, isNameLike, nameResolvers } from '@anywalletkit/core'
import { ensResolver, warningsFor, coinTypeFor, decodeBtcScript, BTC_CAIP2, SOL_CAIP2 } from '../src/index.js'
import type { PublicClient } from 'viem'

const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'

/** A mainnet client stub: records keyed by `${name}:${coinType}`; reverse by address. */
function fakeClient(records: Record<string, string | null>, reverse: Record<string, string | null> = {}, avatars: Record<string, string | null> = {}) {
  const calls: string[] = []
  const client = {
    getEnsAddress: vi.fn(async ({ name, coinType }: { name: string; coinType?: bigint }) => {
      calls.push(`addr ${name} ${coinType ?? 60n}`)
      return records[`${name}:${coinType ?? 60n}`] ?? null
    }),
    getEnsName: vi.fn(async ({ address, coinType }: { address: string; coinType?: bigint }) => {
      calls.push(`name ${address} ${coinType ?? 60n}`)
      return reverse[`${address.toLowerCase()}:${coinType ?? 60n}`] ?? null
    }),
    getEnsAvatar: vi.fn(async ({ name }: { name: string }) => avatars[name] ?? null),
  } as unknown as PublicClient
  return { client, calls }
}

describe('ensResolver', () => {
  it('resolves a .eth name on mainnet, checksummed, with no warnings', async () => {
    const { client } = fakeClient({ 'vitalik.eth:60': VITALIK.toLowerCase() })
    const r = ensResolver({ client })
    const out = await r.resolve('Vitalik.ETH', 'eip155:1')
    expect(out).toEqual({ name: 'vitalik.eth', chain: 'eip155:1', address: VITALIK, resolver: 'ens', warnings: [] })
  })

  it('an L2 uses its own ENSIP-11 coin type and NEVER falls back to the mainnet address', async () => {
    const { client, calls } = fakeClient({ 'vitalik.eth:60': VITALIK, 'vitalik.eth:2147492101': '0x1111111111111111111111111111111111111111' })
    const r = ensResolver({ client })
    expect((await r.resolve('vitalik.eth', 'eip155:8453')).address).toBe('0x1111111111111111111111111111111111111111')
    expect(calls[0]).toBe('addr vitalik.eth 2147492101')
    await expect(r.resolve('vitalik.eth', 'eip155:10')).rejects.toMatchObject({ code: 'no-address-for-chain' })
  })

  it('unregistered → not-found; bad names → invalid-name without any I/O', async () => {
    const { client, calls } = fakeClient({})
    const r = ensResolver({ client })
    await expect(r.resolve('nobody-owns-this-7f3a.eth', 'eip155:1')).rejects.toMatchObject({ code: 'not-found' })
    await expect(r.resolve('bad..name.eth', 'eip155:1')).rejects.toMatchObject({ code: 'invalid-name' })
    await expect(r.resolve('has space.eth', 'eip155:1')).rejects.toMatchObject({ code: 'invalid-name' })
    await expect(r.resolve('vitalik.eth', 'tron:728126428')).rejects.toMatchObject({ code: 'unsupported' })
    expect(calls.filter((c) => c.includes('bad..') || c.includes('has space'))).toEqual([])
  })

  it('RPC failure is lookup-failed, not not-found', async () => {
    const client = { getEnsAddress: vi.fn(async () => { throw new Error('socket hang up') }) } as unknown as PublicClient
    await expect(ensResolver({ client }).resolve('vitalik.eth', 'eip155:1')).rejects.toMatchObject({ code: 'lookup-failed' })
  })

  it('reverse: a primary name counts only when it resolves forward to the same address', async () => {
    const { client } = fakeClient(
      { 'vitalik.eth:60': VITALIK, 'liar.eth:60': '0x2222222222222222222222222222222222222222' },
      { [`${VITALIK.toLowerCase()}:60`]: 'vitalik.eth', ['0x3333333333333333333333333333333333333333:60']: 'liar.eth' },
    )
    const r = ensResolver({ client })
    expect(await r.reverse(VITALIK, 'eip155:1')).toBe('vitalik.eth')
    expect(await r.reverse('0x3333333333333333333333333333333333333333', 'eip155:1')).toBeNull()
    expect(await r.reverse(VITALIK, 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')).toBeNull()
  })

  it('caches by name + chain within the TTL', async () => {
    const { client, calls } = fakeClient({ 'vitalik.eth:60': VITALIK })
    const r = ensResolver({ client, cacheTtlMs: 60_000 })
    await r.resolve('vitalik.eth', 'eip155:1')
    await r.resolve('vitalik.eth', 'eip155:1')
    expect(calls.length).toBe(1)
  })

  it('decodes Bitcoin and Solana records into addresses', async () => {
    // P2WPKH scriptPubKey 0014 + 20 bytes; SOL = raw 32-byte key.
    const { client } = fakeClient({
      'sat.eth:0': '0x0014751e76e8199196d454941c45d1b3a323f1433bd6',
      'sol.eth:501': '0x0000000000000000000000000000000000000000000000000000000000000001',
    })
    const r = ensResolver({ client })
    expect((await r.resolve('sat.eth', BTC_CAIP2)).address).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')
    expect((await r.resolve('sol.eth', SOL_CAIP2)).address).toBe('11111111111111111111111111111112')
  })

  it('decodes the other standard Bitcoin scripts', () => {
    const h20 = '751e76e8199196d454941c45d1b3a323f1433bd6'
    const bytes = (h: string) => Uint8Array.from(h.match(/.{2}/g)!, (b) => parseInt(b, 16))
    expect(decodeBtcScript(bytes(`76a914${h20}88ac`), 'x')).toBe('1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH')
    expect(decodeBtcScript(bytes(`a914${h20}87`), 'x')).toBe('3CNHUhP3uyB9EUtRLsmvFUmvGdjGdkTxJw')
    expect(() => decodeBtcScript(bytes('6a04deadbeef'), 'x')).toThrow(NameError)
  })

  it('avatar comes back as a URL and is cached', async () => {
    const { client } = fakeClient({}, {}, { 'vitalik.eth': 'https://example.org/v.png' })
    const r = ensResolver({ client })
    expect(await r.avatar('vitalik.eth')).toBe('https://example.org/v.png')
    expect(await r.avatar('nobody.eth')).toBeNull()
  })

  it('supports(): dotted names that normalize, not addresses, not foreign TLDs', () => {
    const r = ensResolver({ client: fakeClient({}).client })
    expect(r.supports('vitalik.eth')).toBe(true)
    expect(r.supports('alice.cb.id')).toBe(true)
    expect(r.supports('name.base.eth')).toBe(true)
    expect(r.supports('alice.sol')).toBe(false)
    expect(r.supports('alice.near')).toBe(false)
    expect(r.supports('durov.t.me')).toBe(false)
    expect(r.supports(VITALIK)).toBe(false)
    expect(r.supports('noDots')).toBe(false)
  })
})

describe('warnings', () => {
  it('flags mixed scripts, Cyrillic lookalikes and punycode', () => {
    expect(warningsFor('pаypal.eth').map((w) => w.code)).toEqual(['mixed-script']) // Cyrillic а
    expect(warningsFor('сосо.eth').map((w) => w.code)).toEqual(['confusable']) // all Cyrillic lookalikes
    expect(warningsFor('xn--80ak6aa92e.eth').map((w) => w.code)).toEqual(['punycode'])
    expect(warningsFor('vitalik.eth')).toEqual([])
    expect(warningsFor('москва.eth')).toEqual([]) // honest Cyrillic word, not a lookalike
  })
})

describe('core helpers', () => {
  it('coin types per ENSIP-11', () => {
    expect(coinTypeFor('eip155:1')).toBe(60n)
    expect(coinTypeFor('eip155:8453')).toBe(2147492101n)
    expect(coinTypeFor(BTC_CAIP2)).toBe(0n)
    expect(coinTypeFor(SOL_CAIP2)).toBe(501n)
    expect(coinTypeFor('ton:-239')).toBeNull()
    expect(coinTypeFor('solana:mainnet')).toBe(501n)
    expect(coinTypeFor('bitcoin:mainnet')).toBe(0n)
  })
  it('isNameLike', () => {
    expect(isNameLike('vitalik.eth')).toBe(true)
    expect(isNameLike(VITALIK)).toBe(false)
    expect(isNameLike('plain')).toBe(false)
    expect(isNameLike('a b.eth')).toBe(false)
  })
  it('assertNameUnchanged refuses a moved name', async () => {
    const { client } = fakeClient({ 'vitalik.eth:60': VITALIK })
    const r = ensResolver({ client })
    await expect(assertNameUnchanged(r, 'vitalik.eth', 'eip155:1', VITALIK)).resolves.toMatchObject({ address: VITALIK })
    await expect(assertNameUnchanged(r, 'vitalik.eth', 'eip155:1', '0x2222222222222222222222222222222222222222')).rejects.toMatchObject({ code: 'changed' })
  })
  it('nameResolvers: first supporting resolver answers; reverse asks each', async () => {
    const { client } = fakeClient({ 'vitalik.eth:60': VITALIK })
    const sns = { id: 'sns', supports: (n: string) => n.endsWith('.sol'), resolve: vi.fn(), reverse: vi.fn(async () => null), avatar: vi.fn() }
    const reg = nameResolvers([sns as never, ensResolver({ client })])
    expect((await reg.resolve('vitalik.eth', 'eip155:1')).address).toBe(VITALIK)
    expect(sns.resolve).not.toHaveBeenCalled()
    await expect(reg.resolve('nobody.ton', 'eip155:1')).rejects.toMatchObject({ code: 'unsupported' })
  })
})

// Conformance suite over the stubbed client.
import { namesSuite } from '@anywalletkit/conformance'
namesSuite(
  'ens (stub)',
  () => ensResolver({ client: fakeClient({ 'vitalik.eth:60': VITALIK, 'vitalik.eth:2147492101': null }).client }),
  {
    known: { name: 'vitalik.eth', chain: 'eip155:1', address: VITALIK },
    unregistered: 'nobody-owns-this-7f3a.eth',
    invalid: 'bad..eth',
    noRecord: { name: 'vitalik.eth', chain: 'eip155:8453' },
    unsupportedChain: 'tron:728126428',
    foreign: 'alice.sol',
  },
)

// Audit 2026-10-25 round 3, M5: assertNameUnchanged went through the 5-minute cache, so a name
// re-pointed after the user typed it passed the signing-time check.
describe('ensResolver: the signing-time check is never served from the cache', () => {
  it('a name re-pointed within the TTL is refused by assertNameUnchanged', async () => {
    const records: Record<string, string | null> = { 'pay.eth:60': VITALIK.toLowerCase() }
    const { client, calls } = fakeClient(records)
    const r = ensResolver({ client, cacheTtlMs: 60 * 60_000 })
    const typed = await r.resolve('pay.eth', 'eip155:1')
    records['pay.eth:60'] = '0x2222222222222222222222222222222222222222'
    expect((await r.resolve('pay.eth', 'eip155:1')).address).toBe(typed.address) // display: cached
    await expect(assertNameUnchanged(nameResolvers([r]), 'pay.eth', 'eip155:1', typed.address)).rejects.toMatchObject({ code: 'changed' })
    expect(calls.filter((c) => c.startsWith('addr pay.eth')).length).toBe(2)
    expect((await r.resolve('pay.eth', 'eip155:1')).address).toBe('0x2222222222222222222222222222222222222222') // the fresh answer is cached
  })
})
