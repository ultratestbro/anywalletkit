/** Bad input (seed, key, label) or a keyring rule (duplicate, unknown id). Messages are safe to show the user and never contain secrets. */
export class KeyringError extends Error {
  readonly code: KeyringErrorCode
  constructor(message: string, code: KeyringErrorCode = 'invalid-input') {
    super(message)
    this.name = 'KeyringError'
    this.code = code
  }
}

export type KeyringErrorCode = 'invalid-input' | 'duplicate' | 'not-found' | 'unsupported' | 'secret-missing'
