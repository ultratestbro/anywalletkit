export type UnsafeTransactionCode =
  | 'expired'
  | 'expiration-too-far'
  | 'missing-ref-block'
  | 'owner-mismatch'
  | 'zero-address'
  | 'fee-limit'
  | 'multi-contract'
  | 'memo'

/** A transaction failed a hard check and was not signed. */
export class UnsafeTransactionError extends Error {
  readonly code: UnsafeTransactionCode
  constructor(code: UnsafeTransactionCode, message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
  }
}

/** A constant call (or balance pre-check) predicted failure; nothing was signed or broadcast. */
export class SimulationError extends Error {
  readonly reason: string
  readonly energy: number
  constructor(reason: string, energy = 0) {
    super(`Transaction simulation failed: ${reason}`)
    this.name = 'SimulationError'
    this.reason = reason
    this.energy = energy
  }
}
