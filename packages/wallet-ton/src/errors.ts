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
