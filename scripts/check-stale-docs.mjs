#!/usr/bin/env node
/**
 * Fails on statements the project has outgrown, so a page cannot keep saying
 * something that stopped being true (2026-10-25: the landing still listed
 * "Public npm" under Next after the npm release). Scans the README, AGENTS.md,
 * every package README, the prompts and the docs pages (not the generated API
 * reference, not CHANGELOGs). Also checks the module and package counts the
 * pages state against the registry and packages/. Run by `pnpm docs:build`.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STALE = [
  [/not (yet )?on npm|not published (yet|to npm)|packages are not (yet )?published/i, 'the packages are on npm'],
  [/\bpublic npm\b/i, 'npm is public — say "on npm"'],
  [/npm (release|publish(ing)?) (is )?(coming|planned|soon)/i, 'the packages are on npm'],
  [/@forgewallet\//, 'the scope is @anywalletkit'],
]
// Counts a page states as facts, checked against their source (2026-10-25 review:
// README said 22 modules and 43 packages while the registry had 23 and the repo 44).
const modules = JSON.parse(readFileSync(join(root, 'registry/modules.json'), 'utf8'))
const COUNTS = [
  [/\b(\d+) modules today\b/, (modules.modules ?? modules).length, 'registry/modules.json lists'],
  [/\bacross (\d+) packages\b/, readdirSync(join(root, 'packages')).length, 'packages/ holds'],
]
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) { if (!['api', 'node_modules', 'dist'].includes(name)) walk(p) }
    else if (/\.(md|mdx)$/.test(name) && name !== 'CHANGELOG.md') files.push(p)
  }
}
files.push(join(root, 'README.md'), join(root, 'AGENTS.md'))
for (const d of readdirSync(join(root, 'packages'))) files.push(join(root, 'packages', d, 'README.md'))
walk(join(root, 'prompts'))
walk(join(root, 'apps/docs/src/content/docs'))
let failed = 0
for (const file of files) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { continue }
  text.split('\n').forEach((line, i) => {
    for (const [re, why] of STALE) {
      if (re.test(line)) { console.error(`check-stale-docs: ${relative(root, file)}:${i + 1}: ${why}\n    ${line.trim().slice(0, 160)}`); failed++ }
    }
    for (const [re, actual, source] of COUNTS) {
      const m = re.exec(line)
      if (m && Number(m[1]) !== actual) { console.error(`check-stale-docs: ${relative(root, file)}:${i + 1}: says ${m[1]}, ${source} ${actual}\n    ${line.trim().slice(0, 160)}`); failed++ }
    }
  })
}
if (failed) { console.error(`check-stale-docs: ${failed} stale statement(s)`); process.exit(1) }
console.log(`check-stale-docs: ${files.length} files clean`)
