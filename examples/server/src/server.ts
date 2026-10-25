// The "Ship a wallet" docs page renders the #region blocks of this file.
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { createSwap2Handler, Swap2HandlerError, type Swap2Call } from '@anywalletkit/protocol-swap2-core/server'
import type { CrossChainProvider } from '@anywalletkit/protocol-swap2-core'
import { EXPENSIVE_METHODS, createRpcProxy } from './rpc.ts'

export interface ServerOptions {
  providers: readonly CrossChainProvider[]
  /** CAIP-2 → upstream RPC URLs (with your keys). */
  upstreams: Readonly<Record<string, readonly string[]>>
  /** ≥ 32 random bytes: seals swap quotes. */
  sealSecret: string
  /** The bearer token the app sends. See the guard below before you ship. */
  apiToken: string
  /** The one browser origin allowed to call this server (a native app sends no Origin). */
  allowedOrigin?: string
  /** Requests per minute per caller and bucket; `rpcHeavy` counts each expensive RPC call (eth_getLogs, eth_call…). */
  limits?: { live: number; display: number; status: number; rpc: number; rpcHeavy?: number }
  fetchImpl?: typeof fetch
}

/**
 * Fixed-window rate limits per key, in this process's memory (a real deployment keeps them in a
 * shared store). Keys whose window ended are dropped, so the map holds only live callers.
 */
export function createRateLimiter({ windowMs = 60_000, now = Date.now }: { windowMs?: number; now?: () => number } = {}) {
  const windows = new Map<string, { start: number; count: number }>()
  let swept = now()
  return {
    /** Count one request for `key`; throws 429 above `limit` within the window. */
    take(key: string, limit: number): void {
      const t = now()
      // Forget callers whose window ended, at most once a window: the map holds only live callers.
      if (t - swept > windowMs) {
        for (const [k, w] of windows) if (t - w.start > windowMs) windows.delete(k)
        swept = t
      }
      const w = windows.get(key)
      if (!w || t - w.start > windowMs) { windows.set(key, { start: t, count: 1 }); return }
      if (++w.count > limit) throw new Swap2HandlerError(429, 'too many requests, slow down')
    },
    get size(): number { return windows.size },
  }
}

// #region guard
/**
 * ⚠️  Replace this before production. A token baked into an app is NOT a secret: anyone can pull
 * it out of the bundle. It only stops casual scraping. A real deployment authenticates the USER
 * (Sign-In with Ethereum, your account system, App Attest / Play Integrity for the app itself)
 * and rate-limits per user, in a shared store (Redis, Upstash), not in this process's memory.
 */
function makeGuard(opts: ServerOptions) {
  const token = Buffer.from(opts.apiToken)
  const limits = { rpcHeavy: 60, ...(opts.limits ?? { live: 30, display: 240, status: 120, rpc: 600 }) }
  const limiter = createRateLimiter()
  const take = (key: string, perMinute: number) => limiter.take(key, perMinute)
  const authenticate = (req: IncomingMessage): string => {
    const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''))
    if (got.length !== token.length || !timingSafeEqual(got, token)) throw new Swap2HandlerError(401, 'unauthorized')
    return req.socket.remoteAddress ?? 'unknown' // the caller key; per USER in production
  }
  return {
    swap2: (call: Swap2Call, req: IncomingMessage) => {
      const caller = authenticate(req)
      // Display quotes (route list, every keystroke) get their own, larger bucket so they never
      // starve the one live quote the confirm step needs.
      const bucket = call.action === 'track' || call.action === 'claim' ? 'status' : call.dry ? 'display' : 'live'
      take(`${caller}:swap2:${bucket}`, limits[bucket])
    },
    /** One count per request, then one per expensive call in it (a batch of 20 eth_getLogs is 20). */
    rpc: (req: IncomingMessage) => {
      const caller = authenticate(req)
      take(`${caller}:rpc`, limits.rpc)
      return (methods: readonly string[]) => {
        for (const m of methods) if (EXPENSIVE_METHODS.has(m)) take(`${caller}:rpc-heavy`, limits.rpcHeavy)
      }
    },
  }
}
// #endregion guard

// #region server
export function createServer(opts: ServerOptions): Server {
  const guard = makeGuard(opts)
  // With per-user sign-in (Sign-In with Ethereum), also pass `subject: (req) => <the user's address>`:
  // quotes and swap ids are then bound to that user, and another user's are refused (403).
  const swap2 = createSwap2Handler<IncomingMessage>({ providers: opts.providers, sealSecret: opts.sealSecret, guard: guard.swap2 })
  const rpc = createRpcProxy({ upstreams: opts.upstreams, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })

  return createHttpServer(async (req, res) => {
    if (!cors(req, res, opts.allowedOrigin)) return
    const url = new URL(req.url ?? '/', 'http://local')
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true })
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })

      const swap = /^\/swap2\/([a-z]+)$/.exec(url.pathname)
      if (swap) {
        const raw = await readBody(req, 3 * 1024 * 1024) // a Solana / TON payload can be ~2 MB
        let body: unknown
        try { body = JSON.parse(raw) } catch { return send(res, 400, { error: 'invalid JSON' }) }
        const out = await swap2(swap[1]!, body, req)
        return send(res, out.status, out.body)
      }
      const rpcPath = /^\/rpc\/([a-z0-9]+:[-_a-zA-Z0-9]+)$/.exec(url.pathname)
      if (rpcPath) {
        const charge = guard.rpc(req)
        const out = await rpc(rpcPath[1]!, await readBody(req, 512 * 1024), { charge })
        res.writeHead(out.status, { 'content-type': 'application/json' })
        return res.end(out.body)
      }
      return send(res, 404, { error: 'not found' })
    } catch (err) {
      if (err instanceof Swap2HandlerError) return send(res, err.status, { error: err.message })
      console.error('request failed', req.method, url.pathname) // never log bodies: they carry addresses and signed transactions
      return send(res, 500, { error: 'internal error' })
    }
  })
}
// #endregion server

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** CORS for one browser origin; native apps send no Origin and pass. Returns false when it answered. */
function cors(req: IncomingMessage, res: ServerResponse, allowed?: string): boolean {
  const origin = req.headers.origin
  if (origin && origin !== allowed) { send(res, 403, { error: 'origin not allowed' }); return false }
  if (origin) {
    res.setHeader('access-control-allow-origin', origin)
    res.setHeader('vary', 'origin')
    res.setHeader('access-control-allow-headers', 'authorization, content-type')
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false }
  return true
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) { reject(new Swap2HandlerError(413, 'request too large')); req.destroy() } else chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
