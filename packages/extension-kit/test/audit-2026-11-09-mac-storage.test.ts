import { describe, expect, it } from 'vitest'
import { PermissionStore, STORAGE_MAC_FIELD, VaultError, deriveStorageMacKey, macJsonStorage, memoryJsonStorage, type PermissionsState } from '../src/index.js'

// Extension audit 2026-11-09, E20: settings and site permissions in chrome.storage.local carried no
// integrity — whatever could write the area could switch protections off or plant a grant.

const DEK = (fill = 7) => new Uint8Array(32).fill(fill)
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))

async function setup(opts: { readWithoutKey?: 'unverified' | 'null'; writeWithoutKey?: 'unsigned' | 'refuse' } = {}) {
  const inner = memoryJsonStorage<unknown>()
  const holder: { key: Uint8Array | null } = { key: await deriveStorageMacKey(DEK()) }
  const store = macJsonStorage<{ a: number; b?: string }>(inner, { label: 'settings', key: async () => (holder.key ? Uint8Array.from(holder.key) : null), ...opts })
  return { inner, holder, store }
}

describe('deriveStorageMacKey', () => {
  it('is deterministic per DEK and differs between DEKs; not the DEK itself', async () => {
    const a = await deriveStorageMacKey(DEK(1))
    expect(a).toHaveLength(32)
    expect(Array.from(await deriveStorageMacKey(DEK(1)))).toEqual(Array.from(a))
    expect(Array.from(await deriveStorageMacKey(DEK(2)))).not.toEqual(Array.from(a))
    expect(Array.from(a)).not.toEqual(Array.from(DEK(1)))
    expect(await code(deriveStorageMacKey(new Uint8Array(16)))).toBe('invalid-input')
  })
})

describe('macJsonStorage', () => {
  it('round-trips a signed value; key order on disk does not matter', async () => {
    const { inner, store } = await setup()
    await store.set({ a: 1, b: 'x' })
    expect(await store.get()).toEqual({ a: 1, b: 'x' })
    const raw = inner.value as Record<string, unknown>
    inner.value = { value: { b: 'x', a: 1 }, [STORAGE_MAC_FIELD]: raw[STORAGE_MAC_FIELD] }
    expect(await store.read()).toEqual({ state: 'ok', value: { b: 'x', a: 1 } })
  })

  it('an edited value, a MAC from another store or another key does not verify', async () => {
    const { inner, holder, store } = await setup()
    await store.set({ a: 1 })
    const signed = structuredClone(inner.value) as Record<string, unknown>
    inner.value = { ...signed, value: { a: 2 } }
    expect(await store.read()).toMatchObject({ state: 'invalid', value: { a: 2 } })
    expect(await store.get()).toBeNull()
    // same key, other label
    const otherInner = memoryJsonStorage<unknown>()
    await macJsonStorage<{ a: number }>(otherInner, { label: 'permissions', key: async () => Uint8Array.from(holder.key!) }).set({ a: 1 })
    inner.value = otherInner.value
    expect((await store.read()).state).toBe('invalid')
    // other key
    inner.value = signed
    expect((await store.read()).state).toBe('ok')
    holder.key = await deriveStorageMacKey(DEK(9))
    expect((await store.read()).state).toBe('invalid')
  })

  it('a plain value (written before the MAC existed, or planted) is unsigned and not trusted', async () => {
    const { inner, store } = await setup()
    inner.value = { a: 5 }
    expect(await store.read()).toEqual({ state: 'unsigned', value: { a: 5 } })
    expect(await store.get()).toBeNull()
    inner.value = { [STORAGE_MAC_FIELD]: null, value: { a: 5 } }
    expect((await store.read()).state).toBe('unsigned')
    inner.value = { [STORAGE_MAC_FIELD]: 'not base64 !!', value: { a: 5 } }
    expect((await store.read()).state).toBe('invalid')
  })

  it('without a key: reads unverified (or null), writes unsigned (or refused) — and an unsigned write never verifies later', async () => {
    const { inner, holder, store } = await setup()
    await store.set({ a: 1 })
    const key = holder.key
    holder.key = null
    expect(await store.read()).toEqual({ state: 'no-key', value: { a: 1 } })
    expect(await store.get()).toEqual({ a: 1 })
    await store.set({ a: 2 })
    expect((inner.value as Record<string, unknown>)[STORAGE_MAC_FIELD]).toBeNull()
    holder.key = key
    expect((await store.read()).state).toBe('unsigned')
    expect(await store.get()).toBeNull()
    holder.key = null
    expect(await code(store.write({ a: 4 }))).toBe('locked')

    const strict = await setup({ readWithoutKey: 'null', writeWithoutKey: 'refuse' })
    await strict.store.set({ a: 1 })
    strict.holder.key = null
    expect(await strict.store.get()).toBeNull()
    expect(await code(strict.store.set({ a: 2 }))).toBe('locked')
  })

  it('an explicit key (from the password) reads and writes while the provider has none', async () => {
    const { holder, store } = await setup()
    const key = Uint8Array.from(holder.key!)
    holder.key = null
    await store.write({ a: 7 }, key)
    expect(await store.read(key)).toEqual({ state: 'ok', value: { a: 7 } })
    expect(key).toHaveLength(32)
    expect(Array.from(key).some((b) => b !== 0)).toBe(true) // the caller's copy is not wiped
  })

  it('rekey: a valid value moves to the new key; the old key stops verifying; invalid values stay invalid', async () => {
    const { inner, holder, store } = await setup()
    await store.set({ a: 1 })
    const oldKey = Uint8Array.from(holder.key!)
    const newKey = await deriveStorageMacKey(DEK(8))
    expect(await store.rekey(oldKey, newKey)).toBe('ok')
    expect(await store.read(newKey)).toEqual({ state: 'ok', value: { a: 1 } })
    expect((await store.read(oldKey)).state).toBe('invalid')
    inner.value = { a: 9 }
    expect(await store.rekey(newKey, oldKey)).toBe('unsigned')
    expect(inner.value).toEqual({ a: 9 })
  })

  it('under PermissionStore: a planted grant is not seen; signed grants work', async () => {
    const inner = memoryJsonStorage<unknown>()
    const key = await deriveStorageMacKey(DEK())
    const storage = () => macJsonStorage<PermissionsState>(inner, { label: 'permissions', key: async () => Uint8Array.from(key) })
    await new PermissionStore(storage()).connect('https://good.example', ['0x1'], 'eip155:1')
    expect((await new PermissionStore(storage()).list()).map((p) => p.origin)).toEqual(['https://good.example'])
    const stored = inner.value as { value: PermissionsState }
    inner.value = { ...stored, value: { ...stored.value, 'https://evil.example': { origin: 'https://evil.example', accounts: ['0x1'], chain: 'eip155:1', connectedAt: 1 } } }
    expect(await new PermissionStore(storage()).list()).toEqual([])
  })
})
