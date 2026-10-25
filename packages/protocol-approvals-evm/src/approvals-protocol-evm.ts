import type { ActivityItem, ChainTx, DescribeActivityContext } from '@anywalletkit/core'
import {
  createPublicClient, custom, encodeFunctionData, fallback, getAddress, http, isAddress, zeroAddress,
  type Address, type Hex, type PublicClient, type Transport,
} from 'viem'

import ApprovalsProtocol, {
  ApprovalsError,
  type AccountLike, type Approval, type ApprovalStandard, type ApprovalsResult, type EvmProvider, type GetApprovalsOptions,
  type ReadOnlyAccountLike, type RevokeResult, type RevokeTransaction, type SendResult, type SpenderLabelResolver,
} from './approvals-protocol.js'
import { describeApprovalActivity, type ActivityTokens } from './activity.js'
import RpcLogsSource, { mergeCandidates, type ApprovalSource, type Candidate } from './sources/rpc-logs.js'
import { EIP7702_PREFIX, ERC20_ABI, ERC721_ABI, PERMIT2_ABI, PERMIT2_ADDRESS } from './standards.js'
import StateVerifier, { approvalId } from './state-verifier.js'
import { bigintToNumber } from '@anywalletkit/core'

export interface CacheEntry {
  /** Where the cached scan started. */
  fromBlock: number
  /** The last block the cached scan covered. */
  toBlock: number
  /** Plain JSON, safe to persist. */
  candidates: Candidate[]
}

export interface ApprovalsCache {
  get(key: string): Promise<CacheEntry | undefined | null> | CacheEntry | undefined | null
  set(key: string, value: CacheEntry): Promise<void> | void
}

export interface ApprovalsProtocolEvmConfig {
  /** RPC URL(s) or EIP-1193 provider(s); a list fails over in order. Defaults to the account's. */
  provider?: EvmProvider | EvmProvider[]
  /** Skips the `eth_chainId` round trip when known. */
  chainId?: number
  /** Token labels (lowercase address → symbol / decimals) for activity titles, e.g. "Approved USDC for Permit2". */
  tokens?: ActivityTokens
  /** Where a cold scan starts (the wallet's creation block, ideally). Default 0. */
  fromBlock?: number
  /** Pre-chunk `eth_getLogs` to this many blocks (QuickNode: 10 000). Default null = try the whole range, split on refusal. */
  blockRange?: number | null
  /** A custom discovery source (an indexer); default {@link RpcLogsSource}. */
  source?: ApprovalSource
  /** Persists candidates + last scanned block so rescans are incremental. */
  cache?: ApprovalsCache
  /** Multicall3 address, or false for single `eth_call`s. */
  multicall?: string | false
  /** The account accepts `sendTransaction(tx[])` as one operation (ERC-4337 / 7702-gasless accounts). Default false. */
  batch?: boolean
  /** Also report the account's EIP-7702 delegation. Default true. */
  includeDelegation?: boolean
  /** Parallel RPC requests for discovery and verification. Default 4. */
  concurrency?: number
  /** Milliseconds between retries of a transient `eth_getLogs` failure. Default 300. */
  retryDelay?: number
  /** Spender label resolver (e.g. {@link EtherscanLabels}); failures never fail the scan. */
  labels?: SpenderLabelResolver
}

const SUPPORTED: readonly ApprovalStandard[] = Object.freeze(['erc20', 'erc721', 'erc721-token', 'erc1155', 'permit2', 'eip7702'] as const)

// The transports do not retry on their own: RpcLogsSource retries transient
// failures itself (and counts requests), the way it did over ethers.
const toTransport = (p: EvmProvider | EvmProvider[]): Transport => {
  // A list (wallet-evm's failover config) fails over in order, as the account's own client does.
  if (Array.isArray(p)) return p.length === 1 ? toTransport(p[0]!) : fallback(p.map((x) => toTransport(x)), { retryCount: 0 })
  return typeof p === 'string' ? http(p, { retryCount: 0 }) : custom(p, { retryCount: 0 })
}

interface RevokeItem { ids: string[]; tx?: RevokeTransaction; approval?: Approval }

/**
 * Token approvals for evm accounts: discover what the account has granted,
 * flag the risky grants, revoke them.
 *
 * Discovery: approval-shaped events with the owner in `topic1` (ERC-20 /
 * ERC-721 `Approval`, `ApprovalForAll`, Permit2 `Approval` / `Permit` /
 * `Lockdown`) give candidate pairs; the current state (`allowance`,
 * `isApprovedForAll`, `getApproved`, Permit2 `allowance`, the account's
 * code for EIP-7702) is what gets reported. Revokes reuse the account's own
 * methods — `approve({amount: 0})`, `sendTransaction`, `revokeDelegation` —
 * so on a policy-governed account (the kit's `Wallet.getAccount(...)`) they
 * pass the same policies as any other write.
 */
export default class ApprovalsProtocolEvm extends ApprovalsProtocol<ApprovalsProtocolEvmConfig> {
  private readonly _provider: PublicClient | undefined
  private _chainId: number | null
  private _source: ApprovalSource | null
  private _verifier: StateVerifier | null

  /**
   * @param account - A @anywalletkit/wallet-evm account (or a read-only one for discovery).
   */
  constructor (account: ReadOnlyAccountLike | AccountLike, config: ApprovalsProtocolEvmConfig = {}) {
    super(account, config)
    // wallet-evm keeps the RPC in a protected `_config`: read it without putting it in the account type.
    const provider = config.provider ?? (account as { _config?: { provider?: EvmProvider | EvmProvider[] } } | undefined)?._config?.provider
    if (provider && (!Array.isArray(provider) || provider.length > 0)) {
      // cacheTime 0: every getBlockNumber is a real round trip (viem would
      // otherwise serve it from a 4 s cache). ethers needed `cacheTimeout: -1`
      // for the same reason — a retried eth_getLogs must be a fresh request —
      // and viem does not de-duplicate requests at all.
      this._provider = createPublicClient({ transport: toTransport(provider), cacheTime: 0 })
    }
    this._chainId = config.chainId ?? null
    this._source = config.source ?? null
    this._verifier = null
  }

  private _requireProvider (): PublicClient {
    if (!this._provider) throw new ApprovalsError('The protocol must be initialized with a provider (or an account configured with one).', 'provider-required')
    return this._provider
  }

  private _requireWritable (method: string): AccountLike {
    // Structural, deliberately not instanceof: a duplicated copy of the
    // account package fails instanceof while the account works fine.
    const account = this._account as Partial<AccountLike> | undefined
    if (typeof account?.sendTransaction !== 'function') {
      throw new ApprovalsError(`The '${method}' method requires the protocol to be initialized with a non read-only account.`, 'account-required')
    }
    return this._account as AccountLike
  }

  private async _getChainId (): Promise<number> {
    if (this._chainId === null) this._chainId = Number(await this._requireProvider().getChainId())
    return this._chainId
  }

  private _getSource (): ApprovalSource {
    if (!this._source) {
      this._source = new RpcLogsSource({ provider: this._requireProvider(), blockRange: this._config.blockRange ?? null, concurrency: this._config.concurrency ?? 4, retryDelay: this._config.retryDelay })
    }
    return this._source
  }

  private _getVerifier (): StateVerifier {
    if (!this._verifier) {
      this._verifier = new StateVerifier({ provider: this._requireProvider(), multicall: this._config.multicall, concurrency: this._config.concurrency ?? 4 })
    }
    return this._verifier
  }

  override async getSupportedStandards (): Promise<ApprovalStandard[]> {
    return SUPPORTED.slice()
  }

  override async getApprovals (options: GetApprovalsOptions = {}): Promise<ApprovalsResult> {
    const provider = this._requireProvider()
    const owner = getAddress(await this._account.getAddress())
    const chainId = await this._getChainId()
    const cacheKey = `${chainId}:${owner.toLowerCase()}`
    const cached = options.fromBlock === undefined && this._config.cache ? await this._config.cache.get(cacheKey) : null

    const toBlock = options.toBlock ?? bigintToNumber(await provider.getBlockNumber())
    const fromBlock = options.fromBlock ?? (cached ? cached.toBlock + 1 : (this._config.fromBlock ?? 0))
    const source = this._getSource()
    const scan = toBlock >= fromBlock ? await source.collect(owner, { fromBlock, toBlock }) : { candidates: [], complete: true, gaps: [] }
    const candidates = mergeCandidates(cached?.candidates ?? [], scan.candidates)
    const coveredFrom = cached ? Math.min(cached.fromBlock ?? cached.toBlock, fromBlock) : fromBlock
    if (this._config.cache && scan.complete) {
      await this._config.cache.set(cacheKey, { fromBlock: coveredFrom, toBlock: Math.max(toBlock, cached?.toBlock ?? 0), candidates })
    }

    const wanted = filterOf(options)
    const verifier = this._getVerifier()
    let approvals = await verifier.verify(owner, candidates.filter((c) => wanted.candidate(c)), { chainId, ...(options.includeZero !== undefined ? { includeZero: options.includeZero } : {}) })

    if (this._config.includeDelegation !== false && wanted.standard('eip7702')) {
      const delegation = await this._getDelegation(owner, chainId)
      if (delegation) approvals.push(delegation)
    }
    approvals = approvals.filter((a) => wanted.approval(a))
    if (this._config.labels && approvals.length) {
      try {
        const labels = await this._config.labels.resolve(approvals.map((a) => a.spender))
        for (const a of approvals) {
          const label = labels[a.spender.toLowerCase()]
          if (label?.name) a.spenderLabel = label
        }
      } catch {}
    }
    return {
      approvals,
      coverage: { source: source.name, fromBlock: coveredFrom, toBlock, complete: scan.complete, gaps: scan.gaps }
    }
  }

  private async _getDelegation (owner: string, chainId: number): Promise<Approval | null> {
    const code = await this._requireProvider().getCode({ address: owner as Address })
    if (!code || !code.toLowerCase().startsWith(EIP7702_PREFIX)) return null
    const delegate = getAddress('0x' + code.slice(EIP7702_PREFIX.length, EIP7702_PREFIX.length + 40))
    return { id: approvalId({ chainId, standard: 'eip7702', token: owner, spender: delegate }), standard: 'eip7702', chainId, token: owner, spender: delegate, amount: null, unlimited: true, risks: ['unlimited'] }
  }

  /**
   * The raw transaction that revokes an approval (no account needed). Useful
   * for hosts that build their own batches or policy conditions.
   *
   * @param approval - Several Permit2 approvals fold into one `lockdown`.
   */
  buildRevokeTransaction (approval: Approval | Approval[]): RevokeTransaction {
    const list = Array.isArray(approval) ? approval : [approval]
    if (!list.length) throw new ApprovalsError('Nothing to revoke.', 'invalid-approval')
    for (const a of list) validate(a)
    if (list.length > 1) {
      if (!list.every((a) => a.standard === 'permit2')) throw new ApprovalsError('Only Permit2 approvals fold into one transaction.', 'invalid-approval')
      return { to: PERMIT2_ADDRESS, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'lockdown', args: [list.map((a) => ({ token: a.token as Address, spender: a.spender as Address }))] }), value: 0n }
    }
    const a = list[0]!
    switch (a.standard) {
      case 'erc20':
        return { to: a.token, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [a.spender as Address, 0n] }), value: 0n }
      case 'erc721-token':
        return { to: a.token, data: encodeFunctionData({ abi: ERC721_ABI, functionName: 'approve', args: [zeroAddress, BigInt(a.tokenId!)] }), value: 0n }
      case 'erc721':
      case 'erc1155':
        return { to: a.token, data: encodeFunctionData({ abi: ERC721_ABI, functionName: 'setApprovalForAll', args: [a.spender as Address, false] }), value: 0n }
      case 'permit2':
        return { to: PERMIT2_ADDRESS, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'lockdown', args: [[{ token: a.token as Address, spender: a.spender as Address }]] }), value: 0n }
      case 'eip7702':
        throw new ApprovalsError('An EIP-7702 delegation is revoked with a type-4 transaction (account.revokeDelegation()), not calldata.', 'unsupported-standard', { standard: a.standard })
      default:
        throw new ApprovalsError(`Standard '${a.standard}' is not supported on evm.`, 'unsupported-standard', { standard: a.standard })
    }
  }

  override async quoteRevoke (approval: Approval): Promise<{ fee: bigint }> {
    validate(approval)
    const account = this._account as Partial<AccountLike>
    if (approval.standard === 'eip7702') {
      if (typeof account?.quoteRevokeDelegation === 'function') return { fee: BigInt((await account.quoteRevokeDelegation()).fee ?? 0) }
      return { fee: 0n }
    }
    const tx = this.buildRevokeTransaction(approval)
    if (typeof account?.quoteSendTransaction === 'function') {
      const q = await account.quoteSendTransaction(tx)
      return { fee: BigInt(q?.fee ?? 0) }
    }
    const provider = this._requireProvider()
    const [gas, price] = await Promise.all([
      provider.estimateGas({ account: (await this._account.getAddress()) as Address, to: tx.to as Address, data: tx.data as Hex, value: tx.value }),
      feePerGas(provider)
    ])
    return { fee: gas * price }
  }

  override async revoke (approval: Approval): Promise<{ hash: string; fee: bigint }> {
    const account = this._requireWritable('revoke')
    validate(approval)
    if (approval.standard === 'eip7702') {
      if (typeof account.revokeDelegation !== 'function') throw new ApprovalsError('This account cannot revoke an EIP-7702 delegation (no revokeDelegation()).', 'unsupported-standard', { standard: 'eip7702' })
      return normalize(await account.revokeDelegation())
    }
    // ERC-20 goes through the account's own `approve` when it has one: that is
    // the operation the policy engine governs and the path wallet modules
    // already use (USDT's reset-to-zero rule never applies to amount 0).
    if (approval.standard === 'erc20' && typeof account.approve === 'function') {
      return normalize(await account.approve({ token: approval.token, spender: approval.spender, amount: 0n }))
    }
    return normalize(await account.sendTransaction(this.buildRevokeTransaction(approval)))
  }

  override async revokeAll (approvals: Approval[]): Promise<RevokeResult[]> {
    const account = this._requireWritable('revokeAll')
    if (!Array.isArray(approvals) || !approvals.length) return []
    for (const a of approvals) validate(a)

    const items: RevokeItem[] = []
    const permit2 = approvals.filter((a) => a.standard === 'permit2')
    if (permit2.length) items.push({ ids: permit2.map((a) => a.id), tx: this.buildRevokeTransaction(permit2) })
    // ERC-20 revokes leave the batch when the account has `approve`: raw approve(spender, 0)
    // calldata is an approval of the spender to the policy engine (it is an ERC-721 grant of
    // token #0 too), so only the explicit `approve({amount: 0})` revokes a blocklisted spender.
    const explicitErc20 = typeof account.approve === 'function'
    for (const a of approvals) {
      if (a.standard === 'permit2') continue
      if (a.standard === 'eip7702' || (a.standard === 'erc20' && explicitErc20)) items.push({ ids: [a.id], approval: a })
      else items.push({ ids: [a.id], tx: this.buildRevokeTransaction(a), approval: a })
    }

    const results: RevokeResult[] = []
    if (this._config.batch) {
      const batched = items.filter((i) => i.tx)
      if (batched.length) {
        try {
          const r = normalize(await account.sendTransaction(batched.map((i) => i.tx!)))
          results.push({ ids: batched.flatMap((i) => i.ids), ...r })
        } catch (error) {
          results.push({ ids: batched.flatMap((i) => i.ids), error: error as Error })
        }
      }
      for (const i of items.filter((x) => !x.tx)) results.push(await this._revokeItem(i))
      return results
    }
    for (const i of items) results.push(await this._revokeItem(i))
    return results
  }

  private async _revokeItem (item: RevokeItem): Promise<RevokeResult> {
    try {
      if (item.approval && item.approval.standard !== 'permit2') {
        const r = await this.revoke(item.approval)
        return { ids: item.ids, ...r }
      }
      const r = normalize(await (this._account as AccountLike).sendTransaction(item.tx!))
      return { ids: item.ids, ...r }
    } catch (error) {
      return { ids: item.ids, error: error as Error }
    }
  }

  /**
   * Recognize approvals and revokes offline on any EVM chain: ERC-20 / ERC-721
   * `approve` (amount 0 → revoke), `setApprovalForAll`, Permit2 `approve` / `lockdown`.
   * See `activity.ts` for the rule.
   */
  override describeActivity (tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeApprovalActivity(tx, ctx, this._config.tokens ? { tokens: this._config.tokens } : {})
  }
}

/** ethers' `getFeeData()` pick: `maxFeePerGas` on an EIP-1559 chain, else `gasPrice`, else 0. */
async function feePerGas (client: PublicClient): Promise<bigint> {
  try {
    return (await client.estimateFeesPerGas({ chain: undefined, type: 'eip1559' })).maxFeePerGas
  } catch {
    try { return await client.getGasPrice() } catch { return 0n }
  }
}

function validate (a: Approval | null | undefined): asserts a is Approval {
  if (!a || typeof a !== 'object' || typeof a.standard !== 'string') throw new ApprovalsError('An approval object is required.', 'invalid-approval', { approval: a })
  if (!SUPPORTED.includes(a.standard)) throw new ApprovalsError(`Standard '${a.standard}' is not supported on evm.`, 'unsupported-standard', { standard: a.standard })
  if (a.standard !== 'eip7702' && (!isAddress(a.token) || !isAddress(a.spender))) throw new ApprovalsError('token and spender must be addresses.', 'invalid-approval', { approval: a })
  if (a.standard === 'erc721-token' && a.tokenId === undefined) throw new ApprovalsError('erc721-token approvals need a tokenId.', 'invalid-approval', { approval: a })
}

function normalize (result: SendResult | undefined): { hash: string; fee: bigint } {
  if (typeof result === 'string') return { hash: result, fee: 0n }
  return { hash: result?.hash as string, fee: BigInt(result?.fee ?? 0) }
}

function filterOf (options: GetApprovalsOptions): { standard: (s: ApprovalStandard) => boolean; candidate: (c: Candidate) => boolean; approval: (a: Approval) => boolean } {
  const standards = options.standards ? new Set<ApprovalStandard>(options.standards) : null
  const tokens = options.tokens ? new Set(options.tokens.map((t) => t.toLowerCase())) : null
  const spenders = options.spenders ? new Set(options.spenders.map((s) => s.toLowerCase())) : null
  const kindStandards: Record<Candidate['kind'], ApprovalStandard[]> = { erc20: ['erc20'], 'erc721-token': ['erc721-token'], 'nft-operator': ['erc721', 'erc1155'], permit2: ['permit2'] }
  return {
    standard: (s) => !standards || standards.has(s),
    candidate: (c) => (!standards || kindStandards[c.kind].some((s) => standards.has(s))) &&
      (!tokens || tokens.has(c.token.toLowerCase())) && (!spenders || spenders.has(c.spender.toLowerCase())),
    approval: (a) => (!standards || standards.has(a.standard)) &&
      (!tokens || tokens.has(a.token.toLowerCase())) && (!spenders || spenders.has(a.spender.toLowerCase()))
  }
}
