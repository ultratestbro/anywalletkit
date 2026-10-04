'use strict'

import { BrowserProvider, Contract, JsonRpcProvider } from 'ethers'

import StakingProtocol from './staking-protocol.js'
import SSV_ADDRESS_MAP from './ssv-address-map.js'

/** @typedef {import('./staking-protocol.js').StakeOptions} StakeOptions */
/** @typedef {import('./staking-protocol.js').StakeResult} StakeResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestOptions} WithdrawalRequestOptions */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestResult} WithdrawalRequestResult */
/** @typedef {import('./staking-protocol.js').WithdrawalRequestsView} WithdrawalRequestsView */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsOptions} ClaimWithdrawalsOptions */
/** @typedef {import('./staking-protocol.js').ClaimWithdrawalsResult} ClaimWithdrawalsResult */
/** @typedef {import('./staking-protocol.js').StakedBalance} StakedBalance */

/** SSVNetwork proxy — the staking module's writes (contracts/modules/SSVStaking.sol). */
const NETWORK_ABI = [
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function withdrawUnlocked()',
  'function claimEthRewards()',
  'function syncFees()'
]

/** SSVNetworkViews — every staking read. `pendingUnstake` returns the
 *  account's open cooldown entries; storage packs the amount as uint192 but
 *  the ABI word is the same, so uint256 decodes it. */
const VIEWS_ABI = [
  'function cooldownDuration() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function stakedBalanceOf(address user) view returns (uint256)',
  'function previewClaimableEth(address user) view returns (uint256)',
  'function pendingUnstake(address user) view returns ((uint256 amount, uint256 unlockTime)[])',
  'function stakingEthPoolBalance() view returns (uint256)',
  'function accEthPerShare() view returns (uint256)'
]

const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)'
]

/** `stake()` reverts StakeTooLow below this (1 gwei of SSV — SSVStaking.sol
 *  MINIMAL_STAKING_AMOUNT). */
export const MINIMAL_STAKING_AMOUNT = 1_000_000_000n

/** `claimEthRewards()` pays `accrued - accrued % ETH_CLAIM_UNIT` and reverts
 *  NothingToClaim when that rounds to zero (SSVCoreTypes.sol ETH_DEDUCTED_DIGITS). */
export const ETH_CLAIM_UNIT = 100_000n

/**
 * The staking module's custom errors, keyed by 4-byte selector — the raw
 * revert carries no text, so this is the only way to tell a user what
 * happened. Selectors computed from contracts/modules/SSVStaking.sol and
 * confirmed against the live proxy with eth_call.
 */
export const SSV_ERRORS = Object.freeze({
  '0x1cc3b37b': 'StakeTooLow: the amount is below the minimum stake (1 gwei of SSV).',
  '0x1f2a2005': 'ZeroAmount: the amount must be greater than zero.',
  '0x02a19f57': 'UnstakeAmountExceedsBalance: the amount exceeds the staked balance.',
  '0xee0e82ff': 'MaxRequestsAmountReached: too many open unstake requests — withdraw the unlocked ones first.',
  '0xd0d04f60': 'NothingToWithdraw: no unstake request has finished its cooldown yet.',
  '0x969bf728': 'NothingToClaim: accrued ETH rewards are below the claimable minimum.',
  '0xf4d678b8': "InsufficientBalance: the network's ETH rewards pool cannot cover the payout right now.",
  '0x045c4b02': 'TokenTransferFailed: the SSV token transfer failed.'
})

/**
 * Turns a revert into an error that names the SSVStaking custom error.
 * ethers buries the revert data in `error.data` (CALL_EXCEPTION) or a few
 * `info.error` / `cause` hops down; the selector also tends to appear in the
 * message text — every place is checked. Unknown reverts pass through.
 *
 * @param {unknown} error - The error thrown by ethers / the provider.
 * @returns {Error} The error to surface.
 */
export function describeRevert (error) {
  const haystack = [error instanceof Error ? error.message : String(error)]
  let node = error
  for (let i = 0; i < 8 && node && typeof node === 'object'; i++) {
    for (const key of ['data', 'revert']) {
      const value = node[key]
      if (typeof value === 'string') haystack.push(value)
    }
    node = node.info?.error ?? node.error ?? node.cause
  }
  const text = haystack.join(' ').toLowerCase()
  for (const [selector, message] of Object.entries(SSV_ERRORS)) {
    if (text.includes(selector)) {
      const err = new Error(message)
      err.selector = selector
      err.cause = error
      return err
    }
  }
  return error instanceof Error ? error : new Error(String(error))
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
 * @typedef {Object} SsvProtocolConfig
 * @property {string | import('ethers').Eip1193Provider} [provider] - RPC url or EIP-1193 provider to read the chain through. Defaults to the account's own provider.
 * @property {number} [chainId] - The chain to operate on (default 1). Non-mainnet chains must also supply addresses (and endpoints for APR).
 * @property {Object} [addresses] - Override for the contract addresses ({network, views, ssvToken, cssvToken}).
 * @property {Object} [endpoints] - Override for the REST endpoints ({apr, aprHistory}).
 */

/**
 * SSV Network token staking for EVM wallet accounts.
 *
 * SSV Network is the distributed validator (DVT) infrastructure a large share
 * of Ethereum staking runs on; SSV is its ERC-20 token, and cluster operators
 * pay the network's fees in ETH. Staking SSV mints cSSV 1:1 — a transferable,
 * non-rebasing receipt token — and entitles the holder to a pro-rata share of
 * those ETH fees, tracked through an ETH-per-share index and claimable at any
 * time without unstaking. Getting the SSV back is a two-phase exit: a
 * `requestUnstake` burns the cSSV into a cooldown entry (7 days at launch,
 * DAO-tunable, not cancellable) and `withdrawUnlocked` pays out every entry
 * whose cooldown has ended.
 *
 * That two-phase shape is exactly the proposed `StakingProtocol` interface:
 * `stake` → `requestWithdrawal` → `getWithdrawalRequests` → `claimWithdrawals`.
 * Two honest differences from the Lido implementation are documented on the
 * methods: the withdrawal pays SSV (the staked token, not the chain's native
 * token), and the claim call is all-or-nothing (`ids` are informational).
 *
 * Neither SSV nor cSSV supports EIP-2612 permit, so the first stake is two
 * transactions: approve (awaited to a mined receipt — `stake`'s gas estimate
 * reverts against an unmined allowance) and then `stake`. Every write is
 * proven with an `eth_call` before broadcasting, so a revert surfaces as the
 * named custom error instead of burned gas.
 */
export default class SsvProtocolEvm extends StakingProtocol {
  /**
   * Creates a new interface to the SSV Network staking protocol for evm blockchains.
   *
   * @param {*} account - The wallet account to use to interact with the protocol (a @forgewallet/wallet-evm account, or read-only account for views).
   * @param {SsvProtocolConfig} [config] - The protocol's configuration.
   */
  constructor (account, config = {}) {
    super(account)

    const chainId = config.chainId ?? 1
    const defaults = SSV_ADDRESS_MAP[chainId]
    if (!defaults && !config.addresses) {
      throw new Error(`No default SSV Network deployment for chain ${chainId}: pass 'addresses' explicitly.`)
    }

    /** @private */
    this._chainId = chainId
    const { endpoints, ...addresses } = defaults ?? {}

    /** @private */
    this._addresses = { ...addresses, ...config.addresses }
    for (const key of ['network', 'views', 'ssvToken', 'cssvToken']) {
      if (typeof this._addresses[key] !== 'string') {
        throw new Error(`'addresses.${key}' is required for chain ${chainId}.`)
      }
    }
    /** @private */
    this._endpoints = { ...endpoints, ...config.endpoints }

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
  get _network () {
    if (!this.__network) this.__network = new Contract(this._addresses.network, NETWORK_ABI, this._requireProvider())
    return this.__network
  }

  /** @private */
  get _views () {
    if (!this.__views) this.__views = new Contract(this._addresses.views, VIEWS_ABI, this._requireProvider())
    return this.__views
  }

  /** @private */
  get _ssv () {
    if (!this.__ssv) this.__ssv = new Contract(this._addresses.ssvToken, ERC20_ABI, this._requireProvider())
    return this.__ssv
  }

  /** @private */
  get _cssv () {
    if (!this.__cssv) this.__cssv = new Contract(this._addresses.cssvToken, ERC20_ABI, this._requireProvider())
    return this.__cssv
  }

  /** @private */
  _networkCall (fn, args = []) {
    return { to: this._addresses.network, data: this._network.interface.encodeFunctionData(fn, args) }
  }

  /**
   * Proves a network call with eth_call from the account before it is signed,
   * so a revert costs no gas and comes back as the named custom error.
   *
   * @private
   */
  async _prove (tx) {
    const from = await this._account.getAddress()
    try {
      await this._requireProvider().call({ ...tx, from })
    } catch (error) {
      throw describeRevert(error)
    }
  }

  /**
   * Stakes SSV — cSSV lands on the account 1:1 and ETH rewards start accruing
   * at once. Approves first when the allowance is short (the approval is
   * awaited to a mined receipt), then proves and sends `stake`.
   *
   * @param {StakeOptions} options - The stake's options (amount in SSV base unit).
   * @returns {Promise<StakeResult & { approveHash: string | null }>} The stake's result; `fee` includes the approval when one ran.
   */
  async stake ({ amount }) {
    this._requireWritable('stake(options)')
    const value = toAmount(amount)
    if (value < MINIMAL_STAKING_AMOUNT) {
      throw new Error(SSV_ERRORS['0x1cc3b37b'])
    }
    const provider = this._requireProvider()
    const owner = await this._account.getAddress()

    let approveHash = null
    let approveFee = 0n
    const allowance = await this._ssv.allowance(owner, this._addresses.network)
    if (allowance < value) {
      const approval = await this._account.sendTransaction({
        to: this._addresses.ssvToken,
        data: this._ssv.interface.encodeFunctionData('approve', [this._addresses.network, value])
      })
      approveHash = approval.hash
      approveFee = approval.fee ?? 0n
      // stake's gas estimate reverts against an unmined allowance.
      await provider.waitForTransaction(approval.hash)
    }

    const tx = this._networkCall('stake', [value])
    await this._prove(tx)
    const result = await this._account.sendTransaction(tx)
    return { hash: result.hash, fee: (result.fee ?? 0n) + approveFee, approveHash }
  }

  /**
   * Quotes the costs of a stake operation, assuming the network already holds
   * an allowance (without one the estimate itself reverts).
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<Omit<StakeResult, 'hash'>>} The stake's costs.
   */
  async quoteStake ({ amount }) {
    const value = toAmount(amount)
    const { fee } = await this._account.quoteSendTransaction(this._networkCall('stake', [value]))
    return { fee }
  }

  /**
   * Burns cSSV into a cooldown entry. Irreversible: the entry cannot be
   * cancelled and stops earning immediately; the SSV unlocks after the
   * network's cooldown (see `getCooldown`). There is a single staked-token
   * form, so `token` is accepted for interface parity and ignored.
   *
   * @param {WithdrawalRequestOptions} options - The request's options (amount in cSSV base unit).
   * @returns {Promise<WithdrawalRequestResult>} The request's result (`approveHash` is always null — burning needs no approval).
   */
  async requestWithdrawal ({ amount }) {
    this._requireWritable('requestWithdrawal(options)')
    const value = toAmount(amount)
    const tx = this._networkCall('requestUnstake', [value])
    await this._prove(tx)
    const result = await this._account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n, approveHash: null }
  }

  /**
   * Quotes the costs of an unstake request.
   *
   * @param {WithdrawalRequestOptions} options - The request's options.
   * @returns {Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>} The request's costs.
   */
  async quoteRequestWithdrawal ({ amount }) {
    const value = toAmount(amount)
    const { fee } = await this._account.quoteSendTransaction(this._networkCall('requestUnstake', [value]))
    return { fee }
  }

  /**
   * The account's open cooldown entries. Ids are the entries' positions in
   * the network's per-account list — stable until a withdrawal removes the
   * unlocked ones, so re-read after every write rather than caching them.
   * `timestamp` is derived (unlockTime − current cooldown); `unlockTime` is
   * the on-chain value. Amounts are SSV: the exit pays the staked token, not ETH.
   *
   * @returns {Promise<WithdrawalRequestsView & { requests: (import('./staking-protocol.js').WithdrawalRequest & { unlockTime: number })[] }>} The queue view.
   */
  async getWithdrawalRequests () {
    const owner = await this._account.getAddress()
    const [entries, cooldown] = await Promise.all([
      this._views.pendingUnstake(owner),
      this._views.cooldownDuration()
    ])
    const now = BigInt(Math.floor(Date.now() / 1000))
    const requests = [...entries].map((entry, index) => {
      const unlockTime = BigInt(entry.unlockTime)
      return {
        id: BigInt(index),
        amount: BigInt(entry.amount),
        timestamp: Number(unlockTime - BigInt(cooldown)),
        unlockTime: Number(unlockTime),
        claimable: unlockTime <= now
      }
    })
    let pendingAmount = 0n
    let claimableAmount = 0n
    for (const r of requests) {
      if (r.claimable) claimableAmount += r.amount
      else pendingAmount += r.amount
    }
    return {
      requests: [...requests].sort((a, b) => b.unlockTime - a.unlockTime),
      pendingAmount,
      claimableAmount,
      claimableIds: requests.filter((r) => r.claimable).map((r) => r.id)
    }
  }

  /** @private */
  async _getClaimTransaction () {
    const view = await this.getWithdrawalRequests()
    if (view.claimableIds.length === 0) {
      throw new Error('There are no claimable withdrawal requests.')
    }
    return this._networkCall('withdrawUnlocked')
  }

  /**
   * Pays out every cooldown entry that has unlocked — SSV lands on the
   * account. `withdrawUnlocked` is all-or-nothing on the network side, so
   * `options.ids` cannot narrow the claim; they are accepted for interface
   * parity and the call refuses only when nothing at all is unlocked.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<ClaimWithdrawalsResult>} The claim's result.
   */
  async claimWithdrawals (options) { // eslint-disable-line no-unused-vars
    this._requireWritable('claimWithdrawals(options)')
    const tx = await this._getClaimTransaction()
    await this._prove(tx)
    const result = await this._account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n }
  }

  /**
   * Quotes the costs of a withdraw operation.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<Omit<ClaimWithdrawalsResult, 'hash'>>} The claim's costs.
   */
  async quoteClaimWithdrawals (options) { // eslint-disable-line no-unused-vars
    const tx = await this._getClaimTransaction()
    const { fee } = await this._account.quoteSendTransaction(tx)
    return { fee }
  }

  /**
   * The account's staked position. cSSV is the only staked form and it is
   * 1:1 with SSV, so `wrappedBalance` is 0 and `rate` is exactly 1e18.
   *
   * @returns {Promise<StakedBalance>} The staked balances.
   */
  async getStakedBalance () {
    const owner = await this._account.getAddress()
    const balance = BigInt(await this._views.stakedBalanceOf(owner))
    return { balance, wrappedBalance: 0n, rate: 10n ** 18n, total: balance }
  }

  /**
   * The current APR in percent, from SSV Network's API — the same number
   * stake.ssv.network shows. It is ETH-denominated on an SSV-denominated
   * stake, so it moves with SSV's price.
   *
   * @returns {Promise<number>} The APR.
   */
  async getApr () {
    const res = await fetch(this._endpoints.apr)
    if (!res.ok) {
      throw new Error(`SSV APR API: HTTP ${res.status}`)
    }
    const body = await res.json()
    const apr = typeof body?.apr === 'number' ? body.apr : Number.parseFloat(body?.apr)
    if (!Number.isFinite(apr)) {
      throw new Error('SSV APR API: unexpected response shape.')
    }
    return apr
  }

  // ---- SSV-specific extras (not part of the proposed staking interface) ----

  /**
   * The account's liquid (unstaked, stakeable) SSV balance.
   *
   * @returns {Promise<bigint>} SSV in base unit.
   */
  async getTokenBalance () {
    const owner = await this._account.getAddress()
    return BigInt(await this._ssv.balanceOf(owner))
  }

  /**
   * ETH rewards accrued to the account and not yet claimed. Claims round
   * down to `ETH_CLAIM_UNIT`; below it the network refuses the claim.
   *
   * @returns {Promise<bigint>} ETH in wei.
   */
  async getClaimableRewards () {
    const owner = await this._account.getAddress()
    return BigInt(await this._views.previewClaimableEth(owner))
  }

  /** @private */
  async _getClaimRewardsTransaction () {
    const claimable = await this.getClaimableRewards()
    if (claimable < ETH_CLAIM_UNIT) {
      throw new Error(SSV_ERRORS['0x969bf728'])
    }
    return this._networkCall('claimEthRewards')
  }

  /**
   * Claims the accrued ETH rewards — ETH lands on the account, the staked
   * position is untouched.
   *
   * @returns {Promise<ClaimWithdrawalsResult>} The claim's result.
   */
  async claimRewards () {
    this._requireWritable('claimRewards()')
    const tx = await this._getClaimRewardsTransaction()
    await this._prove(tx)
    const result = await this._account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n }
  }

  /**
   * Quotes the costs of a rewards claim.
   *
   * @returns {Promise<Omit<ClaimWithdrawalsResult, 'hash'>>} The claim's costs.
   */
  async quoteClaimRewards () {
    const tx = await this._getClaimRewardsTransaction()
    const { fee } = await this._account.quoteSendTransaction(tx)
    return { fee }
  }

  /**
   * The network's current unstake cooldown, in seconds (DAO-tunable — read
   * it, never hardcode 7 days).
   *
   * @returns {Promise<number>} Cooldown seconds.
   */
  async getCooldown () {
    return Number(await this._views.cooldownDuration())
  }

  /**
   * Network-wide staking figures.
   *
   * @returns {Promise<{ totalStaked: bigint, rewardsPool: bigint, accEthPerShare: bigint }>} Total cSSV supply (SSV base unit), the ETH pool backing claims (wei), and the cumulative ETH-per-share index (1e18 precision).
   */
  async getNetworkStats () {
    const [totalStaked, rewardsPool, accEthPerShare] = await Promise.all([
      this._views.totalStaked(),
      this._views.stakingEthPoolBalance(),
      this._views.accEthPerShare()
    ])
    return { totalStaked: BigInt(totalStaked), rewardsPool: BigInt(rewardsPool), accEthPerShare: BigInt(accEthPerShare) }
  }

  /**
   * Daily APR samples from SSV Network's API, oldest first, with the SSV and
   * ETH prices the API priced them at. Decoration: failures return an empty
   * array, never throw.
   *
   * @param {{ limit?: number }} [options] - The history's options.
   * @returns {Promise<{ timestamp: number, apr: number, ssvPriceUsd: number | null, ethPriceUsd: number | null }[]>} Samples (timestamp unix seconds, apr percent).
   */
  async getAprHistory ({ limit = 7 } = {}) {
    try {
      const res = await fetch(this._endpoints.aprHistory)
      if (!res.ok) return []
      const body = await res.json()
      const num = (v) => {
        const n = typeof v === 'number' ? v : Number.parseFloat(v)
        return Number.isFinite(n) ? n : null
      }
      return (body?.samples ?? [])
        .map((s) => ({
          timestamp: Math.floor(new Date(s.timestamp).getTime() / 1000),
          apr: num(s.currentApr),
          ssvPriceUsd: num(s.ssvPrice),
          ethPriceUsd: num(s.ethPrice)
        }))
        .filter((s) => Number.isFinite(s.timestamp) && s.apr !== null)
        .slice(-limit)
    } catch {
      return []
    }
  }
}
