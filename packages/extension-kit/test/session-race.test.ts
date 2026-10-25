import { describe, expect, it } from 'vitest'
import { Session, memoryAlarms, memorySessionStorage, type SessionStorage } from '../src/index.js'

// Audit 2026-10-25, finding 5: a touch() that read the record before a lock() removed it wrote
// the record back afterwards — the wallet stayed unlocked after the user (or the alarm) locked it.

const DEK = () => Uint8Array.from({ length: 32 }, (_, i) => i + 1)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** chrome.storage.session with real latency: reads and writes take a few ms, as IPC does. */
function slowStorage(): SessionStorage & { data: Map<string, unknown> } {
  const inner = memorySessionStorage()
  return {
    data: inner.data,
    async get(key) { await wait(5); return inner.get(key) },
    async set(key, value) { await wait(5); return inner.set(key, value) },
    async remove(key) { await wait(1); return inner.remove(key) },
  }
}

function make() {
  const storage = slowStorage()
  const alarms = memoryAlarms()
  const session = new Session({ storage, alarms })
  return { storage, alarms, session }
}

describe('Session: a lock is never undone by concurrent activity', () => {
  it('touch() then lock(), started together → locked', async () => {
    const { session, alarms } = make()
    await session.unlock(DEK())
    await Promise.all([session.touch(), session.lock()])
    expect(await session.isUnlocked()).toBe(false)
    expect(alarms.pending.size).toBe(0)
  })

  it('lock() then touch(), started together → locked', async () => {
    const { session, alarms } = make()
    await session.unlock(DEK())
    await Promise.all([session.lock(), session.touch()])
    expect(await session.isUnlocked()).toBe(false)
    expect(alarms.pending.size).toBe(0)
  })

  it('the auto-lock alarm during a touch() → locked', async () => {
    const { session, alarms } = make()
    await session.unlock(DEK())
    const touching = session.touch()
    alarms.fire('anywalletkit-session/autolock')
    await touching
    await wait(30)
    expect(await session.isUnlocked()).toBe(false)
  })

  it('getKey() started before lock() still answers; started after, it is locked', async () => {
    const { session } = make()
    await session.unlock(DEK())
    const [key, , after] = await Promise.allSettled([session.getKey(), session.lock(), session.getKey()])
    expect(key.status).toBe('fulfilled')
    expect(after).toMatchObject({ status: 'rejected', reason: { code: 'locked' } })
  })

  it('many touches around one lock → locked, and a later unlock works', async () => {
    const { session } = make()
    await session.unlock(DEK())
    await Promise.all([session.touch(), session.touch(), session.lock(), session.touch(), session.setAutoLockMs(60_000)])
    expect(await session.isUnlocked()).toBe(false)
    await session.unlock(DEK())
    expect(await session.isUnlocked()).toBe(true)
  })
})
