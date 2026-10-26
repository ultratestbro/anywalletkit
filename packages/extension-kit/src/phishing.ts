/**
 * Phishing / impersonation checks on a page's host, against a SHIPPED list
 * (never fetched at runtime — decision 10). The list format is MetaMask's
 * eth-phishing-detect `config.json`: `blacklist` / `whitelist` (hosts; a listed
 * domain covers its subdomains), `fuzzylist` + `tolerance` (well-known hosts a
 * lookalike is measured against by Levenshtein distance). On top: punycode
 * (`xn--`) labels are flagged, because mixed-script lookalikes are the common
 * impersonation shape.
 */
export interface PhishingList {
  version?: number
  tolerance?: number
  blacklist: readonly string[]
  whitelist?: readonly string[]
  fuzzylist?: readonly string[]
  /** The wallet's own additions to the fuzzylist (the big dApps our users visit): same semantics. */
  extraFuzzylist?: readonly string[]
}

export interface HostCheck {
  host: string
  /** On the blocklist (or a subdomain of a listed domain): refuse to inject / connect. */
  blocked: boolean
  /** Human lines for the approval window; empty when nothing is odd. */
  warnings: string[]
}

export class PhishingDetector {
  private readonly black: Set<string>
  private readonly white: Set<string>
  private readonly fuzzy: string[]
  private readonly tolerance: number

  constructor(list: PhishingList) {
    this.black = new Set(list.blacklist.map(normalizeHost))
    this.white = new Set((list.whitelist ?? []).map(normalizeHost))
    this.fuzzy = [...new Set([...(list.fuzzylist ?? []), ...(list.extraFuzzylist ?? [])].map(normalizeHost))]
    this.tolerance = list.tolerance ?? 1
  }

  get size(): number {
    return this.black.size
  }

  check(hostOrOrigin: string): HostCheck {
    const host = hostOf(hostOrOrigin)
    const warnings: string[] = []
    if (!host) return { host, blocked: false, warnings }
    if (matchesList(host, this.white)) return { host, blocked: false, warnings }
    if (matchesList(host, this.black)) return { host, blocked: true, warnings: ['This site is on the shipped phishing list.'] }
    if (host.split('.').some((l) => l.startsWith('xn--'))) warnings.push('The address uses punycode (xn--): it may imitate another site with look-alike characters.')
    const look = this.lookalike(host)
    if (look) warnings.push(`The address looks like ${look} but is not that site.`)
    else {
      const brand = this.brandInLabel(host)
      if (brand) warnings.push(`The address contains the name of ${brand.known} (“${brand.label}”) but is not that site.`)
    }
    return { host, blocked: false, warnings }
  }

  /**
   * Why `hostOrOrigin` must be refused outright, or `null`: a host on the blocklist (or under a
   * listed domain) and not on the allowlist. Lookalikes and punycode only warn ({@link check}).
   * Wire it as `ApprovalQueueOptions.refuse` and `RouterDeps.refuse`.
   */
  refusal(hostOrOrigin: string): string | null {
    return this.check(hostOrOrigin).blocked ? 'This site is on the wallet\'s phishing list; the wallet refuses its requests.' : null
  }

  /**
   * `metamask.io-login.com`, `app-uniswap.com`, `uniswap.org.evil.net`: a known site's name used as (part of) a label
   * of a host that is not that site. Names shorter than 5 characters are skipped (too many honest matches).
   */
  brandInLabel(host: string): { known: string; label: string } | null {
    const labels = host.split('.')
    for (const known of this.fuzzy) {
      if (host === known || host.endsWith(`.${known}`)) return null
      const name = stripForFuzzy(known).split('.').pop() ?? ''
      if (name.length < 5) continue
      const hit = labels.find((l) => l.includes(name))
      if (hit) return { known, label: hit }
    }
    return null
  }

  /** eth-phishing-detect's fuzzy check: the host (minus the TLD and a www.) within `tolerance` edits of a known one. */
  lookalike(host: string): string | null {
    const probe = stripForFuzzy(host)
    const probeName = probe.split('.').pop() ?? probe
    for (const known of this.fuzzy) {
      if (host === known || host.endsWith(`.${known}`)) return null // the real site or one of its subdomains
      const stripped = stripForFuzzy(known)
      if (levenshtein(probe, stripped) <= this.tolerance) return known // same name on another TLD counts as a lookalike
      // `uniswep.org` vs the listed `app.uniswap.org`: compare the registrable labels too (names ≥ 5 chars)
      const name = stripped.split('.').pop() ?? stripped
      if (name.length >= 5 && name !== probeName && levenshtein(probeName, name) <= this.tolerance) return known
    }
    return null
  }
}

export const normalizeHost = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '')

export function hostOf(hostOrOrigin: string): string {
  try { return normalizeHost(new URL(hostOrOrigin.includes('://') ? hostOrOrigin : `https://${hostOrOrigin}`).hostname) } catch { return normalizeHost(hostOrOrigin) }
}

/** `a.b.c` matches a list containing `a.b.c`, `b.c` (parent) — never `c` alone unless listed. */
function matchesList(host: string, list: Set<string>): boolean {
  const parts = host.split('.')
  for (let i = 0; i < parts.length - 1; i++) if (list.has(parts.slice(i).join('.'))) return true
  return list.has(host)
}

function stripForFuzzy(host: string): string {
  const parts = host.replace(/^www\./, '').split('.')
  if (parts.length > 1) parts.pop() // TLD
  return parts.join('.')
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]!
}
