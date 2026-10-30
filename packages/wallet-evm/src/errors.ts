import { SignerError } from '@anywalletkit/core'

/**
 * Refused before signing: the payload's chain is not the account's chain.
 * A tx for chain 1 signed by an account that detected chain 10, or typed data
 * whose domain names another chain, is the classic replay / wrong-network
 * mistake — surfaced here instead of as a reverted or stranded transaction.
 */
export class ChainMismatchError extends SignerError {
  /** The account's chain id. */
  readonly expected: number
  /** The chain id the payload names. */
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
  /** Decoded revert reason, or the node's message. */
  readonly reason: string
  /** Raw revert data, when the node returned it. */
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

/**
 * The signed transaction was handed to the node but no answer came back
 * (timeout, connection lost, gateway error): it MAY be in the mempool. Do not
 * re-sign it as new — watch `hash` (keccak of the signed raw tx, computed
 * locally) instead.
 */
export class BroadcastUnknownError extends Error {
  /** Always true: the transaction may be on its way. */
  readonly maybeSent = true
  /** Hash of the signed transaction, computed locally. Watch it instead of sending again. */
  readonly hash: `0x${string}`
  constructor(hash: `0x${string}`, cause: unknown) {
    super(`Broadcast outcome unknown for ${hash}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200)}`, { cause })
    this.name = 'BroadcastUnknownError'
    this.hash = hash
  }
}

/**
 * The node refused the transaction with "nonce too low", its hash was not found, and the nonce could
 * not be proven spent by another transaction (scan 2026-10-30 F1). The RPC that refused it already
 * holds the signed bytes: if it lied, it can still broadcast them, so nothing new is signed. Show
 * "the network didn't confirm — check activity, then retry"; the account's next send uses
 * `nextNonce` (when the node named one) or the nonce after this one.
 */
export class NonceConflictError extends BroadcastUnknownError {
  /** The nonce the signed transaction carries. */
  readonly nonce: number
  /** The next nonce the node named in its refusal, when it named one. */
  readonly nextNonce: number | undefined
  constructor(hash: `0x${string}`, nonce: number, nextNonce: number | undefined, cause: unknown) {
    super(hash, cause)
    this.name = 'NonceConflictError'
    this.message = `The network refused ${hash} (nonce ${nonce}) as "nonce too low", but did not show the nonce taken by another transaction: it may still be broadcast. Check the account's activity before retrying.`
    this.nonce = nonce
    this.nextNonce = nextNonce
  }
}

