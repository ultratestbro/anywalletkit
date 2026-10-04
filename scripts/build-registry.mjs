#!/usr/bin/env node
// Collect every packages/*/module.json into registry/modules.json (sorted, validated).
// Community modules that live in their own repos are listed in registry/external.json
// and merged in. CI fails if a manifest is malformed.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const TYPES = new Set(['swap', 'bridge', 'swidge', 'lending', 'staking', 'approvals', 'fiat'])
const TIERS = new Set(['core', 'verified', 'community', 'deprecated'])

function validate(m, where) {
  const errs = []
  if (!/^@[a-z0-9-]+\/[a-z0-9-]+$/.test(m.name ?? '')) errs.push('name must be a scoped npm name')
  if (!TYPES.has(m.type)) errs.push(`type must be one of ${[...TYPES].join('|')}`)
  if (!Array.isArray(m.chains) || m.chains.length === 0 || !m.chains.every((c) => /^[a-z0-9]+:[A-Za-z0-9*_-]+$/.test(c))) errs.push('chains must be CAIP-2 ids (namespace:reference or namespace:*)')
  if (!TIERS.has(m.tier)) errs.push(`tier must be one of ${[...TIERS].join('|')}`)
  if (!Array.isArray(m.maintainers) || m.maintainers.length === 0) errs.push('at least one maintainer handle is required')
  if (!/^\d+\.(x|\d+)$/.test(m.conformance ?? '')) errs.push('conformance must name the suite version, e.g. "0.x"')
  if (!/^https:\/\//.test(m.repo ?? '')) errs.push('repo must be an https url')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m.addedAt ?? '')) errs.push('addedAt must be YYYY-MM-DD')
  if (errs.length) throw new Error(`${where}: ${errs.join('; ')}`)
}

const modules = []
for (const dir of readdirSync(join(root, 'packages'))) {
  const p = join(root, 'packages', dir, 'module.json')
  if (!existsSync(p)) continue
  const m = JSON.parse(readFileSync(p, 'utf8'))
  validate(m, `packages/${dir}/module.json`)
  modules.push(m)
}
const externalPath = join(root, 'registry', 'external.json')
if (existsSync(externalPath)) for (const m of JSON.parse(readFileSync(externalPath, 'utf8'))) { validate(m, 'registry/external.json'); modules.push(m) }
modules.sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name))
const out = { $schema: './modules.schema.json', generatedAt: new Date().toISOString().slice(0, 10), count: modules.length, modules }
writeFileSync(join(root, 'registry', 'modules.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`registry: ${modules.length} modules → registry/modules.json`)
