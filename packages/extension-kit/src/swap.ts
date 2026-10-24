/**
 * Swaps for the extension, the DIRECT path of Vaulty mobile's `lib/swap2.ts`:
 * the providers run in the service worker and talk to their APIs themselves.
 *
 * - {@link quoteRoutes}: dry quotes from every provider that can serve the
 *   pair, delivered progressively (`onUpdate` fires as each venue answers), with
 *   BEST / FASTEST tags and every refusal named.
 *   TODO: replace with `CrossChainRouter.getQuotes` (net-USD ranking,
 *   RouteSet). Until then this fan-out over the public `CrossChainProvider`
 *   interface ranks by output amount.
 * - {@link reviewSwapPlan}: the engine's `reviewExecution` hook — one sheet for
 *   the whole plan (approvals + source leg) BEFORE anything is signed; on
 *   approval exactly those operations are pre-approved in the {@link ReviewGate}
 *   so the reviewed account lets them through once; a decline aborts with
 *   nothing sent (`ReviewDeclined`, 4001).
 */
import type { CrossChainProvider, Quote, QuoteParams, Swap2ExecutionPlan } from '@anywalletkit/protocol-swap2-core'
import { validQuote } from '@anywalletkit/protocol-swap2-core'
import { ApprovalQueue } from './approvals.js'
import { ReviewGate, chainTxMatcher, evmCallMatcher, type GateMatcher } from './gate.js'

export interface RouteView {
  provider: string
  destAmount: string
  minDestAmount: string
  feeUsd: number
  /** On-chain pool venues take the fee inside the output; "$0.00" would mislead. */
  feeNote?: string
  etaSeconds: number
  validUntilMs: number
  tags: ('best' | 'fastest')[]
}

export interface RouteListView {
  routes: RouteView[]
  /** Providers still quoting. */
  pending: string[]
  /** Provider → why it sat out (refusal, error, timeout). */
  refusals: Record<string, string>
  /** The quotes themselves, by provider, for execution with the same numbers the user saw. */
  quotes: Record<string, Quote>
}

export interface QuoteRoutesOptions {
  onUpdate?: (view: RouteListView) => void
  /** Per-provider wall clock (default 20 s). */
  timeoutMs?: number
  signal?: AbortSignal
  now?: () => number
}

/** Dry quotes from every enabled provider that claims the route, progressively. */
export async function quoteRoutes(providers: readonly CrossChainProvider[], params: QuoteParams, options: QuoteRoutesOptions = {}): Promise<RouteListView> {
  const timeoutMs = options.timeoutMs ?? 20_000
  const from = { chain: params.sourceChain, token: params.sourceToken }
  const to = { chain: params.destChain, token: params.destToken }
  const refusals: Record<string, string> = {}
  const quotes: Record<string, Quote> = {}
  const candidates: CrossChainProvider[] = []
  for (const p of providers) {
    let enabled = false
    try { enabled = p.enabled() } catch { /* fail closed */ }
    if (!enabled) continue
    if (params.sourceChain === params.destChain && !p.supportsSameChain) { refusals[p.name] = 'does not do same-chain swaps'; continue }
    let serves = false
    try { serves = p.supportsRoute(from, to) } catch (e) { refusals[p.name] = e instanceof Error ? e.message : String(e); continue }
    if (!serves) { refusals[p.name] = 'does not serve this pair'; continue }
    candidates.push(p)
  }
  const pending = new Set(candidates.map((p) => p.name))
  const view = (): RouteListView => ({ routes: rank(Object.values(quotes)), pending: [...pending], refusals: { ...refusals }, quotes: { ...quotes } })
  const emit = () => options.onUpdate?.(view())
  emit()
  await Promise.all(
    candidates.map(async (p) => {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(new Error(`no answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)
      const onAbort = () => ctrl.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      let refusal: string | undefined
      try {
        // Race the signal too: a provider that ignores it must not hold the list open forever.
        const aborted = new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason instanceof Error ? ctrl.signal.reason : new Error(String(ctrl.signal.reason ?? 'cancelled'))), { once: true }))
        const q = await Promise.race([p.getQuote({ ...params, dry: true, onRefusal: (r) => { refusal = r } }, ctrl.signal), aborted])
        if (q && validQuote(q, { ...params, dry: true }, p.name)) quotes[p.name] = q
        else refusals[p.name] = refusal ?? (q ? 'returned an invalid quote' : 'no route for this pair right now')
      } catch (e) {
        refusals[p.name] = ctrl.signal.aborted ? String(ctrl.signal.reason instanceof Error ? ctrl.signal.reason.message : ctrl.signal.reason ?? 'cancelled') : e instanceof Error ? e.message : String(e)
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        pending.delete(p.name)
        emit()
      }
    }),
  )
  return view()
}

/** Highest output first (same destination token for every quote); FASTEST = lowest ETA among them. */
export function rank(quotes: Quote[]): RouteView[] {
  const sorted = [...quotes].sort((a, b) => (BigInt(b.destAmount) > BigInt(a.destAmount) ? 1 : BigInt(b.destAmount) < BigInt(a.destAmount) ? -1 : a.feeUsd - b.feeUsd || a.etaSeconds - b.etaSeconds))
  const fastest = sorted.length ? sorted.reduce((f, q) => (q.etaSeconds < f.etaSeconds ? q : f)) : null
  return sorted.map((q, i) => {
    const poolFee = q.providerData?.poolFee
    const feeNote = typeof poolFee === 'string' && poolFee && q.feeUsd === 0 ? (poolFee === 'pools' ? 'pool fees in price' : `pool ${poolFee} in price`) : undefined
    const tags: RouteView['tags'] = []
    if (i === 0) tags.push('best')
    if (fastest && q.provider === fastest.provider) tags.push('fastest')
    return { provider: q.provider, destAmount: q.destAmount, minDestAmount: q.minDestAmount, feeUsd: q.feeUsd, etaSeconds: q.etaSeconds, validUntilMs: q.validUntilMs, tags, ...(feeNote ? { feeNote } : {}) }
  })
}

/** Vaulty's execution floor: 50 bps under the quoted minimum rides normal drift while the user reviews, still refuses a real reprice. */
export const FLOOR_TOLERANCE_BPS = 50n
export function executionFloor(minDestAmount: bigint): bigint {
  const floor = (minDestAmount * (10_000n - FLOOR_TOLERANCE_BPS)) / 10_000n
  return floor > 0n ? floor : minDestAmount
}

// ---- the review stop ----

export interface SwapReviewMeta {
  /** Who runs the flow (the wallet's origin). */
  origin: string
  providerLabel: string
  fromSymbol: string
  fromDecimals: number
  toSymbol: string
  toDecimals: number
  fromChainName: string
  toChainName: string
  /** All of the user's addresses — recipient own/foreign. */
  own: string[]
}

/** What the swap sheet renders. Amounts are base-unit strings. */
export interface SwapApproval {
  provider: string
  providerLabel: string
  fromChain: string
  toChain: string
  fromChainName: string
  toChainName: string
  send: { symbol: string; decimals: number; amount: string }
  receive: { symbol: string; decimals: number; amount: string; min: string }
  recipient: { address: string; isOwn: boolean }
  refundAddress: string
  feeUsd: number
  etaSeconds: number
  validUntilMs: number
  approvals: { token: string; spender: string; amount: string }[]
  source:
    | { kind: 'call'; to: string; data?: string; value: string; deposit?: string }
    | { kind: 'token-transfer'; token: string; recipient: string; amount: string; memo?: string }
    | { kind: 'serialized' }
    | { kind: 'typed-order' }
  checks: { status: 'ok' | 'warn' | 'unknown'; label: string }[]
}

const APPROVE_SELECTOR = '0x095ea7b3'
const TRANSFER_SELECTOR = '0xa9059cbb'
const pad = (hexNoPrefix: string) => hexNoPrefix.toLowerCase().padStart(64, '0')
export const encodeApproveCalldata = (spender: string, amount: bigint): string => `${APPROVE_SELECTOR}${pad(spender.slice(2))}${pad(amount.toString(16))}`
const lc = (s: string) => s.toLowerCase()

/** A plain native send or ERC-20 transfer pays a provider deposit address (1Click-style). */
function depositOf(s: { to: string; data?: string }, approvals: number): string | undefined {
  if (approvals > 0) return undefined
  if (!s.data || s.data === '0x') return s.to
  if (!s.data.startsWith(TRANSFER_SELECTOR) || s.data.length < 10 + 64) return undefined
  return `0x${s.data.slice(10 + 24, 10 + 64)}`
}

export function swapApprovalPayload(plan: Swap2ExecutionPlan, meta: SwapReviewMeta): SwapApproval {
  const isOwn = meta.own.some((a) => lc(a) === lc(plan.recipient))
  const checks: SwapApproval['checks'] = [{ status: 'ok', label: `Built by the ${meta.providerLabel} module` }]
  const s = plan.source
  let source: SwapApproval['source']
  if (s.kind === 'call') {
    const deposit = depositOf(s, plan.approvals.length)
    source = { kind: 'call', to: s.to, ...(s.data ? { data: s.data } : {}), value: s.value.toString(), ...(deposit ? { deposit } : {}) }
    checks.push(deposit ? { status: 'ok', label: `Deposit address from the ${meta.providerLabel} quote` } : { status: 'ok', label: `Calls the ${meta.providerLabel} contract` })
  } else if (s.kind === 'token-transfer') {
    source = { kind: 'token-transfer', token: s.token, recipient: s.recipient, amount: s.amount.toString(), ...(s.memo ? { memo: s.memo } : {}) }
    checks.push({ status: 'ok', label: `Deposit address from the ${meta.providerLabel} quote` })
  } else if (s.kind === 'serialized') {
    source = { kind: 'serialized' }
    checks.push({ status: 'ok', label: 'Balance changes are proven before signing (SDK guard)' })
  } else {
    source = { kind: 'typed-order' }
    checks.push({ status: 'ok', label: 'Signed order — no transaction is sent from your wallet' })
  }
  for (const a of plan.approvals) checks.push(a.amount > plan.sourceAmount ? { status: 'warn', label: 'Approval is larger than this swap needs' } : { status: 'ok', label: 'Approval is exactly the amount needed' })
  if (plan.approvals.length > 1) checks.push({ status: 'ok', label: `${plan.approvals.length} approvals (reset to 0 first)` })
  checks.push(isOwn ? { status: 'ok', label: 'Funds arrive at your address' } : { status: 'warn', label: `Funds arrive at ${plan.recipient.slice(0, 6)}…${plan.recipient.slice(-4)}, not your address` })
  return {
    provider: plan.provider, providerLabel: meta.providerLabel, fromChain: plan.fromChain, toChain: plan.destChain, fromChainName: meta.fromChainName, toChainName: meta.toChainName,
    send: { symbol: meta.fromSymbol, decimals: meta.fromDecimals, amount: plan.sourceAmount.toString() },
    receive: { symbol: meta.toSymbol, decimals: meta.toDecimals, amount: plan.destAmount.toString(), min: plan.minDestAmount.toString() },
    recipient: { address: plan.recipient, isOwn }, refundAddress: plan.refundAddress, feeUsd: plan.feeUsd, etaSeconds: plan.etaSeconds, validUntilMs: plan.validUntilMs,
    approvals: plan.approvals.map((a) => ({ token: a.token, spender: a.spender, amount: a.amount.toString() })),
    source, checks,
  }
}

/** Matchers for exactly the operations the plan will perform, in the engine's order. */
export function planMatchers(plan: Swap2ExecutionPlan): GateMatcher[] {
  const m: GateMatcher[] = plan.approvals.map((a) => evmCallMatcher({ caip2: plan.fromChain, to: a.token, data: encodeApproveCalldata(a.spender, a.amount), value: 0n }))
  const s = plan.source
  if (s.kind === 'call') {
    if (plan.fromChain.startsWith('eip155:')) m.push(evmCallMatcher({ caip2: plan.fromChain, to: s.to, data: s.data, value: s.value }))
    else if (plan.fromChain.startsWith('solana:')) m.push((op) => op.kind === 'solana-tx' && op.to === s.to && op.value === s.value)
    else m.push(chainTxMatcher({ chain: plan.fromChain, to: s.to, amount: s.value, memo: s.memo }))
  } else if (s.kind === 'token-transfer') {
    if (plan.fromChain.startsWith('eip155:')) m.push(evmCallMatcher({ caip2: plan.fromChain, to: s.token, data: `${TRANSFER_SELECTOR}${pad(s.recipient.slice(2))}${pad(s.amount.toString(16))}`, value: 0n }))
    else if (plan.fromChain.startsWith('solana:')) m.push((op) => op.kind === 'solana-transfer' && op.to === s.recipient && op.amount === s.amount && (op.token ?? '') === s.token)
    else m.push(chainTxMatcher({ chain: plan.fromChain, to: s.recipient, amount: s.amount, token: s.token, memo: s.memo }))
  } else if (s.kind === 'serialized') {
    m.push((op) => op.kind === 'solana-serialized' && op.serializedTx === s.serializedTx)
  } else {
    m.push((op) => op.kind === 'evm-typed-data' && op.caip2 === plan.fromChain)
  }
  return m
}

/** The engine's `reviewExecution`: one sheet for the plan; approve → pre-approve exactly its operations; decline → nothing sent. */
export function reviewSwapPlan(approvals: ApprovalQueue, gate: ReviewGate, meta: SwapReviewMeta): (plan: Swap2ExecutionPlan) => Promise<void> {
  return async (plan) => {
    const payload = swapApprovalPayload(plan, meta)
    await approvals.request({ origin: meta.origin, chain: plan.fromChain, kind: 'swap', payload })
    gate.clear()
    gate.preApprove(planMatchers(plan), Math.max(60_000, plan.validUntilMs - Date.now() + 5 * 60_000))
  }
}
