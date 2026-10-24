import { describe, expect, it, vi } from 'vitest'
import type { IntentStatus } from '@forgewallet/protocol-swap2-core'
import { SwapTracker, SwapsStore, memoryJsonStorage, parseSwapId, type SwapRecord } from '../src/index.js'

const base = { provider: 'cctp', fromChain: 'eip155:1', toChain: 'eip155:8453', fromToken: 'USDC', toToken: 'USDC', amountIn: '1000000', destAmount: '999000', recipient: '0xabc', sourceTxHash: '0xsrc' }

function harness() {
  let t = 1_000_000
  const store = new SwapsStore(memoryJsonStorage<SwapRecord[]>())
  const alarm = { running: false, start: vi.fn(() => { alarm.running = true }), stop: vi.fn(() => { alarm.running = false }) }
  const answers = new Map<string, IntentStatus | Error>()
  const status = vi.fn(async (r: SwapRecord) => { const a = answers.get(r.id); if (!a) throw new Error('no answer'); if (a instanceof Error) throw a; return a })
  const tracker = new SwapTracker({ store, status, alarm, now: () => t, giveUpAfterMs: 60_000 })
  return { store, alarm, answers, status, tracker, tick: (ms: number) => { t += ms } }
}

describe('parseSwapId', () => {
  it('decodes the swap2 id with and without the source hash', () => {
    expect(parseSwapId('awk1.cctp.42.0xsrc')).toEqual({ provider: 'cctp', intentId: '42', sourceTxHash: '0xsrc' })
    expect(parseSwapId('awk1.near_intents.dep%2Fosit')).toEqual({ provider: 'near_intents', intentId: 'dep/osit' })
    expect(parseSwapId('xyz1.cctp.42')).toBeNull()
    expect(parseSwapId('awk2.x.y')).toBeNull()
    expect(parseSwapId('awk1.x')).toBeNull()
  })
})

describe('SwapsStore', () => {
  it('persists, lists newest first, updates, filters active', async () => {
    const storage = memoryJsonStorage<SwapRecord[]>()
    const store = new SwapsStore(storage)
    const changes = vi.fn()
    store.onChange(changes)
    const r = (id: string, createdAt: number, status: SwapRecord['status'] = 'pending'): SwapRecord => ({ ...base, id, status, destTxHash: null, createdAt, updatedAt: createdAt, checks: 0 })
    await store.add(r('awk1.cctp.1', 1))
    await store.add(r('awk1.cctp.2', 2, 'completed'))
    expect((await store.list()).map((x) => x.id)).toEqual(['awk1.cctp.2', 'awk1.cctp.1'])
    expect((await store.active()).map((x) => x.id)).toEqual(['awk1.cctp.1'])
    expect(await store.update('awk1.cctp.1', { status: 'failed' })).toMatchObject({ status: 'failed' })
    expect(await store.update('nope', {})).toBeNull()
    expect(await store.active()).toEqual([])
    expect((await new SwapsStore(storage).list())).toHaveLength(2) // survives a "worker restart"
    await store.remove('awk1.cctp.2')
    expect(await store.list()).toHaveLength(1)
    expect(changes).toHaveBeenCalledTimes(4)
  })
})

describe('SwapTracker', () => {
  it('pending → deposit seen → completed with the destination hash; alarm stops when nothing is active', async () => {
    const h = harness()
    await h.tracker.track({ ...base, id: 'awk1.near_intents.a' })
    expect(h.alarm.start).toHaveBeenCalledTimes(1)
    h.answers.set('awk1.near_intents.a', { state: 'pending' })
    await h.tracker.tick()
    expect(await h.store.get('awk1.near_intents.a')).toMatchObject({ status: 'pending', checks: 1 })
    h.answers.set('awk1.near_intents.a', { state: 'pending', depositReceived: true })
    await h.tracker.tick()
    expect(await h.store.get('awk1.near_intents.a')).toMatchObject({ status: 'pending', depositReceived: true, checks: 2 })
    expect(h.alarm.stop).not.toHaveBeenCalled()
    h.answers.set('awk1.near_intents.a', { state: 'completed', destTxHash: '0xdest' })
    await h.tracker.tick()
    expect(await h.store.get('awk1.near_intents.a')).toMatchObject({ status: 'completed', destTxHash: '0xdest', checks: 3 })
    expect(h.alarm.stop).toHaveBeenCalledTimes(1)
    await h.tracker.tick() // nothing active: stop again, no status call
    expect(h.status).toHaveBeenCalledTimes(3)
  })

  it('CCTP: attested → action-required (claim ready) → claiming after the user claims → completed when the mint is seen', async () => {
    const h = harness()
    await h.tracker.track({ ...base, id: 'awk1.cctp.b.0xsrc' })
    h.answers.set('awk1.cctp.b.0xsrc', { state: 'pending', claim: { chain: 'eip155:8453', ready: false } })
    await h.tracker.tick()
    expect(await h.store.get('awk1.cctp.b.0xsrc')).toMatchObject({ status: 'pending', claim: { ready: false } })
    h.answers.set('awk1.cctp.b.0xsrc', { state: 'action-required', claim: { chain: 'eip155:8453', ready: true } })
    await h.tracker.tick()
    expect(await h.store.get('awk1.cctp.b.0xsrc')).toMatchObject({ status: 'action-required', claim: { chain: 'eip155:8453', ready: true } })
    await h.tracker.claimed('awk1.cctp.b.0xsrc', '0xclaim')
    expect(await h.store.get('awk1.cctp.b.0xsrc')).toMatchObject({ status: 'claiming', destTxHash: '0xclaim' })
    // the provider has not seen the mint yet: still claiming, not back to action-required
    await h.tracker.tick()
    expect(await h.store.get('awk1.cctp.b.0xsrc')).toMatchObject({ status: 'claiming' })
    h.answers.set('awk1.cctp.b.0xsrc', { state: 'completed', destTxHash: '0xclaim' })
    await h.tracker.tick()
    expect(await h.store.get('awk1.cctp.b.0xsrc')).toMatchObject({ status: 'completed' })
    expect(h.alarm.running).toBe(false)
  })

  it('tracker errors keep the record and note them; no progress past the give-up window → expired; failed/refunded are final', async () => {
    const h = harness()
    await h.tracker.track({ ...base, id: 'awk1.lifi.c' })
    await h.tracker.track({ ...base, id: 'awk1.lifi.d' })
    h.answers.set('awk1.lifi.c', new Error('HTTP 503'))
    h.answers.set('awk1.lifi.d', { state: 'refunded' })
    await h.tracker.tick()
    expect(await h.store.get('awk1.lifi.c')).toMatchObject({ status: 'pending', lastError: 'HTTP 503', checks: 1 })
    expect(await h.store.get('awk1.lifi.d')).toMatchObject({ status: 'refunded' })
    h.answers.set('awk1.lifi.c', { state: 'pending' })
    await h.tracker.tick()
    expect((await h.store.get('awk1.lifi.c'))!.lastError).toBeUndefined()
    h.answers.set('awk1.lifi.c', new Error('HTTP 503'))
    h.tick(61_000)
    await h.tracker.tick()
    expect(await h.store.get('awk1.lifi.c')).toMatchObject({ status: 'expired', lastError: 'HTTP 503' })
    expect(await h.store.active()).toEqual([])
    expect(h.alarm.running).toBe(false)
    // concurrent ticks coalesce into one run
    await h.tracker.track({ ...base, id: 'awk1.lifi.e' })
    h.answers.set('awk1.lifi.e', { state: 'pending' })
    await Promise.all([h.tracker.tick(), h.tracker.tick(), h.tracker.tick()])
    expect((await h.store.get('awk1.lifi.e'))!.checks).toBe(1)
  })
})
