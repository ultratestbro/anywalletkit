/**
 * The vault: every secret (seed phrase, imported private key, TON words) at rest
 * in `chrome.storage.local`, encrypted with WebCrypto plus one audited pure-JS
 * primitive (`@noble/hashes` scrypt) — no WASM, no third-party crypto in the
 * key path beyond that.
 *
 * Two layers of keys, so that unlocking does not keep the password around and
 * other unlock paths (passkeys) do not re-encrypt the secrets:
 *
 *   password ──scrypt (N=2^17, r=8, p=1)──▶ KEK ──AES-256-GCM──▶ wraps the DEK   (envelope v2)
 *   passkey PRF ──HKDF-SHA256 (salt = credential id)──▶ KEK ──AES-256-GCM──▶ wraps the DEK, one box per passkey
 *   DEK (32 random bytes) ──AES-256-GCM, AAD = secret id──▶ each secret
 *
 * What the session holds while unlocked is the DEK (see {@link Session}); the
 * password and the PRF output never leave {@link Vault.create} / {@link Vault.unlock} /
 * {@link Vault.unlockWithPasskey}. Every ciphertext carries its own 96-bit IV; the
 * AAD binds a secret to its id (so two entries cannot be swapped inside the
 * envelope) and binds the DEK box to the exact KDF parameters (so an envelope whose
 * salt or cost was edited on disk fails to open instead of deriving a weaker key).
 * Wrong password and tampering are indistinguishable (GCM tag failure) and both
 * surface as `wrong-password`.
 *
 * Envelope versions: v1 = PBKDF2-SHA256 (≥ 600 000 iterations), still opened and
 * re-sealed as v2 on the next successful unlock (MetaMask's `updateVault` pattern);
 * v2 = scrypt (OWASP parameters, memory-hard: an attacker who copied the Chrome
 * profile cannot run the search on GPUs the way PBKDF2 allows) + optional passkey
 * boxes. Anything else is refused (`unsupported-envelope`) instead of guessed.
 * Passwords: at least {@link VAULT_MIN_PASSWORD_LENGTH} characters, enforced here
 * and not only in a UI.
 */
import { zeroize } from '@forgewallet/core'
import { scryptAsync } from '@noble/hashes/scrypt.js'
import { fromBase64, toArrayBuffer, toBase64 } from './codec.js'
import { VaultError } from './errors.js'

/** PBKDF2-SHA256 iterations (v1 envelopes): OWASP 2023 floor for SHA-256; anything lower is refused. */
export const VAULT_MIN_ITERATIONS = 600_000
export const VAULT_DEFAULT_ITERATIONS = 600_000
/** scrypt for v2 envelopes: OWASP's recommended cost (128 MiB, ~1 s in a service worker). */
export const VAULT_SCRYPT = { N: 1 << 17, r: 8, p: 1 } as const
/** The weakest scrypt an envelope may carry and still open (16 MiB). Tests use this; `create` uses {@link VAULT_SCRYPT}. */
export const VAULT_MIN_SCRYPT = { N: 1 << 14, r: 8, p: 1 } as const
/** Shortest password `create` / `changePassword` accept. `unlock` takes whatever opens the vault. */
export const VAULT_MIN_PASSWORD_LENGTH = 8
const SALT_BYTES = 32
const IV_BYTES = 12
const DEK_BYTES = 32
/** PRF outputs are 32 bytes (WebAuthn `prf` extension, `first`). */
const PRF_BYTES = 32

export interface SealedBox {
  /** 96-bit AES-GCM nonce, base64. */
  iv: string
  /** ciphertext ‖ 128-bit tag, base64. */
  data: string
}

export interface VaultEnvelopeV1 {
  v: 1
  kdf: { name: 'PBKDF2-SHA256'; iterations: number; salt: string }
  /** The DEK, sealed under the password-derived key. AAD = version + kdf. */
  dek: SealedBox
  /** One box per key source (keyring source id), sealed under the DEK. AAD `forgewallet-vault/secret/<id>`. */
  secrets: Record<string, SealedBox>
  createdAt: number
}

export interface VaultPasskey {
  /** WebAuthn credential id, base64url. */
  id: string
  label: string
  createdAt: number
  /** The DEK sealed under HKDF(PRF output, salt = credential id). AAD = `forgewallet-vault/2/passkey/<id>`. */
  dek: SealedBox
  /** The credential's public key (SPKI, base64) when the authenticator gave one — lets the worker verify assertions (passkey-per-signature). */
  publicKey?: string
  /** COSE algorithm of `publicKey` (-7 = ES256). */
  alg?: number
}

export interface VaultEnvelopeV2 {
  v: 2
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string }
  dek: SealedBox
  secrets: Record<string, SealedBox>
  passkeys: VaultPasskey[]
  createdAt: number
  /** When a v1 envelope was re-sealed as v2. */
  upgradedAt?: number
}

export type VaultEnvelope = VaultEnvelopeV1 | VaultEnvelopeV2

/** Where the envelope lives. `chromeLocalVaultStorage()` for the extension, `memoryVaultStorage()` for tests. */
export interface VaultStorage {
  get(): Promise<VaultEnvelope | null>
  set(envelope: VaultEnvelope): Promise<void>
  clear(): Promise<void>
}

export interface VaultOptions {
  storage: VaultStorage
  /** KDF for NEW envelopes and re-seals. Default scrypt (v2); `'pbkdf2'` writes v1 (tests, or a build that must stay FIPS-only). */
  kdf?: 'scrypt' | 'pbkdf2'
  /** PBKDF2 iterations for v1 envelopes (default and minimum {@link VAULT_DEFAULT_ITERATIONS}). */
  iterations?: number
  /** scrypt cost for v2 envelopes (default {@link VAULT_SCRYPT}; not below {@link VAULT_MIN_SCRYPT}). */
  scrypt?: { N: number; r: number; p: number }
  /** Progress of the scrypt derivation, 0..1 — the unlock screen's bar. */
  onProgress?: (fraction: number) => void
  /** Defaults to `globalThis.crypto`; injectable for tests. */
  crypto?: Crypto
}

export interface VaultKdfInfo {
  version: 1 | 2
  name: 'PBKDF2-SHA256' | 'scrypt'
  /** Human line for the UI, e.g. "scrypt N=2^17 r=8 p=1". */
  summary: string
}

const aadDekV1 = (kdf: VaultEnvelopeV1['kdf']) => `forgewallet-vault/1/dek/${kdf.name}/${kdf.iterations}/${kdf.salt}`
const aadDekV2 = (kdf: VaultEnvelopeV2['kdf']) => `forgewallet-vault/2/dek/scrypt/${kdf.N}/${kdf.r}/${kdf.p}/${kdf.salt}`
const aadPasskey = (id: string) => `forgewallet-vault/2/passkey/${id}`
const aadSecret = (id: string) => `forgewallet-vault/secret/${id}`
const HKDF_INFO = 'forgewallet-vault/2/passkey'

export class Vault {
  private readonly _storage: VaultStorage
  private readonly _kdf: 'scrypt' | 'pbkdf2'
  private readonly _iterations: number
  private readonly _scrypt: { N: number; r: number; p: number }
  private readonly _onProgress: ((fraction: number) => void) | undefined
  private readonly _crypto: Crypto

  constructor(options: VaultOptions) {
    this._storage = options.storage
    this._kdf = options.kdf ?? 'scrypt'
    this._iterations = options.iterations ?? VAULT_DEFAULT_ITERATIONS
    this._scrypt = options.scrypt ?? VAULT_SCRYPT
    this._onProgress = options.onProgress
    this._crypto = options.crypto ?? globalThis.crypto
    if (!Number.isInteger(this._iterations) || this._iterations < VAULT_MIN_ITERATIONS) {
      throw new VaultError(`PBKDF2 iterations must be an integer ≥ ${VAULT_MIN_ITERATIONS}`, 'invalid-input')
    }
    if (!isStrongScrypt(this._scrypt)) throw new VaultError(`scrypt cost must be at least N=${VAULT_MIN_SCRYPT.N} r=${VAULT_MIN_SCRYPT.r} p=${VAULT_MIN_SCRYPT.p} (N a power of two)`, 'invalid-input')
  }

  async exists(): Promise<boolean> {
    return (await this._storage.get()) !== null
  }

  /** What protects the DEK right now (UI). `null` without a vault. */
  async kdfInfo(): Promise<VaultKdfInfo | null> {
    const e = await this._storage.get()
    if (!e) return null
    if (isEnvelopeV1(e)) return { version: 1, name: 'PBKDF2-SHA256', summary: `PBKDF2-SHA256 ${e.kdf.iterations.toLocaleString('en-US')} iterations` }
    if (isEnvelopeV2(e)) return { version: 2, name: 'scrypt', summary: `scrypt N=2^${Math.log2(e.kdf.N)} r=${e.kdf.r} p=${e.kdf.p}` }
    return null
  }

  /**
   * Create an empty vault protected by `password`. Returns the DEK — hand it to the
   * session, then `setSecret` the first seed. Refuses when a vault exists.
   */
  async create(password: string): Promise<Uint8Array> {
    requirePassword(password, VAULT_MIN_PASSWORD_LENGTH)
    if (await this.exists()) throw new VaultError('A vault already exists; unlock it or reset explicitly.', 'exists')
    const dek = this._random(DEK_BYTES)
    await this._storage.set(await this._sealEnvelope(password, dek, {}, [], Date.now()))
    return dek
  }

  /**
   * Derive the KEK from `password`, unseal and return the DEK. `wrong-password` on
   * failure. A v1 (PBKDF2) envelope that opens is re-sealed as v2 (scrypt) on the
   * way out, secrets untouched.
   */
  async unlock(password: string): Promise<Uint8Array> {
    requirePassword(password)
    const envelope = await this._load()
    if (isEnvelopeV1(envelope)) {
      if (envelope.kdf.iterations < VAULT_MIN_ITERATIONS) throw new VaultError(`The vault's KDF (${envelope.kdf.iterations} iterations) is below the floor this build accepts.`, 'weak-kdf')
      const kek = await this._derivePbkdf2(password, fromBase64(envelope.kdf.salt), envelope.kdf.iterations)
      const dek = await this._open(kek, envelope.dek, aadDekV1(envelope.kdf), 'wrong-password')
      if (this._kdf === 'scrypt') {
        // Upgrade in place: same secrets, same createdAt, scrypt-wrapped DEK.
        const next = await this._sealEnvelope(password, dek, envelope.secrets, [], envelope.createdAt)
        await this._storage.set(isEnvelopeV2(next) ? { ...next, upgradedAt: Date.now() } : next)
      }
      return dek
    }
    if (!isStrongScrypt(envelope.kdf)) throw new VaultError(`The vault's scrypt cost (N=${envelope.kdf.N} r=${envelope.kdf.r} p=${envelope.kdf.p}) is below the floor this build accepts.`, 'weak-kdf')
    const kek = await this._deriveScrypt(password, fromBase64(envelope.kdf.salt), envelope.kdf)
    return this._open(kek, envelope.dek, aadDekV2(envelope.kdf), 'wrong-password')
  }

  /** Re-wrap the DEK under a new password (fresh salt, current KDF). Secrets and passkeys are untouched. */
  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    requirePassword(newPassword, VAULT_MIN_PASSWORD_LENGTH)
    const dek = await this.unlock(oldPassword)
    try {
      const envelope = await this._load()
      const passkeys = isEnvelopeV2(envelope) ? envelope.passkeys : []
      const next = await this._sealEnvelope(newPassword, dek, envelope.secrets, passkeys, envelope.createdAt)
      await this._storage.set(isEnvelopeV2(envelope) && envelope.upgradedAt !== undefined && isEnvelopeV2(next) ? { ...next, upgradedAt: envelope.upgradedAt } : next)
    } finally {
      zeroize(dek)
    }
  }

  // ---- passkeys (v2) ----

  /** Public view of the registered passkeys (ids, labels; whether each can verify assertions). */
  async listPasskeys(): Promise<Array<{ id: string; label: string; createdAt: number; canVerify: boolean }>> {
    const e = await this._storage.get()
    if (!e || !isEnvelopeV2(e)) return []
    return e.passkeys.map((p) => ({ id: p.id, label: p.label, createdAt: p.createdAt, canVerify: typeof p.publicKey === 'string' && p.alg === -7 }))
  }

  /** The SPKI public key (base64) of one passkey, for assertion verification; `null` when unknown. */
  async passkeyPublicKey(id: string): Promise<{ publicKey: string; alg: number } | null> {
    const e = await this._storage.get()
    if (!e || !isEnvelopeV2(e)) return null
    const p = e.passkeys.find((k) => k.id === id)
    return p?.publicKey && p.alg !== undefined ? { publicKey: p.publicKey, alg: p.alg } : null
  }

  /**
   * Register a passkey as a second unlock path: the DEK (from the unlocked session)
   * is sealed under HKDF-SHA256(`prf`, salt = credential id). The password stays
   * the recovery path; `prf` is zeroized here. A v1 envelope must be unlocked (and
   * thereby upgraded) first.
   */
  async addPasskey(dek: Uint8Array, passkey: { id: string; prf: Uint8Array; label: string; publicKey?: string | undefined; alg?: number | undefined }): Promise<void> {
    try {
      requireId(passkey.id)
      if (passkey.prf.length !== PRF_BYTES) throw new VaultError(`A PRF output is ${PRF_BYTES} bytes.`, 'invalid-input')
      const envelope = await this._load()
      if (!isEnvelopeV2(envelope)) throw new VaultError('Unlock with the password once so the vault is upgraded before adding a passkey.', 'unsupported-envelope')
      if (envelope.passkeys.some((p) => p.id === passkey.id)) throw new VaultError('This passkey is already registered.', 'exists')
      // Prove the DEK is the vault's before sealing it under a new key.
      await this._requireDek(dek, envelope)
      const key = await this._derivePasskeyKek(passkey.prf, passkey.id)
      const entry: VaultPasskey = { id: passkey.id, label: passkey.label.slice(0, 64), createdAt: Date.now(), dek: await this._seal(key, dek, aadPasskey(passkey.id)) }
      if (passkey.publicKey && passkey.alg !== undefined) { entry.publicKey = passkey.publicKey; entry.alg = passkey.alg }
      await this._storage.set({ ...envelope, passkeys: [...envelope.passkeys, entry] })
    } finally {
      zeroize(passkey.prf)
    }
  }

  /** Unseal the DEK with a passkey's PRF output. `wrong-password` when the box does not open, `missing` when the id is unknown. */
  async unlockWithPasskey(id: string, prf: Uint8Array): Promise<Uint8Array> {
    try {
      requireId(id)
      if (prf.length !== PRF_BYTES) throw new VaultError(`A PRF output is ${PRF_BYTES} bytes.`, 'invalid-input')
      const envelope = await this._load()
      if (!isEnvelopeV2(envelope)) throw new VaultError('This vault has no passkeys; unlock with the password.', 'missing')
      const entry = envelope.passkeys.find((p) => p.id === id)
      if (!entry) throw new VaultError('No such passkey on this vault.', 'missing')
      const key = await this._derivePasskeyKek(prf, id)
      return await this._open(key, entry.dek, aadPasskey(id), 'wrong-password')
    } finally {
      zeroize(prf)
    }
  }

  async removePasskey(id: string): Promise<void> {
    requireId(id)
    const envelope = await this._load()
    if (!isEnvelopeV2(envelope)) return
    await this._storage.set({ ...envelope, passkeys: envelope.passkeys.filter((p) => p.id !== id) })
  }

  // ---- secrets ----

  async listSecretIds(): Promise<string[]> {
    const envelope = await this._storage.get()
    return envelope ? Object.keys(envelope.secrets) : []
  }

  /** Seal `secret` under the DEK as `sourceId` (overwrites an entry with the same id). */
  async setSecret(dek: Uint8Array, sourceId: string, secret: Uint8Array): Promise<void> {
    requireId(sourceId)
    const envelope = await this._load()
    const key = await this._importDek(dek)
    const box = await this._seal(key, secret, aadSecret(sourceId))
    await this._storage.set({ ...envelope, secrets: { ...envelope.secrets, [sourceId]: box } })
  }

  /** Unseal one secret. `null` when the id is unknown; the caller zeroizes the result after use. */
  async getSecret(dek: Uint8Array, sourceId: string): Promise<Uint8Array | null> {
    requireId(sourceId)
    const envelope = await this._load()
    const box = envelope.secrets[sourceId]
    if (!box) return null
    const key = await this._importDek(dek)
    return this._open(key, box, aadSecret(sourceId), 'locked')
  }

  async deleteSecret(sourceId: string): Promise<void> {
    requireId(sourceId)
    const envelope = await this._load()
    if (!(sourceId in envelope.secrets)) return
    const secrets = { ...envelope.secrets }
    delete secrets[sourceId]
    await this._storage.set({ ...envelope, secrets })
  }

  /** Remove the whole vault. The explicit destructive flow only (back up → wipe → create). */
  async destroy(): Promise<void> {
    await this._storage.clear()
  }

  // ---- crypto ----

  private _random(n: number): Uint8Array {
    return this._crypto.getRandomValues(new Uint8Array(n))
  }

  /** A fresh envelope (v2 by default, v1 with `kdf: 'pbkdf2'`) wrapping `dek` under `password`. */
  private async _sealEnvelope(password: string, dek: Uint8Array, secrets: Record<string, SealedBox>, passkeys: VaultPasskey[], createdAt: number): Promise<VaultEnvelope> {
    const salt = this._random(SALT_BYTES)
    if (this._kdf === 'pbkdf2') {
      const kdf: VaultEnvelopeV1['kdf'] = { name: 'PBKDF2-SHA256', iterations: this._iterations, salt: toBase64(salt) }
      const kek = await this._derivePbkdf2(password, salt, this._iterations)
      return { v: 1, kdf, dek: await this._seal(kek, dek, aadDekV1(kdf)), secrets, createdAt }
    }
    const kdf: VaultEnvelopeV2['kdf'] = { name: 'scrypt', ...this._scrypt, salt: toBase64(salt) }
    const kek = await this._deriveScrypt(password, salt, kdf)
    return { v: 2, kdf, dek: await this._seal(kek, dek, aadDekV2(kdf)), secrets, passkeys, createdAt }
  }

  /** The caller's DEK must open this envelope's secrets — it is the key the password protects, not any 32 bytes. */
  private async _requireDek(dek: Uint8Array, envelope: VaultEnvelope): Promise<void> {
    const ids = Object.keys(envelope.secrets)
    const key = await this._importDek(dek)
    if (ids.length === 0) return
    const probe = await this._open(key, envelope.secrets[ids[0]!]!, aadSecret(ids[0]!), 'locked')
    zeroize(probe)
  }

  private async _derivePbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const subtle = this._crypto.subtle
    const material = await subtle.importKey('raw', toArrayBuffer(new TextEncoder().encode(password.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey'])
    return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: toArrayBuffer(salt), iterations }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }

  private async _deriveScrypt(password: string, salt: Uint8Array, cost: { N: number; r: number; p: number }): Promise<CryptoKey> {
    const pw = new TextEncoder().encode(password.normalize('NFKC'))
    let raw: Uint8Array
    try {
      raw = await scryptAsync(pw, salt, { N: cost.N, r: cost.r, p: cost.p, dkLen: 32, maxmem: 2 * 128 * cost.N * cost.r + 1024 * 1024, ...(this._onProgress ? { onProgress: this._onProgress } : {}) })
    } finally {
      zeroize(pw)
    }
    try {
      return await this._crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    } finally {
      zeroize(raw)
    }
  }

  /** HKDF-SHA256(ikm = PRF output, salt = credential id bytes, info) → AES-256-GCM key. */
  private async _derivePasskeyKek(prf: Uint8Array, credentialId: string): Promise<CryptoKey> {
    const subtle = this._crypto.subtle
    const ikm = await subtle.importKey('raw', toArrayBuffer(prf), 'HKDF', false, ['deriveKey'])
    return subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: toArrayBuffer(fromBase64Url(credentialId)), info: toArrayBuffer(new TextEncoder().encode(HKDF_INFO)) }, ikm, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }

  private async _importDek(dek: Uint8Array): Promise<CryptoKey> {
    if (dek.length !== DEK_BYTES) throw new VaultError('Vault key must be 32 bytes.', 'invalid-input')
    return this._crypto.subtle.importKey('raw', toArrayBuffer(dek), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  }

  private async _seal(key: CryptoKey, plaintext: Uint8Array, aad: string): Promise<SealedBox> {
    const iv = this._random(IV_BYTES)
    const ct = await this._crypto.subtle.encrypt({ name: 'AES-GCM', iv: toArrayBuffer(iv), additionalData: toArrayBuffer(new TextEncoder().encode(aad)) }, key, toArrayBuffer(plaintext))
    return { iv: toBase64(iv), data: toBase64(new Uint8Array(ct)) }
  }

  private async _open(key: CryptoKey, box: SealedBox, aad: string, onFail: 'wrong-password' | 'locked'): Promise<Uint8Array> {
    try {
      const pt = await this._crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: toArrayBuffer(fromBase64(box.iv)), additionalData: toArrayBuffer(new TextEncoder().encode(aad)) },
        key,
        toArrayBuffer(fromBase64(box.data)),
      )
      return new Uint8Array(pt)
    } catch {
      throw new VaultError(onFail === 'wrong-password' ? 'Wrong password.' : 'The vault key does not open this entry; lock and unlock again.', onFail)
    }
  }

  private async _load(): Promise<VaultEnvelope> {
    const envelope = await this._storage.get()
    if (!envelope) throw new VaultError('No vault in this storage area.', 'missing')
    if (!isEnvelopeV1(envelope) && !isEnvelopeV2(envelope)) throw new VaultError('Unsupported vault envelope.', 'unsupported-envelope')
    return envelope
  }
}

export function isEnvelopeV1(x: unknown): x is VaultEnvelopeV1 {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  const kdf = e.kdf as Record<string, unknown> | undefined
  return (
    e.v === 1 &&
    typeof kdf === 'object' && kdf !== null && kdf.name === 'PBKDF2-SHA256' && Number.isInteger(kdf.iterations) && typeof kdf.salt === 'string' &&
    isBox(e.dek) &&
    typeof e.secrets === 'object' && e.secrets !== null && Object.values(e.secrets as object).every(isBox)
  )
}

export function isEnvelopeV2(x: unknown): x is VaultEnvelopeV2 {
  if (typeof x !== 'object' || x === null) return false
  const e = x as Record<string, unknown>
  const kdf = e.kdf as Record<string, unknown> | undefined
  return (
    e.v === 2 &&
    typeof kdf === 'object' && kdf !== null && kdf.name === 'scrypt' && Number.isInteger(kdf.N) && Number.isInteger(kdf.r) && Number.isInteger(kdf.p) && typeof kdf.salt === 'string' &&
    isBox(e.dek) &&
    typeof e.secrets === 'object' && e.secrets !== null && Object.values(e.secrets as object).every(isBox) &&
    Array.isArray(e.passkeys) && e.passkeys.every((p) => typeof p === 'object' && p !== null && typeof (p as VaultPasskey).id === 'string' && typeof (p as VaultPasskey).label === 'string' && isBox((p as VaultPasskey).dek))
  )
}

function isBox(x: unknown): x is SealedBox {
  return typeof x === 'object' && x !== null && typeof (x as SealedBox).iv === 'string' && typeof (x as SealedBox).data === 'string'
}

function isStrongScrypt(c: { N: number; r: number; p: number }): boolean {
  return Number.isInteger(c.N) && c.N >= VAULT_MIN_SCRYPT.N && (c.N & (c.N - 1)) === 0 && Number.isInteger(c.r) && c.r >= VAULT_MIN_SCRYPT.r && Number.isInteger(c.p) && c.p >= VAULT_MIN_SCRYPT.p
}

function requirePassword(password: string, minLength = 1): void {
  if (typeof password !== 'string' || password.length === 0) throw new VaultError('Password must not be empty.', 'invalid-input')
  if ([...password].length < minLength) throw new VaultError(`Password must be at least ${minLength} characters.`, 'invalid-input')
}

function requireId(id: string): void {
  if (typeof id !== 'string' || id.length === 0 || id.length > 128) throw new VaultError('Bad source id.', 'invalid-input')
}

/** base64url (WebAuthn ids) → bytes; plain base64 is accepted too. */
export function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  return fromBase64(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
}

export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Envelope in memory — tests and the smoke. */
export function memoryVaultStorage(initial: VaultEnvelope | null = null): VaultStorage & { envelope: VaultEnvelope | null } {
  const s = {
    envelope: initial,
    async get() { return s.envelope ? structuredClone(s.envelope) : null },
    async set(envelope: VaultEnvelope) { s.envelope = structuredClone(envelope) },
    async clear() { s.envelope = null },
  }
  return s
}
