/**
 * Every failure the store can report, as a stable code the app can branch on.
 *
 * - `cancelled` — the user dismissed the Face ID / passcode / fingerprint sheet.
 * - `biometry-changed` — a strict (`biometricsOnly`) secret whose biometrics were
 *   re-enrolled or removed. The OS has made it unreadable for good; the app offers
 *   a restore from backup. Never retried.
 * - `lockout` — too many failed biometric attempts; the OS unlocks it later or with the passcode.
 * - `no-passcode` — the device has no passcode / screen lock, so nothing can be stored safely.
 * - `not-available` — the device cannot give the protection asked for (no biometrics
 *   enrolled for strict mode, no secure hardware, Android older than 11). Fail closed.
 * - `locked` — the device is locked; secrets are readable only while it is unlocked.
 * - `auth-failed` — the OS refused the authentication for another reason.
 * - `invalid` — a bad id or option, rejected before any native call.
 * - `storage` — anything else from the Keychain / Keystore / file layer.
 */
export type SecureStorageErrorCode =
  | 'cancelled'
  | 'biometry-changed'
  | 'lockout'
  | 'no-passcode'
  | 'not-available'
  | 'locked'
  | 'auth-failed'
  | 'invalid'
  | 'storage'

export class SecureStorageError extends Error {
  override readonly name = 'SecureStorageError'
  constructor(
    readonly code: SecureStorageErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}

export function isSecureStorageError(err: unknown, code?: SecureStorageErrorCode): err is SecureStorageError {
  return err instanceof SecureStorageError && (code === undefined || err.code === code)
}

const NATIVE_CODES: Record<string, SecureStorageErrorCode> = {
  ERR_FW_CANCELLED: 'cancelled',
  ERR_FW_BIOMETRY_CHANGED: 'biometry-changed',
  ERR_FW_LOCKOUT: 'lockout',
  ERR_FW_NO_PASSCODE: 'no-passcode',
  ERR_FW_NOT_AVAILABLE: 'not-available',
  ERR_FW_LOCKED: 'locked',
  ERR_FW_AUTH_FAILED: 'auth-failed',
  ERR_FW_STORAGE: 'storage',
}

/** Native module errors carry `code`; map them, wrap everything else as `storage`. */
export function fromNative(err: unknown): SecureStorageError {
  if (err instanceof SecureStorageError) return err
  const code = typeof err === 'object' && err !== null && 'code' in err ? String((err as { code: unknown }).code) : ''
  const message = err instanceof Error ? err.message : String(err)
  return new SecureStorageError(NATIVE_CODES[code] ?? 'storage', message, { cause: err })
}
