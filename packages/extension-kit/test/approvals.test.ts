import { describe, expect, it } from 'vitest'
import { APPROVALS_MAX_PENDING_PER_ORIGIN, ApprovalQueue, QueueLimitError, RELAY_ERRORS, ReviewDeclined, memoryApprovalWindow } from '../src/index.js'

const SITE = 'https://dapp.example'
const flush = () => new Promise((r) => setTimeout(r, 0))
const settled = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof QueueLimitError ? `limit:${e.code}` : e instanceof ReviewDeclined ? 'declined' : `other:${String(e)}`))

describe('ApprovalQueue limits (SDK-142 M3)', () => {
  it('one origin may have at most 3 requests waiting; the 4th is refused with -32005 and nothing is queued', async () => {
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w)
    const reqs = Array.from({ length: APPROVALS_MAX_PENDING_PER_ORIGIN }, (_, i) => q.request({ origin: SITE, chain: 'eip155:1', kind: 'sign-message', payload: { i } }))
    await flush()
    expect(w.opened).toHaveLength(1)
    expect(q.queued).toBe(APPROVALS_MAX_PENDING_PER_ORIGIN - 1)
    expect(q.pendingFor(SITE)).toBe(APPROVALS_MAX_PENDING_PER_ORIGIN)
    expect(await settled(q.request({ origin: SITE, chain: 'eip155:1', kind: 'sign-message', payload: {} }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    expect(q.pendingFor(SITE)).toBe(APPROVALS_MAX_PENDING_PER_ORIGIN)
    // another origin is not affected
    const other = q.request({ origin: 'https://other.example', chain: 'eip155:1', kind: 'sign-message', payload: {} })
    expect(q.pendingFor('https://other.example')).toBe(1)
    // answering one frees a slot
    q.decline(w.opened[0]!.id)
    expect(await settled(reqs[0]!)).toBe('declined')
    await flush()
    expect(q.pendingFor(SITE)).toBe(APPROVALS_MAX_PENDING_PER_ORIGIN - 1)
    const fifth = q.request({ origin: SITE, chain: 'eip155:1', kind: 'sign-message', payload: {} })
    expect(q.pendingFor(SITE)).toBe(APPROVALS_MAX_PENDING_PER_ORIGIN)
    q.declineAll()
    expect(await Promise.all([...reqs.slice(1), other, fifth].map(settled))).toEqual(['declined', 'declined', 'declined', 'declined'])
  })

  it('a second connect from the same origin is refused with -32002 while the first waits', async () => {
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w)
    const first = q.request({ origin: SITE, chain: 'eip155:1', kind: 'connect', payload: {} })
    expect(await settled(q.request({ origin: SITE, chain: 'eip155:1', kind: 'connect', payload: {} }))).toBe(`limit:${RELAY_ERRORS.resourceUnavailable}`)
    await flush()
    q.resolve(w.opened[0]!.id, ['0x1'])
    expect(await settled(first)).toBe('resolved')
    // once answered, a new connect is fine again
    const again = q.request({ origin: SITE, chain: 'eip155:1', kind: 'connect', payload: {} })
    await flush()
    q.resolve(w.opened[1]!.id, [])
    expect(await settled(again)).toBe('resolved')
  })

  it('the limit is configurable and the via note travels with every request of its origin', async () => {
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w, undefined, { maxPendingPerOrigin: 1 })
    q.setVia('wc:topic', { transport: 'walletconnect', url: 'https://claimed.example', name: 'Claimed', verify: 'UNKNOWN' })
    const a = q.request({ origin: 'wc:topic', chain: 'eip155:1', kind: 'sign-message', payload: {} })
    expect(await settled(q.request({ origin: 'wc:topic', chain: 'eip155:1', kind: 'sign-message', payload: {} }))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    await flush()
    expect(w.opened[0]!.via).toEqual({ transport: 'walletconnect', url: 'https://claimed.example', name: 'Claimed', verify: 'UNKNOWN' })
    q.setVia('wc:topic', null)
    q.resolve(w.opened[0]!.id, null)
    await a
    const b = q.request({ origin: 'wc:topic', chain: 'eip155:1', kind: 'sign-message', payload: {} })
    await flush()
    expect(w.opened[1]!.via).toBeUndefined()
    q.resolve(w.opened[1]!.id, null)
    await b
  })
})
