#!/usr/bin/env node
// Fails when the Node.js running it misses a security release. CI runs it right after
// setup-node, before install, so tests, docs and the npm publish never run on a Node with
// known holes (setup-node resolves "22" from a manifest that can lag a release).
//
// Oldest fixed patch per supported line, from the 21 Oct 2026 security release
// (https://nodejs.org/en/blog/vulnerability/october-2026-security-releases): Brotli decoder
// out-of-bounds write (CVE-2026-111497), dns.resolve NUL truncation, TLS hostname checks.
// Lines not listed and older than the newest one (20, 23, 25) get no fixes at all.
// Bump the table with each Node security release.

const FIXED = { 22: [23, 4], 24: [22, 1], 26: [12, 1] }
const NEWEST_KNOWN = 26

export function nodeProblem(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!m) return `unreadable Node.js version "${version}"`
  const [major, minor, patch] = m.slice(1).map(Number)
  if (major > NEWEST_KNOWN) return null
  const fix = FIXED[major]
  if (!fix) return `Node.js ${version}: this line gets no security fixes; use 22, 24 or 26`
  if (minor > fix[0] || (minor === fix[0] && patch >= fix[1])) return null
  return `Node.js ${version} is below ${major}.${fix[0]}.${fix[1]} (October 2026 security release)`
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const problem = nodeProblem(process.version)
  if (problem) {
    console.error(`check-node: ${problem}`)
    process.exit(1)
  }
  console.log(`check-node: ${process.version} ok`)
}
