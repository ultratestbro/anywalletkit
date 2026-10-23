import { CloudBackupError, fromNative } from './errors.js'
import { loadNative, type NativeBackupCloud } from './native.js'

export interface StoredFile {
  name: string
  /** false = iCloud has it but this device hasn't downloaded it yet (`get` downloads it). */
  downloaded: boolean
  modifiedAt: number
}

/** Where backup files live. One small text file per wallet secret. */
export interface BackupStore {
  readonly kind: string
  status(): Promise<{ available: boolean; reason?: 'signed-out' | 'unavailable' }>
  list(): Promise<StoredFile[]>
  put(name: string, text: string): Promise<void>
  get(name: string): Promise<string | null>
  delete(name: string): Promise<void>
}

/** Where backup KEYS live for the no-password option (a key protector on the file). */
export interface KeyVault {
  /** Also the protector id written into the backup file. */
  readonly kind: string
  get(id: string): Promise<Uint8Array | null>
  getOrCreate(id: string): Promise<Uint8Array>
  delete(id: string): Promise<void>
}

async function need(native?: NativeBackupCloud): Promise<NativeBackupCloud> {
  const n = native ?? (await loadNative())
  if (!n) throw new CloudBackupError('unavailable', 'iCloud backups are not available on this platform.')
  return n
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw fromNative(e)
  }
}

export interface ICloudDriveOptions {
  /** The app's iCloud container, e.g. "iCloud.page.vaulty.app" (same as in the config plugin). */
  container: string
  /** Folder inside the container's hidden scope. Default "WalletBackups". */
  folder?: string
  /** How long a read may wait for iCloud to download a file. Default 30 s. */
  downloadTimeoutMs?: number
  native?: NativeBackupCloud
}

/** Backup files in the app's own iCloud Drive container — hidden from the Files app, synced to the user's devices. */
export function iCloudDrive(opts: ICloudDriveOptions): BackupStore {
  const folder = opts.folder ?? 'WalletBackups'
  const timeout = opts.downloadTimeoutMs ?? 30_000
  return {
    kind: 'icloud-drive',
    async status() {
      const n = opts.native ?? (await loadNative())
      if (!n) return { available: false, reason: 'unavailable' }
      const s = await wrap(() => n.driveStatus(opts.container))
      if (!s.signedIn) return { available: false, reason: 'signed-out' }
      if (!s.container) return { available: false, reason: 'unavailable' }
      return { available: true }
    },
    async list() {
      const n = await need(opts.native)
      return wrap(() => n.driveList(opts.container, folder))
    },
    async put(name, text) {
      const n = await need(opts.native)
      await wrap(() => n.driveWrite(opts.container, folder, name, text))
    },
    async get(name) {
      const n = await need(opts.native)
      return wrap(() => n.driveRead(opts.container, folder, name, timeout))
    },
    async delete(name) {
      const n = await need(opts.native)
      await wrap(() => n.driveDelete(opts.container, folder, name))
    },
  }
}

export interface ICloudKeychainOptions {
  /** Keychain service for the synced backup keys. Default "forgewallet.backup-keys". */
  service?: string
  native?: NativeBackupCloud
  /** Randomness for new keys — crypto.getRandomValues by default. */
  random?: (n: number) => Uint8Array
}

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
function fromHex(s: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/.test(s)) return null
  return Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)))
}

/**
 * Backup keys in iCloud Keychain (synchronizable items, end-to-end encrypted by
 * Apple, readable by this app on the user's devices). Holds keys only — never a
 * secret: the backup file itself is in iCloud Drive.
 */
export function iCloudKeychain(opts: ICloudKeychainOptions = {}): KeyVault {
  const service = opts.service ?? 'forgewallet.backup-keys'
  const random = opts.random ?? ((n: number) => globalThis.crypto.getRandomValues(new Uint8Array(n)))
  const vault: KeyVault = {
    kind: 'icloud-keychain',
    async get(id) {
      const n = await need(opts.native)
      const raw = await wrap(() => n.keychainGet(service, id))
      return raw === null ? null : fromHex(raw)
    },
    async getOrCreate(id) {
      const existing = await vault.get(id)
      if (existing) return existing
      const key = random(32)
      if (key.length !== 32) throw new CloudBackupError('storage', 'The random source returned the wrong length.')
      const n = await need(opts.native)
      await wrap(() => n.keychainSet(service, id, toHex(key)))
      return key
    },
    async delete(id) {
      const n = await need(opts.native)
      await wrap(() => n.keychainDelete(service, id))
    },
  }
  return vault
}
