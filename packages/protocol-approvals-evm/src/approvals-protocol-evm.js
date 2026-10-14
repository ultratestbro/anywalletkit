'use strict'

import { BrowserProvider, JsonRpcProvider, ZeroAddress, getAddress, isAddress } from 'ethers'

import ApprovalsProtocol, { ApprovalsError } from './approvals-protocol.js'
import RpcLogsSource, { mergeCandidates } from './sources/rpc-logs.js'
import StateVerifier, { approvalId } from './state-verifier.js'
import { EIP7702_PREFIX, ERC20_ABI, ERC721_ABI, PERMIT2_ABI, PERMIT2_ADDRESS } from './standards.js'
import { describeApprovalActivity } from './activity.js'

/** @typedef {import('./approvals-protocol.js').Approval} Approval */
/** @typedef {import('./approvals-protocol.js').ApprovalStandard} ApprovalStandard */
/** @typedef {import('./approvals-protocol.js').ApprovalsResult} ApprovalsResult */
/** @typedef {import('./approvals-protocol.js').GetApprovalsOptions} GetApprovalsOptions */
/** @typedef {import('./approvals-protocol.js').RevokeResult} RevokeResult */
/** @typedef {import('./sources/rpc-logs.js').ApprovalSource} ApprovalSource */
/** @typedef {import('./sources/rpc-logs.js').Candidate} Candidate */

/**
 * @typedef {Object} CacheEntry
 * @property {number} fromBlock - Where the cached scan started.
 * @property {number} toBlock - The last block the cached scan covered.
 * @property {Candidate[]} candidates - Plain JSON, safe to persist.
 */

/**
 * @typedef {Object} ApprovalsCache
 * @property {(key: string) => Promise<CacheEntry | undefined | null> | CacheEntry | undefined | null} get
 * @property {(key: string, value: CacheEntry) => Promise<void> | void} set
 */

/**
 * @typedef {Object} ApprovalsProtocolEvmConfig
 * @property {string | import('ethers').Eip1193Provider} [provider] - RPC URL or EIP-1193 provider; defaults to the account's.
 * @property {number} [chainId] - Skips the `eth_chainId` round trip when known.
 * @property {number} [fromBlock] - Where a cold scan starts (the wallet's creation block, ideally). Default 0.
 * @property {number | null} [blockRange] - Pre-chunk `eth_getLogs` to this many blocks (QuickNode: 10 000). Default null = try the whole range, split on refusal.
 * @property {ApprovalSource} [source] - A custom discovery source (an indexer); default {@link RpcLogsSource}.
 * @property {ApprovalsCache} [cache] - Persists candidates + last scanned block so rescans are incremental.
 * @property {string | false} [multicall] - Multicall3 address, or false for single `eth_call`s.
 * @property {boolean} [batch] - The account accepts `sendTransaction(tx[])` as one operation (ERC-4337 / 7702-gasless accounts). Default false.
 * @property {boolean} [includeDelegation] - Also report the account's EIP-7702 delegation. Default true.
 * @property {number} [concurrency] - Parallel RPC requests for discovery and verification. Default 4.
 * @property {number} [retryDelay] - Milliseconds between retries of a transient `eth_getLogs` failure. Default 300.
 * @property {{ resolve: (addresses: string[]) => Promise<Record<string, { name: string, url?: string }>> }} [labels] - Spender label resolver (e.g. {@link EtherscanLabels}); failures never fail the scan.
 */

const SUPPORTED = Object.freeze(['erc20', 'erc721', 'erc721-token', 'erc1155', 'permit2', 'eip7702'])

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
 * so on a policy-governed account they are subject
 * to the same rules as any other spend.
 */
export default class ApprovalsProtocolEvm extends ApprovalsProtocol {
  /**
   * @param {*} account - A @forgewallet/wallet-evm account (or a read-only one for discovery).
   * @param {ApprovalsProtocolEvmConfig} [config]
   */
  constructor (account, config = {}) {
    super(account)
    const provider = config.provider ?? account?._config?.provider
    if (provider) {
      /** @private */
      // cacheTimeout -1: ethers de-duplicates identical requests for 250 ms,
      // which would turn a retried eth_getLogs into the same rejected promise.
      const opts = { cacheTimeout: -1 }
      this._provider = typeof provider === 'string' ? new JsonRpcProvider(provider, undefined, opts) : new BrowserProvider(provider, undefined, opts)
    }
    /** @private */
    this._config = config
    /** @private */
    this._chainId = config.chainId ?? null
    /** @private */
    this._source = config.source ?? null
    /** @private */
    this._verifier = null
  }

  /** @private */
  _requireProvider () {
    if (!this._provider) throw new ApprovalsError('The protocol must be initialized with a provider (or an account configured with one).', 'provider-required')
    return this._provider
  }

  /** @private */
  _requireWritable (method) {
    // Structural, deliberately not instanceof: a duplicated copy of the
    // account package fails instanceof while the account works fine.
    if (typeof this._account?.sendTransaction !== 'function') {
      throw new ApprovalsError(`The '${method}' method requires the protocol to be initialized with a non read-only account.`, 'account-required')
    }
  }

  /** @private */
  async _getChainId () {
    if (this._chainId === null) this._chainId = Number((await this._requireProvider().getNetwork()).chainId)
    return this._chainId
  }

  /** @private */
  _getSource () {
    if (!this._source) {
      this._source = new RpcLogsSource({ provider: this._requireProvider(), blockRange: this._config.blockRange ?? null, concurrency: this._config.concurrency ?? 4, retryDelay: this._config.retryDelay })
    }
    return this._source
  }

  /** @private */
  _getVerifier () {
    if (!this._verifier) {
      this._verifier = new StateVerifier({ provider: this._requireProvider(), multicall: this._config.multicall, concurrency: this._config.concurrency ?? 4 })
    }
    return this._verifier
  }

  /** @returns {Promise<ApprovalStandard[]>} */
  async getSupportedStandards () {
    return SUPPORTED.slice()
  }

  /**
   * @param {GetApprovalsOptions} [options]
   * @returns {Promise<ApprovalsResult>}
   */
  async getApprovals (options = {}) {
    const provider = this._requireProvider()
    const owner = getAddress(await this._account.getAddress())
    const chainId = await this._getChainId()
    const cacheKey = `${chainId}:${owner.toLowerCase()}`
    const cached = options.fromBlock === undefined && this._config.cache ? await this._config.cache.get(cacheKey) : null

    const toBlock = options.toBlock ?? await provider.getBlockNumber()
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
    let approvals = await verifier.verify(owner, candidates.filter((c) => wanted.candidate(c)), { chainId, includeZero: options.includeZero })

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

  /** @private */
  async _getDelegation (owner, chainId) {
    const code = await this._requireProvider().getCode(owner)
    if (!code || !code.toLowerCase().startsWith(EIP7702_PREFIX)) return null
    const delegate = getAddress('0x' + code.slice(EIP7702_PREFIX.length, EIP7702_PREFIX.length + 40))
    return { id: approvalId({ chainId, standard: 'eip7702', token: owner, spender: delegate }), standard: 'eip7702', chainId, token: owner, spender: delegate, amount: null, unlimited: true, risks: ['unlimited'] }
  }

  /**
   * The raw transaction that revokes an approval (no account needed). Useful
   * for hosts that build their own batches or policy conditions.
   *
   * @param {Approval | Approval[]} approval - Several Permit2 approvals fold into one `lockdown`.
   * @returns {{ to: string, data: string, value: bigint }}
   */
  buildRevokeTransaction (approval) {
    const list = Array.isArray(approval) ? approval : [approval]
    if (!list.length) throw new ApprovalsError('Nothing to revoke.', 'invalid-approval')
    for (const a of list) validate(a)
    if (list.length > 1) {
      if (!list.every((a) => a.standard === 'permit2')) throw new ApprovalsError('Only Permit2 approvals fold into one transaction.', 'invalid-approval')
      return { to: PERMIT2_ADDRESS, data: PERMIT2_ABI.encodeFunctionData('lockdown', [list.map((a) => ({ token: a.token, spender: a.spender }))]), value: 0n }
    }
    const a = list[0]
    switch (a.standard) {
      case 'erc20':
        return { to: a.token, data: ERC20_ABI.encodeFunctionData('approve', [a.spender, 0n]), value: 0n }
      case 'erc721-token':
        return { to: a.token, data: ERC721_ABI.encodeFunctionData('approve', [ZeroAddress, a.tokenId]), value: 0n }
      case 'erc721':
      case 'erc1155':
        return { to: a.token, data: ERC721_ABI.encodeFunctionData('setApprovalForAll', [a.spender, false]), value: 0n }
      case 'permit2':
        return { to: PERMIT2_ADDRESS, data: PERMIT2_ABI.encodeFunctionData('lockdown', [[{ token: a.token, spender: a.spender }]]), value: 0n }
      case 'eip7702':
        throw new ApprovalsError('An EIP-7702 delegation is revoked with a type-4 transaction (account.revokeDelegation()), not calldata.', 'unsupported-standard', { standard: a.standard })
      default:
        throw new ApprovalsError(`Standard '${a.standard}' is not supported on evm.`, 'unsupported-standard', { standard: a.standard })
    }
  }

  /**
   * @param {Approval} approval
   * @returns {Promise<{ fee: bigint }>}
   */
  async quoteRevoke (approval) {
    validate(approval)
    if (approval.standard === 'eip7702') {
      if (typeof this._account?.quoteRevokeDelegation === 'function') return { fee: BigInt((await this._account.quoteRevokeDelegation()).fee ?? 0) }
      return { fee: 0n }
    }
    const tx = this.buildRevokeTransaction(approval)
    if (typeof this._account?.quoteSendTransaction === 'function') {
      const q = await this._account.quoteSendTransaction(tx)
      return { fee: BigInt(q?.fee ?? 0) }
    }
    const provider = this._requireProvider()
    const [gas, feeData] = await Promise.all([provider.estimateGas({ ...tx, from: await this._account.getAddress() }), provider.getFeeData()])
    return { fee: gas * (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n) }
  }

  /**
   * @param {Approval} approval
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async revoke (approval) {
    this._requireWritable('revoke')
    validate(approval)
    if (approval.standard === 'eip7702') {
      if (typeof this._account.revokeDelegation !== 'function') throw new ApprovalsError('This account cannot revoke an EIP-7702 delegation (no revokeDelegation()).', 'unsupported-standard', { standard: 'eip7702' })
      return normalize(await this._account.revokeDelegation())
    }
    // ERC-20 goes through the account's own `approve` when it has one: that is
    // the operation the policy engine governs and the path wallet modules
    // already use (USDT's reset-to-zero rule never applies to amount 0).
    if (approval.standard === 'erc20' && typeof this._account.approve === 'function') {
      return normalize(await this._account.approve({ token: approval.token, spender: approval.spender, amount: 0n }))
    }
    return normalize(await this._account.sendTransaction(this.buildRevokeTransaction(approval)))
  }

  /**
   * @param {Approval[]} approvals
   * @returns {Promise<RevokeResult[]>}
   */
  async revokeAll (approvals) {
    this._requireWritable('revokeAll')
    if (!Array.isArray(approvals) || !approvals.length) return []
    for (const a of approvals) validate(a)

    /** @type {Array<{ ids: string[], tx?: object, approval?: Approval }>} */
    const items = []
    const permit2 = approvals.filter((a) => a.standard === 'permit2')
    if (permit2.length) items.push({ ids: permit2.map((a) => a.id), tx: this.buildRevokeTransaction(permit2) })
    for (const a of approvals) {
      if (a.standard === 'permit2') continue
      if (a.standard === 'eip7702') items.push({ ids: [a.id], approval: a })
      else items.push({ ids: [a.id], tx: this.buildRevokeTransaction(a), approval: a })
    }

    /** @type {RevokeResult[]} */
    const results = []
    if (this._config.batch) {
      const batched = items.filter((i) => i.tx)
      if (batched.length) {
        try {
          const r = normalize(await this._account.sendTransaction(batched.map((i) => i.tx)))
          results.push({ ids: batched.flatMap((i) => i.ids), ...r })
        } catch (error) {
          results.push({ ids: batched.flatMap((i) => i.ids), error })
        }
      }
      for (const i of items.filter((x) => !x.tx)) results.push(await this._revokeItem(i))
      return results
    }
    for (const i of items) results.push(await this._revokeItem(i))
    return results
  }

  /** @private */
  async _revokeItem (item) {
    try {
      if (item.approval && item.approval.standard !== 'permit2') {
        const r = await this.revoke(item.approval)
        return { ids: item.ids, ...r }
      }
      const r = normalize(await this._account.sendTransaction(item.tx))
      return { ids: item.ids, ...r }
    } catch (error) {
      return { ids: item.ids, error }
    }
  }

  /**
   * Recognize approvals and revokes offline on any EVM chain: ERC-20 / ERC-721
   * `approve` (amount 0 → revoke), `setApprovalForAll`, Permit2 `approve` / `lockdown`.
   * See `activity.js` for the rule.
   *
   * @param {import('@forgewallet/core').ChainTx} tx
   * @param {import('@forgewallet/core').DescribeActivityContext} ctx
   * @returns {import('@forgewallet/core').ActivityItem | null}
   */
  describeActivity (tx, ctx) {
    return describeApprovalActivity(tx, ctx, this._config.tokens ? { tokens: this._config.tokens } : {})
  }
}

function validate (a) {
  if (!a || typeof a !== 'object' || typeof a.standard !== 'string') throw new ApprovalsError('An approval object is required.', 'invalid-approval', { approval: a })
  if (!SUPPORTED.includes(a.standard)) throw new ApprovalsError(`Standard '${a.standard}' is not supported on evm.`, 'unsupported-standard', { standard: a.standard })
  if (a.standard !== 'eip7702' && (!isAddress(a.token) || !isAddress(a.spender))) throw new ApprovalsError('token and spender must be addresses.', 'invalid-approval', { approval: a })
  if (a.standard === 'erc721-token' && a.tokenId === undefined) throw new ApprovalsError('erc721-token approvals need a tokenId.', 'invalid-approval', { approval: a })
}

function normalize (result) {
  if (typeof result === 'string') return { hash: result, fee: 0n }
  return { hash: result?.hash, fee: BigInt(result?.fee ?? 0) }
}

function filterOf (options) {
  const standards = options.standards ? new Set(options.standards) : null
  const tokens = options.tokens ? new Set(options.tokens.map((t) => t.toLowerCase())) : null
  const spenders = options.spenders ? new Set(options.spenders.map((s) => s.toLowerCase())) : null
  const kindStandards = { erc20: ['erc20'], 'erc721-token': ['erc721-token'], 'nft-operator': ['erc721', 'erc1155'], permit2: ['permit2'] }
  return {
    standard: (s) => !standards || standards.has(s),
    candidate: (c) => (!standards || kindStandards[c.kind].some((s) => standards.has(s))) &&
      (!tokens || tokens.has(c.token.toLowerCase())) && (!spenders || spenders.has(c.spender.toLowerCase())),
    approval: (a) => (!standards || standards.has(a.standard)) &&
      (!tokens || tokens.has(a.token.toLowerCase())) && (!spenders || spenders.has(a.spender.toLowerCase()))
  }

}
