'use strict'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

import { buildByteCases } from './byte-cases.js'

// Captured from the module before the @solana/* 8.x move (origin/main 902b85b7, @solana/addresses,
// instructions, transactions and transaction-messages 3.0.3). Any difference is a change of what the
// wallet signs: derived addresses, account metas, instruction data or the compiled v0 message.
const EXPECTED = JSON.parse(readFileSync(new URL('./instruction-bytes.json', import.meta.url), 'utf8'))
const actual = await buildByteCases()

test('derived addresses: withdraw authority, ATAs, unstake seed slots, validator stake PDAs', () => {
  assert.deepEqual(actual.derivations, EXPECTED.derivations)
})

for (const name of Object.keys(EXPECTED.encoders)) {
  test(`encoder bytes: ${name}`, () => {
    assert.deepEqual(actual.encoders[name], EXPECTED.encoders[name])
  })
}

for (const name of Object.keys(EXPECTED.flows)) {
  test(`operation bytes: ${name} (instructions and compiled v0 message)`, () => {
    assert.deepEqual(actual.flows[name].instructions, EXPECTED.flows[name].instructions)
    assert.equal(actual.flows[name].message, EXPECTED.flows[name].message)
  })
}

test('the fixture covers every case the builder produces', () => {
  assert.deepEqual(Object.keys(actual.encoders).sort(), Object.keys(EXPECTED.encoders).sort())
  assert.deepEqual(Object.keys(actual.flows).sort(), Object.keys(EXPECTED.flows).sort())
})
