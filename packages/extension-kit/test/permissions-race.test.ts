import { describe, expect, it } from 'vitest'
import { NetworksTable, PermissionStore, type EvmNetwork, type JsonStorage, type PermissionsState } from '../src/index.js'

/** Storage whose writes land out of order: each later `set` resolves sooner than the one before (the worst case for a stale snapshot). */
function slowStorage<T>(initial: T | null = null) {
  let pending = 0
  const s = {
    value: initial,
    sets: 0,
    failNext: false,
    async get(): Promise<T | null> { return s.value === null ? null : structuredClone(s.value) },
    async set(value: T): Promise<void> {
      s.sets++
      const delay = Math.max(1, 30 - 3 * pending++)
      await new Promise((r) => setTimeout(r, delay))
      pending--
      if (s.failNext) { s.failNext = false; throw new Error('storage quota exceeded') }
      s.value = structuredClone(value)
    },
  }
  return s satisfies JsonStorage<T>
}

const SITE = 'https://evil.example'
const ACCOUNT = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94'

describe('PermissionStore serialization (scan F22)', () => {
  it('a flood of disconnectChain writes interleaved with the user\'s disconnect ends with the site removed', async () => {
    const storage = slowStorage<PermissionsState>()
    const store = new PermissionStore(storage)
    await store.connect(SITE, [ACCOUNT], 'eip155:1')
    await store.connectChain(SITE, 'solanaAccounts', ['So1'], 'eip155:1')
    await store.connectChain(SITE, 'tonAccounts', ['UQ1'], 'eip155:1')
    await store.connect('https://other.example', [ACCOUNT], 'eip155:1')
    // The site floods (no approval needed), the user clicks "Disconnect site" in the middle of it.
    const flood: Promise<unknown>[] = []
    for (let i = 0; i < 20; i++) flood.push(store.disconnectChain(SITE, i % 2 ? 'solanaAccounts' : 'tonAccounts'), store.setChain(SITE, 'eip155:8453'))
    const user = store.disconnect(SITE)
    for (let i = 0; i < 20; i++) flood.push(store.disconnectChain(SITE, 'solanaAccounts'), store.setChain(SITE, 'eip155:10'))
    await Promise.all([...flood, user])
    expect(await store.get(SITE)).toBeNull()
    expect(storage.value?.[SITE]).toBeUndefined()
    expect(storage.value?.['https://other.example']).toBeDefined()
    // A fresh store over the same storage agrees (what the worker sees after a restart).
    expect(await new PermissionStore(storage).get(SITE)).toBeNull()
  })

  it('disconnectChain is a no-op (no write) when there is nothing to remove', async () => {
    const storage = slowStorage<PermissionsState>()
    const store = new PermissionStore(storage)
    await store.connectChain(SITE, 'solanaAccounts', ['So1'], 'eip155:1')
    const before = storage.sets
    await store.disconnectChain(SITE, 'tonAccounts')
    await store.disconnectChain(SITE, 'accounts')
    await store.disconnectChain('https://never.example', 'solanaAccounts')
    expect(storage.sets).toBe(before)
    await store.disconnectChain(SITE, 'solanaAccounts')
    expect(await store.get(SITE)).toBeNull()
  })

  it('the cache changes synchronously with the write and rolls back when storage.set fails; the queue keeps going', async () => {
    const storage = slowStorage<PermissionsState>()
    const store = new PermissionStore(storage)
    await store.connect(SITE, [ACCOUNT], 'eip155:1')
    const seen: Array<string | null> = []
    store.onChange((_o, p) => seen.push(p?.chain ?? null))
    storage.failNext = true
    const failing = store.setChain(SITE, 'eip155:8453')
    const after = store.setChain(SITE, 'eip155:10')
    await expect(failing).rejects.toThrow(/quota/)
    expect((await after)?.chain).toBe('eip155:10')
    expect(storage.value?.[SITE]?.chain).toBe('eip155:10')
    expect(seen).toEqual(['eip155:10']) // no listener call for the write that did not persist
    storage.failNext = true
    await expect(store.disconnect(SITE)).rejects.toThrow(/quota/)
    expect((await store.get(SITE))?.chain).toBe('eip155:10') // rolled back: still connected, as storage says
    expect(storage.value?.[SITE]).toBeDefined()
  })

  it('setAccountsEverywhere (a write per origin) runs inside the queue without deadlocking', async () => {
    const store = new PermissionStore(slowStorage<PermissionsState>())
    await Promise.all([store.connect('https://a.example', [ACCOUNT], 'eip155:1'), store.connect('https://b.example', [ACCOUNT], 'eip155:1')])
    const NEXT = '0x1111111111111111111111111111111111111111'
    const [changed] = await Promise.all([store.setAccountsEverywhere([NEXT]), store.disconnect('https://b.example')])
    expect(changed.map((p) => p.origin).sort()).toEqual(['https://a.example', 'https://b.example'])
    expect(await store.get('https://b.example')).toBeNull()
    expect((await store.get('https://a.example'))?.accounts).toEqual([NEXT])
  })
})

describe('NetworksTable serialization (scan F22)', () => {
  const net = (id: number): EvmNetwork => ({ caip2: `eip155:${id}`, chainId: id, name: `n${id}`, symbol: 'ETH', rpcs: [`https://rpc${id}.example`], custom: { origin: SITE, addedAt: 1 } })
  it('concurrent add/remove keep every write; a failed write rolls back', async () => {
    const storage = slowStorage<EvmNetwork[]>()
    const table = new NetworksTable(storage, [])
    await Promise.all([table.add(net(1001)), table.add(net(1002)), table.add(net(1003)), table.remove('eip155:1002'), table.add(net(1004))])
    expect((await table.list()).map((n) => n.chainId)).toEqual([1001, 1003, 1004])
    expect(storage.value!.map((n) => n.chainId)).toEqual([1001, 1003, 1004])
    storage.failNext = true
    await expect(table.add(net(1005))).rejects.toThrow(/quota/)
    expect((await table.list()).map((n) => n.chainId)).toEqual([1001, 1003, 1004])
    const before = storage.sets
    await table.remove('eip155:9999')
    expect(storage.sets).toBe(before)
  })
})
