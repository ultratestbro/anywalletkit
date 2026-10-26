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
import { UserRejectedError } from '@anywalletkit/core'
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

/** Options for {@link toRelayError}. */
export interface RelayErrorOptions {
  /** Gets every error that is NOT passed to the page, in full — the extension's own log. */
  log?: (error: unknown) => void
}

/** EIP-1193 provider codes a wallet error may carry to the page. */
const PROVIDER_CODES: ReadonlySet<number> = new Set([4001, 4100, 4200, 4900, 4901, 4902])
/** A node's JSON-RPC error: execution reverted (3) or the reserved -32768…-32000 range. */
const isNodeCode = (code: unknown): code is number => typeof code === 'number' && Number.isInteger(code) && (code === 3 || (code >= -32768 && code <= -32000))
const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>()]+/gi
/** A message as a page may see it: no URLs (RPC keys live in their paths and queries), one line, bounded. */
const pageText = (text: string): string => text.replace(URL_RE, '[url]').split('\n')[0]!.slice(0, 300)
const isHexData = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]*$/.test(v) && v.length <= 2 + 2 * 8192

/**
 * The node's own JSON-RPC error inside `e`, if there is one: viem's `RpcRequestError` (alone or
 * under a typed RPC error) carries the node's code, message (`details`) and data, while its
 * `message` adds the URL and the request body; a fetch-based transport may throw the bare
 * `{code, message, data}` object.
 */
function nodeError(e: unknown): RelayError | undefined {
  for (let cur: unknown = e, depth = 0; cur && typeof cur === 'object' && depth < 8; cur = (cur as { cause?: unknown }).cause, depth++) {
    const o = cur as { name?: unknown; code?: unknown; details?: unknown; shortMessage?: unknown; message?: unknown; data?: unknown }
    if (o.name === 'RpcRequestError' && isNodeCode(o.code)) {
      const text = typeof o.details === 'string' && o.details ? o.details : typeof o.shortMessage === 'string' ? o.shortMessage : 'RPC error'
      return { code: o.code, message: pageText(text), ...(isHexData(o.data) ? { data: o.data } : {}) }
    }
  }
  if (!(e instanceof Error) && typeof e === 'object' && e !== null) {
    const o = e as { code?: unknown; message?: unknown; data?: unknown }
    if (isNodeCode(o.code) && typeof o.message === 'string') return { code: o.code, message: pageText(o.message), ...(isHexData(o.data) ? { data: o.data } : {}) }
  }
  return undefined
}

/**
 * Any error → the `RelayError` for the page. Wallet refusals keep their EIP-1193 code
 * ({@link RouterError}, {@link ReviewDeclined}, a core `UserRejectedError` → 4001), a node's own
 * JSON-RPC error keeps its code and revert data; their messages lose URLs. Everything else is
 * `-32603 Internal error` on the page and goes to `options.log` in full — transport errors name
 * the RPC URL (often with the provider key in it) and the request.
 */
export function toRelayError(e: unknown, options: RelayErrorOptions = {}): RelayError {
  if (e instanceof RouterError) return e.data === undefined ? { code: e.code, message: pageText(e.message) } : { code: e.code, message: pageText(e.message), data: e.data }
  if (e instanceof ReviewDeclined) return { code: e.code, message: pageText(e.message) }
  if (e instanceof UserRejectedError) return { code: RELAY_ERRORS.userRejected, message: pageText(e.message) }
  const node = nodeError(e)
  if (node) return node
  const code = (e as { code?: unknown } | null)?.code
  if (e instanceof Error && typeof code === 'number' && PROVIDER_CODES.has(code)) return { code, message: pageText(e.message) }
  options.log?.(e)
  return { code: RELAY_ERRORS.internal, message: 'Internal error' }
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
  /**
   * A reason to refuse every request from `origin` (reads, `eth_accounts`, an earlier permission
   * included) with 4100, or nothing. Wire `PhishingDetector.refusal`.
   */
  refuse?(origin: string): string | null | undefined
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
    const refused = this.deps.refuse?.(origin)
    if (refused) throw new RouterError(RELAY_ERRORS.unauthorized, refused)
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
