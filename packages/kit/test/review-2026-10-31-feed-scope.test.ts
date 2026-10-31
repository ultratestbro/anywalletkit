import { describe, expect, it } from 'vitest'
import { Wallet, createMemoryIntentJournal, type Intent } from '../src/index.js'

// Pending / failed intents with no matching row are shown on the first page only when the query asks
// about them: newer than `since`, and of one of the queried accounts (or a leg on one of their chains).

const SEED = 'test test test test test test test test test test test junk'
const ME = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'

function wallet(intents: Intent[]) {
  const journal = createMemoryIntentJournal(intents)
  const w = new Wallet(SEED, { activity: { now: () => 200, pendingTtl: 10_000 } })
  w.registerHistorySource({ chain: 'eip155:1', listActivity: async () => ({ items: [] }), getTransaction: async () => null } as never)
  w.setIntentJournal(journal)
  return { w, journal }
}
const intent = (over: Partial<Intent>): Intent => ({ id: 'i', kind: 'send', chain: 'eip155:1', address: ME, createdAt: 150, status: 'pending', hashes: [], ...over } as Intent)
const ask = { chains: ['eip155:1'], addresses: [{ chain: 'eip155:1', address: ME }] }

describe('journal-only intents follow the history query', () => {
  it('control: a matching pending intent is shown', async () => {
    const page = await wallet([intent({})]).w.history(ask)
    expect(page.items.map((i) => i.chain)).toEqual(['eip155:1'])
  })

  it('control: the address matches case-insensitively on EVM', async () => {
    const page = await wallet([intent({ address: ME.toUpperCase().replace('0X', '0x') })]).w.history(ask)
    expect(page.items).toHaveLength(1)
  })

  it('control: a cross-chain intent from another chain with a leg on the queried chain is shown', async () => {
    const page = await wallet([intent({ chain: 'eip155:137', hashes: [{ chain: 'eip155:137', hash: '0xaa' }, { chain: 'eip155:1', hash: '0xbb' }] })]).w.history(ask)
    expect(page.items).toHaveLength(1)
  })

  it('another chain is not shown', async () => {
    expect((await wallet([intent({ chain: 'eip155:137' })]).w.history(ask)).items).toEqual([])
  })

  it('another address on the same chain is not shown', async () => {
    expect((await wallet([intent({ address: OTHER })]).w.history(ask)).items).toEqual([])
  })

  it('older than since is not shown; at since it is', async () => {
    expect((await wallet([intent({ createdAt: 50 })]).w.history({ ...ask, since: 100 })).items).toEqual([])
    expect((await wallet([intent({ createdAt: 100 })]).w.history({ ...ask, since: 100 })).items).toHaveLength(1)
  })

  it('a failed intent of another account is not shown', async () => {
    expect((await wallet([intent({ address: OTHER, status: 'failed' })]).w.history(ask)).items).toEqual([])
  })

  it('an expired pending intent of another account is not marked failed by this query', async () => {
    const { w, journal } = wallet([intent({ address: OTHER, createdAt: -20_000 })])
    expect((await w.history(ask)).items).toEqual([])
    expect((await journal.list())[0]!.status).toBe('pending')
  })

  it('control: an expired pending intent of the queried account is marked failed', async () => {
    const { w, journal } = wallet([intent({ createdAt: -20_000 })])
    expect((await w.history(ask)).items.map((i) => i.status)).toEqual(['failed'])
    expect((await journal.list())[0]!.status).toBe('failed')
  })
})
