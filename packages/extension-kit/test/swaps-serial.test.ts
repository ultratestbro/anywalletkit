import { describe, expect, it, vi } from 'vitest'
import type { IntentStatus } from '@anywalletkit/protocol-swap2-core'
import { SwapTracker, SwapsStore, parseSwapId, type JsonStorage, type SwapRecord } from '../src/index.js'

// Audit 2026-10-25 round 3, L2: SwapsStore read the list, changed it and wrote it back with no
// ordering between calls. An alarm tick's `update` that read the list before a just-executed swap
// was `add`ed wrote the old list back: the new swap vanished from the store and was never tracked.

const base = { provider: 'cctp', fromChain: 'eip155:1', toChain: 'eip155:8453', fromToken: 'USDC', toToken: 'USDC', amountIn: '1000000', destAmount: '999000', recipient: '0xabc', sourceTxHash: '0xsrc' }
const rec = (id: string, createdAt: number): SwapRecord => ({ ...base, id, status: 'pending', destTxHash: null, createdAt, updatedAt: createdAt, checks: 0 })

/** chrome.storage.local takes a few ms per write; reads see the last finished write. */
function slowStorage<T>(): JsonStorage<T> & { value: T | null } {
  const s = {
    value: null as T | null,
    async get() { await new Promise((r) => setTimeout(r, 1)); return s.value === null ? null : structuredClone(s.value) },
    async set(value: T) { await new Promise((r) => setTimeout(r, 3)); s.value = structuredClone(value) },
  }
  return s
}

describe('SwapsStore writes one after another', () => {
  it('an update racing an add keeps both: the added swap and the updated one', async () => {
    const storage = slowStorage<SwapRecord[]>()
    const store = new SwapsStore(storage)
    await store.add(rec('awk1.cctp.1', 1))
    await Promise.all([store.update('awk1.cctp.1', { checks: 1 }), store.add(rec('awk1.cctp.2', 2)), store.update('awk1.cctp.1', { status: 'completed' })])
    const ids = storage.value!.map((r) => r.id).sort()
    expect(ids).toEqual(['awk1.cctp.1', 'awk1.cctp.2'])
    expect(storage.value!.find((r) => r.id === 'awk1.cctp.1')).toMatchObject({ checks: 1, status: 'completed' })
  })

  it('a swap tracked while a tick is checking the others is still tracked after the tick', async () => {
    const store = new SwapsStore(slowStorage<SwapRecord[]>())
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const status = vi.fn(async (): Promise<IntentStatus> => { await gate; return { state: 'pending' } })
    const tracker = new SwapTracker({ store, status, alarm: { start: () => undefined, stop: () => undefined } })
    await tracker.track({ ...base, id: 'awk1.cctp.1' })
    const tick = tracker.tick()
    await new Promise((r) => setTimeout(r, 5))
    const added = tracker.track({ ...base, id: 'awk1.cctp.2' })
    release()
    await Promise.all([tick, added])
    expect((await store.list()).map((r) => r.id).sort()).toEqual(['awk1.cctp.1', 'awk1.cctp.2'])
  })

  it('a removal racing an update is not undone', async () => {
    const store = new SwapsStore(slowStorage<SwapRecord[]>())
    await store.add(rec('awk1.cctp.1', 1))
    await Promise.all([store.remove('awk1.cctp.1'), store.update('awk1.cctp.1', { checks: 3 })])
    expect(await store.list()).toEqual([])
  })
})

describe('parseSwapId: the id claimSwap2 returns', () => {
  it('reads the claim hash as the 4th segment', () => {
    expect(parseSwapId('awk1.cctp.42.0xsrc.0xclaim')).toEqual({ provider: 'cctp', intentId: '42', sourceTxHash: '0xsrc', destTxHash: '0xclaim' })
    expect(parseSwapId('awk1.cctp.42.0xsrc.0xclaim.extra')).toBeNull()
  })
})
