import { describe, expect, it } from 'vitest'
import { assertNameUnchanged, nameResolvers, type NameResolver, type ResolvedName } from '../src/index.js'

// Audit 2026-10-25 round 3, M5: assertNameUnchanged — the signing-time check that a name still points
// where it pointed when the user typed it — asked the resolver again, and a caching resolver (ENS:
// 5 minutes) answered from its cache: a name re-pointed in between passed the check. The check now
// asks for a fresh resolution (`resolve(name, chain, { fresh: true })`), which caching resolvers
// must honour; nameResolvers passes it through.

function caching(): NameResolver & { set(address: string): void; calls: Array<boolean | undefined> } {
  let address = '0x1111111111111111111111111111111111111111'
  const cache = new Map<string, ResolvedName>()
  const calls: Array<boolean | undefined> = []
  return {
    id: 'cache', supports: () => true, reverse: async () => null, avatar: async () => null, calls,
    set(a) { address = a },
    async resolve(name, chain, options) {
      calls.push(options?.fresh)
      const key = `${name}:${chain}`
      if (!options?.fresh && cache.has(key)) return cache.get(key)!
      const r = { name, chain, address, resolver: 'cache', warnings: [] }
      cache.set(key, r)
      return r
    },
  }
}

describe('assertNameUnchanged reads the name fresh', () => {
  it('a name re-pointed after the first lookup is refused even when the resolver caches', async () => {
    const r = caching()
    const first = await r.resolve('a.eth', 'eip155:1')
    r.set('0x2222222222222222222222222222222222222222')
    await expect(assertNameUnchanged(r, 'a.eth', 'eip155:1', first.address)).rejects.toMatchObject({ code: 'changed' })
    expect(r.calls.at(-1)).toBe(true)
  })

  it('nameResolvers passes `fresh` to the resolver that serves the name', async () => {
    const r = caching()
    const all = nameResolvers([r])
    const first = await all.resolve('a.eth', 'eip155:1')
    r.set('0x3333333333333333333333333333333333333333')
    await expect(assertNameUnchanged(all, 'a.eth', 'eip155:1', first.address)).rejects.toMatchObject({ code: 'changed' })
    expect(r.calls.at(-1)).toBe(true)
  })
})
