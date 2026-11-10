/**
 * The approval queue — Vaulty's `txGate` (mobile/lib/txGate.ts) for an
 * extension. A dApp request that needs the user waits here; ONE approval window
 * is open at a time (`chrome.windows.create({ type: 'popup' })`), the next
 * request opens when the current one is answered. The window losing focus
 * changes nothing: the request stays pending. Closing the window, or declining,
 * rejects with {@link ReviewDeclined} — EIP-1193 4001, "nothing was signed".
 *
 * The queue lives in the service worker's memory: an open approval window keeps
 * the worker alive, and if the worker is nevertheless restarted the pending
 * promises die with it — the page gets no answer and retries, which is the
 * failure mode MetaMask has too.
 *
 * Limits keep a page from burying one real request under decoys (SDK-142 M3,
 * audit E17): at most `maxPendingPerOrigin` requests wait per origin, at most
 * `maxPendingPerSite` per registrable domain (subdomains share them), at most
 * `maxPendingTotal` in the whole queue (-32005 for each), a second `connect`
 * while one is pending is refused outright (-32002), and each site may open only
 * so many sheets per minute (`openRate`: a token bucket; running dry starts a
 * cooldown that doubles on every repeat). Origins the wallet names `exempt` (its
 * own pages) skip every limit. `declineOrigin` / `declineSite` drop one origin's
 * or one site's backlog (the page closed; "decline all from this site").
 *
 * A follow-up (`request(…, { followUp: true })`) is another sheet for a request
 * the user has just approved — the fee changed before signing. Each approval pays
 * for one follow-up of the same origin, kind and chain: that one skips the limits
 * above and is shown ahead of the requests already waiting. A refused origin
 * stays refused.
 *
 * An origin can carry a transport note (`via`, set by the WalletConnect bridge):
 * the sheet then says the request came over WalletConnect, what the dApp claims
 * to be and what WalletConnect Verify says about that claim — the claim itself is
 * never used as the permission key.
 */
import { RELAY_ERRORS } from './relay.js'
import { TokenBucket, siteOf as defaultSiteOf } from './site.js'

export class ReviewDeclined extends Error {
  readonly code = RELAY_ERRORS.userRejected
  constructor(message = 'You declined — nothing was signed.') {
    super(message)
    this.name = 'ReviewDeclined'
  }
}

export type ApprovalKind = 'connect' | 'switch-chain' | 'add-chain' | 'sign-message' | 'sign-typed-data' | 'send-transaction' | 'solana-send' | 'swap' | 'earn' | 'chain-send' | 'tron-sign' | 'btc-sign' | 'near-sign' | 'near-signin' | 'wc-session'

/** How a request reached the wallet when it did not come through a content script. */
export interface OriginVia {
  transport: 'walletconnect'
  /** What the dApp declared about itself (self-reported, unverified unless `verify` says so). */
  url: string
  name: string
  /** WalletConnect Verify: VALID = the relay saw the request come from `url`'s origin; INVALID = it came from somewhere else; UNKNOWN = not attested. */
  verify: 'VALID' | 'INVALID' | 'UNKNOWN'
  scam?: boolean
}

/** The queue refused to enqueue (per-origin limits); carries an EIP-1474 code the page understands. */
export class QueueLimitError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'QueueLimitError'
  }
}

/** The origin is refused before any window opens (the shipped phishing list); EIP-1193 4100. */
export class OriginRefused extends Error {
  readonly code = RELAY_ERRORS.unauthorized
  constructor(message: string) {
    super(message)
    this.name = 'OriginRefused'
  }
}

export const APPROVALS_MAX_PENDING_PER_ORIGIN = 3
/** Requests one site (registrable domain: every subdomain counts) may have waiting. */
export const APPROVALS_MAX_PENDING_PER_SITE = 5
/** Requests the whole queue holds (exempt origins not counted). */
export const APPROVALS_MAX_PENDING_TOTAL = 20

/** How fast one site may open sheets: a token bucket per site; running dry refuses for a cooldown that doubles on every repeat. */
export interface ApprovalRateOptions {
  /** Sheets a site may open at once. Default 10. */
  burst?: number
  /** Sheets per second a site earns back. Default 1/6 (10 a minute). */
  refillPerSecond?: number
  /** First cooldown after the bucket ran dry. Default 30 s. */
  backoffMs?: number
  /** Longest cooldown; also how long a site must stay quiet for its strikes to reset. Default 10 min. */
  maxBackoffMs?: number
}

export interface ApprovalRequest<P = unknown> {
  id: string
  origin: string
  chain: string
  kind: ApprovalKind
  /** What the window shows; shape per kind, public data only. */
  payload: P
  createdAt: number
  /** Phishing / lookalike / punycode notes about the origin, from the queue's `annotate` hook. */
  originWarnings?: string[]
  /** Set when the origin is a transport pseudo-origin (`wc:<topic>`): what the sheet should say about where this came from. */
  via?: OriginVia
}

export interface ApprovalQueueOptions {
  /** Called for every request's origin; the lines are shown on the sheet (e.g. the shipped phishing list's verdict). */
  annotate?: (origin: string) => string[]
  /**
   * Called for every request's origin before anything is queued: a reason refuses the request with
   * {@link OriginRefused} (4100) and no window opens. Wire `PhishingDetector.refusal` here — a
   * warning on the sheet is one click away from a signature.
   */
  refuse?: (origin: string) => string | null | undefined
  /** Requests one origin may have waiting (current + queued). Default {@link APPROVALS_MAX_PENDING_PER_ORIGIN}. */
  maxPendingPerOrigin?: number
  /** Requests one site may have waiting. Default {@link APPROVALS_MAX_PENDING_PER_SITE}. */
  maxPendingPerSite?: number
  /** Requests the queue holds in all. Default {@link APPROVALS_MAX_PENDING_TOTAL}. */
  maxPendingTotal?: number
  /** Origin → site for the per-site limits. Default {@link defaultSiteOf siteOf} (conservative eTLD+1; pass a Public Suffix List based one if you ship it). */
  siteOf?: (origin: string) => string
  /** Origins that skip every limit (the wallet's own pages: Send, swaps). They still queue behind other requests. */
  exempt?: (origin: string) => boolean
  /** Sheet-opening rate per site; `false` turns it off. */
  openRate?: ApprovalRateOptions | false
  /** Clock (ms), injectable for tests. */
  now?: () => number
}

/** Options of one {@link ApprovalQueue.request}. */
export interface ApprovalRequestOptions {
  /**
   * Another sheet for a request the user has just approved (the fee changed before signing). It skips
   * the queue and rate limits and is shown ahead of the requests already waiting — once per approval
   * of the same origin, kind and chain; with no such approval behind it, it is an ordinary request.
   * `refuse` still applies.
   */
  followUp?: boolean
}

/** Follow-ups one origin + kind + chain may have paid for and not used. */
const FOLLOW_UP_CREDITS_MAX = 8
/** Origin + kind + chain entries remembered for follow-ups. */
const FOLLOW_UP_KEYS_MAX = 256

/** The window side: open for one request, close when it is answered. `memoryApprovalWindow()` for tests. */
export interface ApprovalWindow {
  open(request: ApprovalRequest): Promise<void>
  close(requestId: string): Promise<void>
  /** The user closed the window themself (chrome.windows.onRemoved): the queue declines the request. */
  onClosed(handler: (requestId: string) => void): void
}

interface Pending<T = unknown> {
  request: ApprovalRequest
  resolve: (value: T) => void
  reject: (error: Error) => void
}

export class ApprovalQueue {
  private _current: Pending | null = null
  private readonly _waiting: Pending[] = []
  private readonly _listeners = new Set<() => void>()
  private readonly _via = new Map<string, OriginVia>()
  private readonly _rate: TokenBucket | null
  /** Per site: cooldown end and strikes (how many times the bucket ran dry recently). */
  private readonly _cooldown = new Map<string, { until: number; strikes: number; last: number }>()
  /** Per origin + kind + chain: approvals that have not been followed up (see {@link ApprovalRequestOptions.followUp}). */
  private readonly _approved = new Map<string, number>()

  constructor(private readonly window: ApprovalWindow, private readonly newId: () => string = () => crypto.randomUUID(), private readonly options: ApprovalQueueOptions = {}) {
    window.onClosed((id) => { if (this._current?.request.id === id) this.decline(id) })
    const rate = options.openRate === false ? null : options.openRate ?? {}
    this._rate = rate ? new TokenBucket({ capacity: rate.burst ?? 10, refillPerSecond: rate.refillPerSecond ?? 1 / 6, ...(options.now ? { now: options.now } : {}) }) : null
  }

  private site(origin: string): string {
    try { return (this.options.siteOf ?? defaultSiteOf)(origin) } catch { return origin }
  }

  private get all(): Pending[] {
    return [...(this._current ? [this._current] : []), ...this._waiting]
  }

  /** The per-site rate: a reason to refuse, or null (and one token spent). */
  private rateRefusal(site: string): string | null {
    if (!this._rate) return null
    const rate = this.options.openRate || {}
    const now = (this.options.now ?? Date.now)()
    const max = rate.maxBackoffMs ?? 600_000
    const c = this._cooldown.get(site)
    if (c && now < c.until) return `This site opened too many requests; try again in ${Math.ceil((c.until - now) / 1000)} s.`
    if (this._rate.take(site)) return null
    const strikes = c && now - c.last < max ? c.strikes + 1 : 1
    const wait = Math.min(max, (rate.backoffMs ?? 30_000) * 2 ** (strikes - 1))
    this._cooldown.set(site, { until: now + wait, strikes, last: now })
    if (this._cooldown.size > 1000) for (const [k, v] of this._cooldown) if (now - v.last >= max) this._cooldown.delete(k)
    return `This site opened too many requests; try again in ${Math.ceil(wait / 1000)} s.`
  }

  private static followUpKey(r: Pick<ApprovalRequest, 'origin' | 'kind' | 'chain'>): string {
    return `${r.origin}\n${r.kind}\n${r.chain}`
  }

  /** The user approved `r`: it may be followed up once. */
  private approved(r: ApprovalRequest): void {
    const key = ApprovalQueue.followUpKey(r)
    const n = Math.min((this._approved.get(key) ?? 0) + 1, FOLLOW_UP_CREDITS_MAX)
    this._approved.delete(key)
    this._approved.set(key, n)
    if (this._approved.size > FOLLOW_UP_KEYS_MAX) this._approved.delete(this._approved.keys().next().value!)
  }

  /** Spends one approval of the same origin, kind and chain; false when there is none. */
  private spendApproval(r: Pick<ApprovalRequest, 'origin' | 'kind' | 'chain'>): boolean {
    const key = ApprovalQueue.followUpKey(r)
    const n = this._approved.get(key) ?? 0
    if (n <= 0) return false
    if (n === 1) this._approved.delete(key)
    else this._approved.set(key, n - 1)
    return true
  }

  /** Enqueue and wait for the user's answer. Refuses (never queues) past the per-origin limits. */
  request<T = unknown>(input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'originWarnings' | 'via'>, opts: ApprovalRequestOptions = {}): Promise<T> {
    let refused: string | null | undefined
    try { refused = this.options.refuse?.(input.origin) } catch (e) { refused = `The wallet could not check this site (${e instanceof Error ? e.message : String(e)}).` }
    if (refused) return Promise.reject(new OriginRefused(refused))
    let exempt = false
    try { exempt = this.options.exempt?.(input.origin) === true } catch { exempt = false }
    const followUp = opts.followUp === true && this.spendApproval(input)
    if (!exempt && !followUp) {
      const all = this.all
      const sameOrigin = all.filter((p) => p.request.origin === input.origin)
      if (input.kind === 'connect' && sameOrigin.some((p) => p.request.kind === 'connect')) {
        return Promise.reject(new QueueLimitError(RELAY_ERRORS.resourceUnavailable, 'A connect request from this site is already waiting for your answer.'))
      }
      const max = this.options.maxPendingPerOrigin ?? APPROVALS_MAX_PENDING_PER_ORIGIN
      if (sameOrigin.length >= max) {
        return Promise.reject(new QueueLimitError(RELAY_ERRORS.limitExceeded, `This site already has ${max} requests waiting for you; answer or close them first.`))
      }
      const site = this.site(input.origin)
      const maxSite = this.options.maxPendingPerSite ?? APPROVALS_MAX_PENDING_PER_SITE
      if (all.filter((p) => this.site(p.request.origin) === site).length >= maxSite) {
        return Promise.reject(new QueueLimitError(RELAY_ERRORS.limitExceeded, `This site already has ${maxSite} requests waiting for you across its subdomains; answer or close them first.`))
      }
      const maxTotal = this.options.maxPendingTotal ?? APPROVALS_MAX_PENDING_TOTAL
      if (all.filter((p) => !this.isExempt(p.request.origin)).length >= maxTotal) {
        return Promise.reject(new QueueLimitError(RELAY_ERRORS.limitExceeded, `The wallet already has ${maxTotal} requests waiting for you; answer or close them first.`))
      }
      const slow = this.rateRefusal(site)
      if (slow) return Promise.reject(new QueueLimitError(RELAY_ERRORS.limitExceeded, slow))
    }
    return new Promise<T>((resolve, reject) => {
      const warnings = this.options.annotate?.(input.origin) ?? []
      const via = this._via.get(input.origin)
      const pending: Pending = { request: { ...input, id: this.newId(), createdAt: Date.now(), ...(warnings.length ? { originWarnings: warnings } : {}), ...(via ? { via } : {}) }, resolve: resolve as (v: unknown) => void, reject }
      if (followUp) this._waiting.unshift(pending)
      else this._waiting.push(pending)
      void this.next()
    })
  }

  /** Attach (or clear) the transport note every later request from `origin` carries. */
  setVia(origin: string, via: OriginVia | null): void {
    if (via) this._via.set(origin, via)
    else this._via.delete(origin)
  }

  /** The transport note later requests from `origin` carry (WalletConnect Verify's verdict for `wc:<topic>`), if any. */
  viaFor(origin: string): OriginVia | undefined {
    return this._via.get(origin)
  }

  private isExempt(origin: string): boolean {
    try { return this.options.exempt?.(origin) === true } catch { return false }
  }

  /** Requests waiting for `origin` (current + queued). */
  pendingFor(origin: string): number {
    return this.all.filter((p) => p.request.origin === origin).length
  }

  /** Requests waiting for any origin of `site` (current + queued). */
  pendingForSite(site: string): number {
    return this.all.filter((p) => this.site(p.request.origin) === site).length
  }

  /** The site (registrable domain) the queue's limits put `origin` under. */
  siteFor(origin: string): string {
    return this.site(origin)
  }

  /** Decline everything waiting for `origin` (its last page closed). Returns how many requests were declined. */
  declineOrigin(origin: string, error: Error = new ReviewDeclined('The page was closed — nothing was signed.')): number {
    return this.declineWhere((p) => p.request.origin === origin, error)
  }

  /** "Decline all from this site": everything waiting for any origin of `site` (see {@link siteFor}). */
  declineSite(site: string, error: Error = new ReviewDeclined()): number {
    return this.declineWhere((p) => this.site(p.request.origin) === site, error)
  }

  private declineWhere(match: (p: Pending) => boolean, error: Error): number {
    // Queued ones first: declining the current one opens the next window, which must not be one of these.
    const ids = [...this._waiting.filter(match), ...(this._current && match(this._current) ? [this._current] : [])].map((p) => p.request.id)
    for (const id of ids) this.decline(id, error)
    return ids.length
  }

  /** The request currently shown (the window asks for it by id on load). */
  get current(): ApprovalRequest | null {
    return this._current?.request ?? null
  }

  get queued(): number {
    return this._waiting.length
  }

  resolve(requestId: string, value: unknown): boolean {
    return this.settle(requestId, (p) => { this.approved(p.request); p.resolve(value) })
  }

  decline(requestId: string, error: Error = new ReviewDeclined()): boolean {
    return this.settle(requestId, (p) => p.reject(error))
  }

  /** Lock, disconnect, shutdown: everything pending is declined. */
  declineAll(error: Error = new ReviewDeclined('The wallet was locked.')): void {
    const all = [...(this._current ? [this._current] : []), ...this._waiting.splice(0)]
    this._approved.clear()
    for (const p of all) p.reject(error)
    if (this._current) void this.window.close(this._current.request.id)
    this._current = null
    this.emit()
  }

  onChange(listener: () => void): () => void {
    this._listeners.add(listener)
    return () => this._listeners.delete(listener)
  }

  private settle(requestId: string, fn: (p: Pending) => void): boolean {
    if (this._current?.request.id === requestId) {
      const p = this._current
      this._current = null
      fn(p)
      void this.window.close(requestId).catch(() => undefined)
      this.emit()
      void this.next()
      return true
    }
    const i = this._waiting.findIndex((p) => p.request.id === requestId)
    if (i < 0) return false
    fn(this._waiting.splice(i, 1)[0]!)
    this.emit()
    return true
  }

  private async next(): Promise<void> {
    if (this._current || this._waiting.length === 0) return
    const p = this._waiting.shift()!
    this._current = p
    this.emit()
    try {
      await this.window.open(p.request)
    } catch (e) {
      if (this._current === p) {
        this._current = null
        p.reject(e instanceof Error ? e : new Error(String(e)))
        this.emit()
        void this.next()
      }
    }
  }

  private emit(): void {
    for (const l of this._listeners) l()
  }
}

/** In-memory window: tests answer through the queue; `opened` records every request shown. */
export function memoryApprovalWindow(): ApprovalWindow & { opened: ApprovalRequest[]; openIds: Set<string>; userClose(id: string): void } {
  let handler: (id: string) => void = () => undefined
  const w = {
    opened: [] as ApprovalRequest[],
    openIds: new Set<string>(),
    async open(request: ApprovalRequest) { w.opened.push(request); w.openIds.add(request.id) },
    async close(id: string) { w.openIds.delete(id) },
    onClosed(h: (id: string) => void) { handler = h },
    userClose(id: string) { w.openIds.delete(id); handler(id) },
  }
  return w
}
