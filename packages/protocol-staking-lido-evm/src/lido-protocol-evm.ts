import type { ActivityItem, ChainTx, DescribeActivityContext, IWalletAccountReadOnly } from '@anywalletkit/core'
import {
  compactSignatureToSignature, createPublicClient, custom, encodeFunctionData, http, isAddress, parseCompactSignature, parseSignature, zeroAddress,
  type Address, type Hex, type PublicClient,
} from 'viem'

import { PERMIT_TYPES, STETH_ABI, WITHDRAWAL_QUEUE_ABI, WSTETH_ABI } from './abi.js'
import { describeLidoActivity } from './lido-activity.js'
import LIDO_ADDRESS_MAP, { type LidoPermitDomain } from './lido-address-map.js'
import StakingProtocol, {
  type ClaimWithdrawalsOptions, type ClaimWithdrawalsResult, type StakeOptions, type StakeResult, type StakedBalance,
  type WithdrawalRequestOptions, type WithdrawalRequestResult, type WithdrawalRequestsView,
} from './staking-protocol.js'
import { bigintToNumber } from '@anywalletkit/core'

/** Default timeout for the module's REST reads (APR, rewards, queue times): an API that never answers must not hang the caller. */
const API_TIMEOUT_MS = 15_000

/** `fetch` with a timeout: `AbortSignal.timeout` where the runtime has it, else a timer (Hermes without runtime-hermes). */
async function fetchWithTimeout(url: string, ms = API_TIMEOUT_MS): Promise<Response> {
  let signal: AbortSignal | undefined
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') signal = AbortSignal.timeout(ms)
  else if (typeof AbortController !== 'undefined') {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${ms} ms`)), ms) as unknown as { unref?: () => void }
    timer.unref?.()
    signal = controller.signal
  }
  return fetch(url, signal ? { signal } : {})
}

/** The EIP-1193 surface the module reads the chain through when no RPC url is given. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/** RPC url or EIP-1193 provider. */
export type LidoProvider = string | Eip1193Provider

/** A transaction as the module hands it to the account. */
export interface LidoTx {
  to: string
  data?: string
  value?: bigint
}

/**
 * The account surface the protocol needs. Writable methods are optional —
 * views work with a read-only account that only implements getAddress.
 */
export interface StakingWalletAccount {
  getAddress(): Promise<string>
  signTypedData?(typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    message: Record<string, unknown>
  }): Promise<string>
  sendTransaction?(tx: LidoTx): Promise<{ hash: string; fee?: bigint }>
  quoteSendTransaction?(tx: LidoTx): Promise<{ fee: bigint }>
}

type WritableStakingWalletAccount = StakingWalletAccount & { sendTransaction: NonNullable<StakingWalletAccount['sendTransaction']> }

export interface LidoProtocolConfig {
  /** RPC url or EIP-1193 provider; defaults to the account's provider. */
  provider?: LidoProvider
  /** Default 1. Other chains must also pass addresses and permitDomains. */
  chainId?: number
  /** Lido Rewards-Share referral forwarded to submit(). Defaults to the zero address. */
  referral?: string
  addresses?: { stEth?: string; wstEth?: string; withdrawalQueue?: string }
  permitDomains?: {
    stEth?: LidoPermitDomain
    wstEth?: LidoPermitDomain
  }
  endpoints?: { apr?: string; withdrawalQueueApi?: string; rewardHistory?: string }
}

export interface RewardTotals {
  totalRewards: bigint
  averageApr: number | null
}

export interface RewardEvent {
  /** Unix seconds. */
  timestamp: number
  /** Base units. */
  reward: bigint
  apr: number | null
}

/** The permit tuple `requestWithdrawals*WithPermit` takes. */
interface PermitInput { value: bigint; deadline: bigint; v: number; r: Hex; s: Hex }

interface WithdrawalTokenInfo {
  address: string
  domain: LidoPermitDomain | undefined
  cap: bigint
  requestFn: 'requestWithdrawals' | 'requestWithdrawalsWstETH'
  permitFn: 'requestWithdrawalsWithPermit' | 'requestWithdrawalsWstETHWithPermit'
  abi: typeof STETH_ABI | typeof WSTETH_ABI
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
 * @param amount - The total amount to withdraw (in base unit).
 * @param cap - The queue's per-request maximum.
 * @returns The request amounts.
 */
export function splitWithdrawalAmounts(amount: bigint, cap: bigint): bigint[] {
  const amounts: bigint[] = []
  let rest = amount
  while (rest > cap) {
    amounts.push(cap)
    rest -= cap
  }
  amounts.push(rest)
  return amounts
}

/** Normalizes and validates an amount option. */
function toAmount(amount: number | bigint): bigint {
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
 * Splits a 65-byte (or EIP-2098 64-byte compact) signature into the permit's
 * v / r / s, with v normalized to 27 / 28 the way ethers' Signature.from did.
 */
function toPermitSignature(signature: string): { v: number; r: Hex; s: Hex } {
  const hex = signature as Hex
  const parsed = hex.length === 130 ? compactSignatureToSignature(parseCompactSignature(hex)) : parseSignature(hex)
  const v = parsed.v !== undefined ? bigintToNumber(BigInt(parsed.v)) : 27 + (parsed.yParity ?? 0)
  return { v, r: parsed.r, s: parsed.s }
}

const isDigits = (raw: unknown): boolean => /^[0-9]+$/.test(String(raw))

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
export default class LidoProtocolEvm extends StakingProtocol<LidoProtocolConfig> {
  private readonly _chainId: number
  private readonly _addresses: { stEth?: string; wstEth?: string; withdrawalQueue?: string }
  private readonly _permitDomains: { stEth?: LidoPermitDomain; wstEth?: LidoPermitDomain }
  private readonly _endpoints: { apr?: string; withdrawalQueueApi?: string; rewardHistory?: string }
  private readonly _referral: string
  /** The viem public client; undefined when neither the config nor the account carries a provider. */
  private readonly _provider: PublicClient | undefined

  /**
   * Creates a new interface to the Lido protocol for evm blockchains.
   *
   * @param account - The wallet account to use to interact with the protocol (a @anywalletkit/wallet-evm account, or a read-only account for views).
   * @param config - The protocol's configuration.
   */
  constructor(account: StakingWalletAccount, config: LidoProtocolConfig = {}) {
    // The core base only stores the account; this module reads it through the narrow surface below.
    super(account as unknown as IWalletAccountReadOnly, config)

    const chainId = config.chainId ?? 1
    const defaults = LIDO_ADDRESS_MAP[chainId]
    if (!defaults && !(config.addresses && config.permitDomains)) {
      throw new Error(`No default Lido deployment for chain ${chainId}: pass 'addresses' and 'permitDomains' explicitly.`)
    }

    this._chainId = chainId
    const { permitDomains, endpoints, ...addresses } = defaults ?? {}

    this._addresses = { ...addresses, ...config.addresses }
    this._permitDomains = { ...permitDomains, ...config.permitDomains }
    this._endpoints = { ...endpoints, ...config.endpoints }
    this._referral = config.referral ?? zeroAddress

    if (this._referral !== zeroAddress && !isAddress(this._referral)) {
      throw new Error("'referral' must be a valid address.")
    }

    // A wallet-evm account keeps its RPC in a protected `_config`; read it without making it part of the type
    // (a public `_config` here made every real account fail to type-check against this interface).
    const provider = config.provider ?? (account as { _config?: { provider?: LidoProvider } } | undefined)?._config?.provider
    if (provider) {
      this._provider = createPublicClient({
        transport: typeof provider === 'string' ? http(provider) : custom(provider),
      })
    }
  }

  /** The account, through the surface this module uses. */
  private get _acct(): StakingWalletAccount {
    return this._account as unknown as StakingWalletAccount
  }

  private _requireProvider(): PublicClient {
    if (!this._provider) {
      throw new Error('The protocol must be initialized with a provider (or an account configured with one).')
    }
    return this._provider
  }

  private _requireWritable(method: string): WritableStakingWalletAccount {
    // A structural check, deliberately not instanceof: a duplicated copy of
    // the account package fails instanceof while the account works fine.
    const account = this._acct
    if (typeof account?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
    return account as WritableStakingWalletAccount
  }

  private get _stEthAddress(): Address { return this._addresses.stEth as Address }
  private get _wstEthAddress(): Address { return this._addresses.wstEth as Address }
  private get _queueAddress(): Address { return this._addresses.withdrawalQueue as Address }

  private async _getStakeTransaction(amount: bigint): Promise<{ to: string; value: bigint; data: Hex }> {
    const client = this._requireProvider()
    // Guard pause/rate-limit up front: the raw estimateGas revert carries no
    // readable reason for either condition.
    const [paused, limit] = await Promise.all([
      client.readContract({ address: this._stEthAddress, abi: STETH_ABI, functionName: 'isStakingPaused' }).catch(() => false),
      client.readContract({ address: this._stEthAddress, abi: STETH_ABI, functionName: 'getCurrentStakeLimit' }).catch((): bigint | null => null),
    ])
    if (paused) {
      throw new Error('Lido staking is paused right now.')
    }
    if (limit !== null && amount > limit) {
      throw new Error("This amount is over Lido's current stake rate limit.")
    }
    return {
      to: this._addresses.stEth as string,
      value: amount,
      data: encodeFunctionData({ abi: STETH_ABI, functionName: 'submit', args: [this._referral as Address] }),
    }
  }

  /**
   * Stakes ETH — stETH lands on the account 1:1.
   */
  override async stake({ amount }: StakeOptions): Promise<StakeResult> {
    const account = this._requireWritable('stake(options)')
    const value = toAmount(amount)
    const tx = await this._getStakeTransaction(value)
    return (await account.sendTransaction(tx)) as StakeResult
  }

  /**
   * Quotes the costs of a stake operation.
   */
  override async quoteStake({ amount }: StakeOptions): Promise<Omit<StakeResult, 'hash'>> {
    const value = toAmount(amount)
    const tx = await this._getStakeTransaction(value)
    const { fee } = await this._acct.quoteSendTransaction!(tx)
    return { fee }
  }

  private _withdrawalToken(token: string = 'stETH'): WithdrawalTokenInfo {
    if (token === 'stETH') {
      return {
        address: this._addresses.stEth as string,
        domain: this._permitDomains.stEth,
        cap: MAX_STETH_PER_REQUEST,
        requestFn: 'requestWithdrawals',
        permitFn: 'requestWithdrawalsWithPermit',
        abi: STETH_ABI,
      }
    }
    if (token === 'wstETH') {
      return {
        address: this._addresses.wstEth as string,
        domain: this._permitDomains.wstEth,
        cap: MAX_WSTETH_PER_REQUEST,
        requestFn: 'requestWithdrawalsWstETH',
        permitFn: 'requestWithdrawalsWstETHWithPermit',
        abi: WSTETH_ABI,
      }
    }
    throw new Error("'token' must be either 'stETH' or 'wstETH'.")
  }

  private async _signPermit(tokenInfo: WithdrawalTokenInfo, owner: string, value: bigint): Promise<PermitInput> {
    const client = this._requireProvider()
    const nonce = await client.readContract({ address: tokenInfo.address as Address, abi: tokenInfo.abi, functionName: 'nonces', args: [owner as Address] })
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600)
    const signature = await this._acct.signTypedData!({
      domain: {
        name: tokenInfo.domain!.name,
        version: tokenInfo.domain!.version,
        chainId: this._chainId,
        verifyingContract: tokenInfo.address,
      },
      types: PERMIT_TYPES,
      message: {
        owner,
        spender: this._addresses.withdrawalQueue as string,
        value,
        nonce,
        deadline,
      },
    })
    const { v, r, s } = toPermitSignature(signature)
    return { value, deadline, v, r, s }
  }

  /**
   * Queues stETH or wstETH for withdrawal through the Lido queue. Permit-first
   * (one signature, one transaction); falls back to approve + request if the
   * permit leg fails. Over-cap amounts split into several requests inside the
   * same transaction.
   */
  override async requestWithdrawal({ amount, token = 'stETH' }: WithdrawalRequestOptions): Promise<WithdrawalRequestResult> {
    const account = this._requireWritable('requestWithdrawal(options)')
    const value = toAmount(amount)
    const info = this._withdrawalToken(token)
    const provider = this._requireProvider()
    const owner = await account.getAddress()
    const amounts = splitWithdrawalAmounts(value, info.cap)
    const queueAddress = this._addresses.withdrawalQueue as string

    try {
      const permit = await this._signPermit(info, owner, value)
      const data = encodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, functionName: info.permitFn, args: [amounts, owner as Address, permit] })
      // Prove the permit executes before broadcasting — a bad signature must
      // fall back, not burn gas.
      await provider.call({ account: owner as Address, to: queueAddress as Address, data })
      const result = await account.sendTransaction({ to: queueAddress, data })
      return { ...(result as StakeResult), approveHash: null }
    } catch {
      // fall through to approve + request
    }

    let approveHash: string | null = null
    let approveFee = 0n
    const allowance = await provider.readContract({ address: info.address as Address, abi: info.abi, functionName: 'allowance', args: [owner as Address, queueAddress as Address] })
    if (allowance < value) {
      const approval = await account.sendTransaction({
        to: info.address,
        data: encodeFunctionData({ abi: info.abi, functionName: 'approve', args: [queueAddress as Address, value] }),
      })
      approveHash = approval.hash
      approveFee = approval.fee ?? 0n
      // The request's gas estimate reverts against an unmined allowance.
      await provider.waitForTransactionReceipt({ hash: approval.hash as Hex })
    }

    const result = await account.sendTransaction({
      to: queueAddress,
      data: encodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, functionName: info.requestFn, args: [amounts, owner as Address] }),
    })
    return { hash: result.hash, fee: (result.fee ?? 0n) + approveFee, approveHash }
  }

  /**
   * Quotes the costs of a withdrawal request, assuming the queue already holds
   * an allowance (the executed request needs none — it carries a permit).
   */
  override async quoteRequestWithdrawal({ amount, token = 'stETH' }: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>> {
    const value = toAmount(amount)
    const info = this._withdrawalToken(token)
    // The ethers build bound the queue contract to the provider here; keep the same precondition.
    this._requireProvider()
    const owner = await this._acct.getAddress()
    const amounts = splitWithdrawalAmounts(value, info.cap)
    const { fee } = await this._acct.quoteSendTransaction!({
      to: this._addresses.withdrawalQueue as string,
      data: encodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, functionName: info.requestFn, args: [amounts, owner as Address] }),
    })
    return { fee }
  }

  /**
   * The account's live withdrawal queue.
   */
  override async getWithdrawalRequests(): Promise<WithdrawalRequestsView> {
    const client = this._requireProvider()
    const owner = await this._acct.getAddress()
    const ids = await client.readContract({ address: this._queueAddress, abi: WITHDRAWAL_QUEUE_ABI, functionName: 'getWithdrawalRequests', args: [owner as Address] })
    if (ids.length === 0) {
      return { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] }
    }
    const statuses = await client.readContract({ address: this._queueAddress, abi: WITHDRAWAL_QUEUE_ABI, functionName: 'getWithdrawalStatus', args: [[...ids]] })
    const open = [...ids]
      .map((id, i) => ({ id, status: statuses[i]! }))
      .filter((r) => !r.status.isClaimed)
    const requests = open
      .map((r) => ({
        id: r.id,
        amount: r.status.amountOfStETH,
        timestamp: bigintToNumber(BigInt(r.status.timestamp)),
        claimable: r.status.isFinalized,
      }))
      .sort((a, b) => (b.id > a.id ? 1 : b.id < a.id ? -1 : 0))
    // findCheckpointHints requires ascending ids
    const claimableIds = open.filter((r) => r.status.isFinalized).map((r) => r.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    let claimableAmount = 0n
    if (claimableIds.length > 0) {
      const hints = await this._findHints(claimableIds)
      const ether = await client.readContract({ address: this._queueAddress, abi: WITHDRAWAL_QUEUE_ABI, functionName: 'getClaimableEther', args: [claimableIds, hints] })
      claimableAmount = [...ether].reduce((a, b) => a + b, 0n)
    }
    return {
      requests,
      pendingAmount: open.filter((r) => !r.status.isFinalized).reduce((a, r) => a + r.status.amountOfStETH, 0n),
      claimableAmount,
      claimableIds,
    }
  }

  private async _findHints(ids: bigint[]): Promise<bigint[]> {
    const client = this._requireProvider()
    const last = await client.readContract({ address: this._queueAddress, abi: WITHDRAWAL_QUEUE_ABI, functionName: 'getLastCheckpointIndex' })
    const hints = await client.readContract({ address: this._queueAddress, abi: WITHDRAWAL_QUEUE_ABI, functionName: 'findCheckpointHints', args: [ids, 1n, last] })
    return [...hints]
  }

  private async _getClaimTransaction(options?: ClaimWithdrawalsOptions): Promise<{ to: string; data: Hex }> {
    let ids = options?.ids
    if (!ids || ids.length === 0) {
      const view = await this.getWithdrawalRequests()
      ids = view.claimableIds
    } else {
      ids = ids.map((id) => BigInt(id)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    }
    if (ids.length === 0) {
      throw new Error('There are no claimable withdrawal requests.')
    }
    const hints = await this._findHints(ids)
    return {
      to: this._addresses.withdrawalQueue as string,
      data: encodeFunctionData({ abi: WITHDRAWAL_QUEUE_ABI, functionName: 'claimWithdrawals', args: [ids, hints] }),
    }
  }

  /**
   * Claims finalized withdrawal requests — ETH lands on the account.
   */
  override async claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult> {
    const account = this._requireWritable('claimWithdrawals(options)')
    const tx = await this._getClaimTransaction(options)
    return (await account.sendTransaction(tx)) as ClaimWithdrawalsResult
  }

  /**
   * Quotes the costs of a claim operation.
   */
  override async quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>> {
    const tx = await this._getClaimTransaction(options)
    const { fee } = await this._acct.quoteSendTransaction!(tx)
    return { fee }
  }

  /**
   * The account's staked position: stETH, wstETH and the live rate.
   */
  override async getStakedBalance(): Promise<StakedBalance> {
    const client = this._requireProvider()
    const owner = await this._acct.getAddress()
    const [balance, wrappedBalance, rate] = await Promise.all([
      client.readContract({ address: this._stEthAddress, abi: STETH_ABI, functionName: 'balanceOf', args: [owner as Address] }),
      client.readContract({ address: this._wstEthAddress, abi: WSTETH_ABI, functionName: 'balanceOf', args: [owner as Address] }),
      client.readContract({ address: this._wstEthAddress, abi: WSTETH_ABI, functionName: 'stEthPerToken' }),
    ])
    return {
      balance,
      wrappedBalance,
      rate,
      total: balance + (wrappedBalance * rate) / 10n ** 18n,
    }
  }

  /**
   * Lido's 7-day SMA staking APR, in percent.
   */
  override async getApr(): Promise<number> {
    const res = await fetchWithTimeout(this._endpoints.apr as string)
    if (!res.ok) {
      throw new Error(`Lido APR API: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { data?: { smaApr?: unknown } } | null
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
   * @param options - The wrap's options (amount in stETH base unit).
   * @returns The wrap's result (approveHash null if the allowance already covered it).
   */
  async wrap({ amount }: StakeOptions): Promise<WithdrawalRequestResult> {
    const account = this._requireWritable('wrap(options)')
    const value = toAmount(amount)
    const provider = this._requireProvider()
    const owner = await account.getAddress()
    let approveHash: string | null = null
    let approveFee = 0n
    const allowance = await provider.readContract({ address: this._stEthAddress, abi: STETH_ABI, functionName: 'allowance', args: [owner as Address, this._wstEthAddress] })
    if (allowance < value) {
      const approval = await account.sendTransaction({
        to: this._addresses.stEth as string,
        data: encodeFunctionData({ abi: STETH_ABI, functionName: 'approve', args: [this._wstEthAddress, value] }),
      })
      approveHash = approval.hash
      approveFee = approval.fee ?? 0n
      await provider.waitForTransactionReceipt({ hash: approval.hash as Hex })
    }
    const result = await account.sendTransaction({
      to: this._addresses.wstEth as string,
      data: encodeFunctionData({ abi: WSTETH_ABI, functionName: 'wrap', args: [value] }),
    })
    return { hash: result.hash, fee: (result.fee ?? 0n) + approveFee, approveHash }
  }

  /**
   * Unwraps wstETH back to stETH — a single transaction, no approval needed.
   *
   * @param options - The unwrap's options (amount in wstETH base unit).
   */
  async unwrap({ amount }: StakeOptions): Promise<StakeResult> {
    const account = this._requireWritable('unwrap(options)')
    const value = toAmount(amount)
    // The ethers build bound the wstETH contract to the provider here; keep the same precondition.
    this._requireProvider()
    return (await account.sendTransaction({
      to: this._addresses.wstEth as string,
      data: encodeFunctionData({ abi: WSTETH_ABI, functionName: 'unwrap', args: [value] }),
    })) as StakeResult
  }

  /**
   * Finalization ETA per queued request, in seconds, from Lido's withdrawal
   * queue API. Decoration: failures return an empty map, never throw.
   *
   * @param ids - The request ids.
   * @returns Request id (as string) → ETA seconds. Finalized requests are absent.
   */
  async getWithdrawalEta(ids: bigint[]): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    if (!ids || ids.length === 0) return out
    try {
      const res = await fetchWithTimeout(`${this._endpoints.withdrawalQueueApi}/v2/request-time?ids=${ids.map(String).join(',')}`)
      if (!res.ok) return out
      // Entries mirror the ids order; finalized requests carry requestInfo: null.
      const body = (await res.json()) as Array<{ requestInfo?: { finalizationIn?: unknown } | null } | null>
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
   * @param amount - The amount to withdraw (in base unit).
   * @returns ETA seconds, or null.
   */
  async getWithdrawalEtaForAmount(amount: number | bigint): Promise<number | null> {
    try {
      const value = toAmount(amount)
      const ether = `${value / 10n ** 18n}.${(value % 10n ** 18n).toString().padStart(18, '0')}`
      const res = await fetchWithTimeout(`${this._endpoints.withdrawalQueueApi}/v2/request-time/calculate?amount=${ether}`)
      if (!res.ok) return null
      const body = (await res.json()) as { requestInfo?: { finalizationIn?: unknown } | null } | null
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
   * @returns Lifetime stETH rewards (base unit) and average APR (percent).
   */
  async getRewards(): Promise<RewardTotals | null> {
    try {
      const owner = await this._acct.getAddress()
      const res = await fetchWithTimeout(`${this._endpoints.rewardHistory}/?address=${owner}&limit=1`)
      if (!res.ok) return null
      const body = (await res.json()) as { totals?: { ethRewards?: unknown }; averageApr?: unknown } | null
      const raw = body?.totals?.ethRewards
      if (raw === undefined || !isDigits(raw)) return null
      return {
        totalRewards: BigInt(String(raw)),
        averageApr: typeof body!.averageApr === 'number' ? body!.averageApr : null,
      }
    } catch {
      return null
    }
  }

  /**
   * Daily rebase reward history for the account, newest first. Decoration:
   * failures return an empty array, never throw.
   *
   * @param options - The history's options.
   * @returns Rebase events (reward in stETH base unit, timestamp unix seconds).
   */
  async getRewardHistory({ limit = 14 }: { limit?: number } = {}): Promise<RewardEvent[]> {
    try {
      const owner = await this._acct.getAddress()
      const res = await fetchWithTimeout(`${this._endpoints.rewardHistory}/?address=${owner}&limit=${limit}&skip=0`)
      if (!res.ok) return []
      const body = (await res.json()) as { events?: Array<{ type?: unknown; rewards?: unknown; blockTime?: unknown; apr?: unknown }> } | null
      return (body?.events ?? [])
        .filter((e) => e.type === 'reward' && e.rewards !== undefined && isDigits(e.rewards))
        .map((e) => ({
          timestamp: Number(e.blockTime),
          reward: BigInt(String(e.rewards)),
          apr: e.apr !== undefined && !Number.isNaN(Number(e.apr)) ? Number(e.apr) : null,
        }))
    } catch {
      return []
    }
  }

  /**
   * Recognize this deployment's Lido transactions offline (stETH `submit`, wstETH
   * `wrap` / `unwrap`, WithdrawalQueue `requestWithdrawals*` / `claimWithdrawals*`).
   * See `lido-activity.ts` for the rule.
   */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeLidoActivity(tx, ctx, { chainId: this._chainId, addresses: this._addresses })
  }
}
