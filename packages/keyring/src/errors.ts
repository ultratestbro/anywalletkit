/** Bad input (seed, key, label) or a keyring rule (duplicate, unknown id). Messages are safe to show the user and never contain secrets. */
export class KeyringError extends Error {
  /** Machine-readable reason; see {@link KeyringErrorCode}. */
  readonly code: KeyringErrorCode
  constructor(message: string, code: KeyringErrorCode = 'invalid-input') {
    super(message)
    this.name = 'KeyringError'
    this.code = code
  }
}

/**
 * Why a keyring call failed: bad input, a source that already exists, an unknown id, something the
 * source cannot do (for example exporting a TON-native phrase as a key), or a secret missing from
 * `SecretStorage`.
 */
export type KeyringErrorCode = 'invalid-input' | 'duplicate' | 'not-found' | 'unsupported' | 'secret-missing'
