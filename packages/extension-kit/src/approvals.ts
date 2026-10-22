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
 * Two limits keep a page from burying one real request under decoys (SDK-142 M3):
 * at most `maxPendingPerOrigin` requests wait per origin (-32005), and a second
 * `connect` while one is pending is refused outright (-32002).
 *
 * An origin can carry a transport note (`via`, set by the WalletConnect bridge):
 * the sheet then says the request came over WalletConnect, what the dApp claims
 * to be and what WalletConnect Verify says about that claim — the claim itself is
 * never used as the permission key.
 */
import { RELAY_ERRORS } from './relay.js'

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

export const APPROVALS_MAX_PENDING_PER_ORIGIN = 3

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
  /** Requests one origin may have waiting (current + queued). Default {@link APPROVALS_MAX_PENDING_PER_ORIGIN}. */
  maxPendingPerOrigin?: number
}

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

  constructor(private readonly window: ApprovalWindow, private readonly newId: () => string = () => crypto.randomUUID(), private readonly options: ApprovalQueueOptions = {}) {
    window.onClosed((id) => { if (this._current?.request.id === id) this.decline(id) })
  }

  /** Enqueue and wait for the user's answer. Refuses (never queues) past the per-origin limits. */
  request<T = unknown>(input: Omit<ApprovalRequest, 'id' | 'createdAt' | 'originWarnings' | 'via'>): Promise<T> {
    const sameOrigin = [...(this._current ? [this._current] : []), ...this._waiting].filter((p) => p.request.origin === input.origin)
    if (input.kind === 'connect' && sameOrigin.some((p) => p.request.kind === 'connect')) {
      return Promise.reject(new QueueLimitError(RELAY_ERRORS.resourceUnavailable, 'A connect request from this site is already waiting for your answer.'))
    }
    const max = this.options.maxPendingPerOrigin ?? APPROVALS_MAX_PENDING_PER_ORIGIN
    if (sameOrigin.length >= max) {
      return Promise.reject(new QueueLimitError(RELAY_ERRORS.limitExceeded, `This site already has ${max} requests waiting for you; answer or close them first.`))
    }
    return new Promise<T>((resolve, reject) => {
      const warnings = this.options.annotate?.(input.origin) ?? []
      const via = this._via.get(input.origin)
      const pending: Pending = { request: { ...input, id: this.newId(), createdAt: Date.now(), ...(warnings.length ? { originWarnings: warnings } : {}), ...(via ? { via } : {}) }, resolve: resolve as (v: unknown) => void, reject }
      this._waiting.push(pending)
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

  /** Requests waiting for `origin` (current + queued). */
  pendingFor(origin: string): number {
    return [...(this._current ? [this._current] : []), ...this._waiting].filter((p) => p.request.origin === origin).length
  }

  /** The request currently shown (the window asks for it by id on load). */
  get current(): ApprovalRequest | null {
    return this._current?.request ?? null
  }

  get queued(): number {
    return this._waiting.length
  }

  resolve(requestId: string, value: unknown): boolean {
    return this.settle(requestId, (p) => p.resolve(value))
  }

  decline(requestId: string, error: Error = new ReviewDeclined()): boolean {
    return this.settle(requestId, (p) => p.reject(error))
  }

  /** Lock, disconnect, shutdown: everything pending is declined. */
  declineAll(error: Error = new ReviewDeclined('The wallet was locked.')): void {
    const all = [...(this._current ? [this._current] : []), ...this._waiting.splice(0)]
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
