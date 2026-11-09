import { describe, expect, it } from 'vitest'
import { DEFAULT_NETWORKS, NetworksTable, RecipientBook, STORAGE_MAC_FIELD, STORAGE_VERSION_FIELD, deriveStorageMacKey, macJsonStorage, memoryJsonStorage, storageVersionLedger, type EvmNetwork, type JsonStorage, type RecipientsState } from '../src/index.js'

// Extension audit 2026-11-09, round two (owner decision 9b): a MAC proves who wrote a value, not that
// it is the latest one — an older signed value copied back verified. The version ledger refuses it.

const DEK = (fill = 7) => new Uint8Array(32).fill(fill)
type V = { a: number }

async function setup(opts: { acceptUnversioned?: boolean; now?: () => number } = {}) {
  const key = await deriveStorageMacKey(DEK())
  const holder: { key: Uint8Array | null } = { key }
  const provider = async () => (holder.key ? Uint8Array.from(holder.key) : null)
  const manifest = memoryJsonStorage<unknown>()
  const mark = memoryJsonStorage<unknown>()
  const ledger = storageVersionLedger({ manifest, mark, ...opts })
  const settingsInner = memoryJsonStorage<unknown>()
  const grantsInner = memoryJsonStorage<unknown>()
  const settings = macJsonStorage<V>(settingsInner, { label: 'settings', key: provider, versions: ledger })
  const grants = macJsonStorage<V>(grantsInner, { label: 'grants', key: provider, versions: ledger })
  return { key, holder, manifest, mark, ledger, settingsInner, grantsInner, settings, grants }
}
const snap = (s: { value: unknown }) => structuredClone(s.value)
const versionOf = (s: { value: unknown }) => (s.value as Record<string, unknown>)[STORAGE_VERSION_FIELD] as number

describe('storageVersionLedger + macJsonStorage({ versions })', () => {
  it('a signed value carries its version inside the MAC; each write of a store takes the next one', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    const v1 = versionOf(w.settingsInner)
    expect(Number.isSafeInteger(v1) && v1 > 0).toBe(true)
    expect(await w.settings.read()).toEqual({ state: 'ok', value: { a: 1 }, version: v1 })
    await w.settings.set({ a: 2 })
    expect(versionOf(w.settingsInner)).toBe(v1 + 1)
    expect(await w.settings.get()).toEqual({ a: 2 })
    // the version is part of what is signed: editing it, or the value, breaks the MAC
    const stored = snap(w.settingsInner) as Record<string, unknown>
    w.settingsInner.value = { ...stored, [STORAGE_VERSION_FIELD]: v1 + 5 }
    expect((await w.settings.read()).state).toBe('invalid')
    w.settingsInner.value = { ...stored, [STORAGE_VERSION_FIELD]: 'x' }
    expect((await w.settings.read()).state).toBe('invalid')
    // a signed value of another store at the same version does not verify here
    w.settingsInner.value = stored
    await w.grants.set({ a: 2 })
    await w.grants.set({ a: 2 })
    expect(versionOf(w.grantsInner)).toBe(versionOf(w.settingsInner))
    w.settingsInner.value = snap(w.grantsInner)
    expect((await w.settings.read()).state).toBe('invalid')
  })

  it('replay of an older signed value of ONE store is refused (stale), also after the browser restarts', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    const old = snap(w.settingsInner)
    await w.settings.set({ a: 2 })
    await w.grants.set({ a: 9 })
    w.settingsInner.value = old
    expect(await w.settings.read()).toMatchObject({ state: 'stale', value: { a: 1 } })
    expect(await w.settings.get()).toBeNull()
    expect((await w.grants.read()).state).toBe('ok') // the other store is still the one the manifest lists
    w.mark.value = null // browser restart: the session mark is gone, the manifest on disk still knows
    expect((await w.settings.read()).state).toBe('stale')
  })

  it('a store deleted after it was written is stale, not empty', async () => {
    const w = await setup()
    expect((await w.settings.read()).state).toBe('empty')
    await w.settings.set({ a: 1 })
    w.settingsInner.value = null
    expect(await w.settings.read()).toEqual({ state: 'stale', value: null })
    expect((await w.grants.read()).state).toBe('empty') // never written: nothing to roll back to
  })

  it('whole-area rollback (stores + manifest together) is caught while the session mark lives — and only then', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    await w.grants.set({ a: 1 })
    const old = { settings: snap(w.settingsInner), grants: snap(w.grantsInner), manifest: snap(w.manifest) }
    await w.settings.set({ a: 2 })
    await w.grants.set({ a: 2 })
    const rollBack = () => { w.settingsInner.value = structuredClone(old.settings); w.grantsInner.value = structuredClone(old.grants); w.manifest.value = structuredClone(old.manifest) }
    rollBack()
    expect((await w.settings.read()).state).toBe('stale')
    expect((await w.grants.read()).state).toBe('stale')
    expect((await w.ledger.read(w.key)).state).toBe('stale')
    // The documented limit: after a browser restart (no mark) a consistent older copy of the whole area is
    // indistinguishable from a restored backup.
    w.mark.value = null
    expect(await w.settings.read()).toMatchObject({ state: 'ok', value: { a: 1 } })
    expect((await w.grants.read()).state).toBe('ok')
  })

  it('the manifest deleted or edited: every store it covered is stale; a versioned value with no manifest at all is stale', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    const manifest = snap(w.manifest) as Record<string, unknown>
    w.manifest.value = null // in the same session: the mark remembers there was one
    expect((await w.settings.read()).state).toBe('stale')
    expect((await w.grants.read()).state).toBe('stale') // even a store with nothing in it: "nothing" is not trusted either
    w.mark.value = null // …and after a restart: a value that carries a version cannot exist without a manifest
    expect((await w.settings.read()).state).toBe('stale')
    w.manifest.value = { ...manifest, value: { ...(manifest.value as object), versions: {} } }
    expect((await w.settings.read()).state).toBe('stale')
    w.manifest.value = { ...manifest, [STORAGE_MAC_FIELD]: null }
    expect((await w.settings.read()).state).toBe('stale')
    w.manifest.value = 'garbage'
    expect((await w.settings.read()).state).toBe('stale')
    w.manifest.value = manifest
    expect((await w.settings.read()).state).toBe('ok')
  })

  it('a worker killed between the value and the manifest write is not an attack: the next read accepts and records it', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    await w.grants.set({ a: 1 })
    const manifestBefore = snap(w.manifest)
    await w.settings.set({ a: 2 }) // value written…
    w.manifest.value = structuredClone(manifestBefore) // …the manifest write never happened
    w.mark.value = null // and the browser restarted
    // another store is written first: the interrupted one must still be accepted afterwards
    await w.grants.set({ a: 3 })
    expect(await w.settings.read()).toMatchObject({ state: 'ok', value: { a: 2 } })
    expect((await w.ledger.read(w.key)).versions.settings).toBe(versionOf(w.settingsInner)) // healed
    expect((await w.grants.read()).state).toBe('ok')
    // the tolerance is exactly one step: nothing older, nothing further ahead
    const listed = versionOf(w.settingsInner)
    await w.settings.set({ a: 3 })
    await w.settings.set({ a: 4 })
    const ahead = snap(w.settingsInner)
    const m = snap(w.manifest) as { value: { versions: Record<string, number> } } & Record<string, unknown>
    expect(m.value.versions.settings).toBe(listed + 2)
    await w.settings.set({ a: 5 })
    w.settingsInner.value = ahead
    expect((await w.settings.read()).state).toBe('stale')
  })

  it('a write after an interrupted one never reuses its version (the interrupted value cannot be replayed later)', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    const manifestBefore = snap(w.manifest)
    await w.settings.set({ a: 2 })
    const interrupted = snap(w.settingsInner)
    w.manifest.value = structuredClone(manifestBefore) // the worker died before the manifest write — and so before the mark
    w.mark.value = versionOf({ value: manifestBefore })
    await w.settings.set({ a: 3 }) // written without a read in between
    expect(versionOf(w.settingsInner)).toBe(versionOf({ value: interrupted }) + 1)
    w.settingsInner.value = interrupted
    expect((await w.settings.read()).state).toBe('stale')
  })

  it('condemn: nothing signed before counts — not older values, not "nothing"; rewritten stores are trusted again, above every old version', async () => {
    let now = 1_000
    const w = await setup({ now: () => now })
    await w.settings.set({ a: 1 })
    const oldSettings = snap(w.settingsInner)
    const oldVersion = versionOf(w.settingsInner)
    now = 5_000
    await w.ledger.condemn(w.key)
    expect((await w.settings.read()).state).toBe('stale')
    expect((await w.grants.read()).state).toBe('stale')
    await w.grants.set({ a: 0 })
    expect((await w.grants.read()).state).toBe('ok')
    expect((await w.settings.read()).state).toBe('stale') // still: only a new write clears it
    await w.settings.write({ a: 1 })
    expect((await w.settings.read()).state).toBe('ok')
    expect(versionOf(w.settingsInner)).toBeGreaterThan(Math.max(oldVersion, 5_000))
    w.settingsInner.value = oldSettings
    expect((await w.settings.read()).state).toBe('stale')
  })

  it('a write over a missing or unreadable manifest starts over sealed: the other stores stay refused', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    await w.grants.set({ a: 1 })
    w.manifest.value = 'garbage'
    await w.grants.set({ a: 2 })
    expect((await w.grants.read()).state).toBe('ok')
    expect((await w.settings.read()).state).toBe('stale')
    expect((await w.ledger.read(w.key)).sealed).toBe(true)
  })

  it('a versioned value with no manifest (lost across a restart): the write that replaces it seals the new manifest', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    w.manifest.value = null
    w.mark.value = null
    expect((await w.grants.read()).state).toBe('empty') // nothing tells this from a new install yet
    await w.settings.write({ a: 1 })
    expect((await w.ledger.read(w.key)).sealed).toBe(true)
    expect((await w.settings.read()).state).toBe('ok')
    expect((await w.grants.read()).state).toBe('stale')
  })

  it('labels: no line break, and never the manifest\'s own', async () => {
    const w = await setup()
    const key = async () => Uint8Array.from(w.key)
    expect(() => macJsonStorage<V>(memoryJsonStorage<unknown>(), { label: 'a\nb', key, versions: w.ledger })).toThrow()
    const own = macJsonStorage<V>(memoryJsonStorage<unknown>(), { label: 'anywalletkit/storage-versions/1', key, versions: w.ledger })
    await expect(own.set({ a: 1 })).rejects.toThrow()
    await w.settings.set({ a: 1 }) // the refused write did not wedge the ledger
    expect((await w.settings.read()).state).toBe('ok')
  })

  it('round-one values (signed, no version): accepted once when asked to, upgraded by the next write, then a replay is stale', async () => {
    const w = await setup({ acceptUnversioned: true })
    const legacy = macJsonStorage<V>(w.settingsInner, { label: 'settings', key: async () => Uint8Array.from(w.key) })
    await legacy.set({ a: 1 })
    const roundOne = snap(w.settingsInner) as Record<string, unknown>
    expect(STORAGE_VERSION_FIELD in roundOne).toBe(false)
    expect(await w.settings.read()).toEqual({ state: 'ok', value: { a: 1 }, version: 0 })
    await w.grants.set({ a: 1 }) // the manifest now exists; a store it does not list yet is still in its round-one form
    expect((await w.settings.read()).state).toBe('ok')
    await w.settings.write({ a: 1 }) // the upgrade
    expect(versionOf(w.settingsInner)).toBeGreaterThan(0)
    w.settingsInner.value = roundOne
    expect((await w.settings.read()).state).toBe('stale')
    // an edited round-one value is invalid, not stale
    w.settingsInner.value = { ...roundOne, value: { a: 2 } }
    expect((await w.settings.read()).state).toBe('invalid')
    // a sealed manifest (after condemn) refuses round-one values of every store
    const again = await setup({ acceptUnversioned: true })
    again.settingsInner.value = roundOne
    expect((await again.settings.read()).state).toBe('ok')
    await again.ledger.condemn(again.key)
    expect((await again.settings.read()).state).toBe('stale')
    // by default a ledger does not accept them at all
    const strict = await setup()
    strict.settingsInner.value = roundOne
    expect((await strict.settings.read()).state).toBe('stale')
  })

  it('key rotation: ledger first, then the stores — versions and the mark only go up, the old key verifies nothing', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    await w.grants.set({ a: 1 })
    const before = await w.ledger.read(w.key)
    const markBefore = w.mark.value as number
    const oldCopy = { settings: snap(w.settingsInner), manifest: snap(w.manifest) }
    const newKey = await deriveStorageMacKey(DEK(8))
    expect(await w.ledger.rekey(w.key, newKey)).toBe('ok')
    w.holder.key = newKey
    expect(await w.settings.rekey(w.key, newKey)).toBe('ok')
    expect(await w.grants.rekey(w.key, newKey)).toBe('ok')
    const after = await w.ledger.read(newKey)
    expect(after.state).toBe('ok')
    expect(after.epoch).toBeGreaterThan(before.epoch)
    expect(after.versions).toEqual(before.versions)
    expect(w.mark.value as number).toBeGreaterThan(markBefore)
    expect(await w.settings.read()).toMatchObject({ state: 'ok', value: { a: 1 } })
    expect((await w.settings.read(w.key)).state).toBe('invalid')
    await w.settings.set({ a: 2 })
    expect(versionOf(w.settingsInner)).toBe(before.versions.settings! + 1)
    // the pre-rotation copies (old key) are refused whatever the mark says
    w.settingsInner.value = oldCopy.settings
    w.manifest.value = oldCopy.manifest
    w.mark.value = null
    expect((await w.settings.read()).state).toBe('invalid')
    // a store rekeyed without its ledger is not carried over
    const lone = await setup()
    await lone.settings.set({ a: 1 })
    lone.holder.key = newKey
    expect(await lone.settings.rekey(lone.key, newKey)).toBe('stale')
    expect((await lone.settings.read()).state).not.toBe('ok')
  })

  it('without a key nothing changes: no-key reads, unsigned writes that never verify later', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    const key = w.holder.key
    w.holder.key = null
    expect(await w.settings.read()).toMatchObject({ state: 'no-key', value: { a: 1 } })
    await w.settings.set({ a: 2 })
    w.holder.key = key
    expect((await w.settings.read()).state).toBe('unsigned')
  })

  it('reset: a new vault starts with no manifest and no mark', async () => {
    const w = await setup()
    await w.settings.set({ a: 1 })
    w.settingsInner.value = null
    await w.ledger.reset()
    expect(w.mark.value).toBeNull()
    expect((await w.ledger.read(w.key)).state).toBe('empty')
    expect((await w.settings.read()).state).toBe('empty')
  })

  it('writes of different stores at the same time do not lose each other', async () => {
    const w = await setup()
    await Promise.all([w.settings.set({ a: 1 }), w.grants.set({ a: 2 }), w.settings.set({ a: 3 })])
    expect(await w.settings.get()).toEqual({ a: 3 })
    expect(await w.grants.get()).toEqual({ a: 2 })
  })
})

describe('reload() — a store read before the key existed is read again', () => {
  const custom: EvmNetwork = { caip2: 'eip155:424242', chainId: 424242, name: 'Custom', symbol: 'CST', rpcs: ['https://rpc.custom.example'], custom: { origin: 'https://dapp.example', addedAt: 1 } }

  it('NetworksTable', async () => {
    let visible = false
    const inner = memoryJsonStorage<EvmNetwork[]>([custom])
    const storage: JsonStorage<EvmNetwork[]> = { get: async () => (visible ? inner.get() : null), set: (v) => inner.set(v) }
    const table = new NetworksTable(storage)
    expect(await table.get(custom.caip2)).toBeNull()
    visible = true
    expect(await table.get(custom.caip2)).toBeNull() // cached
    await table.reload()
    expect(await table.get(custom.caip2)).toEqual(custom)
    expect(await table.list()).toHaveLength(DEFAULT_NETWORKS.length + 1)
  })

  it('RecipientBook', async () => {
    let visible = false
    const inner = memoryJsonStorage<RecipientsState>({ eip155: ['0x1111111111111111111111111111111111111111'] })
    const book = new RecipientBook({ get: async () => (visible ? inner.get() : null), set: (v) => inner.set(v) })
    expect((await book.check('eip155', '0x1111111111111111111111111111111111111111')).known).toBe(false)
    visible = true
    expect((await book.check('eip155', '0x1111111111111111111111111111111111111111')).known).toBe(false)
    await book.reload()
    expect((await book.check('eip155', '0x1111111111111111111111111111111111111111')).known).toBe(true)
  })
})
