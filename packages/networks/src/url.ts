/**
 * Endpoint URL policy (owner decision 2, 2026-10-21): https only; `http://`
 * accepted for local / private addresses only (localhost, 127/8, 10/8,
 * 172.16/12, 192.168/16, `*.local`) and only behind the explicit
 * "allow http for local nodes" opt-in. No credentials in the URL.
 *
 * Parsed by hand — Hermes ships no `URL`.
 */

export type UrlPolicyReason = 'not-a-url' | 'scheme' | 'credentials' | 'http-not-local' | 'http-not-allowed'

/** Result of `checkRpcUrl`: the normalized URL and whether it is local, or why it was refused. */
export type UrlPolicyResult = { ok: true; url: string; local: boolean } | { ok: false; reason: UrlPolicyReason; message: string }

/** URL policy options. */
export interface UrlPolicyOptions {
  /** The Advanced toggle: accept `http://` for private addresses. Default false. */
  allowHttpLocal?: boolean
}

/** `scheme://[user@]host[:port][/path]` → parts, or null. Hosts: DNS names, IPv4, bracketed IPv6. */
export function parseUrl(input: string): { scheme: string; host: string; port: number | null; hasCredentials: boolean; rest: string } | null {
  const s = input.trim()
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([/?#].*)?$/i.exec(s)
  if (!m) return null
  let authority = m[2]!
  const hasCredentials = authority.includes('@')
  if (hasCredentials) authority = authority.slice(authority.lastIndexOf('@') + 1)
  let host: string
  let portText: string | undefined
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(authority)
  if (v6) {
    host = v6[1]!.toLowerCase()
    portText = v6[2]
  } else {
    const i = authority.lastIndexOf(':')
    if (i >= 0) {
      host = authority.slice(0, i).toLowerCase()
      portText = authority.slice(i + 1)
      if (!/^\d+$/.test(portText)) return null
    } else host = authority.toLowerCase()
  }
  if (!host || /[\s]/.test(host)) return null
  const port = portText === undefined || portText === '' ? null : Number(portText)
  if (port !== null && (port < 1 || port > 65535)) return null
  return { scheme: m[1]!.toLowerCase(), host, port, hasCredentials, rest: m[3] ?? '' }
}

const ipv4 = (host: string): number[] | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
  return parts.every((n) => n <= 255) ? parts : null
}

/** localhost, 127/8, 10/8, 172.16/12, 192.168/16, `*.local`, IPv6 loopback / unique-local / link-local. */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase()
  if (h === 'localhost' || h.endsWith('.localhost') || h === '0.0.0.0') return true
  if (h.endsWith('.local')) return true
  const v4 = ipv4(h)
  if (v4) {
    const [a, b] = v4 as [number, number, number, number]
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  if (h.includes(':')) {
    if (h === '::1' || h === '::') return true
    const first = h.split(':')[0]!
    return /^f[cd][0-9a-f]{0,2}$/.test(first) || /^fe[89ab][0-9a-f]?$/.test(first)
  }
  return false
}

/** Apply the policy to one endpoint URL. */
export function checkRpcUrl(input: string, opts: UrlPolicyOptions = {}): UrlPolicyResult {
  const p = parseUrl(input)
  if (!p) return { ok: false, reason: 'not-a-url', message: 'Enter a full URL, like https://rpc.example.org.' }
  if (p.hasCredentials) return { ok: false, reason: 'credentials', message: 'Credentials in the URL are not allowed — use a keyed path or header instead.' }
  const local = isPrivateHost(p.host)
  if (p.scheme === 'https') return { ok: true, url: input.trim(), local }
  if (p.scheme !== 'http') return { ok: false, reason: 'scheme', message: 'Only https:// endpoints are accepted.' }
  if (!local) return { ok: false, reason: 'http-not-local', message: 'http:// is only accepted for local nodes (localhost, 10.x, 172.16–31.x, 192.168.x, *.local).' }
  if (!opts.allowHttpLocal) return { ok: false, reason: 'http-not-allowed', message: 'Turn on "Allow http for local nodes" in Advanced to use a plain-http local endpoint.' }
  return { ok: true, url: input.trim(), local }
}

/** Every URL in the list passes the policy; returns the normalised list or the first failure. */
export function checkRpcUrls(urls: readonly string[], opts: UrlPolicyOptions = {}): { ok: true; urls: string[] } | { ok: false; url: string; reason: UrlPolicyReason; message: string } {
  const out: string[] = []
  for (const u of urls) {
    const r = checkRpcUrl(u, opts)
    if (!r.ok) return { ok: false, url: u, reason: r.reason, message: r.message }
    if (!out.includes(r.url)) out.push(r.url)
  }
  return { ok: true, urls: out }
}
