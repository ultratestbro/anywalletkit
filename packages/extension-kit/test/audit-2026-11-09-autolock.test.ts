import { describe, expect, it } from 'vitest'
import { Session, memoryAlarms, memorySessionStorage } from '../src/index.js'

// Extension audit 2026-11-09, E11: every service-worker start ran `setAutoLockMs(<setting>)`, which
// ended in `touch()` — so each restart (alarms every minute, every page load, port reconnects) pushed
// the auto-lock out by a full period and the wallet never locked.

const DEK = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const MIN = 60_000
const ALARM = 'anywalletkit-session/autolock'

function world() {
  let t = 1_000_000
  const storage = memorySessionStorage()
  const alarms = memoryAlarms()
  /** A fresh worker: a new Session over the same storage and alarms, as after an MV3 restart. */
  const worker = (autoLockMs = 15 * MIN) => new Session({ storage, alarms, now: () => t, autoLockMs })
  const expiresAt = () => (storage.data.get('anywalletkit-session') as { expiresAt: number | null } | undefined)?.expiresAt
  return { storage, alarms, worker, expiresAt, tick: (ms: number) => { t += ms }, now: () => t }
}

describe('auto-lock survives worker restarts (E11)', () => {
  it('a restarted worker applying the stored setting does not extend the deadline', async () => {
    const w = world()
    const t0 = w.now()
    await w.worker().unlock(DEK())
    expect(w.expiresAt()).toBe(t0 + 15 * MIN)
    for (let i = 0; i < 14; i++) {
      w.tick(MIN)
      // what the extension does at the top of every worker start
      await w.worker().setAutoLockMs(15 * MIN)
      expect(w.expiresAt()).toBe(t0 + 15 * MIN)
    }
    w.tick(MIN)
    expect(await w.worker().isUnlocked()).toBe(false)
  })

  it('a restart re-arms a lost alarm at the stored deadline, never later', async () => {
    const w = world()
    const t0 = w.now()
    await w.worker().unlock(DEK())
    w.alarms.pending.clear() // the browser dropped the alarm
    w.tick(3 * MIN)
    await w.worker().setAutoLockMs(15 * MIN)
    expect(w.alarms.pending.get(ALARM)).toBe(t0 + 15 * MIN)
  })

  it('a shorter period takes effect at once; a longer one waits for the next explicit touch', async () => {
    const w = world()
    const s = w.worker()
    await s.unlock(DEK())
    w.tick(MIN)
    await s.setAutoLockMs(5 * MIN)
    expect(w.expiresAt()).toBe(w.now() + 5 * MIN)
    expect(w.alarms.pending.get(ALARM)).toBe(w.now() + 5 * MIN)
    const shortened = w.expiresAt()
    await s.setAutoLockMs(60 * MIN)
    expect(w.expiresAt()).toBe(shortened) // not extended
    await s.setAutoLockMs(0)
    expect(w.expiresAt()).toBe(shortened) // "never" does not extend either
    await s.touch() // the user's gesture applies the new period
    expect(w.expiresAt()).toBeNull()
    expect(w.alarms.pending.has(ALARM)).toBe(false)
  })

  it('locked: setAutoLockMs only stores the period (no record appears)', async () => {
    const w = world()
    const s = w.worker()
    await s.setAutoLockMs(5 * MIN)
    expect(w.storage.data.size).toBe(0)
    expect(w.alarms.pending.size).toBe(0)
    await s.unlock(DEK())
    expect(w.expiresAt()).toBe(w.now() + 5 * MIN)
  })

  it('an expired record found at startup locks instead of being re-armed', async () => {
    const w = world()
    await w.worker().unlock(DEK())
    w.tick(16 * MIN)
    const s = w.worker()
    let locks = 0
    s.onLock(() => locks++)
    await s.setAutoLockMs(15 * MIN)
    expect(w.storage.data.size).toBe(0)
    expect(locks).toBe(1)
  })
})
