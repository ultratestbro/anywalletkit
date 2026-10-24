/**
 * - `cancelled` — the user dismissed the Face ID / passcode sheet that guards a backup key.
 * - `signed-out` — no iCloud account on the device, or iCloud Drive is off.
 * - `unavailable` — this platform / build has no such store (e.g. Android today, or the entitlement is missing).
 * - `not-found` — no backup under that name.
 * - `key-missing` — the backup needs its iCloud Keychain key, and this device doesn't have it (Keychain sync off, not synced yet).
 * - `mismatch` — the backup belongs to a different wallet than the one expected.
 * - `storage` — anything else from the cloud layer.
 * Wrong password / wrong key / a corrupted file stay seed-vault `BackupError`s.
 */
export type CloudBackupErrorCode = 'cancelled' | 'signed-out' | 'unavailable' | 'not-found' | 'key-missing' | 'mismatch' | 'storage'

export class CloudBackupError extends Error {
  override readonly name = 'CloudBackupError'
  constructor(
    readonly code: CloudBackupErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export function isCloudBackupError(err: unknown, code?: CloudBackupErrorCode): err is CloudBackupError {
  return err instanceof CloudBackupError && (code === undefined || err.code === code)
}

export function fromNative(err: unknown): CloudBackupError {
  if (err instanceof CloudBackupError) return err
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  const message = err instanceof Error ? err.message : String(err)
  const mapped: CloudBackupErrorCode = code === 'ERR_FW_ICLOUD_SIGNED_OUT' ? 'signed-out' : code === 'ERR_FW_CANCELLED' ? 'cancelled' : 'storage'
  return new CloudBackupError(mapped, message, { cause: err })
}
