#!/usr/bin/env node
/**
 * Publish every workspace package whose current version is not on npm yet.
 *
 *   node scripts/publish.mjs [--dry-run]
 *
 * Each package is packed by pnpm (workspace ranges become real versions) and
 * the tarball is published by npm, which signs provenance and authenticates
 * through GitHub OIDC (trusted publishing) when it runs in the release
 * workflow — so no npm token is needed there. Dependencies go before their
 * dependents. Prints the tags to push for what was published
 * (`@anywalletkit/<name>@<version>`) into $GITHUB_OUTPUT when set.
 *
 * Run `pnpm build` and `pnpm pack:check` first; bump versions with
 * `pnpm changeset version` before a release.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.argv.includes('--dry-run')
const inCi = process.env.GITHUB_ACTIONS === 'true'

const pkgs = new Map()
for (const dir of readdirSync(join(root, 'packages'))) {
  const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
  if (!pkg.private) pkgs.set(pkg.name, { dir: join(root, 'packages', dir), pkg })
}

// dependencies first
const order = []
const seen = new Set()
const visit = (name) => {
  if (seen.has(name)) return
  seen.add(name)
  const { pkg } = pkgs.get(name)
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies })) {
    if (pkgs.has(dep)) visit(dep)
  }
  order.push(name)
}
for (const name of [...pkgs.keys()].sort()) visit(name)

const onNpm = (name, version) => {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch (e) {
    if (String(e.stderr).includes('E404')) return false
    throw new Error(`npm view ${name}@${version} failed: ${String(e.stderr).trim()}`)
  }
}

const out = mkdtempSync(join(tmpdir(), 'awk-publish-'))
const published = []
const skipped = []
// One package npm refuses (a broken trusted-publisher config, a 2FA policy) must not hold back the
// rest: it is recorded, every package that depends on it is held back, and the run fails at the end.
const failed = new Map()
const internalDeps = (pkg) => Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }).filter((d) => pkgs.has(d))
try {
  for (const name of order) {
    const { dir, pkg } = pkgs.get(name)
    if (onNpm(name, pkg.version)) { skipped.push(`${name}@${pkg.version}`); continue }
    const blockedBy = internalDeps(pkg).filter((d) => failed.has(d))
    if (blockedBy.length) {
      failed.set(name, `held back: depends on ${blockedBy.join(', ')}`)
      console.log(`held back ${name}@${pkg.version} (depends on ${blockedBy.join(', ')})`)
      continue
    }
    try {
      const tgz = execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        .trim().split('\n').pop().trim()
      const args = ['publish', tgz, '--access', 'public']
      if (inCi) args.push('--provenance')          // provenance needs the workflow's OIDC token
      if (dryRun) args.push('--dry-run')
      execFileSync('npm', args, { stdio: ['ignore', 'pipe', 'inherit'] })
      published.push(`${name}@${pkg.version}`)
      console.log(`${dryRun ? 'would publish' : 'published'} ${name}@${pkg.version}`)
    } catch (e) {
      failed.set(name, `npm publish failed (exit ${e.status ?? '?'})`)
      console.log(`FAILED ${name}@${pkg.version}: npm publish failed — see npm's error above`)
    }
  }
} finally {
  rmSync(out, { recursive: true, force: true })
}

console.log(`\n${dryRun ? 'dry run: ' : ''}${published.length} to publish, ${skipped.length} already on npm, ${failed.size} failed or held back`)
for (const [name, why] of failed) console.log(`  ${name}: ${why}`)
if (process.env.GITHUB_OUTPUT && !dryRun) appendFileSync(process.env.GITHUB_OUTPUT, `tags=${published.join(' ')}\n`)
if (failed.size) process.exitCode = 1
