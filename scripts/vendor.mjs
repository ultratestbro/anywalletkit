#!/usr/bin/env node
/**
 * Vendor the SDK into a consumer as versioned tarballs, each stamped with the
 * commit it was built from.
 *
 *   node scripts/vendor.mjs --out <dir> [--consumer <package.json>]… [--no-build] [pkg…]
 *
 * For every workspace package (or the named ones — short names like `kit`
 * or full `@forgewallet/kit`):
 *   1. `pnpm run build` (unless --no-build);
 *   2. package.json gets a `forgewallet` field { commit, branch, builtAt, dirty }
 *      — only for the pack, the file is restored afterwards;
 *   3. `pnpm pack` into --out as `forgewallet-<name>-<version>.tgz`; older
 *      tarballs of the same package in --out are removed;
 *   4. --out/manifest.json lists { commit, branch, builtAt, dirty, packages:
 *      { name: { version, file } } } — the consumer reads it to show which
 *      SDK build it runs and to tag its error reports;
 *   5. with --consumer, every `file:…/forgewallet-<name>-<old>.tgz` reference
 *      in that package.json (dependencies and a root's pnpm.overrides) is
 *      pointed at the new tarball (run the consumer's install afterwards).
 *
 * `dirty` is true when the working tree had uncommitted changes under
 * packages/ — such a build is not reproducible from `commit` alone and the
 * stamp says so.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  if (i < 0) return undefined
  const v = args[i + 1]
  args.splice(i, 2)
  return v
}
const opts = (name) => {
  const out = []
  for (let v = opt(name); v !== undefined; v = opt(name)) out.push(v)
  return out
}
const flag = (name) => {
  const i = args.indexOf(name)
  if (i < 0) return false
  args.splice(i, 1)
  return true
}

const out = opt('--out')
const consumers = opts('--consumer')
const noBuild = flag('--no-build')
if (!out) {
  console.error('usage: node scripts/vendor.mjs --out <dir> [--consumer <package.json>]… [--no-build] [pkg…]')
  process.exit(2)
}
const outDir = resolve(out)
mkdirSync(outDir, { recursive: true })

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim()
const commit = git('rev-parse', 'HEAD')
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
const dirty = git('status', '--porcelain', '--', 'packages').length > 0
const builtAt = new Date().toISOString()

const all = readdirSync(join(root, 'packages'))
  .map((d) => join(root, 'packages', d))
  .filter((d) => existsSync(join(d, 'package.json')))
  .map((dir) => ({ dir, pkg: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }))
  .filter(({ pkg }) => !pkg.private)

const wanted = args.map((a) => (a.startsWith('@') ? a : `@forgewallet/${a}`))
const selected = wanted.length ? all.filter(({ pkg }) => wanted.includes(pkg.name)) : all
const missing = wanted.filter((w) => !selected.some(({ pkg }) => pkg.name === w))
if (missing.length) {
  console.error(`unknown package(s): ${missing.join(', ')}`)
  process.exit(2)
}

const tarballName = (pkg) => `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`
const tarballPrefix = (pkg) => `${pkg.name.replace(/^@/, '').replace('/', '-')}-`

const manifestPath = join(outDir, 'manifest.json')
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { packages: {} }
manifest.commit = commit
manifest.branch = branch
manifest.builtAt = builtAt
manifest.dirty = dirty
manifest.packages ??= {}

for (const { dir, pkg } of selected) {
  const pkgPath = join(dir, 'package.json')
  const original = readFileSync(pkgPath, 'utf8')
  if (!noBuild) {
    process.stdout.write(`build ${pkg.name}… `)
    execFileSync('pnpm', ['run', 'build'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  }
  const stamped = { ...pkg, forgewallet: { commit, branch, builtAt, dirty } }
  writeFileSync(pkgPath, JSON.stringify(stamped, null, 2) + '\n')
  try {
    // Drop older tarballs of this package before packing the new one.
    for (const f of readdirSync(outDir)) {
      if (f.startsWith(tarballPrefix(pkg)) && f.endsWith('.tgz') && /^\d/.test(f.slice(tarballPrefix(pkg).length))) rmSync(join(outDir, f))
    }
    execFileSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] })
  } finally {
    writeFileSync(pkgPath, original)
  }
  const file = tarballName(pkg)
  if (!existsSync(join(outDir, file))) throw new Error(`${pkg.name}: expected ${file} in ${outDir}`)
  manifest.packages[pkg.name] = { version: pkg.version, file }
  console.log(`${pkg.name}@${pkg.version} → ${file}`)
}

manifest.packages = Object.fromEntries(Object.entries(manifest.packages).sort(([a], [b]) => a.localeCompare(b)))
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`manifest: ${manifestPath} (${commit.slice(0, 7)}${dirty ? ' DIRTY' : ''} on ${branch})`)

for (const consumer of consumers) {
  const consumerPath = resolve(consumer)
  const text = readFileSync(consumerPath, 'utf8')
  const json = JSON.parse(text)
  const relOut = relative(dirname(consumerPath), outDir).split('\\').join('/')
  let changed = 0
  // dependency tables + a root's pnpm.overrides / overrides / resolutions
  const tables = [json.dependencies, json.devDependencies, json.optionalDependencies, json.overrides, json.resolutions, json.pnpm?.overrides].filter((t) => t && typeof t === 'object')
  for (const table of tables) {
    for (const [name, spec] of Object.entries(table)) {
      const entry = manifest.packages[name]
      if (!entry || typeof spec !== 'string' || !spec.startsWith('file:')) continue
      const next = `file:${relOut}/${entry.file}`
      if (spec !== next) {
        table[name] = next
        changed++
      }
    }
  }
  if (changed) {
    writeFileSync(consumerPath, JSON.stringify(json, null, 2) + '\n')
    console.log(`${consumerPath}: ${changed} file: reference(s) updated — run the consumer's install`)
  } else {
    console.log(`${consumerPath}: references already current`)
  }
}
