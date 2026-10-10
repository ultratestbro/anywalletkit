export type UnsafeTransactionCode =
  | 'signer-mismatch'
  | 'public-key-mismatch'
  | 'dangerous-action'
  | 'invalid-account'
  | 'no-actions'
  | 'gas-limit'
  | 'fee-limit'
  | 'missing-block-hash'
  | 'missing-nonce'
  | 'unknown-action'
  | 'insufficient-balance'
  | 'implicit-account-min-deposit'
  | 'no-access-key'

/** A transaction failed a hard check and was not signed. */
export class UnsafeTransactionError extends Error {
  readonly code: UnsafeTransactionCode
  constructor(code: UnsafeTransactionCode, message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
  }
}

/** The preflight (balances, account, access key, token registration) predicted failure; nothing was signed. */
export class SimulationError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`Transaction preflight failed: ${reason}`)
    this.name = 'SimulationError'
    this.reason = reason
  }
}

/** The RPC answered with an `error` object. */
export class NearRpcError extends Error {
  readonly method: string
  readonly errorName: string | undefined
  override readonly cause: unknown
  constructor(method: string, error: { name?: string; message?: string; cause?: { name?: string; info?: unknown }; data?: unknown; code?: number }) {
    const causeName = error.cause?.name
    super(`${method}: ${error.name ?? 'error'}${causeName ? ` / ${causeName}` : ''}${error.message ? ` — ${error.message}` : ''}`)
    this.name = 'NearRpcError'
    this.method = method
    this.errorName = causeName ?? error.name
    this.cause = error
  }
}
