/**
 * Integrity for the small JSON stores a wallet keeps in `chrome.storage.local` (settings, per-site
 * permissions). That area is not authenticated: anything that can write it — a compromised renderer
 * that reaches the extension's storage, a copied-back profile — could switch a security setting off
 * or plant a site grant. {@link macJsonStorage} wraps a {@link JsonStorage} so each value carries an
 * HMAC-SHA256 under a key derived from the vault key ({@link deriveStorageMacKey}); a value without a
 * valid MAC is not trusted.
 *
 * What the wrapper does NOT know is when a key exists: the wallet supplies it (`key()`, `null` while
 * locked). Without one it can neither verify nor sign, and the options say what happens then:
 * reads hand back the stored value unverified (default) or nothing; writes store the value without a
 * MAC — it fails verification once a key is there, so a write made while locked can only lose data,
 * never add trust — or are refused. Verifying once a key appears (at unlock) is the wallet's job
 * ({@link MacJsonStorage.read}).
 *
 * A MAC proves the value was written by someone holding the key; on its own it does not prove it is
 * the latest such value (an older signed value copied back verifies). Give the stores one
 * {@link storageVersionLedger} (`versions`) and each signed value also carries a version the ledger
 * must agree with: an older value, or a deleted one, reads as `stale`. What that can and cannot
 * detect is spelled out at {@link storageVersionLedger}. Rotating the vault key retires every old
 * MAC: re-sign the ledger, then the stores, with `rekey`.
 */
import { zeroize } from '@anywalletkit/core'
import { fromBase64, toArrayBuffer, toBase64, utf8, withSecretBuffer } from './codec.js'
import { VaultError } from './errors.js'
import type { JsonStorage } from './storage.js'

/** Field of the stored envelope that holds the MAC (base64), or `null` for a value written without a key. */
export const STORAGE_MAC_FIELD = 'anywalletkit.mac/1'
/** Field of the stored envelope that holds the value's version (a positive integer, inside the MAC) when the store has a {@link storageVersionLedger}. */
export const STORAGE_VERSION_FIELD = 'anywalletkit.ver/1'
const HKDF_INFO = 'anywalletkit/storage-mac/1'
const KEY_BYTES = 32

/**
 * The storage MAC key: HKDF-SHA256(ikm = DEK, salt = none, info = "anywalletkit/storage-mac/1"), 32
 * bytes. One-way — it reveals nothing about the DEK — so a wallet may keep it in
 * `chrome.storage.session` while locked. The same DEK always gives the same key; a rotated DEK a new one.
 */
export async function deriveStorageMacKey(dek: Uint8Array, crypto: Crypto = globalThis.crypto): Promise<Uint8Array> {
  if (dek.length !== 32) throw new VaultError('Vault key must be 32 bytes.', 'invalid-input')
  const ikm = await withSecretBuffer(dek, (b) => crypto.subtle.importKey('raw', b, 'HKDF', false, ['deriveBits']))
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new ArrayBuffer(0), info: toArrayBuffer(utf8.encode(HKDF_INFO)) }, ikm, KEY_BYTES * 8)
  return new Uint8Array(bits)
}

/**
 * What a read found:
 * - `ok`: a value with a valid MAC;
 * - `empty`: nothing stored;
 * - `unsigned`: a value without a MAC (written before the wrapper existed, or while no key was there);
 * - `invalid`: a MAC that does not match (edited, from another store, or under another key);
 * - `no-key`: something is stored but there is no key to check it with;
 * - `stale` (only with a {@link storageVersionLedger}): the MAC is valid — or nothing is stored — but
 *   this is not the latest value the ledger knows: an older signed value put back, a deleted one, or
 *   a ledger that was itself removed, edited or rolled back.
 */
export type MacState = 'ok' | 'empty' | 'unsigned' | 'invalid' | 'no-key' | 'stale'

export interface MacRead<T> {
  state: MacState
  /** The stored value — verified only when `state` is `ok`. */
  value: T | null
  /** With a ledger, for a value whose MAC is valid: its version (`0` = signed before versions existed). */
  version?: number
}

export interface MacJsonStorageOptions {
  /** Names the store inside the MAC: a value signed for one store does not verify in another. */
  label: string
  /** The MAC key ({@link deriveStorageMacKey}), or `null` when the wallet has none (locked). The wrapper zeroizes the copy it gets. */
  key: () => Promise<Uint8Array | null>
  /** `get()` without a key: the stored value unverified (`'unverified'`, default) or `null`. */
  readWithoutKey?: 'unverified' | 'null'
  /** `set()` without a key: store the value with no MAC (`'unsigned'`, default — it fails verification later) or throw `VaultError('locked')`. */
  writeWithoutKey?: 'unsigned' | 'refuse'
  /**
   * Rollback protection: the ledger shared by the wallet's signed stores. Every signed write takes the
   * store's next version (inside the MAC) and records it; a read whose version the ledger does not
   * agree with is `stale`. The label must not contain a line break.
   */
  versions?: StorageVersionLedger
}

export interface MacJsonStorage<T> extends JsonStorage<T> {
  /** The verified value (`null` when empty, unsigned or invalid); without a key, per `readWithoutKey`. */
  get(): Promise<T | null>
  /** Sign with the current key; without one, per `writeWithoutKey`. */
  set(value: T): Promise<void>
  /** The stored value and what verification found, under `key` (default: the current key). */
  read(key?: Uint8Array): Promise<MacRead<T>>
  /** Store `value` signed under `key` (default: the current key; refused without one). */
  write(value: T, key?: Uint8Array): Promise<void>
  /**
   * Re-sign the stored value under `newKey` when it verifies under `oldKey`; anything else is left as it is. Returns what `oldKey` found.
   * With a ledger: rekey the ledger first ({@link StorageVersionLedger.rekey}); the value keeps its version, and is re-signed only when the
   * re-signed ledger agrees with it (`stale` otherwise).
   */
  rekey(oldKey: Uint8Array, newKey: Uint8Array): Promise<MacState>
}

type Stored<T> = { [STORAGE_MAC_FIELD]: string | null; [STORAGE_VERSION_FIELD]?: number; value: T }

/** Wrap `inner` (e.g. `chromeJsonStorage(chrome.storage.local, key)`) with a MAC; see the module comment. */
export function macJsonStorage<T>(inner: JsonStorage<unknown>, options: MacJsonStorageOptions): MacJsonStorage<T> {
  const { label, versions } = options
  if (versions && label.includes('\n')) throw new VaultError('A versioned store label has no line break.', 'invalid-input')
  const readWithoutKey = options.readWithoutKey ?? 'unverified'
  const writeWithoutKey = options.writeWithoutKey ?? 'unsigned'
  /** The caller's key, or a fresh one from the provider; zeroized after `fn`. */
  const withKey = async <R>(given: Uint8Array | undefined, fn: (key: Uint8Array | null) => Promise<R>): Promise<R> => {
    const key = given ? Uint8Array.from(given) : await options.key()
    try { return await fn(key) } finally { if (key) zeroize(key) }
  }
  /** What is stored and what its MAC says under `key` — the ledger is not asked here. `version`: 0 for a value signed without one. */
  const stored = async (key: Uint8Array | null): Promise<MacRead<T>> => {
    const raw = await inner.get()
    if (raw === null || raw === undefined) return { state: 'empty', value: null }
    const envelope = isStored<T>(raw)
    const value = (envelope ? raw.value : raw) as T
    if (!envelope || raw[STORAGE_MAC_FIELD] === null) return { state: 'unsigned', value }
    if (!key) return { state: 'no-key', value }
    if (!versions) return { state: (await verify(key, label, value, raw[STORAGE_MAC_FIELD]!)) ? 'ok' : 'invalid', value }
    const version = STORAGE_VERSION_FIELD in raw ? (raw as Record<string, unknown>)[STORAGE_VERSION_FIELD] : 0
    if (version !== 0 && !isVersion(version)) return { state: 'invalid', value }
    if (!(await verify(key, label, value, raw[STORAGE_MAC_FIELD]!, version || undefined))) return { state: 'invalid', value }
    return { state: 'ok', value, version }
  }
  const put = async (key: Uint8Array, value: T, version?: number): Promise<void> => {
    const mac = await sign(key, label, value, version)
    await inner.set((version === undefined ? { [STORAGE_MAC_FIELD]: mac, value } : { [STORAGE_MAC_FIELD]: mac, [STORAGE_VERSION_FIELD]: version, value }) satisfies Stored<T>)
  }
  /** The version of the value stored now when `key` signed it (a write goes above it even when the ledger never recorded it). */
  const seen = async (key: Uint8Array): Promise<number> => {
    const r = await stored(key)
    return r.state === 'ok' ? (r.version ?? 0) : 0
  }
  const read = (given?: Uint8Array): Promise<MacRead<T>> => withKey(given, async (key) => {
    if (!versions || !key) return stored(key)
    // Value and ledger are read in one exclusive step: a write between the two would look like a rollback.
    return versions.exclusive(async (ledger) => {
      const r = await stored(key)
      if (r.state === 'empty') return (await ledger.check(label, null, key)) === 'ok' ? r : { state: 'stale', value: null }
      if (r.state !== 'ok') return r
      return (await ledger.check(label, r.version ?? 0, key)) === 'ok' ? r : { ...r, state: 'stale' }
    })
  })
  const write = (value: T, given?: Uint8Array): Promise<void> => withKey(given, async (key) => {
    if (!key) throw new VaultError('The wallet is locked: unlock it to change this.', 'locked')
    if (!versions) return put(key, value)
    await versions.exclusive((ledger) => ledger.advance(label, key, () => seen(key), (version) => put(key, value, version)))
  })
  return {
    read,
    write,
    async get() {
      const r = await read()
      if (r.state === 'ok') return r.value
      if (r.state === 'no-key' && readWithoutKey === 'unverified') return r.value
      return null
    },
    async set(value) {
      await withKey(undefined, async (key) => {
        if (key) return write(value, key)
        if (writeWithoutKey === 'refuse') throw new VaultError('The wallet is locked: unlock it to change this.', 'locked')
        await inner.set({ [STORAGE_MAC_FIELD]: null, value } satisfies Stored<T>)
      })
    },
    async rekey(oldKey, newKey) {
      if (!versions) {
        const r = await read(oldKey)
        if (r.state === 'ok') await write(r.value as T, newKey)
        return r.state
      }
      return versions.exclusive(async (ledger) => {
        const r = await stored(oldKey)
        if (r.state === 'empty') return (await ledger.check(label, null, newKey)) === 'ok' ? 'empty' : 'stale'
        if (r.state !== 'ok') return r.state
        const version = r.version ?? 0
        if ((await ledger.check(label, version, newKey)) !== 'ok') return 'stale'
        // Same version under the new key; a value from before versions existed takes its first one now.
        if (version > 0) await put(newKey, r.value as T, version)
        else await ledger.advance(label, newKey, async () => 0, (v) => put(newKey, r.value as T, v))
        return 'ok'
      })
    },
  }
}

function isStored<T>(raw: unknown): raw is Stored<T> {
  if (typeof raw !== 'object' || raw === null || !(STORAGE_MAC_FIELD in raw) || !('value' in raw)) return false
  const mac = (raw as Record<string, unknown>)[STORAGE_MAC_FIELD]
  return mac === null || typeof mac === 'string'
}

async function hmacKey(key: Uint8Array, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  if (key.length !== KEY_BYTES) throw new VaultError('A storage MAC key is 32 bytes.', 'invalid-input')
  return withSecretBuffer(key, (b) => globalThis.crypto.subtle.importKey('raw', b, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]))
}

/**
 * label ‖ "\n" ‖ canonical JSON (object keys sorted, `undefined` dropped — what a JSON store gives back);
 * with a version: label ‖ "\n" ‖ version ‖ "\n" ‖ canonical JSON. The two forms cannot collide: canonical
 * JSON has no raw line break, and a versioned label has none either.
 */
function macInput(label: string, value: unknown, version?: number): ArrayBuffer {
  return toArrayBuffer(utf8.encode(version === undefined ? `${label}\n${canonicalJson(value)}` : `${label}\n${version}\n${canonicalJson(value)}`))
}

async function sign(key: Uint8Array, label: string, value: unknown, version?: number): Promise<string> {
  return toBase64(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), macInput(label, value, version))))
}

async function verify(key: Uint8Array, label: string, value: unknown, mac: string, version?: number): Promise<boolean> {
  let bytes: Uint8Array
  try { bytes = fromBase64(mac) } catch { return false }
  return globalThis.crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), toArrayBuffer(bytes), macInput(label, value, version))
}

const isVersion = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0

/** Deterministic JSON: the same data gives the same text whatever order its keys were stored in. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(JSON.parse(JSON.stringify(value ?? null)) as unknown))
}

function sortKeys(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(sortKeys)
  if (x === null || typeof x !== 'object') return x
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(x).sort()) out[k] = sortKeys((x as Record<string, unknown>)[k])
  return out
}

/** What a {@link StorageVersionLedger} holds, as {@link StorageVersionLedger.read} found it. */
export interface StorageVersions {
  /** `ok`; `empty` (no manifest and none expected); `invalid` (unsigned, edited, or another key); `stale` (missing or older than this browser session has seen). */
  state: 'ok' | 'empty' | 'invalid' | 'stale'
  /** Goes up by one with every manifest write. `0` when there is no readable manifest. */
  epoch: number
  /** Where this manifest's numbering started: a store's first version is `base + 1`. */
  base: number
  /** After {@link StorageVersionLedger.condemn}: a store the manifest does not list is not trusted, stored or not. */
  sealed: boolean
  /** The latest version of each store, by label. */
  versions: Record<string, number>
}

/** The ledger operations a store runs inside {@link StorageVersionLedger.exclusive}. */
export interface StorageVersionOps {
  /**
   * Is `version` the latest for `label`? `null` = nothing is stored, `0` = a signed value without a
   * version. A value exactly one ahead of the manifest is accepted and recorded (an interrupted write).
   */
  check(label: string, version: number | null, key: Uint8Array): Promise<'ok' | 'stale'>
  /**
   * One write: `write(version)` stores the value signed with the next version, then the manifest records
   * it. `seen()` is the version of the value stored now (0 when none this key signed). A missing manifest
   * is created first; a refused one is replaced by a sealed one ({@link StorageVersionLedger.condemn}).
   */
  advance(label: string, key: Uint8Array, seen: () => Promise<number>, write: (version: number) => Promise<void>): Promise<number>
}

export interface StorageVersionLedgerOptions {
  /** Where the manifest lives — the same area as the stores it covers (`chrome.storage.local`). */
  manifest: JsonStorage<unknown>
  /**
   * The highest manifest epoch seen, kept where a write to the stores' area cannot reach it and where it
   * dies with the browser session (`chrome.storage.session`). `set(null)` clears it.
   */
  mark: JsonStorage<unknown>
  /** Names the manifest inside its MAC. No store may use it. */
  label?: string
  /**
   * Accept a validly signed value that carries no version (written before the ledger existed) for a
   * store the manifest has no record of. Off by default: such a value can be replayed for as long as it
   * is accepted, so switch it on only to migrate, write every store once, and switch it off again.
   */
  acceptUnversioned?: boolean
  /** Milliseconds since the epoch — where a new manifest starts numbering. */
  now?: () => number
}

export interface StorageVersionLedger {
  /** Run `fn` with no other ledger operation in between (stores use it for read-and-check and for a write). Do not nest. */
  exclusive<R>(fn: (ops: StorageVersionOps) => Promise<R>): Promise<R>
  /**
   * Stop trusting everything signed so far: a fresh, sealed manifest numbered above all it replaces.
   * Every store then reads `stale` — also one with nothing stored — until it is written again.
   */
  condemn(key: Uint8Array): Promise<void>
  /** Re-sign the manifest under `newKey` when it is `ok` under `oldKey` (one epoch up); otherwise it is left as it is. Returns what `oldKey` found. Then rekey the stores. */
  rekey(oldKey: Uint8Array, newKey: Uint8Array): Promise<StorageVersions['state']>
  /** The manifest as `key` sees it. */
  read(key: Uint8Array): Promise<StorageVersions>
  /** Forget manifest and mark — only when the stores are wiped with them (a new vault). */
  reset(): Promise<void>
}

const LEDGER_LABEL = 'anywalletkit/storage-versions/1'
type Manifest = Omit<StorageVersions, 'state'>
type Loaded = { state: 'ok'; manifest: Manifest } | { state: 'empty' | 'invalid' | 'stale'; manifest?: Manifest }

/**
 * Rollback protection for {@link macJsonStorage} stores: one signed manifest that says which version
 * of each store is the latest.
 *
 * - Every signed value carries its version inside the MAC. A write stores the value with the store's
 *   next version, then the manifest (its `epoch` goes up by one), then the session mark. A value the
 *   manifest lists another version for — or lists, when nothing is stored — is `stale`: putting ONE
 *   store back, or deleting it, is caught, across browser restarts too.
 * - The manifest lives next to the stores, so the whole area can be put back together. `mark` — the
 *   highest epoch seen, in session storage — catches that for as long as the browser session lives: a
 *   manifest older than the mark, or missing while there is a mark, makes every store `stale`.
 * - A manifest that is unsigned, edited or under another key makes every store `stale`. So does a
 *   signed value with a version when there is no manifest at all.
 * - A worker killed between the value and the manifest write leaves a value exactly one version ahead.
 *   That is accepted and recorded: only the key holder can sign that version, so it is the wallet's own
 *   last write. Until it is recorded the previous value still verifies — the same as the interrupted
 *   write never having happened.
 *
 * What it cannot see: the whole area (manifest and stores together) put back to an earlier state when
 * there is no mark — after a browser restart, or an extension reload — and likewise everything deleted
 * together. Nothing an extension can store survives that and is out of the same writer's reach; it is
 * what restoring a profile backup looks like. Versions start from the clock (`now`) so that a manifest
 * created after a loss does not hand out numbers already used; a clock set far back defeats that.
 *
 * The ledger never repairs on a read (beyond recording an interrupted write): the wallet decides what
 * a `stale` store falls back to, calls {@link StorageVersionLedger.condemn} when the manifest itself was
 * refused, and writes the stores again.
 */
export function storageVersionLedger(options: StorageVersionLedgerOptions): StorageVersionLedger {
  const label = options.label ?? LEDGER_LABEL
  const acceptUnversioned = options.acceptUnversioned ?? false
  const now = options.now ?? Date.now
  let tail: Promise<unknown> = Promise.resolve()
  const queue = <R>(fn: () => Promise<R>): Promise<R> => {
    const run = tail.then(fn, fn)
    tail = run.then(() => undefined, () => undefined)
    return run
  }
  const high = async (): Promise<number> => {
    const v = await options.mark.get()
    return isVersion(v) ? v : 0
  }
  const parse = async (raw: unknown, key: Uint8Array): Promise<Manifest | null> => {
    if (!isStored<unknown>(raw) || raw[STORAGE_MAC_FIELD] === null) return null
    const epoch = (raw as Record<string, unknown>)[STORAGE_VERSION_FIELD]
    const v = raw.value as Partial<Manifest> | null
    if (!isVersion(epoch) || typeof v !== 'object' || v === null || !isVersion(v.base) || typeof v.sealed !== 'boolean') return null
    if (typeof v.versions !== 'object' || v.versions === null || !Object.values(v.versions).every(isVersion)) return null
    if (!(await verify(key, label, v, raw[STORAGE_MAC_FIELD]!, epoch))) return null
    return { epoch, base: v.base, sealed: v.sealed, versions: { ...v.versions } }
  }
  const load = async (key: Uint8Array): Promise<Loaded> => {
    const mark = await high()
    const raw = await options.manifest.get()
    if (raw === null || raw === undefined) return { state: mark > 0 ? 'stale' : 'empty' }
    const manifest = await parse(raw, key)
    if (!manifest) return { state: 'invalid' }
    if (manifest.epoch < mark) return { state: 'stale', manifest }
    // Ahead of the mark: a new browser session, or the mark write after this manifest never happened.
    if (manifest.epoch > mark) await options.mark.set(manifest.epoch)
    return { state: 'ok', manifest }
  }
  /** Manifest first, mark second: a mark is never ahead of what is on disk. */
  const store = async (m: Manifest, key: Uint8Array): Promise<void> => {
    const value = { base: m.base, sealed: m.sealed, versions: m.versions }
    await options.manifest.set({ [STORAGE_MAC_FIELD]: await sign(key, label, value, m.epoch), [STORAGE_VERSION_FIELD]: m.epoch, value })
    if (m.epoch > (await high())) await options.mark.set(m.epoch)
  }
  /** A new manifest numbered above the clock, the mark and whatever the old one (when it still verified) knew. */
  const fresh = async (sealed: boolean, prior: Manifest | undefined, key: Uint8Array): Promise<Manifest> => {
    const floor = Math.max(await high(), Math.floor(now()), prior ? Math.max(prior.epoch, prior.base, ...Object.values(prior.versions)) : 0)
    if (!Number.isSafeInteger(floor + 2)) throw new VaultError('Storage version out of range.', 'invalid-input')
    const m: Manifest = { epoch: floor + 1, base: floor + 1, sealed, versions: {} }
    await store(m, key)
    return m
  }
  const record = (m: Manifest, name: string, version: number, key: Uint8Array): Promise<void> =>
    store({ ...m, epoch: m.epoch + 1, versions: { ...m.versions, [name]: version } }, key)
  const named = (name: string): void => {
    if (name === label || name.includes('\n')) throw new VaultError('Not a store label.', 'invalid-input')
  }
  const ops: StorageVersionOps = {
    async check(name, version, key) {
      named(name)
      const l = await load(key)
      // No manifest and none expected: nothing was ever versioned here.
      if (l.state === 'empty') return version === null || (version === 0 && acceptUnversioned) ? 'ok' : 'stale'
      if (l.state !== 'ok') return 'stale'
      const m = l.manifest
      const listed = m.versions[name]
      if (listed === undefined && version === null) return m.sealed ? 'stale' : 'ok'
      if (listed === undefined && version === 0) return !m.sealed && acceptUnversioned ? 'ok' : 'stale'
      if (version === null || version === 0) return 'stale'
      if (version === listed) return 'ok'
      if (version !== (listed ?? m.base) + 1) return 'stale'
      // The interrupted write. Recording it is best effort: the next read tries again.
      await record(m, name, version, key).catch(() => undefined)
      return 'ok'
    },
    async advance(name, key, seen, write) {
      named(name)
      const l = await load(key)
      const before = await seen()
      // No manifest, yet a value that carries a version: the manifest was lost, so the new one is sealed too.
      const m = l.state === 'ok' ? l.manifest : await fresh(l.state !== 'empty' || before > 0, l.manifest, key)
      const version = Math.max(m.versions[name] ?? m.base, before) + 1
      if (!Number.isSafeInteger(version)) throw new VaultError('Storage version out of range.', 'invalid-input')
      await write(version)
      await record(m, name, version, key)
      return version
    },
  }
  return {
    exclusive: (fn) => queue(() => fn(ops)),
    condemn: (key) => queue(async () => { await fresh(true, (await load(key)).manifest, key) }),
    rekey: (oldKey, newKey) => queue(async () => {
      const l = await load(oldKey)
      if (l.state === 'ok') await store({ ...l.manifest, epoch: l.manifest.epoch + 1 }, newKey)
      return l.state
    }),
    read: (key) => queue(async () => {
      const l = await load(key)
      return { state: l.state, ...(l.manifest ?? { epoch: 0, base: 0, sealed: false, versions: {} }) }
    }),
    reset: () => queue(async () => {
      await options.manifest.set(null)
      await options.mark.set(null)
    }),
  }
}
