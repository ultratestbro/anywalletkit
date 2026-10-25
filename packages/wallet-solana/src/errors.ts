import { SignerError } from '@anywalletkit/core'

/** Refused before signing: the transaction would almost certainly destroy funds or sign on someone else's behalf. */
export class UnsafeTransactionError extends SignerError {
  /** Machine-readable reason (e.g. `unknown-program`, `token-drain`, `slippage`); undefined for the generic refusals. */
  readonly code: string | undefined
  /** What tripped the check (program ids, account addresses…). */
  readonly details: readonly string[]
  constructor(message: string, code?: string, details: readonly string[] = []) {
    super(message)
    this.name = 'UnsafeTransactionError'
    this.code = code
    this.details = details
  }
}

/** A provider-built transaction needs signatures this wallet cannot produce; signing it would strand a half-signed tx. */
export class MissingSignersError extends SignerError {
  /** Signer addresses the transaction still needs. */
  readonly missing: readonly string[]
  constructor(missing: readonly string[]) {
    super(`The transaction still needs signatures from ${missing.join(', ')}; this wallet can only sign for its own address.`)
    this.name = 'MissingSignersError'
    this.missing = missing
  }
}

/** `simulateTransaction` failed; nothing was signed or sent. `logs` are the program logs the RPC returned. */
export class SimulationError extends Error {
  /** The simulation error. */
  readonly reason: string
  /** Program logs from the simulation. */
  readonly logs: readonly string[]
  constructor(reason: string, logs: readonly string[] = []) {
    super(`Transaction simulation failed: ${reason}`)
    this.name = 'SimulationError'
    this.reason = reason
    this.logs = logs
  }
}

/**
 * The signed transaction was handed to the RPC but no definitive answer came back (no response, a
 * timeout, a gateway error): it MAY be on chain. Do not plan and sign it again (a new blockhash is a
 * second transaction that also lands) — watch `hash`, the signature computed locally, until the
 * blockhash expires.
 */
export class BroadcastUnknownError extends Error {
  /** Always true: the transaction may be on its way. */
  readonly maybeSent = true
  /** Base58 transaction signature (the fee payer's), the id to watch. */
  readonly hash: string
  constructor(hash: string, cause: unknown) {
    super(`Broadcast outcome unknown for ${hash}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200)}`, { cause })
    this.name = 'BroadcastUnknownError'
    this.hash = hash
  }
}
