#!/usr/bin/env node
/**
 * Pack every workspace package exactly as `pnpm publish` would and check the
 * tarball before anything reaches npm:
 *   - no `workspace:` / `file:` / `link:` ranges left in any dependency field;
 *   - LICENSE, README.md and package.json are inside;
 *   - every file `main` / `module` / `types` / `exports` points at is inside;
 *   - repository.url + directory match this repo (npm provenance checks them),
 *     publishConfig.access = public and provenance = true.
 * Run after `pnpm build`. Exit 1 on the first package with a problem list.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'git+https://github.com/ultratestbro/anywalletkit.git'
const out = mkdtempSync(join(tmpdir(), 'awk-pack-'))
const problems = []
let packed = 0

const targets = (node, acc = []) => {
  if (typeof node === 'string') acc.push(node)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) targets(v, acc)
  return acc
}

for (const dir of readdirSync(join(root, 'packages')).sort()) {
  const pkgDir = join(root, 'packages', dir)
  const src = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  const where = `${src.name} (packages/${dir})`
  const tgz = execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .trim().split('\n').pop().trim()
  const files = new Set(execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).split('\n').filter(Boolean).map((f) => f.replace(/^package\//, '')))
  const pkg = JSON.parse(execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { encoding: 'utf8' }))
  const bad = []
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, range] of Object.entries(pkg[field] ?? {})) {
      if (/^(workspace|file|link):/.test(range)) bad.push(`${field}.${name} = ${range}`)
    }
  }
  for (const f of ['LICENSE', 'README.md', 'package.json']) if (!files.has(f)) bad.push(`missing ${f}`)
  const entry = [pkg.main, pkg.module, pkg.types, pkg['react-native'], ...targets(pkg.exports)]
    .filter((t) => typeof t === 'string' && t.startsWith('./') || typeof t === 'string' && !t.startsWith('.') && t.includes('/'))
  for (const t of new Set(entry)) {
    if (t.includes('*')) continue
    const rel = t.replace(/^\.\//, '')
    if (!files.has(rel)) bad.push(`entry point not in tarball: ${t}`)
  }
  if (pkg.repository?.url !== REPO) bad.push(`repository.url = ${pkg.repository?.url}`)
  if (pkg.repository?.directory !== `packages/${dir}`) bad.push(`repository.directory = ${pkg.repository?.directory}`)
  if (pkg.publishConfig?.access !== 'public' || pkg.publishConfig?.provenance !== true) bad.push('publishConfig must be { access: public, provenance: true }')
  if (pkg.private) bad.push('private: true')
  if (bad.length) problems.push(`${where}:\n  - ${bad.join('\n  - ')}`)
  packed++
}
rmSync(out, { recursive: true, force: true })
if (problems.length) {
  console.error(problems.join('\n'))
  process.exit(1)
}
console.log(`check-pack: ${packed} packages pack cleanly`)
