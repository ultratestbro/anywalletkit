/**
 * "Same site" for limits: the registrable domain (eTLD+1) of an origin, and a
 * token bucket keyed by any string. Both exist so a page cannot multiply its
 * allowance by spreading requests over subdomains (`a1.evil.tld`, `a2.evil.tld`…).
 *
 * There is no Public Suffix List in this package (it is large and changes); the
 * helper is conservative instead: the last two labels, or three when the last two
 * are a known multi-label public suffix ({@link MULTI_LABEL_SUFFIXES}: country
 * second-level domains such as `co.uk`, and hosting domains where anyone gets a
 * subdomain, such as `github.io` or `vercel.app`). A suffix that is missing from
 * the list makes unrelated sites under it share one limit (stricter, never looser);
 * pass your own `siteOf` to the queue when you ship a full list.
 */

/**
 * Multi-label public suffixes the helper knows. Two groups: country second-level
 * registries, and hosting platforms that hand out subdomains to anyone (the
 * Public Suffix List's private section).
 */
export const MULTI_LABEL_SUFFIXES: ReadonlySet<string> = new Set([
  // country second-level registries
  'co.uk', 'org.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'co.kr', 'or.kr', 'ne.kr',
  'com.br', 'net.br', 'org.br', 'com.cn', 'net.cn', 'org.cn', 'com.hk', 'com.tw', 'com.sg', 'com.my',
  'co.in', 'net.in', 'org.in', 'co.id', 'co.il', 'co.th', 'co.za', 'com.mx', 'com.ar', 'com.co', 'com.tr',
  'com.ua', 'com.pl', 'com.ru', 'com.vn', 'com.ph', 'com.pk', 'com.ng', 'com.eg', 'com.sa', 'co.ke',
  // hosting platforms: every customer gets its own subdomain
  'github.io', 'gitlab.io', 'vercel.app', 'now.sh', 'pages.dev', 'workers.dev', 'r2.dev', 'netlify.app', 'netlify.com',
  'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net',
  'amplifyapp.com', 'onrender.com', 'fly.dev', 'railway.app', 'up.railway.app', 'deno.dev', 'glitch.me', 'repl.co', 'replit.app',
  'replit.dev', 'surge.sh', 'webflow.io', 'framer.app', 'framer.website', 'wixsite.com', 'blogspot.com', 'myshopify.com',
  'notion.site', 'carrd.co', 'gitbook.io', 'readthedocs.io', 'ngrok.io', 'ngrok-free.app', 'loca.lt', 'trycloudflare.com',
  // ENS / IPFS gateways: every name or CID is its own site
  'eth.limo', 'eth.link', 'ipfs.dweb.link', 'ipns.dweb.link', 'ipfs.w3s.link', 'ipfs.cf-ipfs.com',
])

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * The site an origin belongs to: `https://a.b.example.co.uk:8443` → `example.co.uk`,
 * `https://x.vercel.app` → `x.vercel.app`. IP addresses and single-label hosts
 * (`localhost`) are their own site. A pseudo-origin that is not a URL (`wc:<topic>`)
 * is returned unchanged.
 */
export function siteOf(origin: string): string {
  let host: string
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return origin
    host = url.hostname.toLowerCase().replace(/\.$/, '')
  } catch {
    return origin
  }
  if (!host || host.startsWith('[') || host.includes(':') || IPV4.test(host)) return host || origin
  const labels = host.split('.')
  if (labels.length <= 2) return host
  for (const size of [3, 2]) {
    if (labels.length <= size) continue
    if (MULTI_LABEL_SUFFIXES.has(labels.slice(-size).join('.'))) return labels.slice(-(size + 1)).join('.')
  }
  return labels.slice(-2).join('.')
}

export interface TokenBucketOptions {
  /** Tokens a key holds when full (the burst). */
  capacity: number
  /** Tokens added per second. */
  refillPerSecond: number
  /** Clock (ms), injectable for tests. */
  now?: () => number
  /** Keys tracked before full buckets are dropped (memory bound). Default 2000. */
  maxKeys?: number
}

/** A token bucket per key: `take(key)` spends one token, `false` when the key is out of tokens. Memory only. */
export class TokenBucket {
  private readonly buckets = new Map<string, { tokens: number; at: number }>()
  constructor(private readonly options: TokenBucketOptions) {}

  take(key: string, cost = 1): boolean {
    const now = (this.options.now ?? Date.now)()
    const b = this.refill(key, now)
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }

  /** Tokens `key` holds right now (full for an unknown key). */
  available(key: string): number {
    return this.refill(key, (this.options.now ?? Date.now)()).tokens
  }

  private refill(key: string, now: number): { tokens: number; at: number } {
    let b = this.buckets.get(key)
    if (!b) {
      if (this.buckets.size >= (this.options.maxKeys ?? 2000)) this.prune(now)
      b = { tokens: this.options.capacity, at: now }
      this.buckets.set(key, b)
      return b
    }
    const elapsed = Math.max(0, now - b.at) / 1000
    b.tokens = Math.min(this.options.capacity, b.tokens + elapsed * this.options.refillPerSecond)
    b.at = now
    return b
  }

  /** Drop buckets that are full again (they carry no state); the oldest half when every one is in use. */
  private prune(now: number): void {
    for (const [k, b] of this.buckets) {
      if (b.tokens + (Math.max(0, now - b.at) / 1000) * this.options.refillPerSecond >= this.options.capacity) this.buckets.delete(k)
    }
    if (this.buckets.size >= (this.options.maxKeys ?? 2000)) {
      let drop = Math.ceil(this.buckets.size / 2)
      for (const k of this.buckets.keys()) { if (drop-- <= 0) break; this.buckets.delete(k) }
    }
  }
}
