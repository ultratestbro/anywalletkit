import { SignerError } from '@anywalletkit/core'

/**
 * Refused before signing: the message would almost certainly misbehave or
 * strand funds (zero value, wrong network flag, exotic workchain, a
 * `valid_until` further away than the wallet contract tolerates…).
 */
export class UnsafeTransactionError extends SignerError {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
  }
}

/**
 * `sign()` refused a 32-byte message: the wallet contract checks a transfer's signature over the
 * 32-byte hash of its signing cell, so a signature over 32 raw bytes may authorise one. TON Connect
 * proofs and signData go through `signTonProof` / `signTonConnectData`; transactions through
 * `signTransaction` / `sendTransaction`, where they are reviewed.
 */
export class MessageIsTransactionError extends SignerError {
  readonly code = 'message-is-transaction'
  constructor() {
    super('A 32-byte message has the shape of a TON transaction hash and is not signed; use signTonProof / signTonConnectData for TON Connect, or signTransaction so it can be reviewed.')
    this.name = 'MessageIsTransactionError'
  }
}

/** Emulation of the external message failed (non-zero compute exit, aborted, action phase failed); nothing was signed or sent. */
export class SimulationError extends Error {
  readonly exitCode: number | undefined
  readonly aborted: boolean
  constructor(reason: string, details: { exitCode?: number; aborted?: boolean } = {}) {
    super(`Transaction simulation failed: ${reason}`)
    this.name = 'SimulationError'
    this.exitCode = details.exitCode
    this.aborted = details.aborted ?? false
  }
}
