// Versions that must not reach npm before another version of the same package has (scripts/release-order.json): a
// minor that would otherwise swallow a patch apps on the previous caret range rely on. scripts/publish.mjs holds such a
// version back — in every mode, so `pnpm release:dry` and the release workflow's dry run fail on it too — until the
// version it needs is on npm. Drop a rule once both versions are out.
//
// One `changeset version` over a pending patch and a pending minor of one package writes the minor only: 0.1.5 + a
// patch + a minor → 0.2.0, no 0.1.6, and apps on ^0.1.5 never get the patch (review 2026-11-26 round 2, R2-2: the 0x
// Settler pins of 0.1.6 and Monad in 0.2.0). The fix for a version held back here is to undo that version commit and
// version twice: the patch alone, release it, then the rest.
import {readFileSync} from 'node:fs'

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

/** -1, 0 or 1: `a` against `b`, both plain x.y.z. */
export function compareVersions (a, b) {
  const pa = VERSION.exec(a), pb = VERSION.exec(b)
  if (!pa || !pb) throw new Error(`release-order: not a plain x.y.z version: ${!pa ? a : b}`)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d) return d < 0 ? -1 : 1
  }
  return 0
}

/** The rules of a release-order file, checked: [{package, from, needs, why}]. A malformed file throws (a typo must not drop a rule). */
export function parseReleaseOrder (json) {
  const rules = json?.rules
  if (!Array.isArray(rules)) throw new Error('release-order: `rules` is not a list')
  for (const r of rules) {
    if (typeof r?.package !== 'string' || !/^@anywalletkit\/[a-z0-9-]+$/.test(r.package)) throw new Error(`release-order: bad package ${JSON.stringify(r?.package)}`)
    for (const k of ['from', 'needs']) if (typeof r[k] !== 'string' || !VERSION.test(r[k])) throw new Error(`release-order: ${r.package}: bad ${k} ${JSON.stringify(r[k])}`)
    if (compareVersions(r.needs, r.from) >= 0) throw new Error(`release-order: ${r.package}: needs ${r.needs} is not older than from ${r.from}`)
    if (typeof r.why !== 'string' || !r.why.trim()) throw new Error(`release-order: ${r.package}: no why`)
  }
  return rules
}

export const loadReleaseOrder = (file) => parseReleaseOrder(JSON.parse(readFileSync(file, 'utf8')))

/**
 * Why `entry` ({name, version}) may not be published yet, or null: a rule for its package with `from` at or below its
 * version names a version (`needs`) that `isOnNpm(name, version)` says is not on npm.
 */
export function releaseOrderBlock (entry, rules, isOnNpm) {
  for (const r of rules) {
    if (r.package !== entry.name || compareVersions(entry.version, r.from) < 0) continue
    if (!isOnNpm(r.package, r.needs)) return `${r.package}@${r.needs} must be on npm before ${entry.version}: ${r.why} (scripts/release-order.json)`
  }
  return null
}
