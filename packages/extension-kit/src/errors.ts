/** A vault or session rule was broken. Messages are safe to show the user and never contain secrets. */
export class VaultError extends Error {
  readonly code: VaultErrorCode
  constructor(message: string, code: VaultErrorCode) {
    super(message)
    this.name = 'VaultError'
    this.code = code
  }
}

export type VaultErrorCode =
  /** The password did not open the vault (or the envelope was tampered with — AES-GCM cannot tell the two apart). */
  | 'wrong-password'
  /** `create` was called while a vault already exists — an existing wallet is never overwritten. */
  | 'exists'
  /** `unlock` / `getSecret` on a storage area that holds no vault. */
  | 'missing'
  /** The stored envelope has a version or shape this build does not read. */
  | 'unsupported-envelope'
  /** The session is locked: the unlocked key is gone (auto-lock, browser exit, explicit lock). */
  | 'locked'
  /** Bad input (empty or too-short password, bad key length, bad id). */
  | 'invalid-input'
  /** The stored envelope's KDF parameters are below the floor this build accepts (edited on disk). */
  | 'weak-kdf'
