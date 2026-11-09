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
 * A MAC proves the value was written by someone holding the key; it does not prove it is the latest
 * such value (an older signed value copied back verifies). Rotating the vault key retires every old
 * MAC: re-sign the stores with {@link MacJsonStorage.rekey}.
 */
import { zeroize } from '@anywalletkit/core'
import { fromBase64, toArrayBuffer, toBase64, utf8, withSecretBuffer } from './codec.js'
import { VaultError } from './errors.js'
import type { JsonStorage } from './storage.js'

/** Field of the stored envelope that holds the MAC (base64), or `null` for a value written without a key. */
export const STORAGE_MAC_FIELD = 'anywalletkit.mac/1'
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
 * - `no-key`: something is stored but there is no key to check it with.
 */
export type MacState = 'ok' | 'empty' | 'unsigned' | 'invalid' | 'no-key'

export interface MacRead<T> {
  state: MacState
  /** The stored value — verified only when `state` is `ok`. */
  value: T | null
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
  /** Re-sign the stored value under `newKey` when it verifies under `oldKey`; anything else is left as it is. Returns what `oldKey` found. */
  rekey(oldKey: Uint8Array, newKey: Uint8Array): Promise<MacState>
}

type Stored<T> = { [STORAGE_MAC_FIELD]: string | null; value: T }

/** Wrap `inner` (e.g. `chromeJsonStorage(chrome.storage.local, key)`) with a MAC; see the module comment. */
export function macJsonStorage<T>(inner: JsonStorage<unknown>, options: MacJsonStorageOptions): MacJsonStorage<T> {
  const { label } = options
  const readWithoutKey = options.readWithoutKey ?? 'unverified'
  const writeWithoutKey = options.writeWithoutKey ?? 'unsigned'
  /** The caller's key, or a fresh one from the provider; zeroized after `fn`. */
  const withKey = async <R>(given: Uint8Array | undefined, fn: (key: Uint8Array | null) => Promise<R>): Promise<R> => {
    const key = given ? Uint8Array.from(given) : await options.key()
    try { return await fn(key) } finally { if (key) zeroize(key) }
  }
  const read = (given?: Uint8Array): Promise<MacRead<T>> => withKey(given, async (key) => {
    const raw = await inner.get()
    if (raw === null || raw === undefined) return { state: 'empty', value: null }
    const envelope = isStored<T>(raw)
    const value = (envelope ? raw.value : raw) as T
    if (!envelope || raw[STORAGE_MAC_FIELD] === null) return { state: 'unsigned', value }
    if (!key) return { state: 'no-key', value }
    return { state: (await verify(key, label, value, raw[STORAGE_MAC_FIELD]!)) ? 'ok' : 'invalid', value }
  })
  const write = (value: T, given?: Uint8Array): Promise<void> => withKey(given, async (key) => {
    if (!key) throw new VaultError('The wallet is locked: unlock it to change this.', 'locked')
    await inner.set({ [STORAGE_MAC_FIELD]: await sign(key, label, value), value } satisfies Stored<T>)
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
      const r = await read(oldKey)
      if (r.state === 'ok') await write(r.value as T, newKey)
      return r.state
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

/** label ‖ "\n" ‖ canonical JSON (object keys sorted, `undefined` dropped — what a JSON store gives back). */
function macInput(label: string, value: unknown): ArrayBuffer {
  return toArrayBuffer(utf8.encode(`${label}\n${canonicalJson(value)}`))
}

async function sign(key: Uint8Array, label: string, value: unknown): Promise<string> {
  return toBase64(new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', await hmacKey(key, 'sign'), macInput(label, value))))
}

async function verify(key: Uint8Array, label: string, value: unknown, mac: string): Promise<boolean> {
  let bytes: Uint8Array
  try { bytes = fromBase64(mac) } catch { return false }
  return globalThis.crypto.subtle.verify('HMAC', await hmacKey(key, 'verify'), toArrayBuffer(bytes), macInput(label, value))
}

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
