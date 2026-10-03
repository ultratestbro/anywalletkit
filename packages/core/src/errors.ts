/** Thrown by protocol base classes for methods a module did not implement. */
export class NotImplementedError extends Error {
  constructor(methodName: string) {
    super(`Method '${methodName}' must be implemented.`)
    this.name = 'NotImplementedError'
  }
}

/** A signer could not produce a signature (locked, disposed, wrong curve…). */
export class SignerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerError'
  }
}

/** A network call failed. `provider` names the endpoint so failover can skip it. */
export class NetworkError extends Error {
  readonly provider: string | undefined
  constructor(message: string, options: { provider?: string; cause?: unknown } = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'NetworkError'
    this.provider = options.provider
  }
}

/** The account cannot cover amount + fee. Both in base units. */
export class InsufficientFundsError extends Error {
  readonly required: bigint
  readonly available: bigint
  constructor(required: bigint, available: bigint, token = 'native') {
    super(`Insufficient ${token}: need ${required}, have ${available}`)
    this.name = 'InsufficientFundsError'
    this.required = required
    this.available = available
  }
}

/** An external signer (hardware, Safe, MPC, a human) declined to sign. */
export class UserRejectedError extends Error {
  constructor(message = 'The signer rejected the request.') {
    super(message)
    this.name = 'UserRejectedError'
  }
}

/** A write method was called on a read-only account. */
export class ReadOnlyAccountError extends Error {
  constructor(methodName: string) {
    super(`The '${methodName}' method requires an account with a signer; this account is read-only.`)
    this.name = 'ReadOnlyAccountError'
  }
}
