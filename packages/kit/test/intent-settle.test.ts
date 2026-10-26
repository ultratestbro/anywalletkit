import { describe, expect, it } from 'vitest'
import type { ChainTx, HistoryPage, HistoryQuery, HistorySource } from '@anywalletkit/core'
import { buildFeed, createMemoryIntentJournal, type Intent } from '../src/index.js'

// Audit 2026-10-25 round 3, L24: each leg of a two-leg intent settled the journal on its own, from
// the status read at the start of the call: with one leg confirmed and the other failed, every
// history() wrote the value the journal did not have — confirmed, failed, confirmed, failed…
const OWN = '0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA'
const ETH = 'eip155:1', BASE = 'eip155:8453'
const row = (chain: string, hash: string, status: ChainTx['status']): ChainTx => ({ chain, hash, time: 1000, status, address: OWN, from: OWN, to: '0x000000000000000000000000000000000000bEEF', nativeValue: 1n, transfers: [] })
const source = (chain: string, rows: ChainTx[]): HistorySource => ({
  chain,
  async listActivity(_a: string, _q?: HistoryQuery): Promise<HistoryPage> { return { items: rows } },
  async getTransaction(hash: string) { return rows.find((r) => r.hash === hash) },
  explorerTxUrl: (h: string) => h,
})

describe('a two-leg intent settles once, the same way every time', () => {
  it('source confirmed + destination failed → failed, and it stays failed', async () => {
    const intent: Intent = { id: 'bridge-1', kind: 'bridge', createdAt: 900, chain: ETH, address: OWN, status: 'pending', hashes: [{ chain: ETH, hash: '0xsrc' }, { chain: BASE, hash: '0xdst' }] }
    const journal = createMemoryIntentJournal([intent])
    const sources = new Map<string, HistorySource>([[ETH, source(ETH, [row(ETH, '0xsrc', 'confirmed')])], [BASE, source(BASE, [row(BASE, '0xdst', 'failed')])]])
    const statuses: string[] = []
    for (let i = 0; i < 4; i++) {
      await buildFeed({ sources, addresses: [{ chain: ETH, address: OWN }, { chain: BASE, address: OWN }], recognizers: [], journal, query: {}, opts: { now: () => 2000 } })
      statuses.push((await journal.list())[0]!.status)
    }
    expect(statuses).toEqual(['failed', 'failed', 'failed', 'failed'])
  })
})
