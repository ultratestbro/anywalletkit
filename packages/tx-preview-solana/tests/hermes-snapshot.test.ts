/**
 * Pins Node's results for the cases the Hermes smoke runs (`examples/hermes-smoke/tx-preview-solana.ts`), so the VM's
 * results can be compared string for string. `UPDATE_HERMES=1` rewrites the file after an intended change.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import * as api from '../src/index.js'
import { hermesCases } from './hermes-cases.js'

const file = fileURLToPath(new URL('./hermes-expected.json', import.meta.url))

it('the Hermes smoke cases match the pinned Node results', () => {
  const now = hermesCases(api)
  if (process.env.UPDATE_HERMES === '1' || !existsSync(file)) writeFileSync(file, JSON.stringify(now, null, 1) + '\n')
  expect(now).toEqual(JSON.parse(readFileSync(file, 'utf8')))
  expect(Object.keys(now).length).toBeGreaterThanOrEqual(15)
})
