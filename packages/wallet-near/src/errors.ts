import { SignerError } from '@anywalletkit/core'

/** Why a transaction was refused before signing. */
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
  | 'storage-deposit'
  | 'non-canonical'
  | 'invalid-method'

/** A transaction failed a hard check and was not signed. */
export class UnsafeTransactionError extends Error {
  readonly code: UnsafeTransactionCode
  constructor(code: UnsafeTransactionCode, message: string) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
  }
}

/**
 * `sign()` refused a 32-byte message: NEAR signs a transaction (and a delegate action, and a NEP-413
 * message) as ed25519 over a 32-byte sha256, so a signature over 32 raw bytes may be a valid
 * transaction signature — an AddKey that hands the account over. Off-chain messages go through
 * `signNep413`; transactions through `signTransaction` / `sendTransaction`, where they are reviewed.
 */
export class MessageIsTransactionError extends SignerError {
  readonly code = 'message-is-transaction'
  constructor() {
    super('This message has the shape of a transaction (a 32-byte NEAR hash, or bytes naming this key as a Solana signer) and is not signed; use signNep413 for off-chain messages, or signTransaction so it can be reviewed.')
    this.name = 'MessageIsTransactionError'
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

/**
 * The signed transaction was handed to the RPC but no definitive answer came back (no response, or
 * a node timeout): it MAY be on chain. Do not sign it again (a new nonce would pay twice) — watch
 * `hash`, computed locally.
 */
export class BroadcastUnknownError extends Error {
  /** Always true: the transaction may be on its way. */
  readonly maybeSent = true
  /** Base58 hash of the signed transaction. */
  readonly hash: string
  constructor(hash: string, cause: unknown) {
    super(`Broadcast outcome unknown for ${hash}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200)}`, { cause })
    this.name = 'BroadcastUnknownError'
    this.hash = hash
  }
}
