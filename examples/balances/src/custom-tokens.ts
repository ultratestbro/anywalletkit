// The "Custom tokens" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import type { IWalletAccount, IWalletAccountReadOnly } from '@anywalletkit/core'
import { inspectToken, swapSource, TokensTable, type JsonStorage, type TokenInspection, type TokensState, type UserToken } from '@anywalletkit/tokens'
import { RouterSwap2Protocol, type Swap2Route } from '@anywalletkit/protocol-swap2-router'
import type { CrossChainProvider } from '@anywalletkit/protocol-swap2-core'
import type { ListedToken } from './balances.ts'
// #endregion imports

// #region inspect
/**
 * Step 1 of "Add token": read what the address is and what to warn about. Nothing is saved yet.
 * A token the catalog already lists comes back as `listed`: show it, there is nothing to add.
 */
export async function lookUp(account: IWalletAccountReadOnly, address: string): Promise<TokenInspection> {
  const found = await inspectToken(account, address)
  if (!found.listed) {
    // found.assessment.level: 'danger' | 'caution'; found.assessment.risks: [{ code, level, message }]
    // Show every message, worst first, before the user confirms.
  }
  return found
}
// #endregion inspect

// #region table
/** The user's tokens, kept in the app's storage (AsyncStorage, chrome.storage…). Load once at start. */
export async function openTokens(storage: JsonStorage<TokensState>): Promise<TokensTable> {
  const tokens = new TokensTable(storage)
  await tokens.load()
  return tokens
}

/** Step 2, after the user accepted the warnings: save the token the inspection returned. */
export async function confirmAdd(tokens: TokensTable, found: TokenInspection): Promise<UserToken | null> {
  if (found.listed) return null
  return tokens.add(found.token)
}

/** The user's tokens on one chain as rows for the balances screen (source 'user'). */
export function userRows(tokens: TokensTable, chain: string): ListedToken[] {
  return tokens.list(chain).map((t) => ({ chain, token: t.address, symbol: t.symbol, decimals: t.decimals, source: 'user' }))
}
// #endregion table

// #region swap
/**
 * Routes that sell a user token. `allowUnlistedTokens` lets the engine take a token outside the
 * catalog; only providers that trade any token (LI.FI, Uniswap, Balancer, Fynd, Jupiter) answer.
 */
export function swapsForUserTokens(account: IWalletAccount | IWalletAccountReadOnly, chain: string, providers: CrossChainProvider[]): RouterSwap2Protocol {
  return new RouterSwap2Protocol(account, { fromChain: chain, providers, allowUnlistedTokens: true })
}

export function sellRoutes(swaps: RouterSwap2Protocol, token: UserToken, amount: bigint, toToken: string): Promise<Swap2Route[]> {
  return swaps.quoteSwap2Routes({ ...swapSource(token), toToken, fromTokenAmount: amount })
}
// #endregion swap
