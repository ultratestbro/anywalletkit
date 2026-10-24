// The "History" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import { Wallet, createMemoryIntentJournal, type FeedItem, type HistoryFeedPage, type Intent, type IntentJournal } from '@anywalletkit/kit'
import type { ActivityAsset, ChainTx } from '@anywalletkit/core'
import { createEvmHistory } from '@anywalletkit/history-evm'
import LidoProtocolEvm from '@anywalletkit/protocol-staking-lido-evm'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { WalletManagerSolana, createSolanaHistory } from '@anywalletkit/wallet-solana'
import { WalletManagerTon, createTonHistory } from '@anywalletkit/wallet-ton'
import { WalletManagerTron, createTronHistory } from '@anywalletkit/wallet-tron'
// #endregion imports

// #region setup
/** Keys for explorer APIs: on the client, point the URLs at your proxy instead. */
export interface HistoryKeys { etherscan?: string; blockscoutPro?: string; tonapi?: string; trongrid?: string }

export function walletWithHistory(seedPhrase: string, keys: HistoryKeys = {}): Wallet {
  const wallet = new Wallet(seedPhrase, {
    activity: {
      // A label for contract calls no module recognizes.
      known: { 'eip155:1': { '0x66a9893cc07d91d95644aedd05d03f95e1dba8af': 'Uniswap Universal Router' } },
      onError: (report) => console.warn('history', report.stage, report.chain ?? report.module, report.error),
    },
  })
  // The accounts: history reads account `index` on every chain that has a source.
  wallet.registerWallet('eip155', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com' })
  wallet.registerWallet('solana', WalletManagerSolana, { provider: 'https://api.mainnet-beta.solana.com' })
  wallet.registerWallet('ton', WalletManagerTon, { tonClient: { url: 'https://toncenter.com/api/v2/jsonRPC' } })
  wallet.registerWallet('tron', WalletManagerTron, { provider: 'https://api.trongrid.io' })

  // One source per chain.
  const evmKeys = { ...(keys.etherscan ? { etherscanApiKey: keys.etherscan } : {}), ...(keys.blockscoutPro ? { blockscoutProApiKey: keys.blockscoutPro } : {}) }
  wallet.registerHistorySource(createEvmHistory({ chainId: 1, ...evmKeys }))
  wallet.registerHistorySource(createEvmHistory({ chainId: 8453, ...evmKeys }))
  wallet.registerHistorySource(createSolanaHistory({ rpcUrl: 'https://api.mainnet-beta.solana.com' }))
  wallet.registerHistorySource(createTonHistory(keys.tonapi ? { apiKey: keys.tonapi } : {}))
  wallet.registerHistorySource(createTronHistory(keys.trongrid ? { apiKey: keys.trongrid } : {}))

  // Every registered protocol labels its own transactions: a Lido stake reads "Staked ETH".
  wallet.registerProtocol('lido', LidoProtocolEvm, { chain: 'eip155:1' })
  return wallet
}
// #endregion setup

// #region pages
export async function firstPage(wallet: Wallet): Promise<HistoryFeedPage> {
  const page = await wallet.history({ limit: 20 }) // account 0, every chain with a source
  // A source that failed is listed in page.errors and retried on the next call; the rest still loads.
  return page
}

export async function nextPage(wallet: Wallet, cursor: string): Promise<HistoryFeedPage> {
  return wallet.history({ limit: 20, cursor })
}

export async function refresh(wallet: Wallet, lastSeen: number): Promise<FeedItem[]> {
  const { items } = await wallet.history({ since: lastSeen }) // only what is newer
  return items
}
// #endregion pages

// #region journal
/** Call right after broadcasting a swap: the row shows at once, with what the user meant. */
export async function recordSwap(journal: IntentJournal, swap: {
  id: string; from: string; sourceHash: string; out: ActivityAsset; in: ActivityAsset
}): Promise<void> {
  const intent: Intent = {
    id: swap.id,
    kind: 'swap',
    createdAt: Math.floor(Date.now() / 1000),
    chain: 'eip155:1',
    address: swap.from,
    hashes: [{ chain: 'eip155:1', hash: swap.sourceHash }], // source leg first
    expect: { assetsOut: [swap.out], assetsIn: [swap.in] },
    subtitle: 'LI.FI',
    status: 'pending',
  }
  await journal.put(intent)
}

export function attachJournal(wallet: Wallet): IntentJournal {
  const journal = createMemoryIntentJournal() // or your own { list, put, remove } over SQLite / MMKV
  wallet.setIntentJournal(journal)
  return journal
}
// #endregion journal

// #region render
/** One row of the activity list. Amounts are base units: format with the asset's decimals. */
export function row(item: FeedItem): { title: string; subtitle: string; amount: string; pending: boolean } {
  const fmt = (a: ActivityAsset, sign: string) => `${sign}${units(a.amount, a.decimals ?? 0)} ${a.symbol ?? ''}`.trim()
  const amount = [...item.assetsOut.map((a) => fmt(a, '−')), ...item.assetsIn.map((a) => fmt(a, '+'))].join('  ')
  return { title: item.title, subtitle: item.subtitle ?? '', amount, pending: item.status === 'pending' }
}

function units(amount: bigint, decimals: number): string {
  const s = amount.toString().padStart(decimals + 1, '0')
  const whole = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole
}
// #endregion render

// #region detail
/** A detail screen for one transaction, through the same recognizers as the list. */
export async function detail(wallet: Wallet, tx: ChainTx): Promise<FeedItem> {
  return wallet.describeTransaction(tx)
}
// #endregion detail
