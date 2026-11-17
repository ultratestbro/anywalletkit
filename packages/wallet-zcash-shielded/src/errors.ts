/** A method of the prototype that has a signature but no implementation yet (SDK-229 M1 scope). */
export class NotImplementedError extends Error {
  readonly code = 'not-implemented'
  constructor(method: string) {
    super(`${method} is not implemented in the shielded Zcash prototype yet.`)
    this.name = 'NotImplementedError'
  }
}

/** What the SDK handed out does not hold up: a unified address without the expected receivers, mismatched receivers. */
export class AddressCheckError extends Error {
  readonly code = 'address-check'
  constructor(message: string) {
    super(message)
    this.name = 'AddressCheckError'
  }
}

/** The SDK reported an error while syncing (level `critical` stops the synchronizer). */
export class SyncError extends Error {
  readonly code = 'sync'
  readonly level: 'critical' | 'error'
  constructor(level: 'critical' | 'error', message: string) {
    super(message)
    this.name = 'SyncError'
    this.level = level
  }
}
