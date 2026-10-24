import { decodeBackup, describeBackup, encodeBackup, openBackup, sealBackup, type BackupMeta, type KdfOptions, type OpenedBackup, type Protector } from '@anywalletkit/seed-vault'
import { CloudBackupError } from './errors.js'
import type { BackupStore, KeyVault } from './stores.js'

const EXT = '.fwbackup'

/** One file per wallet secret: `<type>-<fingerprint>.fwbackup`. Saving again replaces it. */
export function backupFileName(meta: Pick<BackupMeta, 'type' | 'fingerprint'>): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
  return `${safe(meta.type)}-${safe(meta.fingerprint)}${EXT}`
}

const keyId = (meta: Pick<BackupMeta, 'type' | 'fingerprint'>) => `backup-key.${backupFileName(meta).slice(0, -EXT.length)}`

export interface SaveBackupOptions {
  store: BackupStore
  /** The keyring's stored string for this source. */
  secret: string
  meta: BackupMeta
  /** A password protector (≥10 characters). */
  password?: string
  /** A key protector from this vault (e.g. iCloud Keychain) — the no-password option. */
  keyVault?: KeyVault
  kdf?: KdfOptions
}

/**
 * Seal one secret with the chosen protectors, write it, read it back and compare.
 * At least one of `password` / `keyVault`.
 */
export async function saveBackup(opts: SaveBackupOptions): Promise<{ name: string; protectors: string[] }> {
  if (!opts.password && !opts.keyVault) throw new CloudBackupError('storage', 'Choose a password, a key vault, or both.')
  const protectors: Protector[] = []
  let key: Uint8Array | null = null
  try {
    if (opts.password) protectors.push({ kind: 'password', password: opts.password })
    if (opts.keyVault) {
      key = await opts.keyVault.getOrCreate(keyId(opts.meta))
      protectors.push({ kind: 'key', id: opts.keyVault.kind, key })
    }
    const text = encodeBackup(await sealBackup(opts.secret, opts.meta, protectors, opts.kdf))
    const name = backupFileName(opts.meta)
    await opts.store.put(name, text)
    if ((await opts.store.get(name)) !== text) throw new CloudBackupError('storage', 'The backup was written but did not read back the same.')
    return { name, protectors: protectors.map((p) => (p.kind === 'password' ? 'password' : p.id)) }
  } finally {
    key?.fill(0)
  }
}

export interface BackupInfo {
  name: string
  downloaded: boolean
  modifiedAt: number
  /** Present when the file was read and decoded. */
  meta?: BackupMeta
  createdAt?: number
  protectors?: string[]
  /** Why the file couldn't be read (left for the app to show; never thrown from list). */
  error?: string
}

/** Every backup in the store, described (downloads placeholders). Broken files are listed with `error`. */
export async function listBackups(store: BackupStore): Promise<BackupInfo[]> {
  const out: BackupInfo[] = []
  for (const f of await store.list()) {
    if (!f.name.endsWith(EXT)) continue
    try {
      const text = await store.get(f.name)
      if (text === null) continue
      const d = describeBackup(decodeBackup(text))
      out.push({ ...f, meta: d.meta, createdAt: d.createdAt, protectors: d.protectors.map((p) => (p.kind === 'password' ? 'password' : p.id)) })
    } catch (e) {
      out.push({ ...f, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return out.sort((a, b) => (b.createdAt ?? b.modifiedAt) - (a.createdAt ?? a.modifiedAt))
}

/**
 * Is this wallet backed up here — without opening anything: the file exists,
 * decodes, and names the same type + fingerprint. For a "Backup: OK" badge.
 */
export async function checkBackup(store: BackupStore, meta: Pick<BackupMeta, 'type' | 'fingerprint'>): Promise<{ present: false } | { present: true; createdAt: number; protectors: string[] }> {
  const text = await store.get(backupFileName(meta)).catch(() => null)
  if (text === null) return { present: false }
  try {
    const d = describeBackup(decodeBackup(text))
    if (d.meta.type !== meta.type || d.meta.fingerprint !== meta.fingerprint) return { present: false }
    return { present: true, createdAt: d.createdAt, protectors: d.protectors.map((p) => (p.kind === 'password' ? 'password' : p.id)) }
  } catch {
    return { present: false }
  }
}

export interface RestoreBackupOptions {
  store: BackupStore
  name: string
  /** Open with the password… */
  password?: string
  /** …or with the key from this vault (tried when no password is given). */
  keyVault?: KeyVault
  /** Refuse a backup of any other wallet (e.g. restoring "this" account). */
  expect?: Pick<BackupMeta, 'type' | 'fingerprint'>
  kdf?: KdfOptions
}

/** Open a stored backup. The caller writes `opened.text()` where it belongs, then `dispose()`s. */
export async function restoreBackup(opts: RestoreBackupOptions): Promise<OpenedBackup> {
  const text = await opts.store.get(opts.name)
  if (text === null) throw new CloudBackupError('not-found', `No backup named ${opts.name}.`)
  const env = decodeBackup(text)
  if (opts.expect && (env.meta.type !== opts.expect.type || env.meta.fingerprint !== opts.expect.fingerprint)) {
    throw new CloudBackupError('mismatch', 'This backup belongs to a different wallet.')
  }
  if (opts.password) return openBackup(env, { kind: 'password', password: opts.password }, opts.kdf)
  if (!opts.keyVault) throw new CloudBackupError('storage', 'Give the backup password or the key vault it was saved with.')
  if (!env.protectors.some((p) => p.kind === 'key' && p.id === opts.keyVault!.kind)) {
    throw new CloudBackupError('key-missing', 'This backup was saved with a password only.')
  }
  const key = await opts.keyVault.get(keyId(env.meta))
  if (!key) throw new CloudBackupError('key-missing', 'The backup key is not in iCloud Keychain on this device yet — turn on iCloud Keychain, wait for it to sync, or use the password.')
  try {
    return await openBackup(env, { kind: 'key', id: opts.keyVault.kind, key }, opts.kdf)
  } finally {
    key.fill(0)
  }
}
