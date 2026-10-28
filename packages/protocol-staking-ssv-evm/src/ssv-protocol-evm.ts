import {
  StakingProtocol,
  type ActivityItem, type ChainTx, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly, bigintToNumber,
} from '@anywalletkit/core'
import {
  createPublicClient, custom, encodeFunctionData, fallback, http, parseAbi,
  type Address, type Hex, type PublicClient, type Transport,
} from 'viem'

import SSV_ADDRESS_MAP from './ssv-address-map.js'
import { describeSsvActivity } from './ssv-activity.js'
import type {
  ClaimWithdrawalsOptions, ClaimWithdrawalsResult, StakeOptions, StakeResult, StakedBalance,
  WithdrawalRequestOptions, WithdrawalRequestResult, WithdrawalRequestsView, SsvWithdrawalRequest,
} from './staking-protocol.js'

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

/** SSVNetwork proxy — the staking module's writes (contracts/modules/SSVStaking.sol). */
const NETWORK_ABI = parseAbi([
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function withdrawUnlocked()',
  'function claimEthRewards()',
  'function syncFees()',
])

/** SSVNetworkViews — every staking read. `pendingUnstake` returns the
 *  account's open cooldown entries; storage packs the amount as uint192 but
 *  the ABI word is the same, so uint256 decodes it. */
const VIEWS_ABI = parseAbi([
  'function cooldownDuration() view returns (uint256)',
  'function totalStaked() view returns (uint256)',
  'function stakedBalanceOf(address user) view returns (uint256)',
  'function previewClaimableEth(address user) view returns (uint256)',
  'function pendingUnstake(address user) view returns ((uint256 amount, uint256 unlockTime)[])',
  'function stakingEthPoolBalance() view returns (uint256)',
  'function accEthPerShare() view returns (uint256)',
])

const ERC20_ABI = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

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
export const SSV_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  '0x1cc3b37b': 'StakeTooLow: the amount is below the minimum stake (1 gwei of SSV).',
  '0x1f2a2005': 'ZeroAmount: the amount must be greater than zero.',
  '0x02a19f57': 'UnstakeAmountExceedsBalance: the amount exceeds the staked balance.',
  '0xee0e82ff': 'MaxRequestsAmountReached: too many open unstake requests — withdraw the unlocked ones first.',
  '0xd0d04f60': 'NothingToWithdraw: no unstake request has finished its cooldown yet.',
  '0x969bf728': 'NothingToClaim: accrued ETH rewards are below the claimable minimum.',
  '0xf4d678b8': "InsufficientBalance: the network's ETH rewards pool cannot cover the payout right now.",
  '0x045c4b02': 'TokenTransferFailed: the SSV token transfer failed.',
})

/**
 * Turns a revert into an error that names the SSVStaking custom error.
 * The provider buries the revert data in `error.data` or a few
 * `info.error` / `error` / `cause` hops down (viem wraps the node's error
 * in CallExecutionError → ExecutionRevertedError → the raw RPC error); the
 * selector also tends to appear in the message text — every place is checked.
 * Unknown reverts pass through.
 *
 * @param error - The error thrown by viem / the provider.
 * @returns The error to surface.
 */
export function describeRevert(error: unknown): Error & { selector?: string } {
  const haystack = [error instanceof Error ? error.message : String(error)]
  let node: unknown = error
  for (let i = 0; i < 8 && node && typeof node === 'object'; i++) {
    const bag = node as Record<string, unknown>
    for (const key of ['data', 'revert'] as const) {
      const value = bag[key]
      if (typeof value === 'string') haystack.push(value)
    }
    node = (bag.info as { error?: unknown } | undefined)?.error ?? bag.error ?? bag.cause
  }
  const text = haystack.join(' ').toLowerCase()
  for (const [selector, message] of Object.entries(SSV_ERRORS)) {
    if (text.includes(selector)) {
      const err: Error & { selector?: string } = new Error(message)
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
 * @param amount - The amount (in base unit).
 * @returns The amount as a bigint.
 */
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

/** An EIP-1193 provider as this module needs it: just `request`. */
export interface Eip1193Like {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/** RPC url or EIP-1193 provider. */
export type EvmProvider = string | Eip1193Like

function toTransport(p: EvmProvider | EvmProvider[]): Transport {
  // A list (wallet-evm's failover config) fails over in order, as the account's own client does.
  if (Array.isArray(p)) return p.length === 1 ? toTransport(p[0]!) : fallback(p.map((x) => toTransport(x)))
  return typeof p === 'string' ? http(p) : custom(p)
}

/**
 * The account surface the protocol needs. Writable methods are optional —
 * views work with a read-only account that only implements getAddress.
 */
export interface StakingWalletAccount {
  getAddress(): Promise<string>
  sendTransaction?(tx: { to: string; data?: string; value?: bigint }): Promise<{ hash: string; fee?: bigint }>
  quoteSendTransaction?(tx: { to: string; data?: string; value?: bigint }): Promise<{ fee: bigint }>
}

type WritableStakingWalletAccount = StakingWalletAccount & Required<Pick<StakingWalletAccount, 'sendTransaction'>>
type QuotingStakingWalletAccount = StakingWalletAccount & Required<Pick<StakingWalletAccount, 'quoteSendTransaction'>>

export interface SsvProtocolConfig {
  /** RPC url(s) or EIP-1193 provider(s) to read the chain through; a list fails over in order. Defaults to the account's own provider. */
  provider?: EvmProvider | EvmProvider[]
  /** The chain to operate on (default 1). Non-mainnet chains must also supply addresses (and endpoints for APR). */
  chainId?: number
  /** Override for the contract addresses. */
  addresses?: { network?: string; views?: string; ssvToken?: string; cssvToken?: string }
  /** Override for the REST endpoints. */
  endpoints?: { apr?: string; aprHistory?: string }
}

export interface NetworkStats {
  totalStaked: bigint
  rewardsPool: bigint
  accEthPerShare: bigint
}

export interface AprSample {
  /** Unix seconds. */
  timestamp: number
  /** Percent. */
  apr: number
  ssvPriceUsd: number | null
  ethPriceUsd: number | null
}

interface SsvAddresses { network: Address; views: Address; ssvToken: Address; cssvToken: Address }

/** A transaction on the SSVNetwork proxy, as the account signs it. */
interface NetworkTx { to: Address; data: Hex; value?: bigint }

type NetworkFn = 'stake' | 'requestUnstake' | 'withdrawUnlocked' | 'claimEthRewards' | 'syncFees'

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
export default class SsvProtocolEvm extends StakingProtocol<SsvProtocolConfig> {
  private readonly _chainId: number
  private readonly _addresses: SsvAddresses
  private readonly _endpoints: { apr?: string; aprHistory?: string }
  private readonly _client: PublicClient | undefined

  /**
   * Creates a new interface to the SSV Network staking protocol for evm blockchains.
   *
   * @param account - The wallet account to use to interact with the protocol (a @anywalletkit/wallet-evm account, or a read-only / minimal `{ getAddress }` account for views).
   * @param config - The protocol's configuration.
   */
  constructor(account: StakingWalletAccount, config: SsvProtocolConfig = {}) {
    // The base class wants a full account; this module only ever touches the
    // narrow StakingWalletAccount surface (see `account` below).
    super(account as unknown as IWalletAccountReadOnly | IWalletAccount, config)

    const chainId = config.chainId ?? 1
    const defaults = SSV_ADDRESS_MAP[chainId]
    if (!defaults && !config.addresses) {
      throw new Error(`No default SSV Network deployment for chain ${chainId}: pass 'addresses' explicitly.`)
    }

    this._chainId = chainId
    const { endpoints, ...addresses } = defaults ?? {}

    const merged: Record<string, unknown> = { ...addresses, ...config.addresses }
    for (const key of ['network', 'views', 'ssvToken', 'cssvToken'] as const) {
      if (typeof merged[key] !== 'string') {
        throw new Error(`'addresses.${key}' is required for chain ${chainId}.`)
      }
    }
    this._addresses = merged as unknown as SsvAddresses
    this._endpoints = { ...endpoints, ...config.endpoints }

    // wallet-evm keeps the RPC in a protected `_config`: read it without putting it in the account type.
    const provider = config.provider ?? ((account as { _config?: { provider?: unknown } } | undefined)?._config?.provider as EvmProvider | EvmProvider[] | undefined)
    if (provider && (!Array.isArray(provider) || provider.length > 0)) {
      this._client = createPublicClient({ transport: toTransport(provider), ccipRead: false })
    }
  }

  /** The account as this module sees it. */
  private get account(): StakingWalletAccount {
    return this._account as unknown as StakingWalletAccount
  }

  private _requireProvider(): PublicClient {
    if (!this._client) {
      throw new Error('The protocol must be initialized with a provider (or an account configured with one).')
    }
    return this._client
  }

  private _requireWritable(method: string): WritableStakingWalletAccount {
    // A structural check, deliberately not instanceof: a duplicated copy of
    // the account package fails instanceof while the account works fine.
    const account = this.account
    if (typeof account?.sendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires the protocol to be initialized with a non read-only account.`)
    }
    return account as WritableStakingWalletAccount
  }

  private _requireQuotable(method: string): QuotingStakingWalletAccount {
    const account = this.account
    if (typeof account?.quoteSendTransaction !== 'function') {
      throw new Error(`The '${method}' method requires an account that implements quoteSendTransaction.`)
    }
    return account as QuotingStakingWalletAccount
  }

  private _networkCall(functionName: 'stake' | 'requestUnstake', args: readonly [bigint]): NetworkTx
  private _networkCall(functionName: 'withdrawUnlocked' | 'claimEthRewards' | 'syncFees'): NetworkTx
  private _networkCall(functionName: NetworkFn, args: readonly bigint[] = []): NetworkTx {
    return { to: this._addresses.network, data: encodeFunctionData({ abi: NETWORK_ABI, functionName, args } as never) }
  }

  /**
   * Proves a network call with eth_call from the account before it is signed,
   * so a revert costs no gas and comes back as the named custom error.
   */
  private async _prove(tx: NetworkTx): Promise<void> {
    const from = (await this.account.getAddress()) as Address
    try {
      await this._requireProvider().call({
        account: from,
        to: tx.to,
        data: tx.data,
        ...(tx.value !== undefined ? { value: tx.value } : {}),
      })
    } catch (error) {
      throw describeRevert(error)
    }
  }

  /**
   * Stakes SSV — cSSV lands on the account 1:1 and ETH rewards start accruing
   * at once. Approves first when the allowance is short (the approval is
   * awaited to a mined receipt), then proves and sends `stake`.
   *
   * @param options - The stake's options (amount in SSV base unit).
   * @returns The stake's result; `fee` includes the approval when one ran.
   */
  override async stake({ amount }: StakeOptions): Promise<StakeResult & { approveHash: string | null }> {
    const account = this._requireWritable('stake(options)')
    const value = toAmount(amount)
    if (value < MINIMAL_STAKING_AMOUNT) {
      throw new Error(SSV_ERRORS['0x1cc3b37b'])
    }
    const provider = this._requireProvider()
    const owner = (await account.getAddress()) as Address
    // Before any approval: with too little SSV the approve would be paid for and left behind.
    await this._assertSsvBalance(owner, value)

    let approveHash: string | null = null
    let approveFee = 0n
    const allowance = await provider.readContract({
      address: this._addresses.ssvToken, abi: ERC20_ABI, functionName: 'allowance', args: [owner, this._addresses.network],
    })
    if (allowance < value) {
      const approval = await account.sendTransaction({
        to: this._addresses.ssvToken,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [this._addresses.network, value] }),
      })
      approveHash = approval.hash
      approveFee = approval.fee ?? 0n
      // stake's gas estimate reverts against an unmined allowance.
      await provider.waitForTransactionReceipt({ hash: approval.hash as Hex })
    }

    const tx = this._networkCall('stake', [value])
    await this._prove(tx)
    const result = await account.sendTransaction(tx)
    return { hash: result.hash, fee: (result.fee ?? 0n) + approveFee, approveHash }
  }

  /**
   * Quotes the costs of a stake operation, assuming the network already holds
   * an allowance (without one the estimate itself reverts).
   *
   * @param options - The stake's options.
   * @returns The stake's costs.
   */
  override async quoteStake({ amount }: StakeOptions): Promise<Omit<StakeResult, 'hash'>> {
    const value = toAmount(amount)
    await this._assertSsvBalance((await this.account.getAddress()) as Address, value)
    const { fee } = await this._requireQuotable('quoteStake(options)').quoteSendTransaction(this._networkCall('stake', [value]))
    return { fee }
  }

  /**
   * Burns cSSV into a cooldown entry. Irreversible: the entry cannot be
   * cancelled and stops earning immediately; the SSV unlocks after the
   * network's cooldown (see `getCooldown`). There is a single staked-token
   * form, so `token` is accepted for interface parity and ignored.
   *
   * @param options - The request's options (amount in cSSV base unit).
   * @returns The request's result (`approveHash` is always null — burning needs no approval).
   */
  override async requestWithdrawal({ amount }: WithdrawalRequestOptions): Promise<WithdrawalRequestResult> {
    const account = this._requireWritable('requestWithdrawal(options)')
    const value = toAmount(amount)
    const tx = this._networkCall('requestUnstake', [value])
    await this._prove(tx)
    const result = await account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n, approveHash: null }
  }

  /**
   * Quotes the costs of an unstake request.
   *
   * @param options - The request's options.
   * @returns The request's costs.
   */
  override async quoteRequestWithdrawal({ amount }: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>> {
    const value = toAmount(amount)
    const { fee } = await this._requireQuotable('quoteRequestWithdrawal(options)').quoteSendTransaction(this._networkCall('requestUnstake', [value]))
    return { fee }
  }

  /**
   * The account's open cooldown entries. Ids are the entries' positions in
   * the network's per-account list — stable until a withdrawal removes the
   * unlocked ones, so re-read after every write rather than caching them.
   * `timestamp` is derived (unlockTime − current cooldown); `unlockTime` is
   * the on-chain value. Amounts are SSV: the exit pays the staked token, not ETH.
   *
   * @returns The queue view.
   */
  override async getWithdrawalRequests(): Promise<WithdrawalRequestsView> {
    const owner = (await this.account.getAddress()) as Address
    const client = this._requireProvider()
    const [entries, cooldown] = await Promise.all([
      client.readContract({ address: this._addresses.views, abi: VIEWS_ABI, functionName: 'pendingUnstake', args: [owner] }),
      client.readContract({ address: this._addresses.views, abi: VIEWS_ABI, functionName: 'cooldownDuration' }),
    ])
    const now = BigInt(Math.floor(Date.now() / 1000))
    const requests: SsvWithdrawalRequest[] = [...entries].map((entry, index) => {
      const unlockTime = BigInt(entry.unlockTime)
      return {
        id: BigInt(index),
        amount: BigInt(entry.amount),
        timestamp: bigintToNumber(unlockTime - BigInt(cooldown)),
        unlockTime: bigintToNumber(unlockTime),
        claimable: unlockTime <= now,
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
      claimableIds: requests.filter((r) => r.claimable).map((r) => r.id),
    }
  }

  private async _getClaimTransaction(): Promise<NetworkTx> {
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
   * @param _options - The claim's options.
   * @returns The claim's result.
   */
  override async claimWithdrawals(_options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult> {
    const account = this._requireWritable('claimWithdrawals(options)')
    const tx = await this._getClaimTransaction()
    await this._prove(tx)
    const result = await account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n }
  }

  /**
   * Quotes the costs of a withdraw operation.
   *
   * @param _options - The claim's options.
   * @returns The claim's costs.
   */
  override async quoteClaimWithdrawals(_options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>> {
    const tx = await this._getClaimTransaction()
    const { fee } = await this._requireQuotable('quoteClaimWithdrawals(options)').quoteSendTransaction(tx)
    return { fee }
  }

  /**
   * The account's staked position. cSSV is the only staked form and it is
   * 1:1 with SSV, so `wrappedBalance` is 0 and `rate` is exactly 1e18.
   *
   * @returns The staked balances.
   */
  override async getStakedBalance(): Promise<StakedBalance> {
    const owner = (await this.account.getAddress()) as Address
    const balance = BigInt(await this._requireProvider().readContract({
      address: this._addresses.views, abi: VIEWS_ABI, functionName: 'stakedBalanceOf', args: [owner],
    }))
    return { balance, wrappedBalance: 0n, rate: 10n ** 18n, total: balance }
  }

  /**
   * The current APR in percent, from SSV Network's API — the same number
   * stake.ssv.network shows. It is ETH-denominated on an SSV-denominated
   * stake, so it moves with SSV's price.
   *
   * @returns The APR.
   */
  override async getApr(): Promise<number> {
    const url = this._endpoints.apr
    if (!url) {
      throw new Error(`'endpoints.apr' is required for chain ${this._chainId}.`)
    }
    const res = await fetchWithTimeout(url)
    if (!res.ok) {
      throw new Error(`SSV APR API: HTTP ${res.status}`)
    }
    const body = (await res.json()) as { apr?: unknown } | null | undefined
    const apr = typeof body?.apr === 'number' ? body.apr : Number.parseFloat(String(body?.apr))
    if (!Number.isFinite(apr)) {
      throw new Error('SSV APR API: unexpected response shape.')
    }
    return apr
  }

  private async _assertSsvBalance(owner: Address, value: bigint): Promise<void> {
    const held = BigInt(await this._requireProvider().readContract({
      address: this._addresses.ssvToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner],
    }))
    if (held < value) throw new Error(`The account holds ${held} SSV base units, ${value} needed to stake.`)
  }

  // ---- SSV-specific extras (not part of the proposed staking interface) ----

  /**
   * The account's liquid (unstaked, stakeable) SSV balance.
   *
   * @returns SSV in base unit.
   */
  async getTokenBalance(): Promise<bigint> {
    const owner = (await this.account.getAddress()) as Address
    return BigInt(await this._requireProvider().readContract({
      address: this._addresses.ssvToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner],
    }))
  }

  /**
   * ETH rewards accrued to the account and not yet claimed. Claims round
   * down to `ETH_CLAIM_UNIT`; below it the network refuses the claim.
   *
   * @returns ETH in wei.
   */
  async getClaimableRewards(): Promise<bigint> {
    const owner = (await this.account.getAddress()) as Address
    return BigInt(await this._requireProvider().readContract({
      address: this._addresses.views, abi: VIEWS_ABI, functionName: 'previewClaimableEth', args: [owner],
    }))
  }

  private async _getClaimRewardsTransaction(): Promise<NetworkTx> {
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
   * @returns The claim's result.
   */
  async claimRewards(): Promise<ClaimWithdrawalsResult> {
    const account = this._requireWritable('claimRewards()')
    const tx = await this._getClaimRewardsTransaction()
    await this._prove(tx)
    const result = await account.sendTransaction(tx)
    return { hash: result.hash, fee: result.fee ?? 0n }
  }

  /**
   * Quotes the costs of a rewards claim.
   *
   * @returns The claim's costs.
   */
  async quoteClaimRewards(): Promise<Omit<ClaimWithdrawalsResult, 'hash'>> {
    const tx = await this._getClaimRewardsTransaction()
    const { fee } = await this._requireQuotable('quoteClaimRewards()').quoteSendTransaction(tx)
    return { fee }
  }

  /**
   * The network's current unstake cooldown, in seconds (DAO-tunable — read
   * it, never hardcode 7 days).
   *
   * @returns Cooldown seconds.
   */
  async getCooldown(): Promise<number> {
    return bigintToNumber(await this._requireProvider().readContract({ address: this._addresses.views, abi: VIEWS_ABI, functionName: 'cooldownDuration' }))
  }

  /**
   * Network-wide staking figures.
   *
   * @returns Total cSSV supply (SSV base unit), the ETH pool backing claims (wei), and the cumulative ETH-per-share index (1e18 precision).
   */
  async getNetworkStats(): Promise<NetworkStats> {
    const client = this._requireProvider()
    const views = this._addresses.views
    const [totalStaked, rewardsPool, accEthPerShare] = await Promise.all([
      client.readContract({ address: views, abi: VIEWS_ABI, functionName: 'totalStaked' }),
      client.readContract({ address: views, abi: VIEWS_ABI, functionName: 'stakingEthPoolBalance' }),
      client.readContract({ address: views, abi: VIEWS_ABI, functionName: 'accEthPerShare' }),
    ])
    return { totalStaked: BigInt(totalStaked), rewardsPool: BigInt(rewardsPool), accEthPerShare: BigInt(accEthPerShare) }
  }

  /**
   * Daily APR samples from SSV Network's API, oldest first, with the SSV and
   * ETH prices the API priced them at. Decoration: failures return an empty
   * array, never throw.
   *
   * @param options - The history's options.
   * @returns Samples (timestamp unix seconds, apr percent).
   */
  async getAprHistory({ limit = 7 }: { limit?: number } = {}): Promise<AprSample[]> {
    try {
      const url = this._endpoints.aprHistory
      if (!url) return []
      const res = await fetchWithTimeout(url)
      if (!res.ok) return []
      const body = (await res.json()) as { samples?: Array<{ timestamp?: unknown; currentApr?: unknown; ssvPrice?: unknown; ethPrice?: unknown }> } | null | undefined
      const num = (v: unknown): number | null => {
        const n = typeof v === 'number' ? v : Number.parseFloat(String(v))
        return Number.isFinite(n) ? n : null
      }
      return (body?.samples ?? [])
        .map((s) => ({
          timestamp: Math.floor(new Date(s.timestamp as string | number).getTime() / 1000),
          apr: num(s.currentApr),
          ssvPriceUsd: num(s.ssvPrice),
          ethPriceUsd: num(s.ethPrice),
        }))
        .filter((s): s is AprSample => Number.isFinite(s.timestamp) && s.apr !== null)
        .slice(-limit)
    } catch {
      return []
    }
  }

  /**
   * Recognize this deployment's SSV staking transactions offline (`stake`,
   * `requestUnstake`, `withdrawUnlocked`, `claimEthRewards` on SSVNetwork).
   * See `ssv-activity.ts` for the rule.
   */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeSsvActivity(tx, ctx, { chainId: this._chainId, addresses: this._addresses })
  }
}
