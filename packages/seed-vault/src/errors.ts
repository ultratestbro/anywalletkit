/**
 * - `wrong-password` / `wrong-key` — the protector did not open (or the file was altered there).
 * - `corrupted` — the protector opened but the payload or its metadata fails authentication.
 * - `unsupported` — a format, version or algorithm this build does not read.
 * - `weak-password` — refused when sealing; see MIN_PASSWORD_LENGTH.
 * - `invalid` — malformed input (decode, a missing protector, out-of-bounds parameters).
 */
export type BackupErrorCode = 'wrong-password' | 'wrong-key' | 'corrupted' | 'unsupported' | 'weak-password' | 'invalid'

export class BackupError extends Error {
  override readonly name = 'BackupError'
  constructor(
    readonly code: BackupErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function isBackupError(err: unknown, code?: BackupErrorCode): err is BackupError {
  return err instanceof BackupError && (code === undefined || err.code === code)
}
