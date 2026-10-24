// The "Balances" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import { bigintToUnits, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { Wallet } from '@anywalletkit/kit'
import { builtinNetwork } from '@anywalletkit/networks'
import { ccChain } from '@anywalletkit/swap2-assets'
import { WalletManagerEvm, type EvmProvider } from '@anywalletkit/wallet-evm'
// #endregion imports

// #region setup
/** One registration per EVM network, each with its own RPC list. */
export function balancesWallet(seedPhrase: string, rpcs: Record<number, EvmProvider[]>): Wallet {
  const wallet = new Wallet(seedPhrase)
  for (const [id, provider] of Object.entries(rpcs)) {
    wallet.registerWallet(`eip155:${id}`, WalletManagerEvm, { provider, chainId: Number(id) })
  }
  return wallet
}
// #endregion setup

// #region token-list
/** A token the wallet reads a balance for. `token: null` is the network's gas coin. */
export interface ListedToken {
  chain: string
  token: string | null
  symbol: string
  decimals: number
  /** `catalog`: shipped with the SDK; `user`: the user added it by contract address. */
  source: 'catalog' | 'user'
}

/** The gas coin from the network table, the catalog's tokens, then the tokens the user added. */
export function tokenList(chain: string, userTokens: ListedToken[] = []): ListedToken[] {
  const network = builtinNetwork(chain)
  const native: ListedToken[] = network ? [{ chain, token: null, symbol: network.symbol, decimals: network.decimals, source: 'catalog' }] : []
  const catalog: ListedToken[] = (ccChain(chain)?.assets ?? [])
    .filter((a) => a.contract) // the native entry is already in from the network table
    .map((a) => ({ chain, token: a.contract!, symbol: a.symbol, decimals: a.decimals, source: 'catalog' }))
  const known = new Set(catalog.map((t) => t.token!.toLowerCase()))
  const own = userTokens.filter((t) => t.chain === chain && t.token && !known.has(t.token.toLowerCase()))
  return [...native, ...catalog, ...own]
}
// #endregion token-list

// #region read
export interface BalanceRow extends ListedToken {
  /** Base units. `null` when this read failed; never show a failed read as 0. */
  amount: bigint | null
  error?: string
}

/** Every listed balance of one account. One failing token does not hide the others. */
export async function readBalances(account: IWalletAccountReadOnly, tokens: ListedToken[]): Promise<BalanceRow[]> {
  const reads = await Promise.allSettled(tokens.map((t) => (t.token ? account.getTokenBalance(t.token) : account.getBalance())))
  return tokens.map((t, i) => {
    const r = reads[i]!
    return r.status === 'fulfilled' ? { ...t, amount: r.value } : { ...t, amount: null, error: String((r.reason as Error)?.message ?? r.reason) }
  })
}
// #endregion read

// #region format
/** Exact decimal string from base units, cut to `maxFraction` digits (rounded down). No Number on the way. */
export function formatAmount(amount: bigint, decimals: number, maxFraction = 6): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const base = 10n ** BigInt(decimals)
  const whole = (abs / base).toLocaleString('en-US')
  const fraction = (abs % base).toString().padStart(decimals, '0').slice(0, maxFraction).replace(/0+$/, '')
  return `${negative ? '-' : ''}${whole}${fraction ? '.' + fraction : ''}`
}
// #endregion format

// #region portfolio
/** Balances on every chain at once. A chain whose RPC is down comes back with its error, not as zero. */
export async function portfolio(wallet: Wallet, chains: string[], userTokens: ListedToken[] = []) {
  const results = await Promise.allSettled(chains.map(async (chain) => readBalances(await wallet.getAccount(chain), tokenList(chain, userTokens))))
  return chains.map((chain, i) => {
    const r = results[i]!
    return r.status === 'fulfilled' ? { chain, rows: r.value } : { chain, rows: [] as BalanceRow[], error: String((r.reason as Error)?.message ?? r.reason) }
  })
}
// #endregion portfolio

// #region prices
/** Your price API, behind your server: USD per whole token, keyed by `chain/token` (token = contract, or `native`). */
export type PriceSource = (keys: string[]) => Promise<Record<string, number>>

export const priceKey = (t: ListedToken) => `${t.chain}/${t.token ? t.token.toLowerCase() : 'native'}`

/** USD value per row and a total. A token with no price is `null` and stays out of the total. */
export async function valued(rows: BalanceRow[], prices: PriceSource) {
  const quotes = await prices(rows.filter((r) => r.amount !== null && r.amount > 0n).map(priceKey))
  const out = rows.map((r) => {
    const price = quotes[priceKey(r)]
    const usd = r.amount !== null && price !== undefined ? bigintToUnits(r.amount, r.decimals) * price : null
    return { ...r, usd }
  })
  return { rows: out, totalUsd: out.reduce((sum, r) => sum + (r.usd ?? 0), 0), unpriced: out.filter((r) => r.usd === null && (r.amount ?? 0n) > 0n).length }
}
// #endregion prices
