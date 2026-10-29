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

/**
 * `scheme://[user@]host[:port][/path]` → parts, or null. Hosts: DNS names, IPv4, bracketed IPv6.
 * A URL with a backslash, a tab, CR/LF or another control character anywhere is refused: a WHATWG parser
 * (browsers, Node, the extension) and OkHttp end the authority at `\` and drop tab/CR/LF, so
 * `https://192.168.1.1\x` would be checked as one host and fetched from another (scan 2026-10-28 F12).
 * `\` also ends the authority here, should the refusal ever be relaxed.
 */
export function parseUrl(input: string): { scheme: string; host: string; port: number | null; hasCredentials: boolean; rest: string } | null {
  const s = input.trim()
  if (/[\x00-\x1f\x7f\\]/.test(s)) return null
  const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#\\]*)([/?#\\].*)?$/i.exec(s)
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

/**
 * An IPv4 literal as a URL parser reads it — 1 to 4 dot-separated parts, each decimal, octal (`0…`)
 * or hex (`0x…`), the last filling the remaining bytes (`127.1`, `2130706433`, `0x7f000001`,
 * `0177.0.0.1` are all 127.0.0.1) — as its 32-bit value; `null` when it is not one.
 */
function ipv4Value(host: string): number | null {
  const parts = host.split('.')
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop()
  if (parts.length === 0 || parts.length > 4) return null
  const values: number[] = []
  for (const p of parts) {
    let v: number
    if (/^0x[0-9a-f]{0,8}$/i.test(p)) v = p.length === 2 ? 0 : parseInt(p.slice(2), 16)
    else if (/^0[0-7]{1,11}$/.test(p)) v = parseInt(p, 8)
    else if (/^(?:0|[1-9][0-9]{0,9})$/.test(p)) v = Number(p)
    else return null
    values.push(v)
  }
  const last = values.pop()!
  if (values.some((v) => v > 255) || last >= 256 ** (4 - values.length)) return null
  return values.reduce((sum, v, i) => sum + v * 256 ** (3 - i), 0) + last
}

/** A host whose last label is a number (or `0x…`) is an IPv4 literal to a URL parser, valid or not. */
const looksNumeric = (host: string): boolean => /^(?:0x[0-9a-f]*|[0-9]+)$/i.test(host.replace(/\.$/, '').split('.').pop() ?? '')

/** 0/8, 10/8, 100.64/10 (CGNAT), 127/8, 169.254/16 (link-local), 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, 224/4 and above. */
function privateV4(v: number): boolean {
  const a = Math.floor(v / 2 ** 24), b = Math.floor(v / 2 ** 16) % 256, c = Math.floor(v / 2 ** 8) % 256
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && c === 0) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19))
}

/** An IPv6 literal (no brackets, no zone) as eight 16-bit groups, an embedded IPv4 tail included; `null` when it is not one. */
function ipv6Groups(host: string): number[] | null {
  let h = host
  let tail: number[] = []
  const v4 = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h)
  if (v4) {
    const v = ipv4Value(v4[2]!)
    if (v === null || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(v4[2]!)) return null
    tail = [Math.floor(v / 65536), v % 65536]
    h = v4[1]!.endsWith('::') ? v4[1]! : v4[1]!.slice(0, -1)
  }
  const halves = h.split('::')
  if (halves.length > 2) return null
  const groups = (part: string) => (part === '' ? [] : part.split(':'))
  const head = groups(halves[0]!), rest = halves.length === 2 ? groups(halves[1]!) : []
  if ([...head, ...rest].some((g) => !/^[0-9a-f]{1,4}$/i.test(g))) return null
  const known = head.length + rest.length + tail.length
  if (halves.length === 1 ? known !== 8 : known > 7) return null
  const zeros = halves.length === 2 ? Array<number>(8 - known).fill(0) : []
  return [...head.map((g) => parseInt(g, 16)), ...zeros, ...rest.map((g) => parseInt(g, 16)), ...tail]
}

/** Private DNS names: localhost, `*.localhost`, `*.local` (mDNS), `*.internal`, `*.home.arpa`, `*.lan`. */
const PRIVATE_NAME = /(?:^|\.)(?:localhost|local|internal|home\.arpa|lan)$/

/**
 * A host the wallet must not be pointed at from outside: the user's own machine or network.
 * Names: localhost, `*.localhost`, `*.local`, `*.internal`, `*.home.arpa`, `*.lan`. IPv4 in every form a
 * URL parser accepts (`127.1`, `2130706433`, `0x7f.0.0.1`): 0/8, 10/8, 100.64/10, 127/8, 169.254/16,
 * 172.16/12, 192.0.0/24, 192.168/16, 198.18/15, multicast and reserved; a numeric host that is no valid
 * IPv4 counts as private too. IPv6: unspecified, loopback, unique-local, link-local, multicast, and the
 * IPv4 inside a mapped (`::ffff:…`), compatible, NAT64 (`64:ff9b::`) or 6to4 (`2002::`) address; and any host
 * that is not printable ASCII, which a URL parser would map to one of these (scan 2026-10-27 modules, F37).
 * A public name that resolves to a private address (DNS rebinding) is not caught here.
 */
export function isPrivateHost(host: string): boolean {
  let h = host.toLowerCase().trim()
  // Not printable ASCII: a URL parser maps fullwidth digits, ideographic full stops and ignorable characters to
  // ASCII (IDNA), so `127.0.0.１` or `ｒｏｕｔｅｒ.ｌａｎ` reaches 127.0.0.1 or router.lan. A name in another script
  // arrives as punycode (`xn--…`), which is ASCII.
  if (!/^[\x21-\x7e]+$/.test(h)) return true
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.includes('%')) return true // an IPv6 zone: link-local by construction
  h = h.replace(/\.$/, '')
  if (!h) return true
  if (h.includes(':')) {
    const g = ipv6Groups(h)
    if (!g) return true
    const zeroUntil = (n: number) => g.slice(0, n).every((x) => x === 0)
    if (zeroUntil(8) || (zeroUntil(7) && g[7] === 1)) return true
    if ((g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xff00) === 0xff00) return true
    if (g[0] === 0x2002) return privateV4(g[1]! * 65536 + g[2]!) // 6to4: the IPv4 in groups 2–3
    const embedded = zeroUntil(5) && g[5] === 0xffff ? true : zeroUntil(6) ? true : g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)
    return embedded ? privateV4(g[6]! * 65536 + g[7]!) : false
  }
  if (PRIVATE_NAME.test(h)) return true
  if (looksNumeric(h)) {
    const v = ipv4Value(h)
    return v === null || privateV4(v)
  }
  return false
}

/**
 * A URL the wallet may fetch from the user's device on behalf of someone else (an ENS gateway, an avatar):
 * https, no credentials, and a public host — no `{…}` template in it, nothing {@link isPrivateHost} names.
 */
export function isPublicHttpsUrl(url: string): boolean {
  const p = parseUrl(url)
  return p !== null && p.scheme === 'https' && !p.hasCredentials && !/[{}]/.test(p.host) && !isPrivateHost(p.host)
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
