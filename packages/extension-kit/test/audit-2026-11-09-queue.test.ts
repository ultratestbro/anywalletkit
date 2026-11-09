/**
 * Extension audit 2026-11-09, E17: the approval queue had a per-origin limit only
 * (no global cap, no per-site cap, no rate limit), so a page hopping over
 * wildcard subdomains queued windows without end, and nothing let the user drop a
 * whole site's backlog.
 */
import { describe, expect, it } from 'vitest'
import { APPROVALS_MAX_PENDING_PER_SITE, APPROVALS_MAX_PENDING_TOTAL, ApprovalQueue, QueueLimitError, RELAY_ERRORS, ReviewDeclined, TokenBucket, memoryApprovalWindow, siteOf } from '../src/index.js'

const flush = () => new Promise((r) => setTimeout(r, 0))
const settled = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => (e instanceof QueueLimitError ? `limit:${e.code}` : e instanceof ReviewDeclined ? 'declined' : `other:${String(e)}`))
const ask = (q: ApprovalQueue, origin: string, kind: 'sign-message' | 'connect' = 'sign-message') => q.request({ origin, chain: 'eip155:1', kind, payload: {} })

describe('siteOf (registrable domain, conservative)', () => {
  it('groups subdomains under their registrable domain, knows multi-label and hosting suffixes', () => {
    expect(siteOf('https://a1.evil.tld')).toBe('evil.tld')
    expect(siteOf('https://x.y.evil.tld:8443')).toBe('evil.tld')
    expect(siteOf('https://evil.tld')).toBe('evil.tld')
    expect(siteOf('https://shop.example.co.uk')).toBe('example.co.uk')
    expect(siteOf('https://alice.github.io')).toBe('alice.github.io')
    expect(siteOf('https://bob.github.io')).toBe('bob.github.io')
    expect(siteOf('https://my-app.vercel.app')).toBe('my-app.vercel.app')
    expect(siteOf('https://a.b.pages.dev')).toBe('b.pages.dev')
    expect(siteOf('https://vitalik.eth.limo')).toBe('vitalik.eth.limo')
    expect(siteOf('https://cid.ipfs.dweb.link')).toBe('cid.ipfs.dweb.link')
    expect(siteOf('http://localhost:3000')).toBe('localhost')
    expect(siteOf('http://127.0.0.1:8545')).toBe('127.0.0.1')
    expect(siteOf('wc:abcdef')).toBe('wc:abcdef')
    expect(siteOf('chrome-extension://abc')).toBe('chrome-extension://abc')
  })

  it('token bucket: burst, refill, independent keys', () => {
    let now = 0
    const b = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: () => now })
    expect([b.take('a'), b.take('a'), b.take('a')]).toEqual([true, true, false])
    expect(b.take('b')).toBe(true)
    now = 1000
    expect([b.take('a'), b.take('a')]).toEqual([true, false])
  })
})

describe('ApprovalQueue: global, per-site and rate limits (audit E17)', () => {
  it(`at most ${APPROVALS_MAX_PENDING_TOTAL} requests wait across all origins; the wallet's own (exempt) origin still gets through`, async () => {
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w, undefined, { exempt: (o) => o === 'chrome-extension://wallet' })
    const all = Array.from({ length: APPROVALS_MAX_PENDING_TOTAL }, (_, i) => ask(q, `https://site${i}.example${i}.tld`))
    expect(await settled(ask(q, 'https://one-more.tld'))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    expect(await settled(ask(q, 'wc:0123abcd'))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`) // WalletConnect origins count in the global cap too
    const own = ask(q, 'chrome-extension://wallet')
    expect(q.pendingFor('chrome-extension://wallet')).toBe(1)
    q.declineAll()
    expect(new Set(await Promise.all([...all, own].map(settled)))).toEqual(new Set(['declined']))
  })

  it(`subdomains of one site share ${APPROVALS_MAX_PENDING_PER_SITE} slots`, async () => {
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w)
    const ok = Array.from({ length: APPROVALS_MAX_PENDING_PER_SITE }, (_, i) => ask(q, `https://a${i}.evil.tld`, 'connect'))
    expect(await settled(ask(q, 'https://a99.evil.tld', 'connect'))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    expect(q.pendingFor('https://good.example')).toBe(0)
    const good = ask(q, 'https://good.example')
    expect(q.pendingFor('https://good.example')).toBe(1)
    q.declineAll()
    await Promise.all([...ok, good].map(settled))
  })

  it('declineOrigin / declineSite drop one origin or one whole site, current window included, and nothing else', async () => {
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w)
    const a = ask(q, 'https://a.evil.tld')
    const b = ask(q, 'https://b.evil.tld')
    const keep = ask(q, 'https://good.example')
    const a2 = ask(q, 'https://a.evil.tld')
    await flush()
    expect(w.opened[0]!.origin).toBe('https://a.evil.tld')
    expect(q.siteFor('https://a.evil.tld')).toBe('evil.tld')
    expect(q.pendingForSite('evil.tld')).toBe(3)
    expect(q.declineOrigin('https://a.evil.tld')).toBe(2)
    expect(await settled(a)).toBe('declined')
    expect(await settled(a2)).toBe('declined')
    expect(w.openIds.has(w.opened[0]!.id)).toBe(false) // its window closed
    await flush()
    expect(q.current?.origin).toBe('https://b.evil.tld')
    expect(q.declineSite('evil.tld')).toBe(1)
    expect(await settled(b)).toBe('declined')
    await flush()
    expect(q.current?.origin).toBe('https://good.example')
    q.resolve(q.current!.id, null)
    expect(await settled(keep)).toBe('resolved')
  })

  it('rate limit per site with backoff: a burst is allowed, then refused; the cooldown doubles on a repeat and ends', async () => {
    let now = 1_000_000
    const w = memoryApprovalWindow()
    const q = new ApprovalQueue(w, undefined, { now: () => now, openRate: { burst: 4, refillPerSecond: 0.5, backoffMs: 10_000, maxBackoffMs: 60_000 } })
    const answerAll = async () => { await flush(); while (q.current) { q.resolve(q.current.id, null); await flush() } }
    for (let i = 0; i < 4; i++) { const p = ask(q, `https://s${i}.spam.tld`); await answerAll(); expect(await settled(p)).toBe('resolved') }
    expect(await settled(ask(q, 'https://s9.spam.tld'))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    // the cooldown holds even after tokens refill
    now += 9_000
    expect(await settled(ask(q, 'https://s9.spam.tld'))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    // other sites are not affected
    const other = ask(q, 'https://fine.example'); await answerAll(); expect(await settled(other)).toBe('resolved')
    now += 2_000 // cooldown over, tokens refilled
    const p = ask(q, 'https://s9.spam.tld'); await answerAll(); expect(await settled(p)).toBe('resolved')
    // drain again: second strike → 20 s
    for (let i = 0; i < 10; i++) { const r = settled(ask(q, 'https://s1.spam.tld')); await answerAll(); if ((await r) !== 'resolved') break }
    now += 15_000
    expect(await settled(ask(q, 'https://s1.spam.tld'))).toBe(`limit:${RELAY_ERRORS.limitExceeded}`)
    now += 6_000
    const late = ask(q, 'https://s1.spam.tld'); await answerAll(); expect(await settled(late)).toBe('resolved')
  })
})
