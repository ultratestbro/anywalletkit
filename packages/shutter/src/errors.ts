/** Base class: everything this package throws on purpose. */
export class ShutterError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
  }
}

/** Bytes that are not what the scheme needs (a bad point, a ciphertext that does not open, padding). */
export class ShutterCryptoError extends ShutterError {}

/**
 * The Shutter API answered with an error or with something this package refuses to trust (an identity that is not
 * derived from the prefix and registrant, a decryption key that fails the pairing check). `status` is the HTTP status
 * when there was one; `rateLimited` is true for 429.
 */
export class ShutterApiError extends ShutterError {
  readonly status: number | undefined
  constructor(message: string, options: { status?: number | undefined; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.status = options.status
  }
  get rateLimited(): boolean { return this.status === 429 }
}

/** The decryption key is not released yet (the reveal time has not come, or the keypers have not caught up). */
export class ShutterNotYetRevealedError extends ShutterError {
  readonly revealAt: number | undefined
  constructor(message: string, revealAt?: number) {
    super(message)
    this.revealAt = revealAt
  }
}
