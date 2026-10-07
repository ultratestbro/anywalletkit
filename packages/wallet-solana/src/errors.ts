import { SignerError } from '@forgewallet/core'

/** Refused before signing: the transaction would almost certainly destroy funds or sign on someone else's behalf. */
export class UnsafeTransactionError extends SignerError {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
  }
}

/** A provider-built transaction needs signatures this wallet cannot produce; signing it would strand a half-signed tx. */
export class MissingSignersError extends SignerError {
  readonly missing: readonly string[]
  constructor(missing: readonly string[]) {
    super(`The transaction still needs signatures from ${missing.join(', ')}; this wallet can only sign for its own address.`)
    this.name = 'MissingSignersError'
    this.missing = missing
  }
}

/** `simulateTransaction` failed; nothing was signed or sent. `logs` are the program logs the RPC returned. */
export class SimulationError extends Error {
  readonly reason: string
  readonly logs: readonly string[]
  constructor(reason: string, logs: readonly string[] = []) {
    super(`Transaction simulation failed: ${reason}`)
    this.name = 'SimulationError'
    this.reason = reason
    this.logs = logs
  }
}
