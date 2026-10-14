'use strict'

import { BrowserProvider, Contract, JsonRpcProvider, Signature, ZeroAddress, isAddress } from 'ethers'

import StakingProtocol from './staking-protocol.js'
import LIDO_ADDRESS_MAP from './lido-address-map.js'
import { describeLidoActivity } from './lido-activity.js'

/** @typedef {import('./staking-protocol.js').StakeOptions} StakeOptions */
/** @typedef {import('./staking-protocol.js').StakeResult} StakeResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestOptions} WithdrawalRequestOptions */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestResult} WithdrawalRequestResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestsView} WithdrawalRequestsView */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsOptions} ClaimWithdrawalsOptions */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsResult} ClaimWithdrawalsResult */
/** @typedef {import('./staking-protocol.js').StakedBalance} StakedBalance */

const STETH_ABI = [
  'function submit(address _referral) payable returns (uint256)',
  'function balanceOf(address _account) view returns (uint256)',
  'function allowance(address _owner, address _spender) view returns (uint256)',
  'function approve(address _spender, uint256 _amount) returns (bool)',
  'function nonces(address _owner) view returns (uint256)',
  'function isStakingPaused() view returns (bool)',
  'function getCurrentStakeLimit() view returns (uint256)'
]

const WSTETH_ABI = [
  'function wrap(uint256 _stETHAmount) returns (uint256)',
  'function unwrap(uint256 _wstETHAmount) returns (uint256)',
  'function balanceOf(address _account) view returns (uint256)',
  'function allowance(address _owner, address _spender) view returns (uint256)',
  'function approve(address _spender, uint256 _amount) returns (bool)',
  'function nonces(address _owner) view returns (uint256)',
  'function stEthPerToken() view returns (uint256)'
]

const WITHDRAWAL_QUEUE_ABI = [
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETHWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function getWithdrawalRequests(address _owner) view returns (uint256[])',
  'function getWithdrawalStatus(uint256[] _requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[])',
  'function getLastCheckpointIndex() view returns (uint256)',
  'function findCheckpointHints(uint256[] _requestIds, uint256 _firstIndex, uint256 _lastIndex) view returns (uint256[])',
  'function getClaimableEther(uint256[] _requestIds, uint256[] _hints) view returns (uint256[])',
  'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)'
]

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' }
  ]
}

/** Withdrawal queue bounds per single request (the contract's
 *  MIN/MAX_STETH_WITHDRAWAL_AMOUNT — immutable on the deployed queue). */
const MAX_STETH_PER_REQUEST = 1000n * 10n ** 18n
/** wstETH cap per request: the queue's limit is 1000 stETH-EQUIVALENT; at
 *  ~1.2 stETH per wstETH, 800 wstETH stays safely under it as the rate keeps
 *  drifting upward. */
const MAX_WSTETH_PER_REQUEST = 800n * 10n ** 18n

/**
 * Splits an over-cap withdrawal into the per-request chunks the queue
 * enforces: N full caps followed by the remainder.
 *
 * @param {bigint} amount - The total amount to withdraw (in base unit).
 * @param {bigint} cap - The queue's per-request maximum.
 * @returns {bigint[]} The request amounts.
 */
export function splitWithdrawalAmounts (amount, cap) {
  const amounts = []
  let rest = amount
  while (rest > cap) {
    amounts.push(cap)
    rest -= cap
  }
  amounts.push(rest)
  return amounts
}

/**
 * Normalizes and validates an amount option.
 *
 * @param {number | bigint} amount - The amount (in base unit).
 * @returns {bigint} The amount as a bigint.
 */
function toAmount (amount) {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new Error("'amount' must be a bigint or a safe integer (in base unit).")
  }
  const value = BigInt(amount)
  if (value <= 0n) {
    throw new Error("'amount' should be greater than zero.")
  }
  return value
}

/**
 * @typedef {Object} LidoProtocolConfig
 * @property {string | import('ethers').Eip1193Provider} [provider] - RPC url or EIP-1193 provider to read the chain through. Defaults to the account's own provider.
 * @property {number} [chainId] - The chain to operate on (default 1). Non-mainnet chains must also supply addresses, permitDomains and endpoints.
 * @property {string} [referral] - Referral address forwarded to Lido's submit() — integrators whitelisted in the Lido Rewards-Share program earn on stake flow. Defaults to the zero address.
 * @property {Object} [addresses] - Override for the contract addresses ({stEth, wstEth, withdrawalQueue}).
 * @property {Object} [permitDomains] - Override for the EIP-2612 domains ({stEth: {name, version}, wstEth: {name, version}}).
 * @property {Object} [endpoints] - Override for the REST endpoints ({apr, withdrawalQueueApi, rewardHistory}).
 */

/**
 * Lido liquid staking for EVM wallet accounts: stake ETH → stETH, exit through
 * the two-phase withdrawal queue (request → finalization → claim), wrap to and
 * unwrap from the non-rebasing wstETH form, and read APR / rewards.
 *
 * Withdrawal requests are permit-first: one EIP-2612 signature rides inside
 * the request transaction, so the whole exit costs a single transaction. The
 * permit is PROVEN with an eth_call before broadcasting — a bad signature must
 * fall back to the two-transaction approve + request path, not burn gas. The
 * fallback's approval is awaited to a mined receipt before the request is
 * sent, because the request's gas estimate reverts against an unmined
 * allowance.
 */
export default class LidoProtocolEvm extends StakingProtocol {
  /**
   * Creates a new interface to the Lido protocol for evm blockchains.
   *
   * @param {*} account - The wallet account to use to interact with the protocol (a @forgewallet/wallet-evm account, or read-only account for views).
   * @param {LidoProtocolConfig} [config] - The protocol's configuration.
   */
  constructor (account, config = {}) {
    super(account)

    const chainId = config.chainId ?? 1
    const defaults = LIDO_ADDRESS_MAP[chainId]
    if (!defaults && !(config.addresses && config.permitDomains)) {
      throw new Error(`No default Lido deployment for chain ${chainId}: pass 'addresses' and 'permitDomains' explicitly.`)
    }

    /** @private */
    this._chainId = chainId
    const { permitDomains, endpoints, ...addresses } = defaults ?? {}

    /** @private */
    this._addresses = { ...addresses, ...config.addresses }
    /** @private */
    this._permitDomains = { ...permitDomains, ...config.permitDomains }
    /** @private */
    this._endpoints = { ...endpoints, ...config.endpoints }
    /** @private */
    this._referral = config.referral ?? ZeroAddress

    if (this._referral !== ZeroAddress && !isAddress(this._referral)) {
      throw new Error("'referral' must be a valid address.")
    }

    const provider = config.provider ?? account?._config?.provider
    if (provider) {
      /** @private */
      this._provider = typeof provider === 'string'
        ? new JsonRpcProvider(provider)
        : new BrowserProvider(provider)
    }
  }

  /** @private */
  _requireProvider () {
    if (!this._provider) {
      throw new Error('The protocol must be initialized with a provider (or an account configured with one).')
    }
    return this._provider
  }

  /** @private */
  _requireWritable (method) {
    // A structural check, deliberately not instanceof: a duplicated copy of
    // the account package fails instanceof while the account works fine.
    if (typeof this._account?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
  }

  /** @private */
  get _stEth () {
    if (!this.__stEth) this.__stEth = new Contract(this._addresses.stEth, STETH_ABI, this._requireProvider())
    return this.__stEth
  }

  /** @private */
  get _wstEth () {
    if (!this.__wstEth) this.__wstEth = new Contract(this._addresses.wstEth, WSTETH_ABI, this._requireProvider())
    return this.__wstEth
  }

  /** @private */
  get _queue () {
    if (!this.__queue) this.__queue = new Contract(this._addresses.withdrawalQueue, WITHDRAWAL_QUEUE_ABI, this._requireProvider())
    return this.__queue
  }

  /** @private */
  async _getStakeTransaction (amount) {
    // Guard pause/rate-limit up front: the raw estimateGas revert carries no
    // readable reason for either condition.
    const [paused, limit] = await Promise.all([
      this._stEth.isStakingPaused().catch(() => false),
      this._stEth.getCurrentStakeLimit().catch(() => null)
    ])
    if (paused) {
      throw new Error('Lido staking is paused right now.')
    }
    if (limit !== null && amount > limit) {
      throw new Error("This amount is over Lido's current stake rate limit.")
    }
    return {
      to: this._addresses.stEth,
      value: amount,
      data: this._stEth.interface.encodeFunctionData('submit', [this._referral])
    }
  }

  /**
   * Stakes ETH — stETH lands on the account 1:1.
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<StakeResult>} The stake's result.
   */
  async stake ({ amount }) {
    this._requireWritable('stake(options)')
    const value = toAmount(amount)
    const tx = await this._getStakeTransaction(value)
    return await this._account.sendTransaction(tx)
  }

  /**
   * Quotes the costs of a stake operation.
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<Omit<StakeResult, 'hash'>>} The stake's costs.
   */
  async quoteStake ({ amount }) {
    const value = toAmount(amount)
    const tx = await this._getStakeTransaction(value)
    const { fee } = await this._account.quoteSendTransaction(tx)
    return { fee }
  }

  /** @private */
  _withdrawalToken (token = 'stETH') {
    if (token === 'stETH') {
      return {
        address: this._addresses.stEth,
        domain: this._permitDomains.stEth,
        cap: MAX_STETH_PER_REQUEST,
        requestFn: 'requestWithdrawals',
        permitFn: 'requestWithdrawalsWithPermit',
        contract: this._stEth
      }
    }
    if (token === 'wstETH') {
      return {
        address: this._addresses.wstEth,
        domain: this._permitDomains.wstEth,
        cap: MAX_WSTETH_PER_REQUEST,
        requestFn: 'requestWithdrawalsWstETH',
        permitFn: 'requestWithdrawalsWstETHWithPermit',
        contract: this._wstEth
      }
    }
    throw new Error("'token' must be either 'stETH' or 'wstETH'.")
  }

  /** @private */
  async _signPermit (tokenInfo, owner, value) {
    const nonce = await tokenInfo.contract.nonces(owner)
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const signature = await this._account.signTypedData({
      domain: {
        name: tokenInfo.domain.name,
        version: tokenInfo.domain.version,
        chainId: this._chainId,
        verifyingContract: tokenInfo.address
      },
      types: PERMIT_TYPES,
      message: {
        owner,
        spender: this._addresses.withdrawalQueue,
        value,
        nonce,
        deadline
      }
    })
    const { v, r, s } = Signature.from(signature)
    return [value, deadline, v, r, s]
  }

  /**
   * Queues stETH or wstETH for withdrawal through the Lido queue. Permit-first
   * (one signature, one transaction); falls back to approve + request if the
   * permit leg fails. Over-cap amounts split into several requests inside the
   * same transaction.
   *
   * @param {WithdrawalRequestOptions} options - The request's options.
   * @returns {Promise<WithdrawalRequestResult>} The request's result.
   */
  async requestWithdrawal ({ amount, token = 'stETH' }) {
    this._requireWritable('requestWithdrawal(options)')
    const value = toAmount(amount)
    const info = this._withdrawalToken(token)
    const provider = this._requireProvider()
    const owner = await this._account.getAddress()
    const amounts = splitWithdrawalAmounts(value, info.cap)
    const queueAddress = this._addresses.withdrawalQueue

    try {
      const permit = await this._signPermit(info, owner, value)
      const data = this._queue.interface.encodeFunctionData(info.permitFn, [amounts, owner, permit])
      // Prove the permit executes before broadcasting — a bad signature must
      // fall back, not burn gas.
      await provider.call({ from: owner, to: queueAddress, data })
      const result = await this._account.sendTransaction({ to: queueAddress, data })
      return { ...result, approveHash: null }
    } catch {
      // fall through to approve + request
    }

    let approveHash = null
    let approveFee = 0n
    const allowance = await info.contract.allowance(owner, queueAddress)
    if (allowance < value) {
      const approval = await this._account.sendTransaction({
        to: info.address,
        data: info.contract.interface.encodeFunctionData('approve', [queueAddress, value])
      })
      approveHash = approval.hash
      approveFee = approval.fee ?? 0n
      // The request's gas estimate reverts against an unmined allowance.
      await provider.waitForTransaction(approval.hash)
    }

    const result = await this._account.sendTransaction({
      to: queueAddress,
      data: this._queue.interface.encodeFunctionData(info.requestFn, [amounts, owner])
    })
    return { hash: result.hash, fee: (result.fee ?? 0n) + approveFee, approveHash }
  }

  /**
   * Quotes the costs of a withdrawal request, assuming the queue already holds
   * an allowance (the executed request needs none — it carries a permit).
   *
   * @param {WithdrawalRequestOptions} options - The request's options.
   * @returns {Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>} The request's costs.
   */
  async quoteRequestWithdrawal ({ amount, token = 'stETH' }) {
    const value = toAmount(amount)
    const info = this._withdrawalToken(token)
    const owner = await this._account.getAddress()
    const amounts = splitWithdrawalAmounts(value, info.cap)
    const { fee } = await this._account.quoteSendTransaction({
      to: this._addresses.withdrawalQueue,
      data: this._queue.interface.encodeFunctionData(info.requestFn, [amounts, owner])
    })
    return { fee }
  }

  /**
   * The account's live withdrawal queue.
   *
   * @returns {Promise<WithdrawalRequestsView>} The queue view.
   */
  async getWithdrawalRequests () {
    const owner = await this._account.getAddress()
    const ids = await this._queue.getWithdrawalRequests(owner)
    if (ids.length === 0) {
      return { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] }
    }
    const statuses = await this._queue.getWithdrawalStatus([...ids])
    const open = [...ids]
      .map((id, i) => ({ id, status: statuses[i] }))
      .filter((r) => !r.status.isClaimed)
    const requests = open
      .map((r) => ({
        id: r.id,
        amount: r.status.amountOfStETH,
        timestamp: Number(r.status.timestamp),
        claimable: r.status.isFinalized
      }))
      .sort((a, b) => Number(b.id - a.id))
    // findCheckpointHints requires ascending ids
    const claimableIds = open.filter((r) => r.status.isFinalized).map((r) => r.id).sort((a, b) => Number(a - b))
    let claimableAmount = 0n
    if (claimableIds.length > 0) {
      const hints = await this._findHints(claimableIds)
      const ether = await this._queue.getClaimableEther(claimableIds, hints)
      claimableAmount = [...ether].reduce((a, b) => a + b, 0n)
    }
    return {
      requests,
      pendingAmount: open.filter((r) => !r.status.isFinalized).reduce((a, r) => a + r.status.amountOfStETH, 0n),
      claimableAmount,
      claimableIds
    }
  }

  /** @private */
  async _findHints (ids) {
    const last = await this._queue.getLastCheckpointIndex()
    const hints = await this._queue.findCheckpointHints(ids, 1n, last)
    return [...hints]
  }

  /** @private */
  async _getClaimTransaction (options) {
    let ids = options?.ids
    if (!ids || ids.length === 0) {
      const view = await this.getWithdrawalRequests()
      ids = view.claimableIds
    } else {
      ids = ids.map((id) => BigInt(id)).sort((a, b) => Number(a - b))
    }
    if (ids.length === 0) {
      throw new Error('There are no claimable withdrawal requests.')
    }
    const hints = await this._findHints(ids)
    return {
      to: this._addresses.withdrawalQueue,
      data: this._queue.interface.encodeFunctionData('claimWithdrawals', [ids, hints])
    }
  }

  /**
   * Claims finalized withdrawal requests — ETH lands on the account.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<ClaimWithdrawalsResult>} The claim's result.
   */
  async claimWithdrawals (options) {
    this._requireWritable('claimWithdrawals(options)')
    const tx = await this._getClaimTransaction(options)
    return await this._account.sendTransaction(tx)
  }

  /**
   * Quotes the costs of a claim operation.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<Omit<ClaimWithdrawalsResult, 'hash'>>} The claim's costs.
   */
  async quoteClaimWithdrawals (options) {
    const tx = await this._getClaimTransaction(options)
    const { fee } = await this._account.quoteSendTransaction(tx)
    return { fee }
  }

  /**
   * The account's staked position: stETH, wstETH and the live rate.
   *
   * @returns {Promise<StakedBalance>} The staked balances.
   */
  async getStakedBalance () {
    const owner = await this._account.getAddress()
    const [balance, wrappedBalance, rate] = await Promise.all([
      this._stEth.balanceOf(owner),
      this._wstEth.balanceOf(owner),
      this._wstEth.stEthPerToken()
    ])
    return {
      balance,
      wrappedBalance,
      rate,
      total: balance + (wrappedBalance * rate) / 10n ** 18n
    }
  }

  /**
   * Lido's 7-day SMA staking APR, in percent.
   *
   * @returns {Promise<number>} The APR.
   */
  async getApr () {
    const res = await fetch(this._endpoints.apr)
    if (!res.ok) {
      throw new Error(`Lido APR API: HTTP ${res.status}`)
    }
    const body = await res.json()
    const apr = body?.data?.smaApr
    if (typeof apr !== 'number') {
      throw new Error('Lido APR API: unexpected response shape.')
    }
    return apr
  }

  // ---- Lido-specific extras (not part of the proposed staking interface) ----

  /**
   * Wraps stETH into the non-rebasing wstETH. wstETH has no wrap-with-permit,
   * so this is approve (awaited to a mined receipt) + wrap.
   *
   * @param {StakeOptions} options - The wrap's options (amount in stETH base unit).
   * @returns {Promise<WithdrawalRequestResult>} The wrap's result (approveHash null if the allowance already covered it).
   */
  async wrap ({ amount }) {
    this._requireWritable('wrap(options)')
    const value = toAmount(amount)
    const provider = this._requireProvider()
    const owner = await this._account.getAddress()
    let approveHash = null
    let approveFee = 0n
    const allowance = await this._stEth.allowance(owner, this._addresses.wstEth)
    if (allowance < value) {
      const approval = await this._account.sendTransaction({
        to: this._addresses.stEth,
        data: this._stEth.interface.encodeFunctionData('approve', [this._addresses.wstEth, value])
      })
      approveHash = approval.hash
      approveFee = approval.fee ?? 0n
      await provider.waitForTransaction(approval.hash)
    }
    const result = await this._account.sendTransaction({
      to: this._addresses.wstEth,
      data: this._wstEth.interface.encodeFunctionData('wrap', [value])
    })
    return { hash: result.hash, fee: (result.fee ?? 0n) + approveFee, approveHash }
  }

  /**
   * Unwraps wstETH back to stETH — a single transaction, no approval needed.
   *
   * @param {StakeOptions} options - The unwrap's options (amount in wstETH base unit).
   * @returns {Promise<StakeResult>} The unwrap's result.
   */
  async unwrap ({ amount }) {
    this._requireWritable('unwrap(options)')
    const value = toAmount(amount)
    return await this._account.sendTransaction({
      to: this._addresses.wstEth,
      data: this._wstEth.interface.encodeFunctionData('unwrap', [value])
    })
  }

  /**
   * Finalization ETA per queued request, in seconds, from Lido's withdrawal
   * queue API. Decoration: failures return an empty map, never throw.
   *
   * @param {bigint[]} ids - The request ids.
   * @returns {Promise<Map<string, number>>} Request id (as string) → ETA seconds. Finalized requests are absent.
   */
  async getWithdrawalEta (ids) {
    const out = new Map()
    if (!ids || ids.length === 0) return out
    try {
      const res = await fetch(`${this._endpoints.withdrawalQueueApi}/v2/request-time?ids=${ids.map(String).join(',')}`)
      if (!res.ok) return out
      // Entries mirror the ids order; finalized requests carry requestInfo: null.
      const body = await res.json()
      body.forEach((item, i) => {
        const id = ids[i]
        const eta = item?.requestInfo?.finalizationIn
        if (id !== undefined && typeof eta === 'number') {
          out.set(String(id), Math.ceil(eta / 1000))
        }
      })
    } catch {}
    return out
  }

  /**
   * Rough finalization ETA for a NEW withdrawal request of the given size, in
   * seconds, from Lido's withdrawal queue API (which takes ETHER units).
   * Decoration: failures return null, never throw.
   *
   * @param {number | bigint} amount - The amount to withdraw (in base unit).
   * @returns {Promise<number | null>} ETA seconds, or null.
   */
  async getWithdrawalEtaForAmount (amount) {
    try {
      const value = toAmount(amount)
      const ether = `${value / 10n ** 18n}.${(value % 10n ** 18n).toString().padStart(18, '0')}`
      const res = await fetch(`${this._endpoints.withdrawalQueueApi}/v2/request-time/calculate?amount=${ether}`)
      if (!res.ok) return null
      const body = await res.json()
      const ms = body?.requestInfo?.finalizationIn
      return typeof ms === 'number' ? Math.ceil(ms / 1000) : null
    } catch {
      return null
    }
  }

  /**
   * Lifetime staking rewards for the account, from the same backend
   * stake.lido.fi uses. Decoration: failures return null, never throw.
   *
   * @returns {Promise<{ totalRewards: bigint, averageApr: number | null } | null>} Lifetime stETH rewards (base unit) and average APR (percent).
   */
  async getRewards () {
    try {
      const owner = await this._account.getAddress()
      const res = await fetch(`${this._endpoints.rewardHistory}/?address=${owner}&limit=1`)
      if (!res.ok) return null
      const body = await res.json()
      const raw = body?.totals?.ethRewards
      if (raw === undefined || !/^[0-9]+$/.test(String(raw))) return null
      return {
        totalRewards: BigInt(String(raw)),
        averageApr: typeof body.averageApr === 'number' ? body.averageApr : null
      }
    } catch {
      return null
    }
  }

  /**
   * Daily rebase reward history for the account, newest first. Decoration:
   * failures return an empty array, never throw.
   *
   * @param {{ limit?: number }} [options] - The history's options.
   * @returns {Promise<{ timestamp: number, reward: bigint, apr: number | null }[]>} Rebase events (reward in stETH base unit, timestamp unix seconds).
   */
  async getRewardHistory ({ limit = 14 } = {}) {
    try {
      const owner = await this._account.getAddress()
      const res = await fetch(`${this._endpoints.rewardHistory}/?address=${owner}&limit=${limit}&skip=0`)
      if (!res.ok) return []
      const body = await res.json()
      return (body?.events ?? [])
        .filter((e) => e.type === 'reward' && e.rewards !== undefined && /^[0-9]+$/.test(String(e.rewards)))
        .map((e) => ({
          timestamp: Number(e.blockTime),
          reward: BigInt(String(e.rewards)),
          apr: e.apr !== undefined && !Number.isNaN(Number(e.apr)) ? Number(e.apr) : null
        }))
    } catch {
      return []
    }
  }

  /**
   * Recognize this deployment's Lido transactions offline (stETH `submit`, wstETH
   * `wrap` / `unwrap`, WithdrawalQueue `requestWithdrawals*` / `claimWithdrawals*`).
   * See `lido-activity.js` for the rule.
   *
   * @param {import('@forgewallet/core').ChainTx} tx
   * @param {import('@forgewallet/core').DescribeActivityContext} ctx
   * @returns {import('@forgewallet/core').ActivityItem | null}
   */
  describeActivity (tx, ctx) {
    return describeLidoActivity(tx, ctx, { chainId: this._chainId, addresses: this._addresses })
  }
}
