import { SecureStorageError, fromNative } from './errors.js'
import { loadNative, type NativeCapabilities, type NativePrompt, type NativeSecureStorage } from './native.js'
import { PROTECTIONS, type Protection, type StoredSecretInfo } from './types.js'

/** Texts for the OS authentication sheet. */
export interface PromptText {
  /** iOS: the line under Face ID / the passcode sheet. Android: the subtitle. */
  reason?: string
  /** Android sheet title. */
  title?: string
  /** Android cancel button (strict mode only — the default mode offers the passcode instead). */
  cancel?: string
}

export interface SecureStorageOptions {
  /**
   * Keeps one app's secrets apart from another's (and from tests). Letters,
   * digits, `.`, `_`, `-`. Default `"default"`.
   */
  namespace?: string
  /** Protection for secrets written without an explicit one. Default `biometricsOrPasscode`. */
  protection?: Protection
  /** Default sheet text for reads (`unlock`) and, on Android, writes (`save`). */
  prompts?: { unlock?: PromptText; save?: PromptText }
  /** The native module — injected by tests; the installed Expo module otherwise. */
  native?: NativeSecureStorage
}

export interface SetSecretOptions {
  /** Defaults to the protection the secret already has, then the store default. */
  protection?: Protection | undefined
  prompt?: PromptText | undefined
}

export interface MigrationSource {
  /** Read the secret from the old store (may prompt). null = nothing there. */
  get(id: string): Promise<string | null>
  /** Remove it from the old store — called only after the copy was read back and matched. */
  delete(id: string): Promise<void>
}

export interface MigrateOptions {
  protection?: Protection
  /**
   * Read the new copy back and compare before deleting the old one (one extra
   * prompt per secret, once). Default true — leave it on unless the platform
   * already prompted inside `set` and the app accepts the risk.
   */
  verify?: boolean
  prompt?: PromptText
}

export interface MigrationResult {
  /** Copied, verified, removed from the old store. */
  migrated: string[]
  /** The old store had nothing under this id. */
  empty: string[]
  /** The new store already holds this id; the old copy was left alone for the app to decide. */
  alreadyPresent: string[]
}

/**
 * Device secret storage. Structurally a keyring `SecretStorage`
 * (`get` / `set` / `delete`) plus what a wallet app needs around it.
 */
export interface DeviceSecretStorage {
  /** The secret, after the OS sheet. null when nothing is stored under `id`. */
  get(id: string, options?: { prompt?: PromptText | undefined }): Promise<string | null>
  /**
   * Store or replace. The new version is written to a fresh slot first and the
   * old one removed only afterwards, so a failed write never loses the secret.
   * Never prompts on iOS; prompts once on Android (Keystore keys need the user for every use).
   * Rejects with `stale-copy` when the new version is stored but an older copy could not be
   * removed; the store retries that removal on its next operation.
   */
  set(id: string, secret: string, options?: SetSecretOptions): Promise<void>
  delete(id: string): Promise<void>
  /** Is something stored under `id` — no prompt. */
  has(id: string): Promise<boolean>
  /**
   * Public facts about one secret — no prompt. `protection` is the weakest among the copies
   * stored: an older copy left behind by a failed removal counts until it is gone.
   */
  info(id: string): Promise<StoredSecretInfo | null>
  /** Every secret in this namespace — no prompt; `protection` as in {@link info}. */
  list(): Promise<StoredSecretInfo[]>
  /**
   * Switch one secret between `biometricsOrPasscode` and `biometricsOnly`.
   * Reads it (one sheet) and writes it again under the new access control.
   * Resolves only once no copy under the old protection is left: rejects with `stale-copy`
   * when the new copy is stored but the old one could not be removed. Calling it again
   * retries the removal (no sheet when the newest copy already has `protection`).
   */
  setProtection(id: string, protection: Protection, options?: { prompt?: PromptText | undefined }): Promise<void>
  /**
   * Delete every secret whose id is not in `keep` and return those ids. Run it
   * on start-up against the app's own account list: the iOS Keychain outlives
   * an uninstall, the app's metadata does not. Older copies of the kept secrets
   * left by a failed removal are removed too (rejects with `stale-copy` when one stays).
   */
  prune(keep: Iterable<string>): Promise<string[]>
  /** Copy secrets from an older store, verify, then delete the old copies. */
  migrateFrom(source: MigrationSource, ids: Iterable<string>, options?: MigrateOptions): Promise<MigrationResult>
  capabilities(): Promise<NativeCapabilities>
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SLOT_RE = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})#(\d{1,9})$/

const DEFAULT_UNLOCK: Required<PromptText> = { reason: 'Unlock your wallet', title: 'Unlock wallet', cancel: 'Cancel' }
const DEFAULT_SAVE: Required<PromptText> = { reason: 'Protect your wallet secret', title: 'Protect wallet', cancel: 'Cancel' }

interface Slot {
  id: string
  n: number
  key: string
  protection: Protection
  createdAt: number
}

export function createSecureStorage(options: SecureStorageOptions = {}): DeviceSecretStorage {
  const namespace = options.namespace ?? 'default'
  if (!ID_RE.test(namespace)) throw new SecureStorageError('invalid', `Bad namespace "${namespace}" — letters, digits, ".", "_", "-".`)
  const defaultProtection = checkProtection(options.protection ?? 'biometricsOrPasscode')
  const unlockText = { ...DEFAULT_UNLOCK, ...options.prompts?.unlock }
  const saveText = { ...DEFAULT_SAVE, ...options.prompts?.save }

  const native = async () => options.native ?? loadNative()
  const call = async <T>(fn: (n: NativeSecureStorage) => Promise<T>): Promise<T> => {
    const n = await native()
    try {
      return await fn(n)
    } catch (e) {
      throw fromNative(e)
    }
  }

  // Writes are serialized: two concurrent `set`s for one id must not pick the same slot.
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  async function slots(): Promise<Slot[]> {
    const entries = await call((n) => n.listItems(namespace))
    const out: Slot[] = []
    for (const e of entries) {
      const m = SLOT_RE.exec(e.key)
      if (!m) continue
      const meta = parseMeta(e.meta)
      if (!meta) continue
      out.push({ id: m[1]!, n: Number(m[2]), key: e.key, ...meta })
    }
    return out
  }

  async function slotsOf(id: string): Promise<Slot[]> {
    return (await slots()).filter((s) => s.id === id).sort((a, b) => b.n - a.n)
  }

  async function latest(id: string): Promise<Slot | undefined> {
    return (await slotsOf(id))[0]
  }

  /** What `info` / `list` report for one id: the newest copy, with the weakest protection of any copy (audit 2026-10-29 A2). */
  function describe(copies: Slot[]): StoredSecretInfo {
    const newest = copies.reduce((a, b) => (b.n > a.n ? b : a))
    const weakest = copies.reduce((a, b) => (PROTECTIONS.indexOf(b.protection) < PROTECTIONS.indexOf(a.protection) ? b : a))
    return { id: newest.id, protection: weakest.protection, createdAt: newest.createdAt }
  }

  /**
   * Older copies may be left behind (a delete that failed after a write): true until a sweep
   * found none. True at start: a copy left by an earlier run of the app is swept on first use.
   */
  let stale = true

  /**
   * Remove `older` (the copies below the newest), oldest first, so a failure never leaves an
   * older copy as the newest one. Rejects with `stale-copy` naming what is left.
   */
  async function dropOlder(id: string, older: Slot[]): Promise<void> {
    const left: Slot[] = []
    let cause: unknown
    for (const old of [...older].sort((a, b) => a.n - b.n)) {
      try {
        await call((nat) => nat.deleteItem(namespace, old.key))
      } catch (e) {
        left.push(old)
        cause ??= e
      }
    }
    if (left.length === 0) return
    stale = true
    const weakest = describe(left).protection
    throw new SecureStorageError('stale-copy', `The newest copy of "${id}" is stored, but an older one (${weakest}) could not be removed; it is retried on the next store operation.`, { cause })
  }

  /** Remove every older copy in the namespace. `strict`: reject when one stays; otherwise only remember to try again. */
  async function sweep(strict: boolean): Promise<void> {
    if (!stale && !strict) return
    stale = false
    const byId = new Map<string, Slot[]>()
    let all: Slot[]
    try {
      all = await slots()
    } catch (e) {
      stale = true
      if (strict) throw e
      return
    }
    for (const s of all) byId.set(s.id, [...(byId.get(s.id) ?? []), s])
    let first: unknown
    for (const [id, copies] of byId) {
      if (copies.length < 2) continue
      const newest = copies.reduce((a, b) => (b.n > a.n ? b : a))
      await dropOlder(id, copies.filter((c) => c !== newest)).catch((e: unknown) => { first ??= e })
    }
    if (first !== undefined && strict) throw first
  }

  /** Before a read: sweep only when something may be left, behind any running write. */
  const tidy = (): Promise<void> => (stale ? serial(() => sweep(false)) : Promise.resolve())

  async function write(id: string, secret: string, opts: SetSecretOptions = {}): Promise<void> {
    checkId(id)
    if (typeof secret !== 'string' || secret.length === 0) throw new SecureStorageError('invalid', 'The secret must be a non-empty string.')
    const existing = await slotsOf(id)
    const protection = checkProtection(opts.protection ?? existing[0]?.protection ?? defaultProtection)
    const n = (existing[0]?.n ?? 0) + 1
    await call((nat) => nat.setItem(namespace, `${id}#${n}`, secret, protection, prompt(saveText, opts.prompt)))
    // The new copy is stored; an older one that stays (maybe under weaker protection) is not
    // swallowed: the caller learns it, info/list report it, and the next operation retries (audit 2026-10-29 A2).
    await dropOlder(id, existing)
  }

  async function read(id: string, opts: { prompt?: PromptText | undefined } = {}): Promise<string | null> {
    checkId(id)
    const slot = await latest(id)
    if (!slot) return null
    return call((n) => n.getItem(namespace, slot.key, prompt(unlockText, opts.prompt)))
  }

  async function remove(id: string): Promise<void> {
    checkId(id)
    // Oldest first: a delete that fails part-way leaves the newest copy, never an older (weaker) one as the one `get` reads.
    for (const s of (await slotsOf(id)).reverse()) await call((n) => n.deleteItem(namespace, s.key))
  }

  const store: DeviceSecretStorage = {
    get: async (id, opts) => {
      await tidy()
      return read(id, opts)
    },
    set: (id, secret, opts) => serial(async () => { await sweep(false); await write(id, secret, opts) }),
    delete: (id) => serial(async () => { await sweep(false); await remove(id) }),

    async has(id) {
      checkId(id)
      await tidy()
      return (await latest(id)) !== undefined
    },

    async info(id) {
      checkId(id)
      await tidy()
      const copies = await slotsOf(id)
      return copies.length > 0 ? describe(copies) : null
    },

    async list() {
      await tidy()
      const byId = new Map<string, Slot[]>()
      for (const s of await slots()) byId.set(s.id, [...(byId.get(s.id) ?? []), s])
      return [...byId.values()].map(describe).sort((a, b) => a.createdAt - b.createdAt)
    },

    setProtection: (id, protection, opts = {}) =>
      serial(async () => {
        checkId(id)
        checkProtection(protection)
        await sweep(false)
        const [cur, ...older] = await slotsOf(id)
        if (!cur) throw new SecureStorageError('invalid', `Nothing is stored under "${id}".`)
        // Already there: done once no older copy is left under another protection (a retry after `stale-copy`).
        if (cur.protection === protection) return dropOlder(id, older)
        if (protection === 'biometricsOnly') {
          const caps = await call((n) => n.capabilities())
          if (!caps.biometry) throw new SecureStorageError('not-available', 'Strict mode needs Face ID, Touch ID or a fingerprint enrolled on this device.')
        }
        const value = await read(id, opts)
        if (value === null) throw new SecureStorageError('storage', `The secret under "${id}" disappeared while switching protection.`)
        await write(id, value, { protection, prompt: opts.prompt })
      }),

    prune: (keep) =>
      serial(async () => {
        await sweep(false)
        const keepSet = new Set(keep)
        const removed: string[] = []
        for (const s of await slots()) {
          if (keepSet.has(s.id)) continue
          await call((n) => n.deleteItem(namespace, s.key))
          if (!removed.includes(s.id)) removed.push(s.id)
        }
        // The start-up pass: an older copy of a kept secret must not stay silently.
        await sweep(true)
        return removed
      }),

    migrateFrom: (source, ids, opts = {}) =>
      serial(async () => {
        await sweep(false)
        const result: MigrationResult = { migrated: [], empty: [], alreadyPresent: [] }
        for (const id of ids) {
          checkId(id)
          if (await latest(id)) {
            result.alreadyPresent.push(id)
            continue
          }
          const value = await source.get(id)
          if (value === null || value === '') {
            result.empty.push(id)
            continue
          }
          await write(id, value, { protection: opts.protection, prompt: opts.prompt })
          if (opts.verify !== false) {
            const back = await read(id, { prompt: opts.prompt })
            if (back !== value) {
              await remove(id).catch(() => undefined)
              throw new SecureStorageError('storage', `Migration of "${id}" failed verification; the old copy was kept.`)
            }
          }
          await source.delete(id)
          result.migrated.push(id)
        }
        return result
      }),

    capabilities: () => call((n) => n.capabilities()),
  }
  return store
}

function prompt(defaults: Required<PromptText>, override?: PromptText): NativePrompt {
  const t = { ...defaults, ...override }
  return { reason: t.reason, title: t.title, subtitle: t.reason, cancel: t.cancel }
}

function checkId(id: string): void {
  if (typeof id !== 'string' || !ID_RE.test(id)) throw new SecureStorageError('invalid', `Bad secret id "${String(id)}" — 1–128 of letters, digits, ".", "_", "-".`)
}

function checkProtection(p: Protection): Protection {
  if (!PROTECTIONS.includes(p)) throw new SecureStorageError('invalid', `Unknown protection "${String(p)}".`)
  return p
}

function parseMeta(raw: string): { protection: Protection; createdAt: number } | null {
  try {
    const m = JSON.parse(raw) as { p?: unknown; t?: unknown }
    if (typeof m.p !== 'string' || !PROTECTIONS.includes(m.p as Protection)) return null
    return { protection: m.p as Protection, createdAt: typeof m.t === 'number' ? m.t : 0 }
  } catch {
    return null
  }
}
