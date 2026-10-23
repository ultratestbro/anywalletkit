import { describe, expect, it } from 'vitest'
import { derivationVectors } from '@forgewallet/conformance'
import type { ChainTx, HistorySource } from '@forgewallet/core'
import { Wallet } from '@forgewallet/kit'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import { attachJournal, detail, firstPage, nextPage, recordSwap, refresh, row, walletWithHistory } from '../src/history.ts'

const SEED = derivationVectors.seeds['bip39-abandon-12']!
const ME = derivationVectors.vectors.evm['bip39-abandon-12']!.accounts[0]!.address
const ALICE = '0x00000000000000000000000000000000000a11ce'
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'
const T0 = 1_760_000_000

/** A history source over fixed rows: what an explorer would return for this address. */
function stubSource(rows: ChainTx[]): HistorySource {
  return {
    chain: 'eip155:1',
    listActivity: async (_address, query) => {
      const start = query?.cursor ? Number(query.cursor) : 0
      const fresh = rows.filter((r) => query?.since === undefined || r.time > query.since)
      const page = fresh.slice(start, start + (query?.limit ?? 20))
      return { items: page, ...(start + page.length < fresh.length ? { cursor: String(start + page.length) } : {}) }
    },
    getTransaction: async (hash) => rows.find((r) => r.hash === hash),
    explorerTxUrl: (hash) => `https://etherscan.io/tx/${hash}`,
  }
}

const tx = (over: Partial<ChainTx>): ChainTx => ({
  chain: 'eip155:1', hash: '0x0', time: T0, status: 'confirmed', address: ME, from: ME, to: ALICE, nativeValue: 0n, transfers: [], ...over,
})
const ROWS: ChainTx[] = [
  tx({ hash: '0x03', time: T0 + 300, from: ALICE, to: ME, transfers: [{ token: USDC, from: ALICE, to: ME, amount: 25_000_000n, standard: 'erc20', symbol: 'USDC', decimals: 6 }] }),
  tx({ hash: '0x02', time: T0 + 200, nativeValue: 10n ** 16n, transfers: [{ token: null, from: ME, to: ALICE, amount: 10n ** 16n }] }),
  tx({ hash: '0x01', time: T0 + 100, from: ALICE, to: ME, transfers: [{ token: '0x00000000000000000000000000000000000005ca', from: ALICE, to: ME, amount: 0n, standard: 'erc20', symbol: 'CLAIM-REWARD.COM', decimals: 18 }], raw: { spam: true } }),
]

function offlineWallet(): Wallet {
  const wallet = new Wallet(SEED)
  wallet.registerWallet('eip155', WalletManagerEvm, {})
  wallet.registerHistorySource(stubSource(ROWS))
  return wallet
}

describe('History guide (docs) — offline', () => {
  it('the feed titles rows from the owner point of view and hides spam', async () => {
    const wallet = offlineWallet()
    const page = await firstPage(wallet)
    expect(page.items.map((i) => [i.kind, i.title])).toEqual([['receive', 'Received USDC'], ['send', 'Sent ETH']])
    expect(row(page.items[0]!)).toEqual({ title: 'Received USDC', subtitle: expect.any(String), amount: '+25 USDC', pending: false })
    expect(row(page.items[1]!).amount).toBe('−0.01 ETH')
    expect(page.items.some((i) => i.title.includes('CLAIM'))).toBe(false)
  })

  it('pages with the cursor and refreshes with since', async () => {
    const wallet = offlineWallet()
    const one = await wallet.history({ limit: 1 })
    expect(one.items).toHaveLength(1)
    const two = await nextPage(wallet, one.cursor!)
    expect(two.items[0]!.hash).toBe('0x02')
    expect((await refresh(wallet, T0 + 250)).map((i) => i.hash)).toEqual(['0x03'])
  })

  it('a journal intent shows a pending swap before the explorer has it', async () => {
    const wallet = offlineWallet()
    const journal = attachJournal(wallet)
    await recordSwap(journal, {
      id: 'swap-1', from: ME, sourceHash: '0xpending',
      out: { token: USDC, amount: 100_000_000n, symbol: 'USDC', decimals: 6 },
      in: { token: null, amount: 3n * 10n ** 16n, symbol: 'ETH', decimals: 18 },
    })
    const { items } = await firstPage(wallet)
    const pending = items.find((i) => i.intentId === 'swap-1')!
    expect(pending).toMatchObject({ kind: 'swap', status: 'pending' })
    expect(row(pending)).toMatchObject({ amount: '−100 USDC  +0.03 ETH', pending: true })
  })

  it('a detail screen describes one transaction through the same pipeline', async () => {
    const item = await detail(offlineWallet(), ROWS[0]!)
    expect(item.title).toBe('Received USDC')
  })

  it('the guide setup registers one source per chain', () => {
    const wallet = walletWithHistory(SEED)
    expect(wallet.historyChains.sort()).toEqual(['eip155:1', 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp', 'ton:-239', 'tron:0x2b6653dc'].sort())
  })
})

// Real sources, nothing signed: LIVE=1 pnpm --filter @forgewallet/example-history test
describe.runIf(process.env.LIVE === '1')('History guide (docs) — live', () => {
  it('reads the first page of a public test address on TON and Tron through keyless sources', async () => {
    const wallet = walletWithHistory(SEED)
    const page = await wallet.history({ limit: 5, chains: ['ton:-239', 'tron:0x2b6653dc'] })
    console.log(page.items.map((i) => [i.chain, i.title, row(i).amount]), page.errors?.map((e) => [e.chain, String(e.error)]))
    expect(page.errors ?? []).toEqual([])
  }, 90_000)
})
