// node --test scripts/release-order.test.mjs — review 2026-11-26 round 2 (R2-2): one `changeset version` over the 0x
// patch (0.1.6, the Settler pins apps on ^0.1.5 need) and the Monad minor writes 0.2.0 only. publish.mjs holds a version
// back until the one scripts/release-order.json says it needs is on npm.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, loadReleaseOrder, parseReleaseOrder, releaseOrderBlock } from './release-order.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ZX = '@anywalletkit/protocol-swap2-0x'
// The rule the 2026-11-27 release ran with (dropped from release-order.json once 0.1.6 and 0.2.0 were both on npm):
// the tests keep it as their fixture.
const RULE = { package: ZX, from: '0.2.0', needs: '0.1.6', why: '0.1.6 raises the Settler pins to 0x\'s 2026-11-24 deployments for apps on ^0.1.5; version and publish it alone, before the minor that adds Monad' }
const rules = parseReleaseOrder({ rules: [RULE] })

test('the checked-in release-order file parses', () => {
  assert.ok(Array.isArray(loadReleaseOrder(join(here, 'release-order.json'))))
})

test('the 0x Monad minor waits for the 0.1.6 pins patch on npm', () => {
  const none = () => false
  const all = () => true
  const asked = []
  const only016 = (name, version) => { asked.push(`${name}@${version}`); return name === ZX && version === '0.1.6' }
  // one `changeset version` over both changesets: 0.1.5 → 0.2.0, no 0.1.6 on npm — held back
  assert.match(releaseOrderBlock({ name: ZX, version: '0.2.0' }, rules, none), /^@anywalletkit\/protocol-swap2-0x@0\.1\.6 must be on npm before 0\.2\.0: /)
  assert.match(releaseOrderBlock({ name: ZX, version: '0.2.3' }, rules, none), /must be on npm before 0\.2\.3/, 'any later version too')
  // the patch itself, an older version, another package: never held back
  for (const entry of [{ name: ZX, version: '0.1.6' }, { name: ZX, version: '0.1.7' }, { name: '@anywalletkit/protocol-swap2-across', version: '0.9.0' }]) assert.equal(releaseOrderBlock(entry, rules, none), null, JSON.stringify(entry))
  // in order: 0.1.6 published, then 0.2.0
  assert.equal(releaseOrderBlock({ name: ZX, version: '0.2.0' }, rules, only016), null)
  assert.deepEqual(asked, [`${ZX}@0.1.6`])
  assert.equal(releaseOrderBlock({ name: ZX, version: '0.2.0' }, rules, all), null)
})

test('a malformed release-order file throws instead of dropping a rule; versions compare as numbers', () => {
  const ok = { package: ZX, from: '0.2.0', needs: '0.1.6', why: 'x' }
  assert.deepEqual(parseReleaseOrder({ rules: [ok] }), [ok])
  for (const bad of [{}, { rules: {} }, { rules: [{ ...ok, package: 'left-pad' }] }, { rules: [{ ...ok, from: '0.2' }] }, { rules: [{ ...ok, needs: '0.2.0' }] }, { rules: [{ ...ok, needs: '0.3.0' }] }, { rules: [{ ...ok, why: ' ' }] }]) {
    assert.throws(() => parseReleaseOrder(bad), /release-order/, JSON.stringify(bad))
  }
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1)
  assert.equal(compareVersions('0.1.6', '0.2.0'), -1)
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0)
  assert.throws(() => compareVersions('0.2.0-beta.1', '0.2.0'), /plain x\.y\.z/)
})

test('publish.mjs holds the version back (pack-only and dry run) and fails the run: nothing is packed or published', async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, chmodSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')
  const root = mkdtempSync(join(tmpdir(), 'release-order-'))
  mkdirSync(join(root, 'scripts'))
  for (const f of ['publish.mjs', 'release-order.mjs']) copyFileSync(join(here, f), join(root, 'scripts', f))
  writeFileSync(join(root, 'scripts/release-order.json'), JSON.stringify({ rules: [RULE] }))
  mkdirSync(join(root, 'packages/protocol-swap2-0x'), { recursive: true })
  writeFileSync(join(root, 'packages/protocol-swap2-0x/package.json'), JSON.stringify({ name: ZX, version: '0.2.0' }))
  // npm: nothing is on the registry (E404); pnpm must never be called (a held-back package is not packed)
  const bin = join(root, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "npm error code E404" >&2\nexit 1\n')
  writeFileSync(join(bin, 'pnpm'), `#!/bin/sh\ntouch "${join(root, 'pnpm-called')}"\nexit 1\n`)
  chmodSync(join(bin, 'npm'), 0o755)
  chmodSync(join(bin, 'pnpm'), 0o755)
  const env = { PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin` }
  for (const args of [['--pack-only', '--out', join(root, 'out')], ['--dry-run']]) {
    const r = spawnSync(process.execPath, [join(root, 'scripts/publish.mjs'), ...args], { env, encoding: 'utf8' })
    assert.equal(r.status, 1, `${args[0]}: ${r.stdout}${r.stderr}`)
    assert.match(r.stdout, /^held back @anywalletkit\/protocol-swap2-0x@0\.2\.0 \(@anywalletkit\/protocol-swap2-0x@0\.1\.6 must be on npm before 0\.2\.0: /m, args[0])
    assert.equal(existsSync(join(root, 'pnpm-called')), false, `${args[0]}: nothing is packed`)
  }
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'out/manifest.json'), 'utf8')), [])
})
