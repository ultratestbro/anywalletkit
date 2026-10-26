import { describe, expect, it } from 'vitest'
import { Session, VaultError, chromeSessionStorage, memoryAlarms, type StorageAreaLike } from '../src/index.js'

// Audit 2026-10-25 round 3, M17: with `autoLockMs: 0` ("no auto-lock") the record was stored with
// `expiresAt: Infinity`. chrome.storage serializes values as JSON, Infinity becomes null, and the
// next read took the record for missing: the wallet was locked right after unlock. A record that is
// there but unreadable was likewise treated as "locked" without removing it or telling listeners.

const DEK = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof VaultError ? e.code : `other:${String(e)}`))

/** chrome.storage.session as Chrome has it: values go through JSON. */
function jsonArea(): StorageAreaLike & { items: Map<string, string> } {
  const items = new Map<string, string>()
  return {
    items,
    async get(keys) { const out: Record<string, unknown> = {}; for (const k of Array.isArray(keys) ? keys : [keys]) if (items.has(k)) out[k] = JSON.parse(items.get(k)!); return out },
    async set(o) { for (const [k, v] of Object.entries(o)) items.set(k, JSON.stringify(v)) },
    async remove(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) items.delete(k) },
  }
}

describe('Session without auto-lock, on storage that goes through JSON', () => {
  it('autoLockMs: 0 keeps the wallet unlocked and arms no alarm', async () => {
    const area = jsonArea()
    const alarms = memoryAlarms()
    let t = 1_000_000
    const session = new Session({ storage: chromeSessionStorage(area), alarms, autoLockMs: 0, name: 's', now: () => t })
    await session.unlock(DEK())
    t += 365 * 24 * 60 * 60_000
    expect(await session.isUnlocked()).toBe(true)
    expect(Array.from(await session.getKey())).toEqual(Array.from(DEK()))
    await session.touch()
    expect(await session.isUnlocked()).toBe(true)
    expect(alarms.pending.size).toBe(0)
    expect(JSON.parse(area.items.get('s')!)).toMatchObject({ expiresAt: null })
  })

  it('switching the timer on and off again works across the JSON round trip', async () => {
    const area = jsonArea()
    const alarms = memoryAlarms()
    let t = 1_000_000
    const session = new Session({ storage: chromeSessionStorage(area), alarms, name: 's', now: () => t })
    await session.unlock(DEK())
    await session.setAutoLockMs(0)
    t += 60 * 60_000
    expect(await session.isUnlocked()).toBe(true)
    expect(alarms.pending.size).toBe(0)
    await session.setAutoLockMs(60_000)
    expect(alarms.pending.get('s/autolock')).toBe(t + 60_000)
    t += 60_001
    expect(await session.isUnlocked()).toBe(false)
  })

  it('a stored record that cannot be read locks the wallet: removed, listeners told', async () => {
    for (const broken of [{ key: 42, expiresAt: null }, { key: 'AAAA', expiresAt: 'soon' }, { expiresAt: null }, 'garbage', { key: 'AAAA', expiresAt: null } /* 3 bytes, not a 32-byte key */]) {
      const area = jsonArea()
      const session = new Session({ storage: chromeSessionStorage(area), alarms: memoryAlarms(), name: 's' })
      let locks = 0
      session.onLock(() => locks++)
      area.items.set('s', JSON.stringify(broken))
      expect(await code(session.getKey())).toBe('locked')
      expect(area.items.has('s')).toBe(false)
      expect(locks).toBe(1)
    }
  })
})
