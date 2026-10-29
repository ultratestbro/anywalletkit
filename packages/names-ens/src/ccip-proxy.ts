import { parseUrl } from '@anywalletkit/networks/url'
import { EnsNameError } from './ens.js'

/**
 * The app side of `createEnsCcipHandler` (`@anywalletkit/names-ens/server`): a `fetch` for
 * `ensResolver({ rpcUrl, ccip: { fetch } })` that sends each CCIP-Read gateway request to your server, which asks
 * the gateway (https only, public addresses only, no redirects) and returns its answer. The device itself
 * then only ever talks to your server, so a gateway's redirect cannot reach the user's network.
 *
 * Runs on React Native / Hermes: fetch, JSON and timers only (no `URL`, no `AbortSignal.timeout`).
 */
export interface EnsCcipViaProxyOptions {
  /** Headers for your server, e.g. `{ authorization: 'Bearer …' }`. They go to the proxy only, never to the gateway. */
  headers?: Readonly<Record<string, string>>
  /** Per request, proxy round trip included. Default 15 s (the server's own gateway timeout is 10 s). */
  timeoutMs?: number
  /** The fetch that reaches your server. Default: the global one. */
  fetch?: (url: string, init: RequestInit) => Promise<{ status: number; text(): Promise<string> }>
  /** Accept `http://` for a proxy on this machine (localhost, 127.0.0.1, [::1]) during development. Default false. */
  allowInsecureProxyUrl?: boolean
}

/** One gateway call as the proxy receives it. */
export interface EnsCcipProxyRequest {
  url: string
  method: 'GET' | 'POST'
  /** POST only: the EIP-3668 body. */
  body?: { sender: string; data: string }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * `fetch` for {@link EnsCcipOptions.fetch} through your server's CCIP-Read route:
 * `ensResolver({ rpcUrl, ccip: { fetch: ensCcipViaProxy('https://api.example.com/ccip', { headers }) } })`.
 * The proxy URL must be https (or a local http one with `allowInsecureProxyUrl`).
 */
export function ensCcipViaProxy(proxyUrl: string, opts: EnsCcipViaProxyOptions = {}): (url: string, init: RequestInit) => Promise<Response> {
  const p = parseUrl(proxyUrl)
  const local = p !== null && p.scheme === 'http' && LOOPBACK.has(p.host) && opts.allowInsecureProxyUrl === true
  if (!p || p.hasCredentials || (p.scheme !== 'https' && !local)) {
    throw new Error('names-ens: ensCcipViaProxy needs an https proxy URL without credentials (http only for localhost with allowInsecureProxyUrl)')
  }
  const target = proxyUrl.trim()
  const timeoutMs = opts.timeoutMs ?? 15_000
  const doFetch = opts.fetch ?? ((url: string, init: RequestInit) => fetch(url, init))

  return async function viaProxy(url: string, init: RequestInit): Promise<Response> {
    const method = String(init.method ?? 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') throw new EnsNameError('lookup-failed', `CCIP-Read uses GET or POST, not ${method.slice(0, 10)}.`)
    const request: EnsCcipProxyRequest = { url, method }
    if (method === 'POST') {
      let body: { sender?: unknown; data?: unknown }
      try { body = JSON.parse(String(init.body ?? '')) as typeof body } catch { throw new EnsNameError('lookup-failed', 'The CCIP-Read POST body is not JSON.') }
      request.body = { sender: String(body?.sender ?? ''), data: String(body?.data ?? '') }
    }
    // Hermes has AbortController but not AbortSignal.timeout / .any: a timer and the caller's signal, by hand.
    const controller = typeof AbortController === 'function' ? new AbortController() : undefined
    const outer = init.signal ?? undefined
    const onAbort = () => controller?.abort()
    if (outer?.aborted) controller?.abort()
    else outer?.addEventListener?.('abort', onAbort)
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new EnsNameError('lookup-failed', `The CCIP-Read proxy did not answer within ${timeoutMs} ms.`)) // first, so the race reports it
        controller?.abort()
      }, timeoutMs)
    })
    timeout.catch(() => undefined) // a cleared timer can still fire on the Hermes CLI
    try {
      const res = await Promise.race([
        doFetch(target, {
          method: 'POST',
          headers: { ...(opts.headers ?? {}), 'content-type': 'application/json' },
          body: JSON.stringify(request),
          ...(controller ? { signal: controller.signal } : {}),
        }),
        timeout,
      ])
      const text = await Promise.race([res.text(), timeout])
      type ProxyReply = { data?: unknown; error?: unknown } | null
      let answer: ProxyReply = null
      try { answer = JSON.parse(text) as ProxyReply } catch { /* not JSON: refused below */ }
      if (res.status !== 200 || typeof answer?.data !== 'string') {
        const why = typeof answer?.error === 'string' ? answer.error.slice(0, 200) : `HTTP ${res.status}`
        throw new EnsNameError('lookup-failed', `The CCIP-Read proxy got no answer from the gateway: ${why}.`)
      }
      return proxyAnswer(answer.data)
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      outer?.removeEventListener?.('abort', onAbort)
    }
  }
}

/**
 * The gateway's data as the Response `ensCcipRequest` reads (status, headers, json, text): built by hand,
 * because a Response from the proxy would carry the proxy's URL, and some runtimes have no Response constructor.
 */
function proxyAnswer(data: string): Response {
  const text = JSON.stringify({ data })
  return {
    ok: true, status: 200, redirected: false, url: '',
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'application/json' : null) },
    json: async () => ({ data }),
    text: async () => text,
  } as unknown as Response
}
