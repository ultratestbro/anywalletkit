import { describe, expect, it } from 'vitest'
import { createSecureStorage, type NativeCapabilities, type NativeSecureStorage } from '../src/index.js'

// Audit 2026-10-29 A2: setProtection('biometricsOnly') resolved while the old biometricsOrPasscode
// copy survived a failed native delete — info/list reported strict mode, a retry was a no-op, and
// neither a restart nor prune cleaned it up. Now the failure is reported (`stale-copy`), info/list
// report the weakest copy, and the removal is retried on the next operation, on start-up and in prune.

/** The in-memory stand-in of tests/storage.test.ts, plus a delete that fails on cue and a read log. */
function fakeNative(caps: Partial<NativeCapabilities> = {}) {
  const items = new Map<string, { value: string; meta: string }>()
  const state = {
    now: 1_000,
    failSet: null as null | { code: string },
    failGet: null as null | { code: string },
    /** keys whose deleteItem rejects */
    failDeleteKeys: new Set<string>(),
    reads: [] as string[],
    deletes: [] as string[],
  }
  const k = (ns: string, key: string) => `${ns}/${key}`
  const native: NativeSecureStorage = {
    async setItem(ns, key, value, protection) {
      if (state.failSet) throw Object.assign(new Error('native'), state.failSet)
      items.set(k(ns, key), { value, meta: JSON.stringify({ p: protection, t: state.now++ }) })
    },
    async getItem(ns, key) {
      state.reads.push(key)
      if (state.failGet) throw Object.assign(new Error('native'), state.failGet)
      return items.get(k(ns, key))?.value ?? null
    },
    async deleteItem(ns, key) {
      state.deletes.push(key)
      if (state.failDeleteKeys.has(key)) throw Object.assign(new Error('native delete failed'), { code: 'ERR_FW_STORAGE' })
      items.delete(k(ns, key))
    },
    async listItems(ns) {
      return [...items.entries()].filter(([key]) => key.startsWith(`${ns}/`)).map(([key, v]) => ({ key: key.slice(ns.length + 1), meta: v.meta }))
    },
    async capabilities() {
      return { platform: 'ios', passcodeSet: true, biometry: 'faceId', hardware: 'secureEnclave', ...caps }
    },
  }
  const slotsOf = (id: string) =>
    [...items.entries()].filter(([key]) => key.startsWith(`default/${id}#`)).map(([key, v]) => ({ key, p: (JSON.parse(v.meta) as { p: string }).p }))
  return { native, items, state, slotsOf }
}

/** An app's strict-mode check: every listed secret is biometricsOnly. */
async function appIsStrictMode(s: ReturnType<typeof createSecureStorage>) {
  const all = await s.list()
  return all.length > 0 && all.every((x) => x.protection === 'biometricsOnly')
}

/** A store holding `main` (biometricsOrPasscode) whose upgrade to strict mode could not remove the old copy. */
async function halfUpgraded() {
  const f = fakeNative()
  const s = createSecureStorage({ native: f.native })
  await s.set('main', 'seed words')
  f.state.failDeleteKeys.add('main#1')
  await expect(s.setProtection('main', 'biometricsOnly')).rejects.toMatchObject({ code: 'stale-copy', message: expect.stringMatching(/could not be removed/) })
  return { f, s }
}

describe('audit 2026-10-29 A2: no weaker copy is left behind silently', () => {
  it('protection change, delete fails: rejects stale-copy; info/list/strict-mode stay honest (weak)', async () => {
    const { f, s } = await halfUpgraded()
    expect(await s.info('main')).toMatchObject({ id: 'main', protection: 'biometricsOrPasscode' })
    expect(await s.list()).toEqual([expect.objectContaining({ id: 'main', protection: 'biometricsOrPasscode' })])
    expect(await appIsStrictMode(s)).toBe(false)
    expect(f.slotsOf('main').map((x) => x.p)).toEqual(['biometricsOrPasscode', 'biometricsOnly'])
  })

  it('get() reads the newest (strict) copy while both exist', async () => {
    const { f, s } = await halfUpgraded()
    f.state.reads.length = 0
    expect(await s.get('main')).toBe('seed words')
    expect(f.state.reads).toEqual(['main#2'])
  })

  it('a retry of setProtection removes the old copy, with no sheet, then reports strict', async () => {
    const { f, s } = await halfUpgraded()
    f.state.failDeleteKeys.clear()
    f.state.reads.length = 0
    await expect(s.setProtection('main', 'biometricsOnly')).resolves.toBeUndefined()
    expect(f.state.reads).toEqual([])
    expect(f.slotsOf('main')).toEqual([{ key: 'default/main#2', p: 'biometricsOnly' }])
    expect(await appIsStrictMode(s)).toBe(true)
  })

  it('a retry while the delete still fails rejects again', async () => {
    const { s } = await halfUpgraded()
    await expect(s.setProtection('main', 'biometricsOnly')).rejects.toMatchObject({ code: 'stale-copy' })
    expect(await s.info('main')).toMatchObject({ protection: 'biometricsOrPasscode' })
  })

  it('the next operation of any kind retries the removal (here a read)', async () => {
    const { f, s } = await halfUpgraded()
    f.state.failDeleteKeys.clear()
    expect(await s.has('main')).toBe(true)
    expect(f.slotsOf('main').map((x) => x.p)).toEqual(['biometricsOnly'])
    expect(await s.info('main')).toMatchObject({ protection: 'biometricsOnly' })
  })

  it('a restart sweeps on first use; prune(keep) sweeps the kept secrets', async () => {
    const { f } = await halfUpgraded()
    f.state.failDeleteKeys.clear()
    const restarted = createSecureStorage({ native: f.native })
    expect(await restarted.info('main')).toMatchObject({ protection: 'biometricsOnly' })
    expect(f.slotsOf('main').map((x) => x.p)).toEqual(['biometricsOnly'])

    const again = await halfUpgraded()
    again.f.state.failDeleteKeys.clear()
    expect(await createSecureStorage({ native: again.f.native }).prune(['main'])).toEqual([])
    expect(again.f.slotsOf('main').map((x) => x.p)).toEqual(['biometricsOnly'])
  })

  it('prune rejects stale-copy when a kept secret\'s old copy still cannot be removed', async () => {
    const { f } = await halfUpgraded()
    const restarted = createSecureStorage({ native: f.native })
    await expect(restarted.prune(['main'])).rejects.toMatchObject({ code: 'stale-copy' })
    expect(await restarted.info('main')).toMatchObject({ protection: 'biometricsOrPasscode' })
  })

  it('set() over an old copy that cannot be removed: rejects stale-copy, the new value is stored and read', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('main', 'old words')
    f.state.failDeleteKeys.add('main#1')
    await expect(s.set('main', 'new words')).rejects.toMatchObject({ code: 'stale-copy' })
    expect(await s.get('main')).toBe('new words')
    f.state.failDeleteKeys.clear()
    await s.set('other', 'x')
    expect(f.slotsOf('main')).toEqual([{ key: 'default/main#2', p: 'biometricsOrPasscode' }])
  })

  it('write fails during the protection change: rejects, nothing changes, info stays weak', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('main', 'seed words')
    f.state.failSet = { code: 'ERR_FW_CANCELLED' }
    await expect(s.setProtection('main', 'biometricsOnly')).rejects.toMatchObject({ code: 'cancelled' })
    f.state.failSet = null
    expect(await s.info('main')).toMatchObject({ protection: 'biometricsOrPasscode' })
    expect(f.slotsOf('main')).toEqual([{ key: 'default/main#1', p: 'biometricsOrPasscode' }])
  })

  it('read fails during the protection change: rejects, nothing written', async () => {
    const f = fakeNative()
    const s = createSecureStorage({ native: f.native })
    await s.set('main', 'seed words')
    f.state.failGet = { code: 'ERR_FW_CANCELLED' }
    await expect(s.setProtection('main', 'biometricsOnly')).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.slotsOf('main')).toEqual([{ key: 'default/main#1', p: 'biometricsOrPasscode' }])
  })

  it('delete(id) removes the oldest copy first: a failure never leaves the weak copy as the one get() reads', async () => {
    const { f, s } = await halfUpgraded()
    await expect(s.delete('main')).rejects.toMatchObject({ code: 'storage' })
    f.state.reads.length = 0
    expect(await s.get('main')).toBe('seed words')
    expect(f.state.reads).toEqual(['main#2'])
    expect(await s.info('main')).toMatchObject({ protection: 'biometricsOrPasscode' })
    f.state.failDeleteKeys.clear()
    await s.delete('main')
    expect(f.slotsOf('main')).toEqual([])
  })
})
