/**
 * The request router: what a dApp may ask and what happens to each request.
 * Policy ported from Vaulty's in-app browser (`mobile/lib/browser.ts`):
 *
 * - the origin is the browser's (checked by the service worker before this runs);
 * - accounts are exposed only to origins the user connected (`eth_requestAccounts`
 *   → approval window); `eth_accounts` is `[]` otherwise;
 * - chain switching and adding go through the approval window; a chain can be
 *   added only if the asset catalog knows it, with https RPCs;
 * - read-only JSON-RPC is answered from the wallet's own clients (the networks
 *   table's failover list), never from a URL the page names;
 * - `eth_sign` (blind hash signing) is never offered; the other signing methods
 *   go to the `sign` hook (the review flow) when the wallet provides one;
 * - everything else is refused with 4200.
 *
 * Errors leave as {@link RouterError} (EIP-1193 codes) or {@link ReviewDeclined}
 * (4001); the service worker turns both into a `RelayResponse.error`.
 */
import { ApprovalQueue, ReviewDeclined } from './approvals.js'
import { DEFAULT_CHAIN, NetworksTable, caip2FromChainId, chainHex, parseAddChainParams, type EvmNetwork } from './networks.js'
import { PermissionStore, type OriginPermission } from './permissions.js'
import { RELAY_ERRORS, type RelayChain, type RelayError } from './relay.js'

export class RouterError extends Error {
  readonly code: number
  readonly data: unknown
  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RouterError'
    this.code = code
    this.data = data
  }
  static from(e: RelayError): RouterError {
    return new RouterError(e.code, e.message, e.data)
  }
}

/** Any error → the `RelayError` for the page. Unknown errors keep their message but never their stack. */
export function toRelayError(e: unknown): RelayError {
  if (e instanceof RouterError) return e.data === undefined ? { code: e.code, message: e.message } : { code: e.code, message: e.message, data: e.data }
  if (e instanceof ReviewDeclined) return { code: e.code, message: e.message }
  const code = typeof (e as { code?: unknown })?.code === 'number' ? (e as { code: number }).code : RELAY_ERRORS.internal
  return { code, message: e instanceof Error ? e.message : String(e) }
}

/** Read-only methods answered from our RPC without asking the user. */
export const READ_METHODS: ReadonlySet<string> = new Set([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice', 'eth_getBalance',
  'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_getStorageAt',
  'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas',
])

/** Methods that produce a signature — the review flow's business (step 4), never answered here. */
export const SIGNING_METHODS: ReadonlySet<string> = new Set(['personal_sign', 'eth_signTypedData_v4', 'eth_signTypedData_v3', 'eth_signTypedData', 'eth_sendTransaction'])

export interface ConnectApproval {
  /** Addresses the wallet can expose, active account first (empty while locked — the window unlocks first and reloads). */
  accounts: string[]
}
export interface SwitchChainApproval {
  from: EvmNetwork | null
  to: EvmNetwork
}
export interface AddChainApproval {
  network: EvmNetwork
}

export interface RouterDeps {
  permissions: PermissionStore
  networks: NetworksTable
  approvals: ApprovalQueue
  /** EVM addresses the wallet exposes, active account first. Empty when locked or without a wallet. */
  accounts(): Promise<string[]>
  /** Read-only JSON-RPC over the network's own RPC list. */
  rpc(network: EvmNetwork, method: string, params: unknown[]): Promise<unknown>
  /** Push an EIP-1193 event to every page of `origin`. */
  emit(origin: string, event: string, data: unknown): void
  /** The review flow for signing methods. Absent → 4200. */
  sign?(input: { origin: string; network: EvmNetwork; method: string; params: unknown[]; accounts: string[] }): Promise<unknown>
  defaultChain?: string
}

export class RequestRouter {
  constructor(private readonly deps: RouterDeps) {}

  /** The chain an origin currently sees (its permission's, else the default). */
  async chainFor(origin: string): Promise<EvmNetwork> {
    const permission = await this.deps.permissions.get(origin)
    const wanted = permission?.chain ?? this.deps.defaultChain ?? DEFAULT_CHAIN
    return (await this.deps.networks.get(wanted)) ?? (await this.deps.networks.get(DEFAULT_CHAIN))!
  }

  async handle(origin: string, chain: RelayChain, method: string, rawParams: unknown): Promise<unknown> {
    if (chain !== 'eip155') throw new RouterError(RELAY_ERRORS.unsupportedMethod, `${chain} providers are not available yet.`)
    const params = Array.isArray(rawParams) ? rawParams : rawParams === undefined ? [] : [rawParams]
    const network = await this.chainFor(origin)
    const permission = await this.deps.permissions.get(origin)

    switch (method) {
      case 'eth_chainId':
        return chainHex(network.caip2)
      case 'net_version':
        return String(network.chainId)
      case 'eth_accounts':
        return this.visibleAccounts(permission)
      case 'eth_requestAccounts':
        return this.connect(origin, network)
      case 'wallet_getPermissions':
        // An origin connected only on another chain holds no EVM permission (scan F6/F8).
        return permission && permission.accounts.length > 0 ? [permissionDescriptor(origin, permission.accounts)] : []
      case 'wallet_requestPermissions': {
        const accounts = await this.connect(origin, network)
        return [permissionDescriptor(origin, accounts)]
      }
      case 'wallet_revokePermissions':
        await this.disconnect(origin)
        return null
      case 'wallet_switchEthereumChain': {
        const target = caip2FromChainId((params[0] as { chainId?: unknown } | undefined)?.chainId)
        if (!target) throw new RouterError(RELAY_ERRORS.invalidParams, 'wallet_switchEthereumChain expects [{ chainId }].')
        const to = await this.deps.networks.get(target)
        if (!to) throw new RouterError(RELAY_ERRORS.chainNotAdded, `Chain ${chainHex(target)} is not in this wallet; add it with wallet_addEthereumChain.`)
        await this.switchChain(origin, network, to)
        return null
      }
      case 'wallet_addEthereumChain': {
        const parsed = parseAddChainParams(params)
        if ('code' in parsed) throw RouterError.from(parsed)
        const existing = await this.deps.networks.get(parsed.caip2)
        if (existing) { await this.switchChain(origin, network, existing); return null }
        await this.deps.approvals.request({ origin, chain: network.caip2, kind: 'add-chain', payload: { network: parsed } satisfies AddChainApproval })
        // EIP-3085: the endpoint must answer for the chain it is being added as (a look-alike RPC for a real chain id is the phishing shape).
        let answered: unknown
        try { answered = await this.deps.rpc(parsed, 'eth_chainId', []) } catch (e) { throw new RouterError(RELAY_ERRORS.invalidParams, `The RPC for ${parsed.name} did not answer eth_chainId (${e instanceof Error ? e.message : String(e)}); the network was not added.`) }
        const got = caip2FromChainId(answered)
        if (got !== parsed.caip2) throw new RouterError(RELAY_ERRORS.invalidParams, `The RPC for ${parsed.name} answers chain ${String(answered)}, not ${chainHex(parsed.caip2)}; the network was not added.`)
        await this.deps.networks.add({ ...parsed, custom: { origin, addedAt: Date.now() } })
        if (permission) await this.switchChain(origin, network, parsed, true)
        return null
      }
      case 'eth_sign':
      case 'eth_signTransaction':
        throw new RouterError(RELAY_ERRORS.unsupportedMethod, `${method} (blind signing) is never offered by this wallet.`)
    }

    if (READ_METHODS.has(method)) return this.deps.rpc(network, method, params)

    if (SIGNING_METHODS.has(method)) {
      if (!this.deps.sign) throw new RouterError(RELAY_ERRORS.unsupportedMethod, `${method} is not available yet.`)
      if (!permission) throw new RouterError(RELAY_ERRORS.unauthorized, 'Connect the wallet first (eth_requestAccounts).')
      return this.deps.sign({ origin, network, method, params, accounts: permission.accounts })
    }

    throw new RouterError(RELAY_ERRORS.unsupportedMethod, `This wallet does not support ${method}.`)
  }

  /** What a connected origin sees right now: its permitted accounts that the wallet can expose (none while locked). */
  private async visibleAccounts(permission: OriginPermission | null): Promise<string[]> {
    if (!permission) return []
    const available = await this.deps.accounts()
    return permission.accounts.filter((a) => available.includes(a))
  }

  /**
   * Connected and unlocked → the accounts; otherwise the approval window (which
   * unlocks first when needed) picks them. Emits `connect` + `accountsChanged`.
   */
  private async connect(origin: string, network: EvmNetwork): Promise<string[]> {
    const existing = await this.visibleAccounts(await this.deps.permissions.get(origin))
    if (existing.length) return existing
    const chosen = await this.deps.approvals.request<unknown>({ origin, chain: network.caip2, kind: 'connect', payload: { accounts: await this.deps.accounts() } satisfies ConnectApproval })
    const available = await this.deps.accounts()
    const accounts = Array.isArray(chosen) ? chosen.filter((a): a is string => typeof a === 'string' && available.includes(a)) : []
    if (accounts.length === 0) throw new ReviewDeclined('No account was selected.')
    await this.deps.permissions.connect(origin, accounts, network.caip2)
    this.deps.emit(origin, 'connect', { chainId: chainHex(network.caip2) })
    this.deps.emit(origin, 'accountsChanged', accounts)
    return accounts
  }

  async disconnect(origin: string): Promise<void> {
    if (!(await this.deps.permissions.get(origin))) return
    await this.deps.permissions.disconnect(origin)
    this.deps.emit(origin, 'accountsChanged', [])
    this.deps.emit(origin, 'disconnect', { code: RELAY_ERRORS.disconnected, message: 'The wallet disconnected this site.' })
  }

  private async switchChain(origin: string, from: EvmNetwork, to: EvmNetwork, approved = false): Promise<void> {
    if (from.caip2 === to.caip2) return
    const permission = await this.deps.permissions.get(origin)
    if (!permission) throw new RouterError(RELAY_ERRORS.unauthorized, 'Connect the wallet first (eth_requestAccounts).')
    if (!approved) await this.deps.approvals.request({ origin, chain: from.caip2, kind: 'switch-chain', payload: { from, to } satisfies SwitchChainApproval })
    await this.deps.permissions.setChain(origin, to.caip2)
    this.deps.emit(origin, 'chainChanged', chainHex(to.caip2))
  }
}

const permissionDescriptor = (origin: string, accounts: string[]) => ({
  id: crypto.randomUUID(),
  parentCapability: 'eth_accounts',
  invoker: origin,
  caveats: [{ type: 'restrictReturnedAccounts', value: [...accounts] }],
  date: Date.now(),
})
