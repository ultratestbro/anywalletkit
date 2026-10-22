/**
 * Pre-approvals — the second half of Vaulty's `txGate` (mobile/lib/txGate.ts).
 * A flow that reviewed a WHOLE plan in one sheet (a swap: approvals + source
 * leg) registers one matcher per operation it is about to perform; the
 * reviewed account then lets exactly those operations through without a second
 * window, each once, within `ttlMs`. Anything else still stops at the review.
 */
export type GatedOp =
  | { kind: 'evm-tx'; caip2: string; to: string; data?: string; value: bigint }
  | { kind: 'evm-typed-data'; caip2: string }
  | { kind: 'solana-transfer'; to: string; amount: bigint; token?: string }
  | { kind: 'solana-tx'; to: string; value: bigint }
  | { kind: 'solana-serialized'; serializedTx: string }
  /** A module-built Solana transaction message (instructions), reviewed as a plan. */
  | { kind: 'solana-message' }
  /** TON / Tron / Bitcoin / NEAR send or token transfer (amount in base units; token = jetton master / TRC-20 / NEP-141 id). */
  | { kind: 'chain-tx'; chain: string; to: string; amount: bigint; token?: string | undefined; memo?: string | undefined }

export type GateMatcher = (op: GatedOp) => boolean

export class ReviewGate {
  private approved: { match: GateMatcher; until: number }[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /** Each matcher passes ONE operation, within `ttlMs` (default 10 min). */
  preApprove(matchers: GateMatcher[], ttlMs = 10 * 60_000): void {
    const until = this.now() + ttlMs
    this.approved.push(...matchers.map((match) => ({ match, until })))
  }

  /** True (and the matcher is spent) when a pre-approval covers `op`. */
  consume(op: GatedOp): boolean {
    const now = this.now()
    this.approved = this.approved.filter((a) => a.until > now)
    const i = this.approved.findIndex((a) => a.match(op))
    if (i < 0) return false
    this.approved.splice(i, 1)
    return true
  }

  get pending(): number {
    return this.approved.length
  }

  clear(): void {
    this.approved = []
  }
}

const lc = (s: string) => s.toLowerCase()

/** Matcher for an exact EVM call: same chain, `to`, calldata and value. */
export function evmCallMatcher(expected: { caip2: string; to: string; data?: string | undefined; value: bigint }): GateMatcher {
  const data = expected.data && expected.data !== '0x' ? lc(expected.data) : undefined
  return (op) =>
    op.kind === 'evm-tx' &&
    op.caip2 === expected.caip2 &&
    lc(op.to) === lc(expected.to) &&
    (op.data && op.data !== '0x' ? lc(op.data) : undefined) === data &&
    op.value === expected.value
}

/** Matcher for a non-EVM send: same chain, recipient, amount, token and memo. */
export function chainTxMatcher(expected: { chain: string; to: string; amount: bigint; token?: string | undefined; memo?: string | undefined }): GateMatcher {
  return (op) => op.kind === 'chain-tx' && op.chain === expected.chain && op.to === expected.to && op.amount === expected.amount && (op.token ?? '') === (expected.token ?? '') && (op.memo ?? '') === (expected.memo ?? '')
}
