import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { randomBytes } from '@noble/ciphers/utils.js'
import { argon2idAsync } from '@noble/hashes/argon2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { BackupError } from './errors.js'
import { canonicalJson, fromB64u, fromUtf8, toB64u, utf8 } from './encoding.js'

/** Stable wire identifier: existing backups carry it — never rename. */
export const BACKUP_FORMAT = 'forgewallet-backup'
export const BACKUP_VERSION = 1

/**
 * Argon2id cost. Default = OWASP's minimum recommendation (19 MiB, 2 passes):
 * ~6 s in pure JS on Hermes, well under a second with a native implementation —
 * pass a stronger one (e.g. 64 MiB × 3) together with `argon2id` on devices that have it.
 */
export interface Argon2Params {
  /** Memory in KiB. */
  m: number
  /** Passes. */
  t: number
  /** Lanes. */
  p: number
}
export const DEFAULT_ARGON2: Argon2Params = { m: 19 * 1024, t: 2, p: 1 }
/** Below these a password protector is refused, on seal and on decode; above, a file is refused on decode (memory bomb). */
const ARGON2_MIN: Argon2Params = { m: 19 * 1024, t: 2, p: 1 }
const ARGON2_MAX: Argon2Params = { m: 1024 * 1024, t: 16, p: 16 }

/** A password needs at least this many characters (after NFKC). Suggest four or more random words. */
export const MIN_PASSWORD_LENGTH = 10

/** A native Argon2id (e.g. react-native-quick-crypto): same inputs and output as RFC 9106, 32-byte output. */
export type Argon2idImpl = (password: Uint8Array, salt: Uint8Array, params: Argon2Params) => Promise<Uint8Array>

export interface KdfOptions {
  /** Faster Argon2id; the pure-JS one is used otherwise (and always works to open a backup). */
  argon2id?: Argon2idImpl
  /** Cost for a new password protector. Default DEFAULT_ARGON2; never below it. */
  argon2?: Argon2Params
  /** Progress 0…1 of the pure-JS Argon2id, for a progress bar. */
  onProgress?: (progress: number) => void
}

/** Public, authenticated facts about the secret — compare them with the keyring before restoring. */
export interface BackupMeta {
  /** Keyring source type: 'mnemonic' | 'privateKey' | 'tonMnemonic' | … */
  type: string
  /** Keyring duplicate-check fingerprint (BIP-32 master fingerprint for a seed). */
  fingerprint: string
  label?: string
  chain?: string
}

/** Who can open a backup. Several can be attached; each one alone opens it. */
export type Protector =
  | { kind: 'password'; password: string }
  /**
   * A ≥32-byte secret held elsewhere: a passkey PRF output, a random key in iCloud
   * Keychain / Google Block Store, a hardware key's hmac-secret. `id` names it
   * so the app knows which key to fetch (e.g. "passkey:<credentialId>", "icloud-keychain").
   */
  | { kind: 'key'; id: string; key: Uint8Array; label?: string }

/** What opens a backup: a password, or the key behind one `key` protector. */
export type Unlock = { kind: 'password'; password: string } | { kind: 'key'; id: string; key: Uint8Array }

interface Sealed {
  nonce: string
  ct: string
}

export type ProtectorRecord =
  | ({ kind: 'password'; kdf: { alg: 'argon2id'; salt: string } & Argon2Params } & Sealed)
  | ({ kind: 'key'; id: string; label?: string; salt: string } & Sealed)

/** The backup file. JSON-safe as is: `encodeBackup` / `decodeBackup`. */
export interface BackupEnvelope {
  format: typeof BACKUP_FORMAT
  v: typeof BACKUP_VERSION
  createdAt: number
  meta: BackupMeta
  payload: { alg: 'xchacha20poly1305' } & Sealed
  protectors: ProtectorRecord[]
}

/** An opened backup. Read the secret, then `dispose()` — the bytes are zeroized. */
export interface OpenedBackup {
  readonly meta: BackupMeta
  readonly bytes: Uint8Array
  text(): string
  dispose(): void
}

/** HKDF info of v1 key protectors: part of the format — never rename. */
const KEY_INFO = utf8('forgewallet-backup v1 key protector')

/** Seal `secret` (the keyring's stored string, or raw bytes) for every protector. */
export async function sealBackup(secret: string | Uint8Array, meta: BackupMeta, protectors: Protector[], opts: KdfOptions = {}): Promise<BackupEnvelope> {
  checkMeta(meta)
  if (protectors.length === 0) throw new BackupError('invalid', 'A backup needs at least one protector (a password or a key).')
  const plain = typeof secret === 'string' ? utf8(secret) : new Uint8Array(secret) // a copy, never a view (Buffer#slice shares memory)
  if (plain.length === 0) throw new BackupError('invalid', 'Nothing to back up.')
  const dek = randomBytes(32)
  try {
    const header = { format: BACKUP_FORMAT, v: BACKUP_VERSION, createdAt: Date.now(), meta: { ...meta } } as const
    const payloadNonce = randomBytes(24)
    const ct = xchacha20poly1305(dek, payloadNonce, payloadAad(header)).encrypt(plain)
    const records: ProtectorRecord[] = []
    for (const p of protectors) records.push(await wrap(dek, p, opts, records))
    return openable({ ...header, payload: { alg: 'xchacha20poly1305', nonce: toB64u(payloadNonce), ct: toB64u(ct) }, protectors: records })
  } finally {
    dek.fill(0)
    plain.fill(0)
  }
}

/** Open with one protector. Throws `wrong-password` / `wrong-key` / `corrupted`. */
export async function openBackup(envelope: BackupEnvelope, unlock: Unlock, opts: KdfOptions = {}): Promise<OpenedBackup> {
  checkEnvelope(envelope)
  const dek = await unwrap(envelope, unlock, opts)
  try {
    const p = envelope.payload
    let bytes: Uint8Array
    try {
      bytes = xchacha20poly1305(dek, mustB64(p.nonce, 24), payloadAad(envelope)).decrypt(mustB64(p.ct))
    } catch {
      throw new BackupError('corrupted', 'The backup opened, but its contents or metadata were altered.')
    }
    let disposed = false
    return {
      meta: { ...envelope.meta },
      bytes,
      text() {
        if (disposed) throw new BackupError('invalid', 'This opened backup was disposed.')
        return fromUtf8(bytes)
      },
      dispose() {
        disposed = true
        bytes.fill(0)
      },
    }
  } finally {
    dek.fill(0)
  }
}

/** Attach another protector (e.g. a passkey after a password backup). Opens with `unlock` first. */
export async function addProtector(envelope: BackupEnvelope, unlock: Unlock, protector: Protector, opts: KdfOptions = {}): Promise<BackupEnvelope> {
  checkEnvelope(envelope)
  const dek = await unwrap(envelope, unlock, opts)
  try {
    const kept = envelope.protectors.filter((r) => !sameProtector(r, protector))
    return openable({ ...envelope, protectors: [...kept, await wrap(dek, protector, opts, kept)] })
  } finally {
    dek.fill(0)
  }
}

/** Detach a protector. The last one cannot be removed — the backup would be unopenable. */
export function removeProtector(envelope: BackupEnvelope, which: { kind: 'password' } | { kind: 'key'; id: string }): BackupEnvelope {
  checkEnvelope(envelope)
  const kept = envelope.protectors.filter((r) => !sameProtector(r, which))
  if (kept.length === envelope.protectors.length) throw new BackupError('invalid', 'No such protector on this backup.')
  if (kept.length === 0) throw new BackupError('invalid', 'The last protector cannot be removed.')
  return { ...envelope, protectors: kept }
}

/** What the file says about itself — no secret, no KDF. */
export function describeBackup(envelope: BackupEnvelope): {
  meta: BackupMeta
  createdAt: number
  protectors: Array<{ kind: 'password' } | { kind: 'key'; id: string; label?: string }>
} {
  checkEnvelope(envelope)
  return {
    meta: { ...envelope.meta },
    createdAt: envelope.createdAt,
    protectors: envelope.protectors.map((r) => (r.kind === 'password' ? { kind: 'password' as const } : { kind: 'key' as const, id: r.id, ...(r.label ? { label: r.label } : {}) })),
  }
}

/** The largest backup file decodeBackup reads. */
const MAX_BACKUP_CHARS = 256 * 1024

/**
 * What sealBackup / addProtector hand out must pass the checks openBackup and decodeBackup run: a
 * key-protector label past 256 characters or a file past {@link MAX_BACKUP_CHARS} used to seal fine
 * and then never open (round 3, L6).
 */
function openable(envelope: BackupEnvelope): BackupEnvelope {
  checkEnvelope(envelope)
  if (JSON.stringify(envelope).length > MAX_BACKUP_CHARS) throw new BackupError('invalid', `This backup would be too large to open later (over ${MAX_BACKUP_CHARS / 1024} KB): the secret is too big.`)
  return envelope
}

export function encodeBackup(envelope: BackupEnvelope): string {
  checkEnvelope(envelope)
  return JSON.stringify(envelope)
}

/** Parse and validate a backup file. Unknown formats, versions, algorithms or out-of-bounds costs are refused. */
export function decodeBackup(text: string): BackupEnvelope {
  if (typeof text !== 'string' || text.length > MAX_BACKUP_CHARS) throw new BackupError('invalid', 'Not a backup file (empty or too large).')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new BackupError('invalid', 'Not a backup file (not JSON).')
  }
  checkEnvelope(raw)
  const e = raw as BackupEnvelope
  // Rebuild from known fields only: nothing unexpected rides along.
  return {
    format: e.format,
    v: e.v,
    createdAt: e.createdAt,
    meta: pickMeta(e.meta),
    payload: { alg: e.payload.alg, nonce: e.payload.nonce, ct: e.payload.ct },
    protectors: e.protectors.map((r) =>
      r.kind === 'password'
        ? { kind: 'password', kdf: { alg: 'argon2id', salt: r.kdf.salt, m: r.kdf.m, t: r.kdf.t, p: r.kdf.p }, nonce: r.nonce, ct: r.ct }
        : { kind: 'key', id: r.id, ...(r.label !== undefined ? { label: r.label } : {}), salt: r.salt, nonce: r.nonce, ct: r.ct },
    ),
  }
}

// ---- internals ----

async function wrap(dek: Uint8Array, p: Protector, opts: KdfOptions, existing: ProtectorRecord[]): Promise<ProtectorRecord> {
  if (existing.some((r) => sameProtector(r, p))) throw new BackupError('invalid', 'This protector is already on the backup.')
  if (p.kind === 'password') {
    const params = opts.argon2 ?? DEFAULT_ARGON2
    checkArgon2(params, ARGON2_MIN, 'A password backup cannot use a cost below the default.')
    const salt = randomBytes(16)
    const descriptor = { kind: 'password' as const, kdf: { alg: 'argon2id' as const, salt: toB64u(salt), ...pickArgon2(params) } }
    const kek = await passwordKek(p.password, salt, params, opts, true)
    return { ...descriptor, ...seal(kek, dek, descriptor) }
  }
  checkKeyId(p.id)
  if (p.label !== undefined && (typeof p.label !== 'string' || p.label.length > 256)) throw new BackupError('invalid', 'A key protector label is at most 256 characters.')
  if (!(p.key instanceof Uint8Array) || p.key.length < 32) throw new BackupError('invalid', 'A key protector needs at least 32 bytes of key material.')
  const salt = randomBytes(16)
  const descriptor = { kind: 'key' as const, id: p.id, ...(p.label ? { label: p.label } : {}), salt: toB64u(salt) }
  const kek = hkdf(sha256, p.key, salt, KEY_INFO, 32)
  return { ...descriptor, ...seal(kek, dek, descriptor) }
}

async function unwrap(envelope: BackupEnvelope, unlock: Unlock, opts: KdfOptions): Promise<Uint8Array> {
  if (unlock.kind === 'password') {
    const r = envelope.protectors.find((x): x is Extract<ProtectorRecord, { kind: 'password' }> => x.kind === 'password')
    if (!r) throw new BackupError('invalid', 'This backup has no password.')
    const { salt, ...rest } = r.kdf
    const kek = await passwordKek(unlock.password, mustB64(salt), pickArgon2(rest), opts, false)
    return open(kek, r, descriptorOf(r), 'wrong-password', 'Wrong password.')
  }
  const r = envelope.protectors.find((x): x is Extract<ProtectorRecord, { kind: 'key' }> => x.kind === 'key' && x.id === unlock.id)
  if (!r) throw new BackupError('invalid', `This backup has no key "${unlock.id}".`)
  const kek = hkdf(sha256, unlock.key, mustB64(r.salt), KEY_INFO, 32)
  return open(kek, r, descriptorOf(r), 'wrong-key', 'Wrong key.')
}

async function passwordKek(password: string, salt: Uint8Array, params: Argon2Params, opts: KdfOptions, sealing: boolean): Promise<Uint8Array> {
  if (typeof password !== 'string') throw new BackupError('invalid', 'The password must be a string.')
  const normalized = password.normalize('NFKC')
  if (sealing && [...normalized].length < MIN_PASSWORD_LENGTH) {
    throw new BackupError('weak-password', `Use at least ${MIN_PASSWORD_LENGTH} characters — four or more random words work best.`)
  }
  const pw = utf8(normalized)
  try {
    if (opts.argon2id) return await opts.argon2id(pw, salt, params)
    return await argon2idAsync(pw, salt, { ...params, dkLen: 32, asyncTick: 10, ...(opts.onProgress ? { onProgress: opts.onProgress } : {}) })
  } finally {
    pw.fill(0)
  }
}

function seal(kek: Uint8Array, dek: Uint8Array, descriptor: object): Sealed {
  try {
    const nonce = randomBytes(24)
    return { nonce: toB64u(nonce), ct: toB64u(xchacha20poly1305(kek, nonce, utf8(canonicalJson(descriptor))).encrypt(dek)) }
  } finally {
    kek.fill(0)
  }
}

function open(kek: Uint8Array, r: Sealed, descriptor: object, code: 'wrong-password' | 'wrong-key', message: string): Uint8Array {
  try {
    const dek = xchacha20poly1305(kek, mustB64(r.nonce, 24), utf8(canonicalJson(descriptor))).decrypt(mustB64(r.ct))
    if (dek.length !== 32) throw new Error('length')
    return dek
  } catch {
    throw new BackupError(code, message)
  } finally {
    kek.fill(0)
  }
}

function descriptorOf(r: ProtectorRecord): object {
  if (r.kind === 'password') return { kind: 'password', kdf: { alg: r.kdf.alg, salt: r.kdf.salt, m: r.kdf.m, t: r.kdf.t, p: r.kdf.p } }
  return { kind: 'key', id: r.id, ...(r.label ? { label: r.label } : {}), salt: r.salt }
}

function payloadAad(h: Pick<BackupEnvelope, 'format' | 'v' | 'createdAt' | 'meta'>): Uint8Array {
  return utf8(canonicalJson({ format: h.format, v: h.v, createdAt: h.createdAt, meta: pickMeta(h.meta) }))
}

function sameProtector(r: ProtectorRecord, p: { kind: 'password' } | { kind: 'key'; id: string }): boolean {
  return r.kind === p.kind && (r.kind === 'password' || r.id === (p as { id: string }).id)
}

function pickArgon2(p: Argon2Params): Argon2Params {
  return { m: p.m, t: p.t, p: p.p }
}

function pickMeta(m: BackupMeta): BackupMeta {
  return {
    type: m.type,
    fingerprint: m.fingerprint,
    ...(m.label !== undefined ? { label: m.label } : {}),
    ...(m.chain !== undefined ? { chain: m.chain } : {}),
  }
}

function mustB64(text: string, len?: number): Uint8Array {
  const b = fromB64u(text)
  if (!b || (len !== undefined && b.length !== len)) throw new BackupError('invalid', 'Malformed backup field.')
  return b
}

const isInt = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n)
const isStr = (s: unknown, max = 512): s is string => typeof s === 'string' && s.length <= max

function checkArgon2(p: Argon2Params, min: Argon2Params, message: string): void {
  if (!isInt(p.m) || !isInt(p.t) || !isInt(p.p)) throw new BackupError('invalid', 'Argon2 parameters must be integers.')
  if (p.m < min.m || p.t < min.t || p.p < min.p) throw new BackupError('invalid', message)
  if (p.m > ARGON2_MAX.m || p.t > ARGON2_MAX.t || p.p > ARGON2_MAX.p) throw new BackupError('invalid', 'Argon2 cost is out of bounds.')
  if (p.m < 8 * p.p) throw new BackupError('invalid', 'Argon2 memory must be at least 8 KiB per lane.')
}

function checkKeyId(id: unknown): void {
  if (!isStr(id, 256) || id.length === 0) throw new BackupError('invalid', 'A key protector needs an id (1–256 characters).')
}

function checkMeta(m: unknown): void {
  const meta = m as BackupMeta
  if (!meta || typeof meta !== 'object' || !isStr(meta.type, 64) || !meta.type || !isStr(meta.fingerprint, 256)) {
    throw new BackupError('invalid', 'Backup metadata needs a type and a fingerprint.')
  }
  if ((meta.label !== undefined && !isStr(meta.label, 256)) || (meta.chain !== undefined && !isStr(meta.chain, 64))) {
    throw new BackupError('invalid', 'Backup label / chain must be short strings.')
  }
}

function checkEnvelope(raw: unknown): asserts raw is BackupEnvelope {
  const e = raw as BackupEnvelope
  if (!e || typeof e !== 'object' || e.format !== BACKUP_FORMAT) throw new BackupError('unsupported', 'Not an Any Wallet Kit backup.')
  if (e.v !== BACKUP_VERSION) throw new BackupError('unsupported', `Backup version ${String(e.v)} is not supported by this build.`)
  if (!isInt(e.createdAt) || e.createdAt < 0) throw new BackupError('invalid', 'Malformed backup (createdAt).')
  checkMeta(e.meta)
  if (!e.payload || e.payload.alg !== 'xchacha20poly1305') throw new BackupError('unsupported', 'Unknown payload cipher.')
  if (!isStr(e.payload.nonce, 64) || !isStr(e.payload.ct, 128 * 1024)) throw new BackupError('invalid', 'Malformed backup payload.')
  if (!Array.isArray(e.protectors) || e.protectors.length === 0 || e.protectors.length > 16) throw new BackupError('invalid', 'A backup carries 1–16 protectors.')
  let passwords = 0
  const ids = new Set<string>()
  for (const r of e.protectors) {
    if (!r || typeof r !== 'object' || !isStr(r.nonce, 64) || !isStr(r.ct, 256)) throw new BackupError('invalid', 'Malformed protector.')
    if (r.kind === 'password') {
      passwords++
      if (!r.kdf || r.kdf.alg !== 'argon2id') throw new BackupError('unsupported', 'Unknown password KDF.')
      if (!isStr(r.kdf.salt, 128)) throw new BackupError('invalid', 'Malformed password salt.')
      // The sealing floor, not just sanity: this SDK never wrote less, and a cheaper file is cheaper to brute-force offline.
      checkArgon2(r.kdf, ARGON2_MIN, 'Password protector cost is below the minimum this build accepts.')
    } else if (r.kind === 'key') {
      checkKeyId(r.id)
      if (ids.has(r.id)) throw new BackupError('invalid', `Duplicate key protector "${r.id}".`)
      ids.add(r.id)
      if (!isStr(r.salt, 128) || (r.label !== undefined && !isStr(r.label, 256))) throw new BackupError('invalid', 'Malformed key protector.')
    } else {
      throw new BackupError('unsupported', 'Unknown protector kind.')
    }
  }
  if (passwords > 1) throw new BackupError('invalid', 'A backup carries at most one password.')
}
