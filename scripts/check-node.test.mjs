import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nodeProblem } from './check-node.mjs'

test('patched lines pass, older patches and dead lines fail', () => {
  for (const v of ['v22.23.4', 'v22.24.0', 'v24.22.1', 'v24.23.0', 'v26.12.1', 'v27.0.0']) assert.equal(nodeProblem(v), null, v)
  for (const v of ['v22.23.3', 'v24.21.0', 'v24.22.0', 'v26.12.0', 'v20.20.2', 'v23.11.1', 'v25.9.0', 'v18.20.8']) assert.ok(nodeProblem(v), v)
  assert.match(nodeProblem('v24.21.0'), /below 24\.22\.1/)
  assert.match(nodeProblem('v20.20.2'), /no security fixes/)
  assert.ok(nodeProblem('24.x'))
})
