// The "Networks" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region imports
import {
  NetworksTable, SOLANA_CHAIN, checkRpcUrl, isAddChainError, parseAddChainParams, verifyNetwork,
  type FetchLike, type JsonStorage, type Network, type NetworksState,
} from '@anywalletkit/networks'
import { Wallet } from '@anywalletkit/kit'
import { WalletManagerEvm } from '@anywalletkit/wallet-evm'
import { WalletManagerSolana } from '@anywalletkit/wallet-solana'
// #endregion imports

// #region table
/** Load once at cold start. Storage holds only the user's changes; the shipped lists stay current. */
export async function openNetworks(storage: JsonStorage<NetworksState>): Promise<NetworksTable> {
  const table = new NetworksTable(storage) // AsyncStorage, MMKV, chrome.storage…
  await table.load()
  return table
}
// #endregion table

// #region wallet
export function walletOnNetworks(seedPhrase: string, table: NetworksTable, evmChainIds: number[]): Wallet {
  const wallet = new Wallet(seedPhrase)
  for (const id of evmChainIds) {
    // One registration per EVM network: its own failover list, user RPCs first.
    wallet.registerWallet(`eip155:${id}`, WalletManagerEvm, { provider: table.rpcUrlsForSync(`eip155:${id}`), chainId: id })
  }
  wallet.registerWallet('solana', WalletManagerSolana, { provider: table.rpcUrlsForSync(SOLANA_CHAIN) })
  return wallet
}
// #endregion wallet

// #region user-rpc
/** "Add your own RPC": check the URL, prove the endpoint serves this chain, then store it. */
export async function addUserRpc(table: NetworksTable, caip2: string, url: string, fetch?: FetchLike) {
  const policy = checkRpcUrl(url, { allowHttpLocal: table.allowHttpLocalSync() })
  if (!policy.ok) return { ok: false as const, error: policy.message } // http, credentials in the URL…

  const network = (await table.get(caip2))!
  const result = await verifyNetwork(network, { rpc: url, ...(fetch ? { fetch } : {}) })
  if (!result.ok) return { ok: false as const, error: result.error! } // e.g. "chain-id-mismatch: …"

  await table.addRpc(caip2, url) // goes before the shipped list
  await table.markRpc(caip2, url, result)
  return { ok: true as const, latencyMs: result.latencyMs }
}
// #endregion user-rpc

// #region trust
/** Label screens that ran through an endpoint you didn't ship. */
export function reviewLabel(table: NetworksTable, caip2: string): string | null {
  return table.usesUserRpcSync(caip2) ? 'Custom RPC: the simulation comes from a node you added' : null
}
// #endregion trust

// #region add-chain
/** A site calls wallet_addEthereumChain. Never add silently: ask, verify, then store. */
export async function onAddEthereumChain(
  table: NetworksTable,
  origin: string,
  params: unknown,
  ask: (network: Network) => Promise<boolean>,
  fetch?: FetchLike,
): Promise<null | { code: number; message: string }> {
  // `known` decides which chains a site may add: by default only the catalog (already built in),
  // here any chain the user approves.
  const parsed = parseAddChainParams(params, { origin, known: () => true })
  if (isAddChainError(parsed)) return parsed // the EIP-1193 error to answer with
  if (await table.get(parsed.caip2)) return null // known already: nothing to add
  if (!(await ask(parsed))) return { code: 4001, message: 'User rejected the request.' }
  const result = await verifyNetwork(parsed, fetch ? { fetch } : {})
  // The site gets a generic answer: what the endpoint said (or where it redirected) is for the user's
  // own screen, not for the page that supplied the endpoint.
  if (!result.ok) return { code: -32603, message: "The network's RPC failed the check." }
  await table.add(parsed)
  return null
}
// #endregion add-chain
