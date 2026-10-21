export type UnsafeTransactionCode =
  | 'expired'
  | 'expiration-too-far'
  | 'missing-ref-block'
  | 'owner-mismatch'
  | 'zero-address'
  | 'fee-limit'
  | 'multi-contract'
  | 'memo'
  /** `txID` is not sha256(raw_data_hex). */
  | 'txid-mismatch'
  /** The JSON `raw_data` disagrees with the bytes that would be signed. */
  | 'raw-mismatch'
  /** No `raw_data_hex`, or bytes that are not a well-formed Transaction.raw. */
  | 'raw-undecodable'
  /** Bytes a strict protobuf reader would not produce (over-long tag, non-minimal varint, repeated singular field, parameter that does not re-encode to itself): java-tron could read them differently. */
  | 'raw-noncanonical'
  /** A node-built transaction is not what was requested (type, owner, recipient, amount, contract, calldata, call value, fee limit, extra fields) — scan F7. */
  | 'build-mismatch'

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
