import { describe, expect, it } from 'vitest'
import { Session, VaultError, chromeAlarms, chromeSessionStorage, memoryAlarms, memorySessionStorage, type AlarmsLike, type StorageAreaLike } from '../src/index.js'

const DEK = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))

function make(autoLockMs?: number) {
  let t = 1_000_000
  const storage = memorySessionStorage()
  const alarms = memoryAlarms()
  const session = new Session({ storage, alarms, now: () => t, ...(autoLockMs === undefined ? {} : { autoLockMs }) })
  return { storage, alarms, session, tick: (ms: number) => { t += ms } }
}

describe('Session', () => {
  it('holds the key in session storage, arms the auto-lock alarm, zeroizes the caller copy', async () => {
    const { storage, alarms, session } = make()
    expect(await session.isUnlocked()).toBe(false)
    expect(await code(session.getKey())).toBe('locked')
    const dek = DEK()
    await session.unlock(dek)
    expect(Array.from(dek)).toEqual(new Array(32).fill(0))
    expect(await session.isUnlocked()).toBe(true)
    expect(Array.from(await session.getKey())).toEqual(Array.from(DEK()))
    expect(storage.data.size).toBe(1)
    expect(alarms.pending.get('anywalletkit-session/autolock')).toBe(1_000_000 + 15 * 60_000)
    expect(await code(session.unlock(new Uint8Array(16)))).toBe('invalid-input')
  })

  it('locks when the alarm fires and notifies listeners once', async () => {
    const { alarms, session } = make()
    let locks = 0
    const off = session.onLock(() => locks++)
    await session.unlock(DEK())
    alarms.fire('anywalletkit-session/autolock')
    await Promise.resolve()
    expect(await session.isUnlocked()).toBe(false)
    expect(locks).toBe(1)
    await session.lock() // already locked: no second notification
    expect(locks).toBe(1)
    off()
  })

  it('treats an expired record as locked even if the alarm never fired (worker asleep)', async () => {
    const { session, storage, tick } = make(60_000)
    await session.unlock(DEK())
    tick(59_999)
    expect(await session.isUnlocked()).toBe(true)
    tick(1)
    expect(await code(session.getKey())).toBe('locked')
    expect(storage.data.size).toBe(0)
  })

  it('touch extends the expiry and re-arms the alarm; no-op when locked', async () => {
    const { session, alarms, tick } = make(60_000)
    await session.touch()
    expect(alarms.pending.size).toBe(0)
    await session.unlock(DEK())
    tick(30_000)
    await session.touch()
    expect(alarms.pending.get('anywalletkit-session/autolock')).toBe(1_000_000 + 90_000)
    tick(59_000)
    expect(await session.isUnlocked()).toBe(true)
  })

  it('autoLockMs = 0 disables the timer (no alarm, no expiry)', async () => {
    const { session, alarms, tick } = make(0)
    await session.unlock(DEK())
    expect(alarms.pending.size).toBe(0)
    tick(10 ** 12)
    expect(await session.isUnlocked()).toBe(true)
    await session.lock()
    expect(await session.isUnlocked()).toBe(false)
  })

  it('works over chrome.storage.session + chrome.alarms shaped objects and pins the access level', async () => {
    const items = new Map<string, unknown>()
    let accessLevel = ''
    const area: StorageAreaLike = {
      async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = items.get(k); return out },
      async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, v) },
      async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
      async setAccessLevel(o) { accessLevel = o.accessLevel },
    }
    const created = new Map<string, number>()
    const listeners: Array<(a: { name: string }) => void> = []
    const alarms: AlarmsLike = {
      create(name, info) { created.set(name, info.when) },
      clear(name) { return created.delete(name) },
      onAlarm: { addListener(cb) { listeners.push(cb) } },
    }
    const session = new Session({ storage: chromeSessionStorage(area), alarms: chromeAlarms(alarms), name: 's' })
    await session.unlock(DEK())
    expect(accessLevel).toBe('TRUSTED_CONTEXTS')
    expect(items.has('s')).toBe(true)
    expect(created.has('s/autolock')).toBe(true)
    for (const l of listeners) l({ name: 's/autolock' })
    await new Promise((r) => setTimeout(r, 0))
    expect(items.has('s')).toBe(false)
    expect(created.has('s/autolock')).toBe(false)
  })
})
