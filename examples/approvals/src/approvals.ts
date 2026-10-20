// The "Approvals" guide on docs.anywallet.tech renders the #region blocks of this file.

// #region setup
import { Wallet, type Policies, type WriteIntent } from '@forgewallet/kit'
import { WalletManagerEvm } from '@forgewallet/wallet-evm'
import ApprovalsProtocolEvm, {
  BlockscoutSource, type Approval, type ApprovalsCache, type CacheEntry, type RevokeResult,
} from '@forgewallet/protocol-approvals-evm'

export interface ApprovalsSetup {
  /** An RPC that answers eth_getLogs WITHOUT an address filter (your node, most paid plans). */
  logsRpc: string
  cache: ApprovalsCache
  policies?: Policies
}

export function walletWithApprovals(seedPhrase: string, { logsRpc, cache, policies }: ApprovalsSetup): Wallet {
  const wallet = new Wallet(seedPhrase, policies ? { policies } : {})
  wallet.registerWallet('eip155:1', WalletManagerEvm, { provider: 'https://ethereum-rpc.publicnode.com', chainId: 1 })
  wallet.registerProtocol('approvals', ApprovalsProtocolEvm, {
    chain: 'eip155:1',
    config: {
      provider: logsRpc, // discovery only; revokes are sent through the account's own provider
      fromBlock: 23_000_000, // the block your app created this wallet in: no approval can be older
      blockRange: 10_000, // your RPC's eth_getLogs window
      cache, // rescans read only the blocks since the last one
    },
  })
  return wallet
}
// #endregion setup

// #region cache
/** Scan state per `chainId:owner`. Plain JSON: persist it as-is (file, MMKV, IndexedDB). */
export function memoryCache(store = new Map<string, string>()): ApprovalsCache {
  return {
    get: (key) => {
      const json = store.get(key)
      return json ? (JSON.parse(json) as CacheEntry) : null
    },
    set: (key, entry) => {
      store.set(key, JSON.stringify(entry))
    },
  }
}
// #endregion cache

// #region scan
export async function listApprovals(wallet: Wallet) {
  const approvals = await wallet.getProtocol<ApprovalsProtocolEvm>('approvals')
  const { approvals: list, coverage } = await approvals.getApprovals()

  // complete: false = some block range could not be scanned; the list may be missing entries.
  if (!coverage.complete) console.warn('partial scan, gaps:', coverage.gaps)

  return {
    // Unlimited allowances, spenders without code, live EIP-7702 delegations.
    risky: list.filter((a) => a.risks.length > 0),
    all: list,
  }
}
// #endregion scan

// #region audit
/** Any address, no key and no seed: a read-only account only needs getAddress(). */
export async function auditAddress(address: string): Promise<Approval[]> {
  const approvals = new ApprovalsProtocolEvm(
    { getAddress: async () => address },
    {
      provider: 'https://ethereum-rpc.publicnode.com',
      chainId: 1,
      // The whole history in one request instead of a block-by-block eth_getLogs walk.
      source: new BlockscoutSource({ chainId: 1 }),
    },
  )
  const { approvals: list } = await approvals.getApprovals({ standards: ['erc20', 'permit2'] })
  return list
}
// #endregion audit

// #region revoke
export async function revokeOne(wallet: Wallet, approval: Approval) {
  const approvals = await wallet.getProtocol<ApprovalsProtocolEvm>('approvals')
  const { fee } = await approvals.quoteRevoke(approval) // gas in wei, nothing is signed
  const { hash } = await approvals.revoke(approval)
  return { hash, fee }
}

export async function revokeRisky(wallet: Wallet): Promise<RevokeResult[]> {
  const approvals = await wallet.getProtocol<ApprovalsProtocolEvm>('approvals')
  const { approvals: list } = await approvals.getApprovals()
  // Permit2 entries fold into one `lockdown`; every other approval is its own transaction.
  const results = await approvals.revokeAll(list.filter((a) => a.risks.length > 0))
  for (const r of results) {
    // revokeAll never throws for one item: a failure rides on its result.
    if (r.error) console.warn('not revoked:', r.ids, r.error.message)
  }
  return results
}
// #endregion revoke

// #region policies
/** `ask` is your confirmation sheet: resolve true when the user taps Confirm. */
export function approvalPolicies(ask: (intent: WriteIntent, warning?: string) => Promise<boolean>): Policies {
  return {
    confirm: (intent) => {
      if (intent.kind !== 'approval') return ask(intent)
      // approve, signPermit, EIP-2612 and Permit2 typed data all arrive here; intent.to is the spender.
      // amount 0 is a revoke: approvals.revoke() sends account.approve({ amount: 0 }).
      if (intent.amount === 0n) return ask(intent)
      if (intent.unlimited) return ask(intent, `${intent.to} could spend all of this token, now and later.`)
      return ask(intent)
    },
  }
}
// #endregion policies
