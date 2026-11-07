import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ActivityFixtureJson } from '@anywalletkit/conformance'

const dir = fileURLToPath(new URL('../fixtures/activity/', import.meta.url))

/** Recorded activity fixtures (`.`) or negatives (`negatives`), sorted by file name. */
export const loadFixtures = (sub: '.' | 'negatives'): ActivityFixtureJson[] =>
  readdirSync(join(dir, sub)).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, sub, f), 'utf8')) as ActivityFixtureJson)

/** One fixture by file name. */
export const fixture = (file: string): ActivityFixtureJson => JSON.parse(readFileSync(join(dir, file), 'utf8')) as ActivityFixtureJson
