/**
 * Sign-In with Ethereum (EIP-4361) messages, parsed so the sheet can say what a
 * `personal_sign` really is and check the fields a phishing site would lie
 * about: the domain (scheme + host) must be the site asking, the address must
 * be the signing account, the chain must be the site's, the message must not be
 * expired or not-yet-valid, and the nonce must look like one (replay).
 *
 * Everything here is a WARNING: the sheet turns problems into warn checks and
 * the user can still sign. Whenever the first line is an EIP-4361 header the
 * text is treated as a sign-in (scan F9) — a message whose remaining fields do
 * not parse is reported as malformed instead of silently becoming a plain
 * message without the cross-site check.
 */
import type { OriginVia } from './approvals.js'

export interface SiweMessage {
  /** As written in the header: `host[:port]`, optionally prefixed by `scheme://`. */
  domain: string
  address: string
  statement?: string
  uri: string
  version: string
  chainId: number
  nonce: string
  issuedAt: string
  expirationTime?: string
  notBefore?: string
  requestId?: string
  resources: string[]
}

export interface SiweInfo {
  message: SiweMessage
  /** Human lines, each a reason the sheet should warn; empty = the sign-in is consistent with the request. */
  problems: string[]
  /** The header said "sign-in" but the rest did not parse as EIP-4361 (`message` then holds what could be read). */
  malformed?: boolean
}

export interface SiweContext {
  /** The page that asked, as the browser recorded it (`https://…`), or a transport pseudo-origin (`wc:<topic>`). */
  origin: string
  /** The signing address. */
  account: string
  /** The site's chain. */
  chainId: number
  now?: number
  /** Transport note for pseudo-origins (WalletConnect): the dApp's claimed URL and what Verify said about it. */
  via?: OriginVia
}

/** First line of an EIP-4361 message; the "Ethereum account" literal is what makes it one. */
const HEADER_LINE = /^(?<domain>[^\n]+?) wants you to sign in with your Ethereum account:(?:\n|$)/
const ADDRESS_LINE = /^0x[0-9a-fA-F]{40}$/
const FIELD = /^([A-Za-z ]+): (.*)$/

interface Parsed { message: SiweMessage; missing: string[] }

/** Tolerant parse: `null` only when the first line is not an EIP-4361 header. */
function parseLoose(text: string): Parsed | null {
  const head = HEADER_LINE.exec(text)
  if (!head?.groups) return null
  const lines = text.slice(head[0].length).split('\n')
  const missing: string[] = []
  const addressLine = lines.shift() ?? ''
  const address = ADDRESS_LINE.test(addressLine) ? addressLine : ''
  if (!address) missing.push('address')
  // Between the address and the `URI:` line: blank lines and at most one statement line.
  // Covers `addr\n\nstatement\n\nURI`, `addr\n\n\nURI` (no statement, the ABNF form) and `addr\n\nURI` (older libraries).
  const uriAt = lines.findIndex((l) => l.startsWith('URI: '))
  const between = (uriAt < 0 ? lines : lines.slice(0, uriAt)).filter((l) => l !== '')
  let statement: string | undefined
  if (uriAt >= 0) {
    if (between.length === 1 && !FIELD.test(between[0]!)) statement = between[0]
    else if (between.length > 0) missing.push('statement layout')
  }
  const fields: Record<string, string> = {}
  const resources: string[] = []
  for (const line of uriAt < 0 ? [] : lines.slice(uriAt)) {
    if (line.startsWith('- ')) { resources.push(line.slice(2)); continue }
    const m = FIELD.exec(line)
    if (m && !(m[1]! in fields)) fields[m[1]!] = m[2]!
  }
  const chainId = Number(fields['Chain ID'])
  if (!fields.URI) missing.push('URI')
  if (!fields.Version) missing.push('Version')
  if (fields['Chain ID'] === undefined || !Number.isInteger(chainId)) missing.push('Chain ID')
  if (!fields.Nonce) missing.push('Nonce')
  if (!fields['Issued At']) missing.push('Issued At')
  const message: SiweMessage = { domain: head.groups.domain!, address, uri: fields.URI ?? '', version: fields.Version ?? '', chainId: Number.isInteger(chainId) ? chainId : NaN, nonce: fields.Nonce ?? '', issuedAt: fields['Issued At'] ?? '', resources }
  if (statement) message.statement = statement
  if (fields['Expiration Time']) message.expirationTime = fields['Expiration Time']
  if (fields['Not Before']) message.notBefore = fields['Not Before']
  if (fields['Request ID']) message.requestId = fields['Request ID']
  return { message, missing }
}

/** `null` when the text is not a well-formed EIP-4361 message (see {@link describeSiwe} for the tolerant form the sheet uses). */
export function parseSiwe(text: string): SiweMessage | null {
  const p = parseLoose(text)
  return p && p.missing.length === 0 ? p.message : null
}

interface Where { scheme: string; host: string }

/** `scheme://host[:port]` or bare `host[:port]` (scheme defaults to https, as EIP-4361 says). */
function whereOf(s: string): Where | null {
  try {
    if (!s.includes('://')) {
      // A URL parser, never fetched — and written as the one dynamic `https://` prefix the extension's host gate knows.
      const host = new URL(`https://${s}`).host.toLowerCase()
      return host ? { scheme: 'https', host } : null
    }
    const u = new URL(s)
    return u.host ? { scheme: u.protocol.replace(/:$/, '').toLowerCase(), host: u.host.toLowerCase() } : null
  } catch { return null }
}

/** A browser origin with a host the wallet can vouch for: http(s) only — `wc:<topic>` and other pseudo-origins have none. */
function originWhere(origin: string): Where | null {
  try {
    const u = new URL(origin)
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.host ? { scheme: u.protocol.slice(0, -1), host: u.host.toLowerCase() } : null
  } catch { return null }
}

/** Loopback / `*.localhost` (dev servers): plain http is normal there, so no scheme warnings. Takes `host[:port]`. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '')
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.localhost')
}

/** The checks; `origin` is the page that asked (as the browser recorded it), `account` the signing address, `chainId` the site's chain. */
export function siweProblems(m: SiweMessage, ctx: SiweContext): string[] {
  const out: string[] = []
  const domain = whereOf(m.domain)
  let site = originWhere(ctx.origin)
  if (!site) {
    // No browser-recorded host (WalletConnect `wc:<topic>`): only a Verify-attested claim naming the same host counts (scan F10).
    const claimed = ctx.via?.verify === 'VALID' && !ctx.via.scam ? whereOf(ctx.via.url) : null
    if (claimed && domain && claimed.host === domain.host) site = claimed
    else out.push(`The wallet cannot verify which site is asking; this sign-in for ${m.domain} may be replayed there.`)
  }
  if (site) {
    // Scheme as well as host (scan F20/F21): an http:// twin of the site must not collect sign-ins valid for the https one.
    const local = isLocalHost(site.host)
    if (site.scheme === 'http' && !local) out.push(`This sign-in is requested by an insecure page (${site.scheme}://${site.host}); anyone on the network can read or change it and replay the signature on the https site.`)
    if (!domain || domain.host !== site.host) out.push(`The sign-in names ${m.domain} but the request comes from ${site.host} — a sign-in meant for another site would be replayable there.`)
    else if (!local && domain.scheme !== site.scheme) out.push(`The sign-in is for ${domain.scheme}://${domain.host} but the request comes from ${site.scheme}://${site.host}.`)
    const uri = m.uri ? whereOf(m.uri) : null
    if (uri && uri.host !== site.host) out.push(`The URI ${m.uri} is not on ${site.host}.`)
    else if (uri && !local && (uri.scheme === 'http' || uri.scheme === 'https') && uri.scheme !== site.scheme) out.push(`The URI ${m.uri} uses ${uri.scheme}:// but the request comes from ${site.scheme}://${site.host}.`)
  }
  if (m.address && m.address.toLowerCase() !== ctx.account.toLowerCase()) out.push(`The sign-in is for ${m.address}, not the account that would sign (${ctx.account}).`)
  if (Number.isInteger(m.chainId) && m.chainId !== ctx.chainId) out.push(`The sign-in is for chain ${m.chainId}; this site is on chain ${ctx.chainId}.`)
  if (m.version && m.version !== '1') out.push(`Unknown SIWE version ${m.version}.`)
  if (m.nonce && (m.nonce.length < 8 || !/^[A-Za-z0-9]+$/.test(m.nonce))) out.push('The nonce is too short to protect against replay.')
  const now = ctx.now ?? Date.now()
  const exp = m.expirationTime ? Date.parse(m.expirationTime) : NaN
  if (m.expirationTime && (Number.isNaN(exp) || exp <= now)) out.push('The sign-in has already expired.')
  const nbf = m.notBefore ? Date.parse(m.notBefore) : NaN
  if (m.notBefore && (Number.isNaN(nbf) || nbf > now)) out.push('The sign-in is not valid yet (Not Before is in the future).')
  if (m.issuedAt) {
    const iat = Date.parse(m.issuedAt)
    if (Number.isNaN(iat)) out.push('Issued At is not a date.')
    else if (iat > now + 5 * 60_000) out.push('Issued At is in the future.')
  }
  return out
}

/** `null` only when the text does not start with an EIP-4361 header; a header with unreadable fields comes back with a "malformed sign-in message" problem. */
export function describeSiwe(text: string, ctx: SiweContext): SiweInfo | null {
  const p = parseLoose(text)
  if (!p) return null
  const problems = siweProblems(p.message, ctx)
  if (p.missing.length === 0) return { message: p.message, problems }
  return { message: p.message, problems: [`This is a malformed sign-in message (EIP-4361): ${p.missing.join(', ')} missing or unreadable — check the site before signing.`, ...problems], malformed: true }
}
