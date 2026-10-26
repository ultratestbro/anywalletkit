/**
 * The unlocked state. An MV3 service worker dies after ~30 s idle, so the
 * unlocked vault key cannot live in a JS variable: it lives in
 * `chrome.storage.session` (memory-only, cleared when the browser exits, readable
 * by extension contexts only) together with its expiry, and a `chrome.alarms`
 * alarm locks it when the auto-lock timer (default 15 min since the last
 * activity) runs out.
 *
 * The session never sees a password or a seed — only the DEK the vault returned.
 * The popup never receives the DEK either: it asks the service worker to
 * perform operations by id.
 */
import { zeroize } from '@anywalletkit/core'
import { fromBase64, toBase64 } from './codec.js'
import { VaultError } from './errors.js'

/** Structural `chrome.storage.session` (or any `StorageArea`); `memorySessionStorage()` for tests. */
export interface SessionStorage {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
  remove(key: string): Promise<void>
}

/** Structural `chrome.alarms`: one named alarm, fired once at `when` (ms since epoch). */
export interface SessionAlarms {
  schedule(name: string, when: number): Promise<void> | void
  clear(name: string): Promise<void> | void
  /** Register the lock callback; the chrome adapter wires `chrome.alarms.onAlarm`. */
  onFire(handler: (name: string) => void): void
}

export interface SessionOptions {
  storage: SessionStorage
  alarms: SessionAlarms
  /** Lock this long after the last `touch` / `unlock`. Default 15 min; 0 disables the timer (lock only on browser exit or explicit lock; stored as `expiresAt: null`). */
  autoLockMs?: number
  /** Storage key and alarm name prefix. */
  name?: string
  /** Clock, injectable for tests. */
  now?: () => number
}

interface SessionRecord {
  key: string
  /** When the auto-lock fires (ms since epoch); `null` = no auto-lock. Never `Infinity`: chrome.storage stores JSON. */
  expiresAt: number | null
}

export const SESSION_DEFAULT_AUTOLOCK_MS = 15 * 60_000

export class Session {
  private readonly _storage: SessionStorage
  private readonly _alarms: SessionAlarms
  private _autoLockMs: number
  private readonly _key: string
  private readonly _alarm: string
  private readonly _now: () => number
  private readonly _onLock = new Set<() => void>()
  /**
   * Every operation on the stored record runs here, one after another: a `touch` that read the
   * record before a `lock` removed it would otherwise write it back and undo the lock.
   */
  private _queue: Promise<unknown> = Promise.resolve()
  /** Bumped by every lock; a `touch` writes only when no lock happened since it read the record. */
  private _epoch = 0

  constructor(options: SessionOptions) {
    this._storage = options.storage
    this._alarms = options.alarms
    this._autoLockMs = options.autoLockMs ?? SESSION_DEFAULT_AUTOLOCK_MS
    const name = options.name ?? 'anywalletkit-session'
    this._key = name
    this._alarm = `${name}/autolock`
    this._now = options.now ?? Date.now
    this._alarms.onFire((fired) => { if (fired === this._alarm) void this.lock() })
  }

  /** Store the DEK and arm the auto-lock. The caller's copy is zeroized. */
  async unlock(dek: Uint8Array): Promise<void> {
    if (dek.length !== 32) throw new VaultError('Vault key must be 32 bytes.', 'invalid-input')
    return this._serial(async () => {
      const expiresAt = this._expiry()
      await this._storage.set(this._key, { key: toBase64(dek), expiresAt } satisfies SessionRecord)
      zeroize(dek)
      await this._arm(expiresAt)
    })
  }

  /** Forget the DEK and cancel the alarm. Safe to call when already locked. */
  async lock(): Promise<void> {
    return this._serial(() => this._lockNow())
  }

  async isUnlocked(): Promise<boolean> {
    return this._serial(async () => (await this._read()) !== null)
  }

  /**
   * The DEK for one operation (zeroize it after). `locked` when there is none or the
   * timer ran out while the worker was asleep — the record is then removed as well, so
   * a missed alarm cannot keep the key alive.
   */
  async getKey(): Promise<Uint8Array> {
    return this._serial(async () => {
      const record = await this._read()
      if (!record) throw new VaultError('Wallet is locked.', 'locked')
      return fromBase64(record.key)
    })
  }

  /** User activity: push the auto-lock out again. No-op when locked. */
  async touch(): Promise<void> {
    return this._serial(async () => {
      const epoch = this._epoch
      const record = await this._read()
      if (!record || epoch !== this._epoch) return
      const expiresAt = this._expiry()
      await this._storage.set(this._key, { ...record, expiresAt } satisfies SessionRecord)
      await this._arm(expiresAt)
    })
  }

  get autoLockMs(): number {
    return this._autoLockMs
  }

  /** Change the timer (options page); re-arms from now when unlocked. 0 disables. */
  async setAutoLockMs(ms: number): Promise<void> {
    if (!Number.isFinite(ms) || ms < 0) throw new VaultError('Auto-lock must be a non-negative number of milliseconds.', 'invalid-input')
    this._autoLockMs = ms
    await this.touch()
  }

  onLock(callback: () => void): () => void {
    this._onLock.add(callback)
    return () => this._onLock.delete(callback)
  }

  private _serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(fn)
    this._queue = run.catch(() => undefined)
    return run
  }

  /** The lock itself; callers are already in the queue. */
  private async _lockNow(): Promise<void> {
    this._epoch++
    const was = await this._storage.get(this._key)
    await this._storage.remove(this._key)
    await this._alarms.clear(this._alarm)
    if (was !== undefined && was !== null) for (const cb of this._onLock) cb()
  }

  private _expiry(): number | null {
    return this._autoLockMs > 0 ? this._now() + this._autoLockMs : null
  }

  private async _arm(expiresAt: number | null): Promise<void> {
    if (expiresAt !== null) await this._alarms.schedule(this._alarm, expiresAt)
    else await this._alarms.clear(this._alarm)
  }

  /** The stored record, or `null` when locked. A record that is there but unreadable locks the wallet (removed, listeners told). */
  private async _read(): Promise<SessionRecord | null> {
    const raw = await this._storage.get(this._key)
    if (raw === undefined || raw === null) return null
    const r = raw as Partial<SessionRecord>
    const expiryOk = r.expiresAt === null || (typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt))
    if (typeof raw !== 'object' || typeof r.key !== 'string' || !expiryOk || !isKey(r.key)) { await this._lockNow(); return null }
    if (r.expiresAt !== null && r.expiresAt! <= this._now()) { await this._lockNow(); return null }
    return r as SessionRecord
  }
}

/** A stored DEK: base64 of exactly 32 bytes (the decoded copy is wiped). */
function isKey(text: string): boolean {
  let bytes: Uint8Array
  try { bytes = fromBase64(text) } catch { return false }
  const ok = bytes.length === 32
  zeroize(bytes)
  return ok
}

/** In-memory `chrome.storage.session` stand-in. */
export function memorySessionStorage(): SessionStorage & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>()
  return {
    data,
    async get(key) { return data.get(key) },
    async set(key, value) { data.set(key, structuredClone(value)) },
    async remove(key) { data.delete(key) },
  }
}

/** In-memory alarms: `fire(name)` from the test, `pending` to inspect. */
export function memoryAlarms(): SessionAlarms & { pending: Map<string, number>; fire(name: string): void } {
  const pending = new Map<string, number>()
  const handlers = new Set<(name: string) => void>()
  return {
    pending,
    schedule(name, when) { pending.set(name, when) },
    clear(name) { pending.delete(name) },
    onFire(handler) { handlers.add(handler) },
    fire(name) { pending.delete(name); for (const h of handlers) h(name) },
  }
}
