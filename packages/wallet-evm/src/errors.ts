import { SignerError } from '@forgewallet/core'

/**
 * Refused before signing: the payload's chain is not the account's chain.
 * A tx for chain 1 signed by an account that detected chain 10, or typed data
 * whose domain names another chain, is the classic replay / wrong-network
 * mistake — surfaced here instead of as a reverted or stranded transaction.
 */
export class ChainMismatchError extends SignerError {
  readonly expected: number
  readonly actual: number
  constructor(expected: number, actual: number, what = 'transaction') {
    super(`The ${what} targets chain ${actual} but this account is on chain ${expected}.`)
    this.name = 'ChainMismatchError'
    this.expected = expected
    this.actual = actual
  }
}

/** Refused before signing: the transaction would almost certainly destroy funds (e.g. value to the zero address). */
export class UnsafeTransactionError extends SignerError {
  constructor(message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
  }
}

/** `eth_call` of the transaction reverted; nothing was signed or sent. `reason` is decoded when possible. */
export class SimulationError extends Error {
  readonly reason: string
  readonly data: `0x${string}` | undefined
  constructor(reason: string, data?: `0x${string}`) {
    super(`Transaction simulation failed: ${reason}`)
    this.name = 'SimulationError'
    this.reason = reason
    this.data = data
  }
}

/** The token does not implement EIP-2612 `permit` (or its domain could not be reproduced). */
export class PermitUnsupportedError extends Error {
  constructor(token: string, reason: string) {
    super(`${token} does not support EIP-2612 permit: ${reason}`)
    this.name = 'PermitUnsupportedError'
  }
}
