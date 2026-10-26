#!/usr/bin/env node
/**
 * Publish every workspace package whose current version is not on npm yet.
 *
 *   node scripts/publish.mjs [--dry-run]                    pack + publish (local use)
 *   node scripts/publish.mjs --pack-only --out <dir>         pack what is not on npm into <dir> (+ manifest.json)
 *   node scripts/publish.mjs --from <dir> [--dry-run]        publish the tarballs packed into <dir>
 *
 * The release workflow splits the two halves (audit 2026-10-25 round 3, M28): an unprivileged job
 * installs, builds and packs; the publish job — the only one holding the OIDC token — runs no
 * install and no build, only `npm publish <tarball> --provenance --ignore-scripts` over what the
 * pack job produced. Each package is packed by pnpm (workspace ranges become real versions);
 * dependencies go before their dependents. Prints the tags to push for what was published
 * (`@anywalletkit/<name>@<version>`) into $GITHUB_OUTPUT when set.
 *
 * Run `pnpm build` and `pnpm pack:check` first; bump versions with
 * `pnpm changeset version` before a release.
 */
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const packOnly = argv.includes('--pack-only')
const valueOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? resolve(argv[i + 1]) : null }
const outDir = valueOf('--out')
const fromDir = valueOf('--from')
if (packOnly && !outDir) throw new Error('--pack-only needs --out <dir>')
if (argv.includes('--from') && !fromDir) throw new Error('--from needs a directory')
const inCi = process.env.GITHUB_ACTIONS === 'true'

const onNpm = (name, version) => {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch (e) {
    if (String(e.stderr).includes('E404')) return false
    throw new Error(`npm view ${name}@${version} failed: ${String(e.stderr).trim()}`)
  }
}

/** The workspace's public packages, dependencies first: [{ name, version, dir, deps }]. */
function workspacePackages () {
  const pkgs = new Map()
  for (const dir of readdirSync(join(root, 'packages'))) {
    const pkg = JSON.parse(readFileSync(join(root, 'packages', dir, 'package.json'), 'utf8'))
    if (!pkg.private) pkgs.set(pkg.name, { dir: join(root, 'packages', dir), pkg })
  }
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
  return order.map((name) => {
    const { dir, pkg } = pkgs.get(name)
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }).filter((d) => pkgs.has(d))
    return { name, version: pkg.version, dir, deps }
  })
}

const pack = (dir, dest) => execFileSync('pnpm', ['pack', '--pack-destination', dest], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  .trim().split('\n').pop().trim()

const published = []
const skipped = []
// One package npm refuses (a broken trusted-publisher config, a 2FA policy) must not hold back the
// rest: it is recorded, every package that depends on it is held back, and the run fails at the end.
const failed = new Map()

function publishOne (entry, tarball) {
  const blockedBy = entry.deps.filter((d) => failed.has(d))
  if (blockedBy.length) {
    failed.set(entry.name, `held back: depends on ${blockedBy.join(', ')}`)
    console.log(`held back ${entry.name}@${entry.version} (depends on ${blockedBy.join(', ')})`)
    return
  }
  try {
    // --ignore-scripts: a tarball's lifecycle scripts never run in the job that holds the OIDC token.
    const args = ['publish', tarball, '--access', 'public', '--ignore-scripts']
    if (inCi) args.push('--provenance')          // provenance needs the workflow's OIDC token
    if (dryRun) args.push('--dry-run')
    execFileSync('npm', args, { stdio: ['ignore', 'pipe', 'inherit'] })
    published.push(`${entry.name}@${entry.version}`)
    console.log(`${dryRun ? 'would publish' : 'published'} ${entry.name}@${entry.version}`)
  } catch (e) {
    failed.set(entry.name, `npm publish failed (exit ${e.status ?? '?'})`)
    console.log(`FAILED ${entry.name}@${entry.version}: npm publish failed — see npm's error above`)
  }
}

if (packOnly) {
  // Unprivileged half: pack what is not on npm yet, in order, and say so in manifest.json.
  mkdirSync(outDir, { recursive: true })
  const manifest = []
  for (const entry of workspacePackages()) {
    if (onNpm(entry.name, entry.version)) { skipped.push(`${entry.name}@${entry.version}`); continue }
    const file = pack(entry.dir, outDir)
    manifest.push({ name: entry.name, version: entry.version, deps: entry.deps, file: file.split('/').pop() })
    console.log(`packed ${entry.name}@${entry.version}`)
  }
  writeFileSync(join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n')
  console.log(`\n${manifest.length} packed, ${skipped.length} already on npm`)
} else if (fromDir) {
  // Privileged half: no install, no build — the tarballs the pack job produced, in its order.
  const manifest = JSON.parse(readFileSync(join(fromDir, 'manifest.json'), 'utf8'))
  for (const entry of manifest) {
    if (typeof entry.file !== 'string' || !/^[a-z0-9._-]+\.tgz$/i.test(entry.file)) throw new Error(`manifest: bad file name ${String(entry.file)}`)
    if (!/^@anywalletkit\/[a-z0-9-]+$/.test(entry.name)) throw new Error(`manifest: not one of ours: ${String(entry.name)}`)
    if (onNpm(entry.name, entry.version)) { skipped.push(`${entry.name}@${entry.version}`); continue }
    publishOne(entry, join(fromDir, entry.file))
  }
} else {
  const out = mkdtempSync(join(tmpdir(), 'awk-publish-'))
  try {
    for (const entry of workspacePackages()) {
      if (onNpm(entry.name, entry.version)) { skipped.push(`${entry.name}@${entry.version}`); continue }
      if (entry.deps.some((d) => failed.has(d))) { publishOne(entry, ''); continue }
      let tarball
      try { tarball = pack(entry.dir, out) } catch (e) { failed.set(entry.name, `pnpm pack failed (exit ${e.status ?? '?'})`); continue }
      publishOne(entry, tarball)
    }
  } finally {
    rmSync(out, { recursive: true, force: true })
  }
}

if (!packOnly) {
  console.log(`\n${dryRun ? 'dry run: ' : ''}${published.length} to publish, ${skipped.length} already on npm, ${failed.size} failed or held back`)
  for (const [name, why] of failed) console.log(`  ${name}: ${why}`)
  if (process.env.GITHUB_OUTPUT && !dryRun) appendFileSync(process.env.GITHUB_OUTPUT, `tags=${published.join(' ')}\n`)
  if (failed.size) process.exitCode = 1
}
