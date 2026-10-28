/**
 * Message shapes on the two hops between a dApp and the wallet:
 *
 * ```text
 * page (injected provider, MAIN world)
 *   │ window.postMessage — PageRequest ⇄ PageResponse / PageEvent
 * content script (isolated world) — stamps `location.origin`, owns the port
 *   │ chrome.runtime.connect(PORT_NAME) — RelayRequest ⇄ RelayResponse / RelayEvent
 * service worker — trusts `port.sender` (set by the browser), never the page
 * ```
 *
 * The page can forge anything it posts, so a page message carries no origin and
 * no identity: the content script adds the origin, and the service worker
 * cross-checks it against `port.sender.origin` ({@link checkSenderOrigin}) — a
 * mismatch is dropped, not answered. Request ids are opaque strings minted by
 * the page side ({@link newRequestId}); the content script does not reuse them
 * across ports.
 */

/** `chrome.runtime.connect({ name })` for content-script ports. */
export const PORT_NAME = 'anywalletkit/relay/1'
/** `window.postMessage` discriminators (both directions). */
export const PAGE_TARGET = { toContent: 'anywalletkit/content', toPage: 'anywalletkit/page' } as const

/** CAIP-2 namespace of the provider that spoke. */
export type RelayChain = 'eip155' | 'solana' | 'ton' | 'tron' | 'bip122' | 'near'

export interface RelayError {
  /** EIP-1193 / EIP-1474 numbering for EVM; the same numbers are reused for the other providers. */
  code: number
  message: string
  data?: unknown
}

export const RELAY_ERRORS = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  /** EIP-3326/3085: the chain is not in the wallet (`wallet_switchEthereumChain` → suggest `wallet_addEthereumChain`). */
  chainNotAdded: 4902,
  internal: -32603,
  invalidRequest: -32600,
  invalidParams: -32602,
  /** EIP-1474: a request of the same kind from this origin is already waiting (MetaMask's "already pending"). */
  resourceUnavailable: -32002,
  /** EIP-1474: this origin has too many requests waiting. */
  limitExceeded: -32005,
} as const

// ---- hop 1: page ⇄ content script ----

export interface PageRequest {
  target: typeof PAGE_TARGET.toContent
  id: string
  chain: RelayChain
  method: string
  params?: unknown
}

export interface PageResponse {
  target: typeof PAGE_TARGET.toPage
  id: string
  result?: unknown
  error?: RelayError
}

export interface PageEvent {
  target: typeof PAGE_TARGET.toPage
  chain: RelayChain
  event: string
  data?: unknown
}

// ---- hop 2: content script ⇄ service worker ----

export interface RelayRequest {
  kind: 'request'
  id: string
  /** `location.origin` of the page, stamped by the content script. */
  origin: string
  chain: RelayChain
  method: string
  params?: unknown
}

export interface RelayResponse {
  kind: 'response'
  id: string
  result?: unknown
  error?: RelayError
}

export interface RelayEvent {
  kind: 'event'
  chain: RelayChain
  event: string
  data?: unknown
}

export type RelayToWorker = RelayRequest
export type RelayToContent = RelayResponse | RelayEvent

// ---- guards ----

const CHAINS: ReadonlySet<string> = new Set<RelayChain>(['eip155', 'solana', 'ton', 'tron', 'bip122', 'near'])

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isId = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 64
/** Longest method name a request may carry. */
export const RELAY_METHOD_MAX = 128
/**
 * A method name as the providers spell them (`eth_sendTransaction`, `signAndSendTransaction`,
 * `tron_requestAccounts`): letters, digits and `_`, at most {@link RELAY_METHOD_MAX}. Anything else
 * is dropped at the relay, so a megabyte "method" never reaches a regex, a log or an error message
 * (scan 2026-10-27 modules, F5).
 */
export const isRelayMethod = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= RELAY_METHOD_MAX && /^[A-Za-z0-9_]+$/.test(x)

export function isPageRequest(x: unknown): x is PageRequest {
  return isRecord(x) && x.target === PAGE_TARGET.toContent && isId(x.id) && CHAINS.has(x.chain as string) && isRelayMethod(x.method)
}

export function isPageResponse(x: unknown): x is PageResponse {
  return isRecord(x) && x.target === PAGE_TARGET.toPage && isId(x.id)
}

export function isPageEvent(x: unknown): x is PageEvent {
  return isRecord(x) && x.target === PAGE_TARGET.toPage && !('id' in x) && CHAINS.has(x.chain as string) && typeof x.event === 'string'
}

export function isRelayRequest(x: unknown): x is RelayRequest {
  return isRecord(x) && x.kind === 'request' && isId(x.id) && typeof x.origin === 'string' && CHAINS.has(x.chain as string) && isRelayMethod(x.method)
}

export function isRelayToContent(x: unknown): x is RelayToContent {
  return isRecord(x) && ((x.kind === 'response' && isId(x.id)) || (x.kind === 'event' && typeof x.event === 'string'))
}

export function newRequestId(): string {
  return crypto.randomUUID()
}

/** What a content script's `message` listener receives (structural `MessageEvent`). */
export interface PageMessageEvent { data: unknown; origin: string; source: unknown }
/** The page window the content script shares (structural `window`). */
export interface PageWindow { location: { origin: string } }

/**
 * The page's own request, or `null`. A content script must take only messages the page itself
 * posted — `event.source` is the page window and `event.origin` its origin — or an iframe on the
 * page (an ad, an embed) would have its `parent.postMessage` stamped with the site's origin and
 * shown in the approval window as the site (round 3, H6).
 */
export function pageRequestFrom(event: PageMessageEvent, page: PageWindow): PageRequest | null {
  if (event.source !== page || event.origin !== page.location.origin) return null
  return isPageRequest(event.data) ? event.data : null
}

/** The content script's stamp: {@link PageRequest} + the page origin. */
export function stampOrigin(request: PageRequest, origin: string): RelayRequest {
  const { id, chain, method } = request
  return 'params' in request ? { kind: 'request', id, origin, chain, method, params: request.params } : { kind: 'request', id, origin, chain, method }
}

/** What `port.sender` looks like (structural `chrome.runtime.MessageSender`). */
export interface PortSender {
  origin?: string | undefined
  url?: string | undefined
  tab?: { id?: number | undefined } | undefined
  frameId?: number | undefined
}

/**
 * The service worker's check before it believes a stamped origin: it must equal the
 * origin the browser recorded for the port. Returns the trusted origin or `null`.
 */
export function checkSenderOrigin(sender: PortSender | undefined, stamped: string): string | null {
  const fromSender = sender?.origin ?? (sender?.url ? safeOrigin(sender.url) : undefined)
  if (!fromSender || fromSender === 'null') return null
  return fromSender === stamped ? fromSender : null
}

function safeOrigin(url: string): string | undefined {
  try { return new URL(url).origin } catch { return undefined }
}

export const relayError = (code: number, message: string, data?: unknown): RelayError => (data === undefined ? { code, message } : { code, message, data })
