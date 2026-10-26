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
