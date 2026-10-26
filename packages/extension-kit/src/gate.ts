/**
 * Pre-approvals — the second half of Vaulty's `txGate` (mobile/lib/txGate.ts).
 * A flow that reviewed a WHOLE plan in one sheet (a swap: approvals + source
 * leg) registers one matcher per operation it is about to perform; the
 * reviewed account then lets exactly those operations through without a second
 * window, each once, within `ttlMs`, and only for the account that reviewed the
 * plan. Anything else still stops at the review.
 */
export type GatedOp = (
  | { kind: 'evm-tx'; caip2: string; to: string; data?: string; value: bigint }
  /** EIP-712 data about to be signed: `typedDataHash` is `typedDataHash(typed)` from `@anywalletkit/wallet-evm` — the digest the account signs. */
  | { kind: 'evm-typed-data'; caip2: string; typedDataHash: string }
  | { kind: 'solana-transfer'; to: string; amount: bigint; token?: string }
  | { kind: 'solana-tx'; to: string; value: bigint }
  | { kind: 'solana-serialized'; serializedTx: string }
  /** A module-built Solana transaction message (instructions), reviewed as a plan. */
  | { kind: 'solana-message' }
  /** TON / Tron / Bitcoin / NEAR send or token transfer (amount in base units; token = jetton master / TRC-20 / NEP-141 id). */
  | { kind: 'chain-tx'; chain: string; to: string; amount: bigint; token?: string | undefined; memo?: string | undefined }
) & {
  /** The account about to sign or send. A pre-approval bound to an account passes only ops that name it. */
  account?: string | undefined
}

export type GateMatcher = (op: GatedOp) => boolean

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/
/** Same account: EVM addresses in any case, anything else exactly. */
const sameAccount = (a: string, b: string): boolean => a === b || (HEX_ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase())

export class ReviewGate {
  private approved: { match: GateMatcher; until: number; account?: string }[] = []

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Each matcher passes ONE operation, within `ttlMs` (default 10 min). With `account`, only an op
   * whose `account` is that account (an op without one does not pass). `reviewSwapPlan` and
   * `reviewEarnPlan` always bind.
   */
  preApprove(matchers: GateMatcher[], ttlMs = 10 * 60_000, account?: string): void {
    const until = this.now() + ttlMs
    this.approved.push(...matchers.map((match) => ({ match, until, ...(account ? { account } : {}) })))
  }

  /** True (and the matcher is spent) when a pre-approval covers `op`. */
  consume(op: GatedOp): boolean {
    const now = this.now()
    this.approved = this.approved.filter((a) => a.until > now)
    const i = this.approved.findIndex((a) => (a.account === undefined || (op.account !== undefined && sameAccount(a.account, op.account))) && a.match(op))
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

/** Matcher for one EIP-712 payload on one chain, by the digest the account signs (`typedDataHash` from `@anywalletkit/wallet-evm`). */
export function typedDataMatcher(expected: { caip2: string; typedDataHash: string }): GateMatcher {
  const hash = lc(expected.typedDataHash)
  return (op) => op.kind === 'evm-typed-data' && op.caip2 === expected.caip2 && lc(op.typedDataHash) === hash
}

/** Matcher for a non-EVM send: same chain, recipient, amount, token and memo. */
export function chainTxMatcher(expected: { chain: string; to: string; amount: bigint; token?: string | undefined; memo?: string | undefined }): GateMatcher {
  return (op) => op.kind === 'chain-tx' && op.chain === expected.chain && op.to === expected.to && op.amount === expected.amount && (op.token ?? '') === (expected.token ?? '') && (op.memo ?? '') === (expected.memo ?? '')
}
