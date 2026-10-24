import { describe, expect, it } from 'vitest'
import type { SecretStorage } from '@anywalletkit/keyring'
import { createSecureStorage, isSecureStorageError, type NativeCapabilities, type NativeSecureStorage, type Protection } from '../src/index.js'

/** In-memory stand-in for the Expo module: counts OS prompts, can fail on cue. */
function fakeNative(caps: Partial<NativeCapabilities> = {}) {
  const items = new Map<string, { value: string; meta: string }>()
  const state = { prompts: 0, failGet: null as null | { code: string }, failSet: null as null | { code: string }, now: 1_000 }
  const k = (ns: string, key: string) => `${ns}/${key}`
  const native: NativeSecureStorage = {
    async setItem(ns, key, value, protection) {
      if (state.failSet) throw Object.assign(new Error('native'), state.failSet)
      items.set(k(ns, key), { value, meta: JSON.stringify({ p: protection, t: state.now++ }) })
    },
    async getItem(ns, key) {
      state.prompts++
      if (state.failGet) throw Object.assign(new Error('native'), state.failGet)
      return items.get(k(ns, key))?.value ?? null
    },
    async deleteItem(ns, key) {
      items.delete(k(ns, key))
    },
    async listItems(ns) {
      return [...items.entries()].filter(([key]) => key.startsWith(`${ns}/`)).map(([key, v]) => ({ key: key.slice(ns.length + 1), meta: v.meta }))
    },
    async capabilities() {
      return { platform: 'ios', passcodeSet: true, biometry: 'faceId', hardware: 'secureEnclave', ...caps }
    },
  }
  return { native, items, state }
}

describe('secure storage', () => {
  it('is a keyring SecretStorage', () => {
    const s: SecretStorage = createSecureStorage({ native: fakeNative().native })
    expect(typeof s.get).toBe('function')
  })

  it('stores, reads, lists without prompts and deletes', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('main', 'seed words')
    expect(await s.has('main')).toBe(true)
    expect(await s.list()).toEqual([{ id: 'main', protection: 'biometricsOrPasscode', createdAt: 1000 }])
    expect(f.state.prompts).toBe(0)
    expect(await s.get('main')).toBe('seed words')
    expect(f.state.prompts).toBe(1)
    await s.delete('main')
    expect(await s.get('main')).toBeNull()
    expect(f.items.size).toBe(0)
  })

  it('replaces through a fresh slot and keeps the old one when the write fails', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('a', 'one')
    await s.set('a', 'two')
    expect([...f.items.keys()]).toEqual(['default/a#2'])
    f.state.failSet = { code: 'ERR_FW_CANCELLED' }
    await expect(s.set('a', 'three')).rejects.toMatchObject({ code: 'cancelled' })
    f.state.failSet = null
    expect(await s.get('a')).toBe('two')
  })

  it('reads the newest slot when a crash left two behind', async () => {
    const f = fakeNative()
    f.items.set('default/a#1', { value: 'old', meta: JSON.stringify({ p: 'biometricsOrPasscode', t: 1 }) })
    f.items.set('default/a#2', { value: 'new', meta: JSON.stringify({ p: 'biometricsOrPasscode', t: 2 }) })
    const s = createSecureStorage({ native: f.native })
    expect(await s.get('a')).toBe('new')
    expect(await s.list()).toHaveLength(1)
  })

  it('serializes concurrent writes to one id', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await Promise.all([s.set('a', '1'), s.set('a', '2'), s.set('a', '3')])
    expect(f.items.size).toBe(1)
    expect(await s.get('a')).toBe('3')
  })

  it('keeps namespaces apart', async () => {
    const f = fakeNative()
    const a = createSecureStorage({ native: f.native, namespace: 'app-a' })
    const b = createSecureStorage({ native: f.native, namespace: 'app-b' })
    await a.set('x', 'secret-a')
    expect(await b.has('x')).toBe(false)
    expect(await b.prune([])).toEqual([])
    expect(await a.get('x')).toBe('secret-a')
  })

  it('keeps an existing protection on overwrite instead of silently downgrading', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('a', 'v', { protection: 'biometricsOnly' })
    await s.set('a', 'v2')
    expect((await s.info('a'))?.protection).toBe('biometricsOnly')
  })

  it('switches protection with one read', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('a', 'seed')
    await s.setProtection('a', 'biometricsOnly')
    expect((await s.info('a'))?.protection).toBe('biometricsOnly')
    expect(f.state.prompts).toBe(1)
    expect(await s.get('a')).toBe('seed')
    await s.setProtection('a', 'biometricsOnly') // no-op
    expect(f.state.prompts).toBe(2)
  })

  it('refuses strict mode without enrolled biometrics, before any prompt', async () => {
    const f = fakeNative({ biometry: null })
    const s = createSecureStorage({ native: f.native })
    await s.set('a', 'seed')
    await expect(s.setProtection('a', 'biometricsOnly')).rejects.toMatchObject({ code: 'not-available' })
    expect(f.state.prompts).toBe(0)
    expect((await s.info('a'))?.protection).toBe('biometricsOrPasscode')
  })

  it('maps native error codes', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('a', 'seed', { protection: 'biometricsOnly' })
    for (const [code, mapped] of [
      ['ERR_FW_BIOMETRY_CHANGED', 'biometry-changed'],
      ['ERR_FW_CANCELLED', 'cancelled'],
      ['ERR_FW_LOCKOUT', 'lockout'],
      ['ERR_FW_NO_PASSCODE', 'no-passcode'],
      ['ERR_FW_LOCKED', 'locked'],
      ['SOMETHING_ELSE', 'storage'],
    ] as const) {
      f.state.failGet = { code }
      const err = await s.get('a').catch((e: unknown) => e)
      expect(isSecureStorageError(err, mapped)).toBe(true)
    }
  })

  it('rejects bad ids, namespaces, secrets and protections before the native layer', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    for (const id of ['', 'a#1', '../x', 'a b', 'x'.repeat(129)]) {
      await expect(s.set(id, 'v')).rejects.toMatchObject({ code: 'invalid' })
    }
    await expect(s.set('a', '')).rejects.toMatchObject({ code: 'invalid' })
    await expect(s.set('a', 'v', { protection: 'none' as Protection })).rejects.toMatchObject({ code: 'invalid' })
    expect(() => createSecureStorage({ native: f.native, namespace: 'a/b' })).toThrow(/namespace/)
    expect(f.items.size).toBe(0)
  })

  it('ignores foreign and malformed entries', async () => {
    const f = fakeNative()
    f.items.set('default/not-a-slot', { value: 'x', meta: '{}' })
    f.items.set('default/a#1', { value: 'x', meta: 'not json' })
    f.items.set('default/b#1', { value: 'x', meta: JSON.stringify({ p: 'weird', t: 1 }) })
    const s = createSecureStorage({ native: f.native })
    expect(await s.list()).toEqual([])
  })

  it('prunes secrets the app no longer knows (Keychain outlives an uninstall)', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('main', 'a')
    await s.set('imported1', 'b')
    await s.set('orphan', 'c')
    expect(await s.prune(['main', 'imported1'])).toEqual(['orphan'])
    expect((await s.list()).map((x) => x.id)).toEqual(['main', 'imported1'])
  })

  it('migrates with read-back verification and deletes the old copy only after it matches', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    const old = new Map([['main', 'seed one'], ['imp', 'seed two']])
    const deleted: string[] = []
    const source = { get: async (id: string) => old.get(id) ?? null, delete: async (id: string) => void deleted.push(id) }
    await s.set('imp', 'already here')
    const r = await s.migrateFrom(source, ['main', 'imp', 'none'])
    expect(r).toEqual({ migrated: ['main'], empty: ['none'], alreadyPresent: ['imp'] })
    expect(deleted).toEqual(['main'])
    expect(await s.get('main')).toBe('seed one')
    expect(await s.get('imp')).toBe('already here')
  })

  it('keeps the old copy when verification fails', async () => {
    const f = fakeNative()
    const realGet = f.native.getItem
    f.native.getItem = async () => 'corrupted'
    const s = createSecureStorage({ native: f.native })
    const deleted: string[] = []
    const source = { get: async () => 'seed', delete: async (id: string) => void deleted.push(id) }
    await expect(s.migrateFrom(source, ['main'])).rejects.toMatchObject({ code: 'storage' })
    expect(deleted).toEqual([])
    f.native.getItem = realGet
    expect(await s.has('main')).toBe(false)
  })

  it('keeps the old copy when the user cancels the migration', async () => {
    const f = fakeNative()
    f.state.failSet = { code: 'ERR_FW_CANCELLED' }
    const s = createSecureStorage({ native: f.native })
    const deleted: string[] = []
    await expect(s.migrateFrom({ get: async () => 'seed', delete: async (id) => void deleted.push(id) }, ['main'])).rejects.toMatchObject({ code: 'cancelled' })
    expect(deleted).toEqual([])
  })
})
