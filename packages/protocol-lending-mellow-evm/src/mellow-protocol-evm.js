'use strict'

import { BrowserProvider, Contract, JsonRpcProvider, ZeroAddress, getAddress, isAddress } from 'ethers'
import { LendingProtocol, NotImplementedError } from '@forgewallet/core'

import MELLOW_ADDRESS_MAP from './mellow-address-map.js'
import { describeMellowActivity } from './mellow-activity.js'

/** @typedef {import('@forgewallet/core').SupplyOptions} SupplyOptions */
/** @typedef {import('@forgewallet/core').SupplyResult} SupplyResult */
/** @typedef {import('@forgewallet/core').WithdrawOptions} WithdrawOptions */
/** @typedef {import('@forgewallet/core').WithdrawResult} WithdrawResult */

/** The vault's id for native ETH (the ERC-7528 placeholder). */
export const NATIVE_ASSET = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
/** Mellow's public vault registry — APY / TVL / withdrawal time (decoration only). */
export const DEFAULT_REGISTRY = 'https://api.mellow.finance/v1/vaults'
const E18 = 10n ** 18n
const MAX_UINT224 = (1n << 224n) - 1n

const VAULT_ABI = [
  'function shareManager() view returns (address)',
  'function feeManager() view returns (address)',
  'function oracle() view returns (address)',
  'function riskManager() view returns (address)',
  'function getAssetCount() view returns (uint256)',
  'function assetAt(uint256 index) view returns (address)',
  'function getQueueCount(address asset) view returns (uint256)',
  'function queueAt(address asset, uint256 index) view returns (address)',
  'function hasQueue(address queue) view returns (bool)',
  'function isDepositQueue(address queue) view returns (bool)',
  'function isPausedQueue(address queue) view returns (bool)'
]

const SHARE_MANAGER_ABI = [
  'function activeSharesOf(address account) view returns (uint256)',
  'function claimableSharesOf(address account) view returns (uint256)',
  'function sharesOf(address account) view returns (uint256)',
  'function activeShares() view returns (uint256)',
  // `flags()` returns a struct whose tail differs between deployed versions
  // (5 or 4 bools, then the lockups); it is read raw and the leading four
  // bools — mint pause, burn pause, transfer pause, whitelist — decoded.
  'function flags() view returns (bytes)'
]
/** keccak256('flags()')[0..4] */
const FLAGS_SELECTOR = '0x64cc4aa5' 

const ORACLE_ABI = [
  'function getReport(address asset) view returns ((uint224 priceD18, uint32 timestamp, bool isSuspicious))',
  'function securityParams() view returns ((uint208 absoluteDeviation, uint64 relativeDeviationD18, uint64 suspiciousAbsoluteDeviation, uint64 suspiciousRelativeDeviationD18, uint32 timeout, uint32 depositInterval, uint32 redeemInterval))'
]

const FEE_MANAGER_ABI = [
  'function depositFeeD6() view returns (uint24)',
  'function redeemFeeD6() view returns (uint24)',
  'function performanceFeeD6() view returns (uint24)',
  'function protocolFeeD6() view returns (uint24)'
]

const DEPOSIT_QUEUE_ABI = [
  'function deposit(uint224 assets, address referral, bytes32[] merkleProof) payable',
  'function cancelDepositRequest()',
  'function claimableOf(address account) view returns (uint256)',
  'function claim(address account) returns (bool)',
  'function requestOf(address account) view returns (uint256 timestamp, uint256 assets)'
]

const REDEEM_QUEUE_ABI = [
  'function redeem(uint256 shares)',
  'function requestsOf(address account, uint256 offset, uint256 limit) view returns ((uint256 timestamp, uint256 shares, bool isClaimable, uint256 assets)[])',
  'function claim(address receiver, uint32[] timestamps) returns (uint256)',
  'function getState() view returns (uint256 batchIterator, uint256 batches, uint256 demandedAssets, uint256 pendingShares)'
]

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]

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
 * Normalizes a token option to the vault's asset id: 'native' / the zero
 * address / the ERC-7528 placeholder all mean ETH.
 *
 * @param {string} token - The token option.
 * @returns {string} A checksummed asset address.
 */
export function toAsset (token) {
  if (token === undefined || token === null || token === 'native' || token === 'ETH') return NATIVE_ASSET
  if (!isAddress(token)) throw new Error("'token' must be a valid address or 'native'.")
  const a = getAddress(token)
  return a === ZeroAddress ? NATIVE_ASSET : a
}

/**
 * @typedef {Object} MellowProtocolConfig
 * @property {string} [vault] - The Core Vault address. Required unless `preset` names a known vault.
 * @property {string} [preset] - A key of `MELLOW_ADDRESS_MAP` (e.g. 'lido-earn-eth', 'lido-earn-usd').
 * @property {number} [chainId] - The chain the vault lives on (default 1). Only used to pick presets and label errors.
 * @property {string | import('ethers').Eip1193Provider} [provider] - RPC url or EIP-1193 provider to read the chain through. Defaults to the account's own provider.
 * @property {string | null} [registry] - Mellow's vault registry URL for APY / TVL / withdrawal time (decoration). `null` disables it.
 * @property {boolean} [instant] - Try the vault's synchronous deposit queue first (shares in the same transaction), fall back to the async queue (default true).
 * @property {string} [referral] - Referral address forwarded to the deposit queues (default zero address).
 * @property {number} [maxRedeemRequests] - How many redeem requests to read per queue (default 50).
 */

/**
 * Mellow Core Vaults for EVM wallet accounts — Lido's Earn vaults (EarnETH,
 * EarnUSD, stRATEGY) and any other vault on the same contracts.
 *
 * A Core Vault holds LP money that a curator allocates across DeFi through
 * verified sub-vault calls; LPs hold vault **shares** (earnETH, earnUSD, …)
 * priced by the vault's oracle once per report (~daily). Money moves through
 * per-asset queues the vault itself lists on-chain:
 *
 *  - **supply** — `deposit` into the asset's queue. The synchronous queue
 *    mints shares in the same transaction at the last report's price (used
 *    first when `instant` is on); the asynchronous queue records a request
 *    that the next report prices, after which the shares are counted in the
 *    account's balance without any further action (`claimShares` only moves
 *    them physically). One open async request per account; cancellable until
 *    it is priced (`cancelSupply`).
 *  - **withdraw** — `redeem(shares)` on the asset's redeem queue: the shares
 *    burn at once, the request is *not* cancellable, the next report at least
 *    `redeemInterval` later prices it, the curator pulls liquidity, and
 *    `claimWithdrawals` pays the asset out. That second phase is what makes
 *    this a two-step withdraw; `getWithdrawalRequests` reports the queue.
 *
 * Reads run through the account's provider (ethers v6). Every queue is found
 * on-chain (`getQueueCount` / `queueAt`, classified by the methods it
 * answers) and re-verified against the vault (`hasQueue`, direction, pause)
 * before money touches it; a suspicious oracle report or a whitelist gate
 * refuses instead of pricing blindly. Mellow's registry only decorates.
 *
 * `borrow` / `repay` reject: a vault does not lend.
 */
export default class MellowProtocolEvm extends LendingProtocol {
  /**
   * Creates a new interface to a Mellow Core Vault for evm blockchains.
   *
   * @param {*} account - The wallet account (a @forgewallet/wallet-evm account, or a read-only one for views).
   * @param {MellowProtocolConfig} [config] - The protocol's configuration.
   */
  constructor (account, config = {}) {
    super(account)

    const chainId = config.chainId ?? 1
    const preset = config.preset ? MELLOW_ADDRESS_MAP[chainId]?.[config.preset] : undefined
    if (config.preset && !preset) {
      throw new Error(`Unknown Mellow preset '${config.preset}' on chain ${chainId}.`)
    }
    const vault = config.vault ?? preset?.vault
    if (!vault || !isAddress(vault)) {
      throw new Error("'vault' must be a Core Vault address (or 'preset' a key of MELLOW_ADDRESS_MAP).")
    }
    /** The vault this protocol talks to. */
    this.vault = getAddress(vault)
    /** @private */
    this._chainId = chainId
    /** @private */
    this._preset = preset ?? null
    /** @private */
    this._registry = config.registry === undefined ? DEFAULT_REGISTRY : config.registry
    /** @private */
    this._instant = config.instant ?? true
    /** @private */
    this._referral = config.referral ?? ZeroAddress
    if (this._referral !== ZeroAddress && !isAddress(this._referral)) {
      throw new Error("'referral' must be a valid address.")
    }
    /** @private */
    this._maxRedeemRequests = config.maxRedeemRequests ?? 50

    const provider = config.provider ?? account?._config?.provider
    if (provider) {
      /** @private */
      // Discovery fires many reads at once; send them one per request — some gateways answer a batch member with empty data.
      this._provider = typeof provider === 'string' ? new JsonRpcProvider(provider, undefined, { batchMaxCount: 1 }) : new BrowserProvider(provider)
    }
    /** @private */
    this._vaultData = null
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
    // Structural, deliberately not instanceof: a duplicated copy of the
    // account package fails instanceof while the account works fine.
    if (typeof this._account?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
  }

  /** @private */
  _contract (address, abi) {
    return new Contract(address, abi, this._requireProvider())
  }

  /** @private */
  get _vault () {
    if (!this.__vault) this.__vault = this._contract(this.vault, VAULT_ABI)
    return this.__vault
  }

  // ---- Discovery ----

  /**
   * Classifies a queue by the methods it answers: an async deposit queue has
   * `requestOf`, a sync one does not; a redeem queue has `requestsOf`, a
   * signature queue does not.
   *
   * @private
   */
  async _classifyQueue (address, isDeposit) {
    // Only a revert says "this contract has no such method"; a transport error
    // (rate limit, batch rejected, timeout) must not reclassify a queue.
    const probe = async (abi, fn, args) => {
      try {
        await this._contract(address, abi)[fn](...args)
        return true
      } catch (e) {
        if (e?.code === 'CALL_EXCEPTION' || e?.code === 'BAD_DATA') return false
        throw e
      }
    }
    if (isDeposit) {
      return (await probe(DEPOSIT_QUEUE_ABI, 'requestOf', [ZeroAddress])) ? 'async' : 'sync'
    }
    return (await probe(REDEEM_QUEUE_ABI, 'requestsOf', [ZeroAddress, 0n, 1n])) ? 'async' : 'signature'
  }

  /**
   * The vault's components, assets and queues as the chain reports them,
   * plus the fee and oracle parameters. Cached per instance (queues change
   * rarely); pass `{ refresh: true }` to re-read.
   *
   * @param {{ refresh?: boolean }} [options] - Cache control.
   * @returns {Promise<{ vault: string, shareManager: string, feeManager: string, oracle: string, riskManager: string, assets: Array<{ address: string, native: boolean, depositQueues: Array<{ address: string, kind: 'async' | 'sync', paused: boolean }>, redeemQueues: Array<{ address: string, kind: 'async' | 'signature', paused: boolean }> }>, fees: { depositPct: number, redeemPct: number, performancePct: number, protocolPct: number }, oracleParams: { timeout: number, depositInterval: number, redeemInterval: number }, flags: { hasWhitelist: boolean, hasMintPause: boolean, hasBurnPause: boolean } }>} The vault data.
   */
  async getVaultData ({ refresh = false } = {}) {
    if (this._vaultData && !refresh) return this._vaultData
    const v = this._vault
    const [shareManager, feeManager, oracle, riskManager, assetCount] = await Promise.all([
      v.shareManager(), v.feeManager(), v.oracle(), v.riskManager(), v.getAssetCount()
    ])
    // Assets and their queues are read in parallel (order kept): sequentially
    // this was ~100 round trips per vault, 5-11 s on a phone.
    const range = (n) => Array.from({ length: Number(n) }, (_, i) => BigInt(i))
    const assets = await Promise.all(range(assetCount).map(async (i) => {
      const asset = await v.assetAt(i)
      const queues = await Promise.all(range(await v.getQueueCount(asset)).map(async (j) => {
        const q = await v.queueAt(asset, j)
        const [isDeposit, paused] = await Promise.all([v.isDepositQueue(q), v.isPausedQueue(q)])
        return { address: q, isDeposit, paused, kind: await this._classifyQueue(q, isDeposit) }
      }))
      const pick = (dep) => queues.filter((q) => q.isDeposit === dep).map(({ address, kind, paused }) => ({ address, kind, paused }))
      return { address: asset, native: asset === NATIVE_ASSET, depositQueues: pick(true), redeemQueues: pick(false) }
    }))
    const fm = this._contract(feeManager, FEE_MANAGER_ABI)
    const [depositFee, redeemFee, performanceFee, protocolFee] = await Promise.all([
      fm.depositFeeD6().catch(() => 0n), fm.redeemFeeD6().catch(() => 0n), fm.performanceFeeD6().catch(() => 0n), fm.protocolFeeD6().catch(() => 0n)
    ])
    const params = await this._contract(oracle, ORACLE_ABI).securityParams()
    const flags = await this._readFlags(shareManager)
    this._vaultData = {
      vault: this.vault,
      shareManager,
      feeManager,
      oracle,
      riskManager,
      assets,
      fees: {
        depositPct: Number(depositFee) / 1e4,
        redeemPct: Number(redeemFee) / 1e4,
        performancePct: Number(performanceFee) / 1e4,
        protocolPct: Number(protocolFee) / 1e4
      },
      oracleParams: { timeout: Number(params.timeout), depositInterval: Number(params.depositInterval), redeemInterval: Number(params.redeemInterval) },
      flags: {
        hasWhitelist: Boolean(flags?.hasWhitelist),
        hasMintPause: Boolean(flags?.hasMintPause),
        hasBurnPause: Boolean(flags?.hasBurnPause)
      }
    }
    return this._vaultData
  }

  /**
   * The share manager's `flags()` as raw words: the first four are the mint
   * pause, burn pause, transfer pause and deposit-whitelist booleans on every
   * deployed version; the lockup tail varies and is ignored.
   *
   * @private
   */
  async _readFlags (shareManager) {
    try {
      const raw = await this._requireProvider().call({ to: shareManager, data: FLAGS_SELECTOR })
      const word = (i) => raw.length >= 2 + 64 * (i + 1) && BigInt('0x' + raw.slice(2 + 64 * i, 2 + 64 * (i + 1))) !== 0n
      return { hasMintPause: word(0), hasBurnPause: word(1), hasTransferPause: word(2), hasWhitelist: word(3) }
    } catch {
      return null
    }
  }

  /**
   * The oracle's latest report for an asset: shares per one unit of the asset (1e18 fixed point).
   *
   * @param {string} [token] - The asset (default native).
   * @returns {Promise<{ priceD18: bigint, timestamp: number, suspicious: boolean }>} The report.
   */
  async getReport (token) {
    const { oracle } = await this.getVaultData()
    const r = await this._contract(oracle, ORACLE_ABI).getReport(toAsset(token))
    return { priceD18: BigInt(r.priceD18), timestamp: Number(r.timestamp), suspicious: Boolean(r.isSuspicious) }
  }

  /** @private */
  async _asset (token) {
    const asset = toAsset(token)
    const data = await this.getVaultData()
    const entry = data.assets.find((a) => a.address.toLowerCase() === asset.toLowerCase())
    if (!entry) throw new Error(`The vault does not accept ${asset}.`)
    return entry
  }

  /**
   * Re-checks a queue against the vault right before money touches it:
   * it must be the vault's own, of the wanted direction, and not paused.
   *
   * @private
   */
  async _verifyQueue (queue, wantDeposit) {
    const v = this._vault
    const [has, isDeposit, paused] = await Promise.all([v.hasQueue(queue), v.isDepositQueue(queue), v.isPausedQueue(queue)])
    if (!has || isDeposit !== wantDeposit) throw new Error(`Queue ${queue} is not a ${wantDeposit ? 'deposit' : 'redeem'} queue of vault ${this.vault}.`)
    if (paused) throw new Error(`Queue ${queue} is paused right now — try again later.`)
  }

  // ---- Position ----

  /**
   * Vault shares the account holds (18 decimals), including shares priced by
   * a report but not yet physically claimed.
   *
   * @returns {Promise<bigint>} Shares.
   */
  async getShares () {
    const { shareManager } = await this.getVaultData()
    return BigInt(await this._contract(shareManager, SHARE_MANAGER_ABI).activeSharesOf(await this._account.getAddress()))
  }

  /**
   * The account's position: shares, their value in `token` at the latest
   * report, and what sits in the queues.
   *
   * @param {{ token?: string }} [options] - Asset to value the shares in (default native, or the first vault asset when the vault has no native leg).
   * @returns {Promise<{ shares: bigint, token: string, priceD18: bigint, value: bigint, reportAt: number, suspicious: boolean, claimableShares: bigint, pendingDeposits: Array<{ token: string, queue: string, requestedAt: number, assets: bigint }>, redeemRequests: Array<{ token: string, queue: string, timestamp: number, shares: bigint, claimable: boolean, assets: bigint }> }>} The position.
   */
  async getPosition ({ token } = {}) {
    const data = await this.getVaultData()
    const account = await this._account.getAddress()
    const valueAsset = token !== undefined ? toAsset(token) : (data.assets.find((a) => a.native) ?? data.assets[0]).address
    const [shares, report] = await Promise.all([this.getShares(), this.getReport(valueAsset)])
    const pendingDeposits = []
    const redeemRequests = []
    let claimableShares = 0n
    const async_ = (qs) => qs.filter((q) => q.kind === 'async')
    const [deposits, redeems] = await Promise.all([
      Promise.all(data.assets.flatMap((asset) => async_(asset.depositQueues).map(async (q) => {
        const c = this._contract(q.address, DEPOSIT_QUEUE_ABI)
        const [req, claimable] = await Promise.all([c.requestOf(account), c.claimableOf(account).catch(() => 0n)])
        return { asset, q, req, claimable }
      }))),
      Promise.all(data.assets.flatMap((asset) => async_(asset.redeemQueues).map(async (q) => ({
        asset, q, reqs: await this._contract(q.address, REDEEM_QUEUE_ABI).requestsOf(account, 0n, BigInt(this._maxRedeemRequests))
      }))))
    ])
    for (const { asset, q, req, claimable } of deposits) {
      claimableShares += BigInt(claimable)
      if (BigInt(req.assets) > 0n) pendingDeposits.push({ token: asset.address, queue: q.address, requestedAt: Number(req.timestamp), assets: BigInt(req.assets) })
    }
    for (const { asset, q, reqs } of redeems) {
      for (const r of reqs) {
        redeemRequests.push({ token: asset.address, queue: q.address, timestamp: Number(r.timestamp), shares: BigInt(r.shares), claimable: Boolean(r.isClaimable), assets: BigInt(r.assets) })
      }
    }
    redeemRequests.sort((a, b) => b.timestamp - a.timestamp)
    return {
      shares,
      token: valueAsset,
      priceD18: report.priceD18,
      value: report.priceD18 > 0n ? (shares * E18) / report.priceD18 : 0n,
      reportAt: report.timestamp,
      suspicious: report.suspicious,
      claimableShares,
      pendingDeposits,
      redeemRequests
    }
  }

  // ---- Supply ----

  /**
   * Builds a deposit: verifies the queue, settles the ERC-20 allowance
   * (Ethereum's USDT wants a reset to zero before a raise), optionally
   * proves the call with an eth_call.
   *
   * @private
   */
  async _prepareDeposit (asset, queue, amount, { prove }) {
    await this._verifyQueue(queue.address, true)
    const account = await this._account.getAddress()
    const approvals = []
    if (!asset.native) {
      const erc20 = this._contract(asset.address, ERC20_ABI)
      const allowance = BigInt(await erc20.allowance(account, queue.address))
      if (allowance < amount) {
        if (allowance > 0n) approvals.push({ to: asset.address, data: erc20.interface.encodeFunctionData('approve', [queue.address, 0n]) })
        approvals.push({ to: asset.address, data: erc20.interface.encodeFunctionData('approve', [queue.address, amount]) })
      }
    }
    const c = this._contract(queue.address, DEPOSIT_QUEUE_ABI)
    const tx = { to: queue.address, data: c.interface.encodeFunctionData('deposit', [amount, this._referral, []]), value: asset.native ? amount : 0n }
    if (prove && approvals.length === 0) {
      await this._requireProvider().call({ from: account, to: tx.to, data: tx.data, value: tx.value })
    }
    return { approvals, tx }
  }

  /**
   * The transaction(s) a supply needs and the queue it goes to.
   *
   * @protected
   * @param {string} token - The asset.
   * @param {bigint} amount - The amount (base units).
   * @returns {Promise<{ queue: { address: string, kind: 'async' | 'sync' }, approvals: Array<{ to: string, data: string }>, tx: { to: string, data: string, value: bigint }, sharesOut: bigint, instant: boolean }>} The plan.
   */
  async _getSupplyPlan (token, amount, { instant = this._instant } = {}) {
    if (amount > MAX_UINT224) throw new Error("'amount' exceeds the queue's uint224 limit.")
    const asset = await this._asset(token)
    const data = await this.getVaultData()
    if (data.flags.hasWhitelist) throw new Error('This vault gates deposits with a whitelist (merkle proof) — not supported.')
    if (data.flags.hasMintPause) throw new Error('This vault has minting paused.')
    const report = await this.getReport(asset.address)
    if (report.suspicious) throw new Error("The oracle's latest report for this asset is flagged suspicious — deposits wait for an accepted report.")
    if (report.priceD18 === 0n) throw new Error('The oracle has no price for this asset yet.')
    const gross = (amount * report.priceD18) / E18
    const sharesOut = gross - (gross * BigInt(Math.round(data.fees.depositPct * 1e4))) / 1_000_000n

    const sync = asset.depositQueues.find((q) => q.kind === 'sync' && !q.paused)
    const async = asset.depositQueues.find((q) => q.kind === 'async' && !q.paused)
    if (instant && sync) {
      try {
        const plan = await this._prepareDeposit(asset, sync, amount, { prove: true })
        if (plan.approvals.length === 0) return { queue: sync, ...plan, sharesOut, instant: true }
        // An approval is still pending: the proof cannot run yet; the sync queue
        // stays the target only if its report is fresh enough to not revert.
        const age = Math.floor(Date.now() / 1000) - report.timestamp
        if (age < data.oracleParams.timeout) return { queue: sync, ...plan, sharesOut, instant: true }
      } catch {
        // stale report or a paused sync queue — take the async road
      }
    }
    if (!async) throw new Error(`The vault has no open deposit queue for ${asset.address}.`)
    const account = await this._account.getAddress()
    const open = await this._contract(async.address, DEPOSIT_QUEUE_ABI).requestOf(account)
    if (BigInt(open.assets) > 0n) {
      throw new Error('The account already has an open deposit request in this queue — wait for the next report or cancel it first.')
    }
    const plan = await this._prepareDeposit(asset, async, amount, { prove: false })
    return { queue: async, ...plan, sharesOut, instant: false }
  }

  /** @private */
  async _send (tx) {
    const result = await this._account.sendTransaction(tx)
    if (!result?.hash) throw new Error('The account returned no transaction hash.')
    return { hash: result.hash, fee: BigInt(result.fee ?? 0) }
  }

  /** @private */
  async _sendAndWait (tx) {
    const sent = await this._send(tx)
    const receipt = await this._requireProvider().waitForTransaction(sent.hash, 1, 180_000)
    if (!receipt || receipt.status !== 1) throw new Error(`Transaction ${sent.hash} reverted.`)
    return sent
  }

  /** @private */
  async _quoteFee (txs) {
    if (typeof this._account?.quoteSendTransaction !== 'function') return 0n
    let fee = 0n
    for (const tx of txs) fee += BigInt((await this._account.quoteSendTransaction(tx)).fee ?? 0)
    return fee
  }

  /**
   * Supplies an asset to the vault. ERC-20 legs approve first (awaited to a
   * mined receipt); the synchronous queue is used when it can mint at once,
   * otherwise the request enters the asynchronous queue and the next report
   * prices it.
   *
   * @param {SupplyOptions} options - `token` (address or 'native') and `amount` in base units. `onBehalfOf` is not supported.
   * @returns {Promise<SupplyResult & { instant: boolean, queue: string, approveHashes: string[] }>} The result, whether shares minted at once, and the queue used.
   */
  async supply ({ token, amount, onBehalfOf }) {
    this._requireWritable('supply(options)')
    if (onBehalfOf) throw new Error("'onBehalfOf' is not supported: Mellow queues credit the depositor.")
    const value = toAmount(amount)
    let plan = await this._getSupplyPlan(token, value)
    const approveHashes = []
    let fee = 0n
    for (const approval of plan.approvals) {
      const sent = await this._sendAndWait(approval)
      approveHashes.push(sent.hash)
      fee += sent.fee
    }
    if (plan.instant && plan.approvals.length > 0) {
      // The proof could not run before the allowance was mined; run it now, and
      // take the async queue if the sync one would revert (stale report).
      try {
        await this._requireProvider().call({ from: await this._account.getAddress(), to: plan.tx.to, data: plan.tx.data, value: plan.tx.value })
      } catch {
        plan = await this._getSupplyPlan(token, value, { instant: false })
      }
    }
    const sent = await this._send(plan.tx)
    return { hash: sent.hash, fee: fee + sent.fee, instant: plan.instant, queue: plan.queue.address, approveHashes }
  }

  /**
   * Quotes a supply: network fee (approvals included), shares at the latest report, and the queue it would take.
   *
   * @param {SupplyOptions} options - The supply's options.
   * @returns {Promise<{ fee: bigint, sharesOut: bigint, instant: boolean, queue: string }>} The quote.
   */
  async quoteSupply ({ token, amount }) {
    const plan = await this._getSupplyPlan(token, toAmount(amount))
    return { fee: await this._quoteFee([...plan.approvals, plan.tx]), sharesOut: plan.sharesOut, instant: plan.instant, queue: plan.queue.address }
  }

  /**
   * Cancels the account's open asynchronous deposit request for an asset (only before a report prices it).
   *
   * @param {{ token?: string }} options - The asset.
   * @returns {Promise<{ hash: string, fee: bigint }>} The result.
   */
  async cancelSupply ({ token } = {}) {
    this._requireWritable('cancelSupply(options)')
    const asset = await this._asset(token)
    const q = asset.depositQueues.find((x) => x.kind === 'async')
    if (!q) throw new Error('No asynchronous deposit queue for this asset.')
    const c = this._contract(q.address, DEPOSIT_QUEUE_ABI)
    const open = await c.requestOf(await this._account.getAddress())
    if (BigInt(open.assets) === 0n) throw new Error('No open deposit request to cancel.')
    return await this._send({ to: q.address, data: c.interface.encodeFunctionData('cancelDepositRequest', []), value: 0n })
  }

  /**
   * Moves shares a report already priced from the asset's deposit queue to the
   * account. Optional — balances count them either way; cheap and idempotent.
   *
   * @param {{ token?: string }} options - The asset.
   * @returns {Promise<{ hash: string, fee: bigint }>} The result.
   */
  async claimShares ({ token } = {}) {
    this._requireWritable('claimShares(options)')
    const asset = await this._asset(token)
    const q = asset.depositQueues.find((x) => x.kind === 'async')
    if (!q) throw new Error('No asynchronous deposit queue for this asset.')
    const account = await this._account.getAddress()
    const c = this._contract(q.address, DEPOSIT_QUEUE_ABI)
    return await this._send({ to: q.address, data: c.interface.encodeFunctionData('claim', [account]), value: 0n })
  }

  // ---- Withdraw ----

  /**
   * @protected
   * @param {string} token - The payout asset.
   * @param {bigint} shares - Shares to redeem.
   * @returns {Promise<{ queue: string, tx: { to: string, data: string, value: bigint }, assetsOut: bigint }>} The plan.
   */
  async _getWithdrawPlan (token, shares) {
    const asset = await this._asset(token)
    const data = await this.getVaultData()
    const q = asset.redeemQueues.find((x) => x.kind === 'async' && !x.paused)
    if (!q) throw new Error(`The vault has no open redeem queue paying ${asset.address}.`)
    if (data.flags.hasBurnPause) throw new Error('This vault has redemptions paused.')
    const held = await this.getShares()
    if (shares > held) throw new Error(`The amount exceeds the account's shares (${held}).`)
    const report = await this.getReport(asset.address)
    if (report.suspicious) throw new Error("The oracle's latest report for this asset is flagged suspicious — redemptions wait for an accepted report.")
    await this._verifyQueue(q.address, false)
    const net = shares - (shares * BigInt(Math.round(data.fees.redeemPct * 1e4))) / 1_000_000n
    const assetsOut = report.priceD18 > 0n ? (net * E18) / report.priceD18 : 0n
    const c = this._contract(q.address, REDEEM_QUEUE_ABI)
    return { queue: q.address, tx: { to: q.address, data: c.interface.encodeFunctionData('redeem', [shares]), value: 0n }, assetsOut }
  }

  /**
   * Requests a redemption: `amount` is in **shares** (the only unit known
   * before the report); they burn at once and the request is not cancellable.
   * The payout in `token` becomes claimable after the next report that is at
   * least `redeemInterval` later and the curator's liquidity handling —
   * see {@link getWithdrawalRequests} and {@link claimWithdrawals}.
   *
   * @param {WithdrawOptions} options - `token` = payout asset, `amount` = shares. `to` is not supported.
   * @returns {Promise<WithdrawResult & { queue: string, assetsOut: bigint }>} The result, the queue and the estimated payout.
   */
  async withdraw ({ token, amount, to }) {
    this._requireWritable('withdraw(options)')
    if (to) throw new Error("'to' is not supported: the redeem queue pays the requesting account.")
    const plan = await this._getWithdrawPlan(token, toAmount(amount))
    const sent = await this._send(plan.tx)
    return { ...sent, queue: plan.queue, assetsOut: plan.assetsOut }
  }

  /**
   * Quotes a redemption request: network fee and the payout at the latest report (after the redeem fee).
   *
   * @param {WithdrawOptions} options - The withdraw's options.
   * @returns {Promise<{ fee: bigint, assetsOut: bigint, queue: string }>} The quote.
   */
  async quoteWithdraw ({ token, amount }) {
    const plan = await this._getWithdrawPlan(token, toAmount(amount))
    return { fee: await this._quoteFee([plan.tx]), assetsOut: plan.assetsOut, queue: plan.queue }
  }

  /**
   * The account's redemption queue across every payout asset.
   *
   * @returns {Promise<{ requests: Array<{ id: string, token: string, queue: string, timestamp: number, shares: bigint, assets: bigint, claimable: boolean }>, pendingShares: bigint, claimable: Array<{ token: string, queue: string, assets: bigint, timestamps: number[] }> }>} Requests newest first, shares still waiting, and what is claimable per asset.
   */
  async getWithdrawalRequests () {
    const { redeemRequests } = await this.getPosition()
    const requests = redeemRequests.map((r) => ({ id: `${r.queue}:${r.timestamp}`, ...r }))
    let pendingShares = 0n
    const byQueue = new Map()
    for (const r of requests) {
      if (!r.claimable) {
        pendingShares += r.shares
        continue
      }
      const entry = byQueue.get(r.queue) ?? { token: r.token, queue: r.queue, assets: 0n, timestamps: [] }
      entry.assets += r.assets
      entry.timestamps.push(r.timestamp)
      byQueue.set(r.queue, entry)
    }
    return { requests, pendingShares, claimable: [...byQueue.values()] }
  }

  /**
   * Claims processed redemptions — the asset lands on the account. One
   * transaction per payout asset; `token` picks one, otherwise every asset
   * with claimable requests is swept in sequence.
   *
   * @param {{ token?: string, timestamps?: number[] }} [options] - Restrict to a payout asset and/or specific request timestamps.
   * @returns {Promise<{ hashes: string[], fee: bigint, assets: Array<{ token: string, amount: bigint }> }>} The transactions sent and what they claim.
   */
  async claimWithdrawals ({ token, timestamps } = {}) {
    this._requireWritable('claimWithdrawals(options)')
    const { claimable } = await this.getWithdrawalRequests()
    const wanted = token !== undefined ? toAsset(token).toLowerCase() : null
    const targets = claimable
      .filter((c) => !wanted || c.token.toLowerCase() === wanted)
      .map((c) => ({ ...c, timestamps: timestamps ? c.timestamps.filter((t) => timestamps.includes(t)) : c.timestamps }))
      .filter((c) => c.timestamps.length > 0)
    if (targets.length === 0) throw new Error('Nothing is claimable yet.')
    const account = await this._account.getAddress()
    const hashes = []
    let fee = 0n
    const assets = []
    for (const t of targets) {
      const c = this._contract(t.queue, REDEEM_QUEUE_ABI)
      const sent = await this._send({ to: t.queue, data: c.interface.encodeFunctionData('claim', [account, t.timestamps]), value: 0n })
      hashes.push(sent.hash)
      fee += sent.fee
      assets.push({ token: t.token, amount: t.assets })
    }
    return { hashes, fee, assets }
  }

  // ---- Not lending ----

  /** @param {*} options @returns {Promise<never>} Always rejects: a Mellow vault does not lend. */
  async borrow (options) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError('borrow(options): Mellow vaults do not lend.')
  }

  /** @param {*} options @returns {Promise<never>} Always rejects. */
  async quoteBorrow (options) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError('quoteBorrow(options): Mellow vaults do not lend.')
  }

  /** @param {*} options @returns {Promise<never>} Always rejects. */
  async repay (options) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError('repay(options): Mellow vaults do not lend.')
  }

  /** @param {*} options @returns {Promise<never>} Always rejects. */
  async quoteRepay (options) { // eslint-disable-line no-unused-vars
    throw new NotImplementedError('quoteRepay(options): Mellow vaults do not lend.')
  }

  // ---- Registry (decoration) ----

  /**
   * The vault's entry in Mellow's registry: APY, TVL, average withdrawal time. Null when the registry is disabled, unreachable, or does not list the vault.
   *
   * @returns {Promise<{ id: string, name: string, apy: number | null, tvlUsd: number | null, withdrawAvgSeconds: number | null } | null>} The stats.
   */
  async getStats () {
    if (!this._registry) return null
    try {
      const res = await fetch(this._registry)
      if (!res.ok) return null
      const list = await res.json()
      const entry = list.find((v) => typeof v.address === 'string' && v.address.toLowerCase() === this.vault.toLowerCase()) ??
        (this._preset ? list.find((v) => v.id === this._preset.registryId) : undefined)
      if (!entry) return null
      return {
        id: entry.id,
        name: entry.name ?? entry.id,
        apy: typeof entry.apy === 'number' ? entry.apy : null,
        tvlUsd: typeof entry.tvl_usd === 'number' ? entry.tvl_usd : null,
        withdrawAvgSeconds: typeof entry.withdraw_avg_time_seconds === 'number' ? entry.withdraw_avg_time_seconds : null
      }
    } catch {
      return null
    }
  }

  /**
   * The vault's APY in percent, from Mellow's registry.
   *
   * @returns {Promise<number>} The APY.
   */
  async getApr () {
    const stats = await this.getStats()
    if (!stats || stats.apy === null) throw new Error('APY needs the Mellow registry (config.registry) and a listed vault.')
    return stats.apy
  }

  /**
   * Recognize Mellow queue transactions offline (`deposit`, `cancelDepositRequest`,
   * `claim` on deposit queues; `redeem`, `claim` on redeem queues) for the preset
   * vaults and the vault this instance targets. See `mellow-activity.js` for the rule.
   *
   * @param {import('@forgewallet/core').ChainTx} tx
   * @param {import('@forgewallet/core').DescribeActivityContext} ctx
   * @returns {import('@forgewallet/core').ActivityItem | null}
   */
  describeActivity (tx, ctx) {
    return describeMellowActivity(tx, ctx, { chainId: this._chainId, vault: this.vault, shareManager: this._preset?.shareManager ?? this._vaultData?.shareManager ?? null })
  }
}
