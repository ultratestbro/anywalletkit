/**
 * The transaction was handed to the network but no definitive answer came back (no response, a
 * timeout, a 5xx, an unreadable body): it MAY be in the mempool. Do not spend the same coins again —
 * watch `hash`, the txid computed before sending (round 3, M12).
 */
export class BroadcastUnknownError extends Error {
  /** Always true: the transaction may be on its way. */
  readonly maybeSent = true
  /** The transaction id (hex). */
  readonly hash: string
  constructor(hash: string, cause: unknown) {
    super(`Broadcast outcome unknown for ${hash}: ${cause instanceof Error ? cause.message.slice(0, 200) : String(cause).slice(0, 200)}`, { cause })
    this.name = 'BroadcastUnknownError'
    this.hash = hash
  }
}

/**
 * The fee of the transaction about to go out is above the cap in force: the account's configured
 * maximum or the call's `maxFee`, whichever is lower. Thrown before anything is broadcast or
 * returned, so a wallet can show `fee` and ask the user again.
 */
export class FeeLimitExceededError extends Error {
  readonly code = 'fee-limit-exceeded'
  /** The fee the transaction would pay, base units. */
  readonly fee: bigint
  /** The cap it is above, base units. */
  readonly limit: bigint
  constructor(fee: bigint, limit: bigint, message: string) {
    super(message)
    this.name = 'FeeLimitExceededError'
    this.fee = fee
    this.limit = limit
  }
}
