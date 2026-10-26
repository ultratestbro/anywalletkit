'use strict'

import assert from 'node:assert/strict'
import { test } from 'node:test'

import SplStakePoolProtocolSolana from '../index.js'

const HOLDER = '9hNaQ3crLjWihWa5BeQgSYfrPY3eoDmHJAX2sTWE8nUC'
const account = (rpc) => ({ async getAddress () { return HOLDER }, ...(rpc ? { _rpc: rpc } : {}) })
const EPOCH = { epoch: 1030, slotIndex: 1, slotsInEpoch: 432_000 }

/**
 * A @solana/kit Rpc as wallet-solana's account carries it (`account._rpc`): a proxy on which EVERY
 * property is an RPC method — `request` included — returning a pending request with `.send()`.
 */
function kitRpc (answers, seen = []) {
  return new Proxy({}, {
    get: (_t, method) => (...params) => ({
      send: async ({ abortSignal } = {}) => { seen.push({ method, params, abortSignal }); return answers[method] }
    })
  })
}

// Audit 2026-10-25 round 3, open item: the default provider (the account's own kit Rpc) was taken
// for an EIP-1193-style `{ request(method, params) }` because the proxy answers `request` too: the
// call returned a pending-request object instead of the result.
test('the account\'s kit Rpc is called as a kit Rpc, not as { request }', async () => {
  const seen = []
  const p = new SplStakePoolProtocolSolana(account(kitRpc({ getEpochInfo: EPOCH }, seen)))
  assert.equal((await p.getEpochInfo()).epoch, 1030n)
  assert.equal(seen[0].method, 'getEpochInfo')
})

// M32: no RPC call had a timeout: one silent endpoint hung every read (and the failover never ran).
test('a silent endpoint times out and the next one answers', async () => {
  const p = new SplStakePoolProtocolSolana(account(), {
    timeoutMs: 50,
    provider: [
      { request: () => new Promise(() => {}) }, // never answers
      { async request (method) { if (method === 'getEpochInfo') return EPOCH; throw Object.assign(new Error('x'), { final: true }) } }
    ]
  })
  const started = Date.now()
  assert.equal((await p.getEpochInfo()).epoch, 1030n)
  assert.ok(Date.now() - started < 2_000)
})

test('a kit Rpc gets an abort signal; a URL provider is fetched with one', async () => {
  const seen = []
  const p = new SplStakePoolProtocolSolana(account(kitRpc({ getEpochInfo: EPOCH }, seen)), { timeoutMs: 1_000 })
  await p.getEpochInfo()
  assert.ok(seen[0].abortSignal instanceof AbortSignal)

  const realFetch = globalThis.fetch
  let signal
  globalThis.fetch = async (_url, init) => { signal = init.signal; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: EPOCH })) }
  try {
    await new SplStakePoolProtocolSolana(account(), { provider: 'https://rpc.example', timeoutMs: 1_000 }).getEpochInfo()
  } finally {
    globalThis.fetch = realFetch
  }
  assert.ok(signal instanceof AbortSignal)
})

test('every endpoint silent: the call fails within the timeout instead of hanging', async () => {
  const p = new SplStakePoolProtocolSolana(account(), { timeoutMs: 30, provider: [{ request: () => new Promise(() => {}) }] })
  await assert.rejects(() => p.getEpochInfo(), /timed? ?out|did not answer/i)
})
