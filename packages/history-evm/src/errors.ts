/** No explorer could serve the request for this chain: every configured backend failed or none applies. */
export class HistoryUnavailableError extends Error {
  readonly chain: string
  readonly reason: string
  /** One line per backend that was tried, in order. */
  readonly attempts: readonly string[]
  constructor(chain: string, reason: string, attempts: readonly string[] = []) {
    super(`History unavailable for ${chain}: ${reason}`)
    this.name = 'HistoryUnavailableError'
    this.chain = chain
    this.reason = reason
    this.attempts = attempts
  }
}

/** Internal: how one backend call failed, so the source can decide between retry and fallback. */
export type ExplorerFailureKind = 'rate-limit' | 'unavailable' | 'http' | 'network'

/**
 * One explorer backend failed: rate limit, bad key, unsupported chain, malformed answer or network
 * error. The source tries the next backend.
 */
export class ExplorerError extends Error {
  /** What went wrong. */
  readonly kind: ExplorerFailureKind
  /** Backend that failed (`etherscan`, `blockscout`, `alchemy`…). */
  readonly backend: string
  constructor(backend: string, kind: ExplorerFailureKind, message: string) {
    super(`${backend}: ${message}`)
    this.name = 'ExplorerError'
    this.kind = kind
    this.backend = backend
  }
}
