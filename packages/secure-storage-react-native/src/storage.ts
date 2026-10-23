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
   */
  set(id: string, secret: string, options?: SetSecretOptions): Promise<void>
  delete(id: string): Promise<void>
  /** Is something stored under `id` — no prompt. */
  has(id: string): Promise<boolean>
  /** Public facts about one secret — no prompt. */
  info(id: string): Promise<StoredSecretInfo | null>
  /** Every secret in this namespace — no prompt. */
  list(): Promise<StoredSecretInfo[]>
  /**
   * Switch one secret between `biometricsOrPasscode` and `biometricsOnly`.
   * Reads it (one sheet) and writes it again under the new access control.
   */
  setProtection(id: string, protection: Protection, options?: { prompt?: PromptText | undefined }): Promise<void>
  /**
   * Delete every secret whose id is not in `keep` and return those ids. Run it
   * on start-up against the app's own account list: the iOS Keychain outlives
   * an uninstall, the app's metadata does not.
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

  async function write(id: string, secret: string, opts: SetSecretOptions = {}): Promise<void> {
    checkId(id)
    if (typeof secret !== 'string' || secret.length === 0) throw new SecureStorageError('invalid', 'The secret must be a non-empty string.')
    const existing = await slotsOf(id)
    const protection = checkProtection(opts.protection ?? existing[0]?.protection ?? defaultProtection)
    const n = (existing[0]?.n ?? 0) + 1
    await call((nat) => nat.setItem(namespace, `${id}#${n}`, secret, protection, prompt(saveText, opts.prompt)))
    for (const old of existing) await call((nat) => nat.deleteItem(namespace, old.key)).catch(() => undefined)
  }

  async function read(id: string, opts: { prompt?: PromptText | undefined } = {}): Promise<string | null> {
    checkId(id)
    const slot = await latest(id)
    if (!slot) return null
    return call((n) => n.getItem(namespace, slot.key, prompt(unlockText, opts.prompt)))
  }

  async function remove(id: string): Promise<void> {
    checkId(id)
    for (const s of await slotsOf(id)) await call((n) => n.deleteItem(namespace, s.key))
  }

  const store: DeviceSecretStorage = {
    get: (id, opts) => read(id, opts),
    set: (id, secret, opts) => serial(() => write(id, secret, opts)),
    delete: (id) => serial(() => remove(id)),

    async has(id) {
      checkId(id)
      return (await latest(id)) !== undefined
    },

    async info(id) {
      checkId(id)
      const s = await latest(id)
      return s ? { id: s.id, protection: s.protection, createdAt: s.createdAt } : null
    },

    async list() {
      const byId = new Map<string, Slot>()
      for (const s of await slots()) {
        const cur = byId.get(s.id)
        if (!cur || s.n > cur.n) byId.set(s.id, s)
      }
      return [...byId.values()].map((s) => ({ id: s.id, protection: s.protection, createdAt: s.createdAt })).sort((a, b) => a.createdAt - b.createdAt)
    },

    setProtection: (id, protection, opts = {}) =>
      serial(async () => {
        checkId(id)
        checkProtection(protection)
        const cur = await latest(id)
        if (!cur) throw new SecureStorageError('invalid', `Nothing is stored under "${id}".`)
        if (cur.protection === protection) return
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
        const keepSet = new Set(keep)
        const removed: string[] = []
        for (const s of await slots()) {
          if (keepSet.has(s.id)) continue
          await call((n) => n.deleteItem(namespace, s.key))
          if (!removed.includes(s.id)) removed.push(s.id)
        }
        return removed
      }),

    migrateFrom: (source, ids, opts = {}) =>
      serial(async () => {
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
