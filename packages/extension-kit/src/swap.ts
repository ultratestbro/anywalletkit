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
import { slippageFloor, validQuote } from '@anywalletkit/protocol-swap2-core'
import { typedDataHash } from '@anywalletkit/wallet-evm'
import { ApprovalQueue } from './approvals.js'
import { ReviewGate, chainTxMatcher, evmCallMatcher, typedDataMatcher, type GateMatcher } from './gate.js'
import type { TypedData } from './signing.js'

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
  /** Why this route is not a plain pick: a flagged route is never BEST (see {@link rank}). Absent when there is nothing to say. */
  warnings?: RouteWarning[]
}

/**
 * What the wallet cannot vouch for on a route — data for the app's list and sheet, never a refusal:
 * - `min-below-slippage`: the provider's minimum sits `minGapBps` under its own quote, further than the `slippageBps`
 *   the app asked for (a backend that inflates the output and drops the minimum would otherwise win BEST);
 * - `deposit-address`: the route pays an address the provider's server assigns (a 1Click deposit address), so where the
 *   funds end up is that server's word, not calldata the wallet can check.
 */
export type RouteWarning =
  | { kind: 'min-below-slippage'; slippageBps: number; minGapBps: number }
  | { kind: 'deposit-address' }

/** The app's route policy inputs for {@link rank}. */
export interface RankOptions {
  /** The slippage the quotes were requested at (bps): a route whose minimum sits further under its output is flagged and never BEST. */
  slippageBps?: number
  /**
   * Providers whose routes pay an address their server assigns (NEAR Intents 1Click): flagged, and BEST only when no
   * route from any other provider exists. Which providers these are is the app's call.
   */
  depositAddressProviders?: readonly string[]
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
  /** See {@link RankOptions.depositAddressProviders}; the slippage comes from `params.slippageBps`. */
  depositAddressProviders?: readonly string[]
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
  const rankOptions: RankOptions = { ...(params.slippageBps !== undefined ? { slippageBps: params.slippageBps } : {}), ...(options.depositAddressProviders ? { depositAddressProviders: options.depositAddressProviders } : {}) }
  // The requested slippage is the providers' input; a quote whose minimum still lands under it is shown with a
  // warning (rank), not refused: quote-value issues are warnings, never blocks.
  const { slippageBps: _slippage, ...shapeParams } = params
  const view = (): RouteListView => ({ routes: rank(Object.values(quotes), rankOptions), pending: [...pending], refusals: { ...refusals }, quotes: { ...quotes } })
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
        if (q && validQuote(q, { ...shapeParams, dry: true }, p.name)) quotes[p.name] = q
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

/** How far `min` sits under `dest`, in whole bps (rounded up, so a gap is never understated). */
function gapBps(dest: bigint, min: bigint): number {
  if (dest <= 0n || min >= dest) return 0
  return Number((((dest - min) * 10_000n + dest - 1n) / dest).toString()) // ≤ 10 000: min ≥ 0
}

/**
 * Highest output first (same destination token for every quote); FASTEST = lowest ETA among them.
 *
 * BEST goes to the highest output among the routes without a {@link RouteWarning} that bars it: never a route whose
 * minimum is below the requested slippage, and a deposit-address route only when no other provider's route exists.
 * The BEST route is listed first; the rest keep the output order. With no route eligible there is no BEST.
 */
export function rank(quotes: Quote[], options: RankOptions = {}): RouteView[] {
  const sorted = [...quotes].sort((a, b) => (BigInt(b.destAmount) > BigInt(a.destAmount) ? 1 : BigInt(b.destAmount) < BigInt(a.destAmount) ? -1 : a.feeUsd - b.feeUsd || a.etaSeconds - b.etaSeconds))
  const fastest = sorted.length ? sorted.reduce((f, q) => (q.etaSeconds < f.etaSeconds ? q : f)) : null
  const depositProviders = new Set(options.depositAddressProviders ?? [])
  const s = options.slippageBps
  const warningsOf = (q: Quote): RouteWarning[] => {
    const w: RouteWarning[] = []
    if (s !== undefined && Number.isInteger(s) && s >= 0 && s < 10_000) {
      const dest = BigInt(q.destAmount)
      const min = BigInt(q.minDestAmount)
      if (min < slippageFloor(dest, s)) w.push({ kind: 'min-below-slippage', slippageBps: s, minGapBps: gapBps(dest, min) })
    }
    if (depositProviders.has(q.provider)) w.push({ kind: 'deposit-address' })
    return w
  }
  const warned = new Map(sorted.map((q) => [q, warningsOf(q)] as const))
  const verifiableExists = sorted.some((q) => !depositProviders.has(q.provider))
  const best = sorted.find((q) => {
    const w = warned.get(q)!
    return !w.some((x) => x.kind === 'min-below-slippage') && !(w.some((x) => x.kind === 'deposit-address') && verifiableExists)
  })
  const ordered = best ? [best, ...sorted.filter((q) => q !== best)] : sorted
  return ordered.map((q) => {
    const poolFee = q.providerData?.poolFee
    const feeNote = typeof poolFee === 'string' && poolFee && q.feeUsd === 0 ? (poolFee === 'pools' ? 'pool fees in price' : `pool ${poolFee} in price`) : undefined
    const tags: RouteView['tags'] = []
    if (q === best) tags.push('best')
    if (fastest && q.provider === fastest.provider) tags.push('fastest')
    const warnings = warned.get(q)!
    return { provider: q.provider, destAmount: q.destAmount, minDestAmount: q.minDestAmount, feeUsd: q.feeUsd, etaSeconds: q.etaSeconds, validUntilMs: q.validUntilMs, tags, ...(feeNote ? { feeNote } : {}), ...(warnings.length ? { warnings } : {}) }
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
  /** The account that signs the plan: the gate passes the plan's operations for this account only. */
  account: string
  providerLabel: string
  fromSymbol: string
  fromDecimals: number
  toSymbol: string
  toDecimals: number
  fromChainName: string
  toChainName: string
  /** All of the user's addresses — recipient own/foreign. */
  own: string[]
  /** The slippage the swap was quoted at (bps): a plan minimum further under its output is warned on the sheet (never refused). */
  slippageBps?: number
  /**
   * The route pays an address the provider's server assigned (NEAR Intents 1Click deposit address): the sheet warns,
   * and the recipient check does not pass on `plan.recipient` alone — the transaction does not carry it.
   */
  depositAddressAssignedByProvider?: boolean
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
    /** The EIP-712 order the account signs (gasless routes): `typedData` to render, `text` pretty JSON. */
    | { kind: 'typed-order'; typedData: TypedData; text: string }
  checks: { status: 'ok' | 'warn' | 'unknown'; label: string }[]
  /** With `meta.slippageBps`: how far the minimum sits under the output, and whether that is more than the slippage. */
  slippage?: { bps: number; minGapBps: number; below: boolean }
  /** With `meta.depositAddressAssignedByProvider`: the funds go to an address the provider's server named. */
  depositAssignedByProvider?: true
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

/** bps as a short percentage: 50 → "0.5%", 1000 → "10%", 125 → "1.25%". */
const pct = (bps: number): string => `${Number((bps / 100).toFixed(2))}%`

export function swapApprovalPayload(plan: Swap2ExecutionPlan, meta: SwapReviewMeta): SwapApproval {
  const isOwn = meta.own.some((a) => lc(a) === lc(plan.recipient))
  const assigned = meta.depositAddressAssignedByProvider === true
  const checks: SwapApproval['checks'] = [{ status: 'ok', label: `Built by the ${meta.providerLabel} module` }]
  const depositCheck: SwapApproval['checks'][number] = assigned
    ? { status: 'warn', label: `Deposit address assigned by the ${meta.providerLabel} server — funds go to an address the wallet cannot verify` }
    : { status: 'ok', label: `Deposit address from the ${meta.providerLabel} quote` }
  const s = plan.source
  let source: SwapApproval['source']
  if (s.kind === 'call') {
    const deposit = depositOf(s, plan.approvals.length)
    source = { kind: 'call', to: s.to, ...(s.data ? { data: s.data } : {}), value: s.value.toString(), ...(deposit ? { deposit } : {}) }
    checks.push(deposit || assigned ? depositCheck : { status: 'ok', label: `Calls the ${meta.providerLabel} contract` })
  } else if (s.kind === 'token-transfer') {
    source = { kind: 'token-transfer', token: s.token, recipient: s.recipient, amount: s.amount.toString(), ...(s.memo ? { memo: s.memo } : {}) }
    checks.push(depositCheck)
  } else if (s.kind === 'serialized') {
    source = { kind: 'serialized' }
    checks.push({ status: 'ok', label: 'Balance changes are proven before signing (SDK guard)' })
  } else {
    const typedData = parseTypedOrder(s.typedData)
    source = { kind: 'typed-order', typedData, text: JSON.stringify(typedData, null, 2) }
    checks.push({ status: 'ok', label: 'Signed order — no transaction is sent from your wallet' })
  }
  for (const a of plan.approvals) checks.push(a.amount > plan.sourceAmount ? { status: 'warn', label: 'Approval is larger than this swap needs' } : { status: 'ok', label: 'Approval is exactly the amount needed' })
  if (plan.approvals.length > 1) checks.push({ status: 'ok', label: `${plan.approvals.length} approvals (reset to 0 first)` })
  // A deposit-address leg does not carry the recipient: "your address" is only the provider server's promise.
  checks.push(!isOwn
    ? { status: 'warn', label: `Funds arrive at ${plan.recipient.slice(0, 6)}…${plan.recipient.slice(-4)}, not your address` }
    : assigned
      ? { status: 'unknown', label: `Delivery to your address is the ${meta.providerLabel} server’s promise — this transaction does not enforce it` }
      : { status: 'ok', label: 'Funds arrive at your address' })
  let slippage: SwapApproval['slippage']
  const sb = meta.slippageBps
  if (sb !== undefined && Number.isInteger(sb) && sb >= 0 && sb < 10_000) {
    const below = plan.minDestAmount < slippageFloor(plan.destAmount, sb)
    slippage = { bps: sb, minGapBps: gapBps(plan.destAmount, plan.minDestAmount), below }
    checks.push(below
      ? { status: 'warn', label: `Minimum is ${pct(slippage.minGapBps)} under the quote — more than your ${pct(sb)} slippage` }
      : { status: 'ok', label: `Minimum within your ${pct(sb)} slippage` })
  }
  return {
    provider: plan.provider, providerLabel: meta.providerLabel, fromChain: plan.fromChain, toChain: plan.destChain, fromChainName: meta.fromChainName, toChainName: meta.toChainName,
    send: { symbol: meta.fromSymbol, decimals: meta.fromDecimals, amount: plan.sourceAmount.toString() },
    receive: { symbol: meta.toSymbol, decimals: meta.toDecimals, amount: plan.destAmount.toString(), min: plan.minDestAmount.toString() },
    recipient: { address: plan.recipient, isOwn }, refundAddress: plan.refundAddress, feeUsd: plan.feeUsd, etaSeconds: plan.etaSeconds, validUntilMs: plan.validUntilMs,
    approvals: plan.approvals.map((a) => ({ token: a.token, spender: a.spender, amount: a.amount.toString() })),
    source, checks,
    ...(slippage ? { slippage } : {}),
    ...(assigned ? { depositAssignedByProvider: true as const } : {}),
  }
}

function parseTypedOrder(json: string): TypedData {
  const t = JSON.parse(json) as TypedData
  if (!t || typeof t !== 'object' || !t.domain || typeof t.domain !== 'object' || !t.types || typeof t.types !== 'object' || !t.message || typeof t.message !== 'object') throw new Error('The swap order is not EIP-712 typed data.')
  return t
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
    // The order itself, by the EIP-712 digest the account will sign (the engine's domain / type clean-up does not change it).
    m.push(typedDataMatcher({ caip2: plan.fromChain, typedDataHash: typedDataHash(parseTypedOrder(s.typedData) as Parameters<typeof typedDataHash>[0]) }))
  }
  return m
}

/** The engine's `reviewExecution`: one sheet for the plan; approve → pre-approve exactly its operations; decline → nothing sent. */
export function reviewSwapPlan(approvals: ApprovalQueue, gate: ReviewGate, meta: SwapReviewMeta): (plan: Swap2ExecutionPlan) => Promise<void> {
  if (typeof meta.account !== 'string' || !meta.account) throw new TypeError('reviewSwapPlan needs meta.account: the gate passes the plan for that account only.')
  return async (plan) => {
    const matchers = planMatchers(plan) // a plan that cannot be matched is refused before the sheet
    const payload = swapApprovalPayload(plan, meta)
    await approvals.request({ origin: meta.origin, chain: plan.fromChain, kind: 'swap', payload })
    gate.clear()
    gate.preApprove(matchers, Math.max(60_000, plan.validUntilMs - Date.now() + 5 * 60_000), meta.account)
  }
}
