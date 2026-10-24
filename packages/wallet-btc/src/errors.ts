export { InsufficientFundsError, NetworkError, SignerError } from '@forgewallet/core'

export type UnsafeTransactionCode =
  /** Fee rate above `maxFeeRate`. */
  | 'fee-rate-too-high'
  /** An output that is neither the requested recipient/amount nor our change. */
  | 'unexpected-output'
  /** The recipient output is missing or carries a different amount. */
  | 'recipient-mismatch'
  /** A change output pays an address that is not ours. */
  | 'change-not-ours'
  /** A coin the indexer reported does not match its previous transaction (txid, amount or script). */
  | 'prevout-mismatch'

/** A transaction failed a hard safety check and was not signed / broadcast. */
export class UnsafeTransactionError extends Error {
  readonly code: UnsafeTransactionCode
  constructor(code: UnsafeTransactionCode, message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
  }
}

/** Coin selection would need more inputs than `maxInputs` allows. */
export class TooManyInputsError extends Error {
  readonly maxInputs: number
  constructor(maxInputs: number) {
    super(`The spend needs more than ${maxInputs} inputs; consolidate the UTXOs first or raise maxInputs.`)
    this.name = 'TooManyInputsError'
    this.maxInputs = maxInputs
  }
}

/** BIP-137 message signatures only exist for p2pkh/p2wpkh keys; taproot accounts have none (BIP-322 is not implemented). */
export class UnsupportedAddressTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedAddressTypeError'
  }
}
