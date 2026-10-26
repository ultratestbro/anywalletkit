import {
  StakingProtocol, bigintToNumber,
  type ActivityItem, type ChainTx, type ClaimWithdrawalsOptions, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly,
  type StakedBalance, type StakeOptions, type WithdrawalRequest, type WithdrawalRequestOptions, type WithdrawalRequestsView,
} from '@anywalletkit/core'
import { encodeFunctionData, isAddress, zeroAddress, type Address, type Hex, type PublicClient } from 'viem'
import { REVERTS, STAKING_ABI } from './abi.js'
import { describeMonadStakingActivity } from './activity.js'
import {
  BLOCK_REWARD, DUST_THRESHOLD, MAX_WITHDRAW_ID, MONAD_CHAIN_IDS, STAKING_PRECOMPILE, USER_RESERVE_BALANCE, type MonadChainId,
} from './constants.js'
import { activatesAtEpoch, commissionToPercent, packWithdrawalId, percentToCommission, toValidatorId, toWithdrawId, unpackWithdrawalId, withdrawableAtEpoch } from './encode.js'
import { DEFAULT_CONCURRENCY, createReadClient, paginate, pool, type MonadProvider } from './rpc.js'
import {
  normalizeValidators, type NormalizedValidators, type ValidatorEnricher, type ValidatorExtra, type ValidatorInfo, type ValidatorRefusal, type ValidatorsOption,
} from './validators.js'

/** Default cap on validator commission, percent. */
export const DEFAULT_MAX_COMMISSION = 10
/** How long validator reads are reused, ms. */
const VALIDATOR_TTL_MS = 60_000
/** How long the network APR inputs are reused, ms. */
const NETWORK_TTL_MS = 10 * 60_000
/** Blocks sampled to measure the block time. */
const BLOCK_TIME_SAMPLE = 50_000n
/** Gap scan: stop after this many empty withdrawal slots past the last used one. */
export const WITHDRAW_SCAN_GAP = 32
/** The canonical Multicall3 (deployed on Monad mainnet). */
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const
/** Validator reads kept before expired ones are swept. */
const VALIDATOR_CACHE_MAX = 512

/** Configuration of {@link NativeStakingProtocolMonad}. Only `validators` is required. */
export interface NativeStakingMonadConfig {
  /** Validator ids to delegate to, or `'any'`. Required: there is no default list. */
  validators: ValidatorsOption
  /** Used by `stake` when the call names no validator. A single-entry list is its own default. */
  defaultValidator?: bigint | number
  /** Refuse validators whose commission is above this, percent (default 10). Read fresh from the precompile at every delegation and compound. */
  maxCommission?: number
  /** Allow validators outside the consensus set or flagged by the precompile (default false: their stake earns nothing). */
  allowInactive?: boolean
  /** Pin the network (143 mainnet, 10143 testnet). Default: the account's, which must be one of them. */
  chainId?: MonadChainId
  /** RPC url(s) or EIP-1193 provider(s) for reads; a list fails over in order. Defaults to the account's provider. */
  provider?: MonadProvider | MonadProvider[]
  /** Per-request timeout for URL providers, ms (default 15 000). */
  timeoutMs?: number
  /** The staking precompile (default 0x…1000). */
  stakingAddress?: `0x${string}`
  /** MON `stake` leaves on the wallet: at least Monad's 10 MON reserve balance (below it transfers revert), more if you like. */
  reserveBalance?: bigint | number
  /** Reads in flight at once (default 6). */
  concurrency?: number
  /** Highest withdrawal id used and scanned (default 255). */
  maxWithdrawId?: number
  /**
   * How pending withdrawals are found per validator. `'multicall'` (default) reads every slot up to
   * `maxWithdrawId` in ONE `eth_call` through Multicall3 (falling back to `'full'` when that call
   * fails); `'full'` reads every slot one call each (256 per validator); `'gap'` reads from 0 and
   * stops 32 empty slots past the last used one — cheaper, but it misses a pending slot above a run
   * of claimed ones (withdrawals 0–39 with 0–35 claimed: 36–39 are not found).
   */
  withdrawScan?: 'multicall' | 'gap' | 'full'
  /** Multicall3 for the `'multicall'` scan (default the canonical 0xcA11…CA11, deployed on Monad). */
  multicallAddress?: `0x${string}`
  /** Adds data to validators (APR, names) from an explorer or the app's backend. */
  enrich?: ValidatorEnricher
}

/** The epoch clock and when a change made now takes effect. */
export interface MonadEpoch { epoch: bigint; inEpochDelayPeriod: boolean; activatesAtEpoch: bigint }

/** One delegation of the wallet. Amounts in wei. */
export interface DelegatorPosition {
  validatorId: bigint
  name: string | null
  /** Active stake: earns rewards and can be undelegated. */
  active: bigint
  /** Becomes active at `activationEpoch`. */
  activating: bigint
  /** Becomes active at `nextActivationEpoch` (a delegation made after the boundary block). */
  activatingNext: bigint
  activationEpoch: bigint | null
  nextActivationEpoch: bigint | null
  /** Rewards earned and not yet claimed or compounded. */
  unclaimedRewards: bigint
  validator: ValidatorInfo
}

/** Network figures behind the APR estimate. */
export interface MonadNetworkStats {
  consensusValidators: number
  totalConsensusStake: bigint
  blockTimeMs: number
  blocksPerYear: number
  /** Delegator APR before commission, percent: 18 MON × blocks per year ÷ consensus stake. */
  apr: number
}

export interface MonadStakeOptions extends StakeOptions { validator?: bigint | number }
export interface MonadStakeQuote { fee: bigint; amount: bigint; validator: ValidatorInfo; activatesAtEpoch: bigint }
export interface MonadStakeResult extends MonadStakeQuote { hash: string }

export interface MonadUnstakeOptions extends WithdrawalRequestOptions {
  validator?: bigint | number
  /** Withdrawal slot 0..255; the lowest free one by default. */
  withdrawId?: number
}
export interface MonadUnstakeQuote {
  fee: bigint
  amount: bigint
  validatorId: bigint
  withdrawId: number
  /** The request's id for `claimWithdrawals({ ids })`: `validatorId << 8 | withdrawId`. */
  id: bigint
  /** First epoch the MON can be claimed in (projection). */
  withdrawableAtEpoch: bigint
}
export interface MonadUnstakeResult extends MonadUnstakeQuote { hash: string; approveHash: null }

/** One pending withdrawal. `id` packs the validator and the slot. */
export interface MonadWithdrawalRequest extends WithdrawalRequest {
  validatorId: bigint
  withdrawId: number
  withdrawEpoch: bigint
  withdrawableAtEpoch: bigint
}
export type MonadWithdrawalRequestsView = Omit<WithdrawalRequestsView, 'requests'> & { requests: MonadWithdrawalRequest[] }

/** Claim options: `ids` as `getWithdrawalRequests` returns them; `validators` adds validators to look at (see {@link NativeStakingProtocolMonad.getWithdrawalRequests}). */
export interface MonadClaimOptions extends ClaimWithdrawalsOptions { validators?: Array<bigint | number> }

/** Where to look for pending withdrawals. */
export interface MonadWithdrawalScanOptions {
  /** Only this validator. */
  validator?: bigint | number
  /** Also these validators (e.g. from the wallet's history or the app's storage): a full exit drops a validator from `getDelegations`. */
  validators?: Array<bigint | number>
}

export interface MonadClaimQuote {
  /** Total fee: one `withdraw` transaction per request (the precompile takes no batches). */
  fee: bigint
  amount: bigint
  claims: Array<{ id: bigint; validatorId: bigint; withdrawId: number; amount: bigint }>
}
export interface MonadClaimResult extends MonadClaimQuote { hash: string; hashes: string[] }

export interface MonadRewardsOptions { validator?: bigint | number }
export interface MonadRewardsQuote { fee: bigint; validatorId: bigint; amount: bigint; activatesAtEpoch: bigint | null }
export interface MonadRewardsResult extends MonadRewardsQuote { hash: string }

interface Tx { to: Address; data: Hex; value: bigint; chainId: number }
type ValidatorTuple = readonly [Address, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, Hex, Hex]
type DelegatorTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]

function toAmount(amount: unknown): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new Error("'amount' must be a bigint or a safe integer (wei).")
  }
  const v = BigInt(amount)
  if (v <= 0n) throw new Error("'amount' must be greater than zero.")
  return v
}

const mon = (value: bigint): string => {
  if (value < 0n) return `-${mon(-value)}`
  const wei = value
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6)
  return `${whole}${frac ? `.${frac}` : ''} MON`
}

/** Turns a precompile revert into a plain-language error (the cause is kept). */
export function describeRevert(error: unknown): Error {
  const texts: string[] = []
  let node: unknown = error
  for (let i = 0; i < 8 && node && typeof node === 'object'; i++) {
    const e = node as Record<string, unknown>
    for (const k of ['message', 'shortMessage', 'details', 'reason']) if (typeof e[k] === 'string') texts.push(e[k] as string)
    // The precompile's revert data is the reason as raw UTF-8 (not ABI Error(string)); some providers send only that.
    if (typeof e.data === 'string' && /^0x(?:[0-9a-f]{2})+$/i.test(e.data)) {
      const bytes = (e.data.slice(2).match(/../g) ?? []).map((h) => parseInt(h, 16))
      if (bytes.every((b) => b >= 0x20 && b < 0x7f)) texts.push(String.fromCharCode(...bytes))
    }
    node = e.cause ?? e.error
  }
  if (typeof error === 'string') texts.push(error)
  const text = texts.join(' ')
  for (const [pattern, message] of REVERTS) {
    if (pattern.test(text)) return Object.assign(new Error(message), { cause: error })
  }
  return error instanceof Error ? error : new Error(String(error))
}

/**
 * Native MON staking on Monad: delegations straight to validators through the staking precompile
 * (0x…1000). No pool, no token: the position is the wallet's `DelInfo` per validator.
 *
 * - `stake` is `delegate(validatorId)` with the amount as value. It becomes active at the next
 *   epoch (n+1), or n+2 when sent after the boundary block (`getEpoch().activatesAtEpoch`).
 * - `requestWithdrawal` is `undelegate(validatorId, amount, withdrawId)` with the lowest free slot
 *   (0..255). Only active stake can be undelegated. The MON can be withdrawn one epoch after it
 *   deactivates (`withdrawableAtEpoch`).
 * - `claimWithdrawals` sends `withdraw(validatorId, withdrawId)` for each ready request (the
 *   precompile takes one per transaction). Rewards are separate: `claimRewards` / `compound`.
 *
 * Fail-closed before anything is signed: the validator must be listed (or `'any'`), exist, be in
 * the consensus set in good standing and charge at most `maxCommission`; amounts respect the 1 gwei
 * minimum, the active stake and Monad's 10 MON reserve balance; withdrawal slots must be free; the
 * account and the read RPC must both be on Monad. Every write is simulated with `eth_call` first and
 * a revert comes back in plain words.
 */
export class NativeStakingProtocolMonad extends StakingProtocol<NativeStakingMonadConfig> {
  readonly validators: NormalizedValidators
  readonly defaultValidator: bigint | undefined
  readonly maxCommission: number
  readonly stakingAddress: Address
  readonly reserveBalance: bigint
  readonly maxWithdrawId: number
  private readonly client: PublicClient | undefined
  private readonly concurrency: number
  private chainChecked: Promise<MonadChainId> | undefined
  readonly withdrawScan: 'multicall' | 'gap' | 'full'
  private readonly multicallAddress: `0x${string}`
  private readonly validatorCache = new Map<bigint, { at: number; value: Promise<ValidatorTuple> }>()
  private consensusCache: { at: number; value: Promise<bigint[]> } | undefined
  private networkCache: { at: number; value: Promise<MonadNetworkStats> } | undefined
  /** The last network stats that finished, for decoration that must not trigger the ~200 reads behind them. */
  private networkSettled: MonadNetworkStats | undefined
  /** Validators this instance undelegated from: a full exit removes them from `getDelegations`. */
  private readonly unstakedFrom = new Set<bigint>()

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: NativeStakingMonadConfig) {
    super(account, config)
    if (!config || typeof config !== 'object') throw new Error('NativeStakingProtocolMonad needs a config with `validators`.')
    this.validators = normalizeValidators(config.validators)

    if (config.defaultValidator !== undefined) {
      const id = toValidatorId(config.defaultValidator, 'defaultValidator')
      if (this.validators !== 'any' && !this.validators.some((v) => v.id === id)) throw new Error('defaultValidator must be one of `validators`.')
      this.defaultValidator = id
    } else {
      this.defaultValidator = this.validators !== 'any' && this.validators.length === 1 ? this.validators[0]!.id : undefined
    }

    const max = config.maxCommission ?? DEFAULT_MAX_COMMISSION
    if (typeof max !== 'number' || !(max >= 0 && max <= 100)) throw new Error('maxCommission must be a percentage between 0 and 100.')
    this.maxCommission = max

    if (config.chainId !== undefined && !MONAD_CHAIN_IDS.includes(config.chainId)) throw new Error(`chainId must be ${MONAD_CHAIN_IDS.join(' or ')}.`)

    const staking = config.stakingAddress ?? STAKING_PRECOMPILE
    if (!isAddress(staking)) throw new Error('stakingAddress must be an address.')
    this.stakingAddress = staking

    this.reserveBalance = BigInt(config.reserveBalance ?? USER_RESERVE_BALANCE)
    if (this.reserveBalance < USER_RESERVE_BALANCE) throw new Error('reserveBalance cannot be below Monad\'s 10 MON reserve balance: the chain reverts stakes that dip under it anyway.')

    this.maxWithdrawId = config.maxWithdrawId ?? MAX_WITHDRAW_ID
    if (!Number.isInteger(this.maxWithdrawId) || this.maxWithdrawId < 0 || this.maxWithdrawId > MAX_WITHDRAW_ID) throw new Error(`maxWithdrawId must be an integer from 0 to ${MAX_WITHDRAW_ID}.`)

    this.withdrawScan = config.withdrawScan ?? 'multicall'
    if (this.withdrawScan !== 'multicall' && this.withdrawScan !== 'gap' && this.withdrawScan !== 'full') throw new Error("withdrawScan must be 'multicall', 'gap' or 'full'.")
    this.multicallAddress = config.multicallAddress ?? MULTICALL3

    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) throw new Error('concurrency must be a positive integer.')

    // A wallet-evm account keeps its RPC (one or a failover list) in a protected `_config`.
    const provider = config.provider ?? (account as { _config?: { provider?: MonadProvider | MonadProvider[] } } | undefined)?._config?.provider
    const list = provider === undefined ? [] : Array.isArray(provider) ? provider : [provider]
    this.client = createReadClient(list, config.timeoutMs)
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────────

  private rpc(): PublicClient {
    if (!this.client) throw new Error('NativeStakingProtocolMonad needs a Monad RPC: pass `provider`, or an account configured with one.')
    return this.client
  }

  /** The account's chain id, checked to be Monad (and the configured one); the read RPC must be on it too. */
  private async chain(): Promise<MonadChainId> {
    this.chainChecked ??= (async () => {
      const m = /^eip155:(\d+)$/.exec(String(this._account.chain ?? ''))
      let fromAccount = m ? Number(m[1]) : undefined
      // "eip155:unknown" (an account that has not asked its RPC yet): ask the account itself, not just our read RPC.
      const ask = (this._account as { getChainId?: () => Promise<number | bigint> }).getChainId
      if (fromAccount === undefined && typeof ask === 'function') fromAccount = Number(String(await ask.call(this._account))) // a chain id: small
      const rpcChain = await this.rpc().getChainId()
      const id = fromAccount ?? rpcChain
      if (!MONAD_CHAIN_IDS.includes(id as MonadChainId)) throw new Error(`NativeStakingProtocolMonad needs a Monad account (chain 143 or 10143), got ${this._account.chain}.`)
      if (this._config.chainId !== undefined && id !== this._config.chainId) throw new Error(`The account is on chain ${id}, the module is pinned to ${this._config.chainId}.`)
      if (rpcChain !== id) throw new Error(`The read RPC is on chain ${rpcChain}, the account on ${id}.`)
      return id as MonadChainId
    })()
    try {
      return await this.chainChecked
    } catch (e) {
      this.chainChecked = undefined
      throw e
    }
  }

  private async me(): Promise<Address> {
    if (!String(this._account.chain ?? '').startsWith('eip155:')) throw new Error(`NativeStakingProtocolMonad needs a Monad account, got ${this._account.chain}.`)
    return (await this._account.getAddress()) as Address
  }

  private async read<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    return (await this.rpc().readContract({ address: this.stakingAddress, abi: STAKING_ABI, functionName: functionName as never, args: args as never })) as T
  }

  private tx(functionName: 'delegate' | 'undelegate' | 'withdraw' | 'compound' | 'claimRewards', args: readonly unknown[], value: bigint, chainId: number): Tx {
    return { to: this.stakingAddress, data: encodeFunctionData({ abi: STAKING_ABI, functionName, args: args as never }), value, chainId }
  }

  /** `eth_call` of the exact transaction as the wallet; a revert becomes a plain-language error. */
  private async simulate(tx: Tx, from: Address): Promise<void> {
    try {
      await this.rpc().call({ account: from, to: tx.to, data: tx.data, value: tx.value })
    } catch (e) {
      throw describeRevert(e)
    }
  }

  private async quoteFee(tx: Tx): Promise<bigint> {
    if (typeof this._account.quoteSendTransaction !== 'function') return 0n
    try {
      return BigInt((await this._account.quoteSendTransaction(tx)).fee ?? 0)
    } catch (e) {
      throw describeRevert(e)
    }
  }

  private async send(account: IWalletAccount, tx: Tx): Promise<{ hash: string; fee: bigint }> {
    try {
      const r = await account.sendTransaction(tx)
      return { hash: r.hash, fee: BigInt(r.fee ?? 0) }
    } catch (e) {
      throw describeRevert(e)
    }
  }

  // ── Epochs and validators ────────────────────────────────────────────────────

  /** The current epoch, whether the boundary block has passed, and the epoch a change made now takes effect in. */
  async getEpoch(): Promise<MonadEpoch> {
    const [epoch, inEpochDelayPeriod] = await this.read<readonly [bigint, boolean]>('getEpoch')
    return { epoch, inEpochDelayPeriod, activatesAtEpoch: activatesAtEpoch({ epoch, inEpochDelayPeriod }) }
  }

  /** A validator's tuple; cached a minute for display, read fresh (`fresh`) before a delegation or compound. */
  private validatorTuple(id: bigint, fresh = false): Promise<ValidatorTuple> {
    const hit = this.validatorCache.get(id)
    if (!fresh && hit && Date.now() - hit.at < VALIDATOR_TTL_MS) return hit.value
    if (this.validatorCache.size >= VALIDATOR_CACHE_MAX) {
      for (const [k, v] of this.validatorCache) if (Date.now() - v.at >= VALIDATOR_TTL_MS) this.validatorCache.delete(k)
    }
    const value = this.read<ValidatorTuple>('getValidator', [id])
    this.validatorCache.set(id, { at: Date.now(), value })
    value.catch(() => { if (this.validatorCache.get(id)?.value === value) this.validatorCache.delete(id) })
    return value
  }

  private consensusIds(): Promise<bigint[]> {
    if (this.consensusCache && Date.now() - this.consensusCache.at < VALIDATOR_TTL_MS) return this.consensusCache.value
    const value = paginate<number>(async (start) => this.read<readonly [boolean, number, readonly bigint[]]>('getConsensusValidatorSet', [start]), 0)
    this.consensusCache = { at: Date.now(), value }
    value.catch(() => { if (this.consensusCache?.value === value) this.consensusCache = undefined })
    return value
  }

  private nameOf(id: bigint, extra?: ValidatorExtra): string | null {
    const configured = this.validators === 'any' ? undefined : this.validators.find((v) => v.id === id)?.name
    return configured ?? (typeof extra?.name === 'string' ? extra.name : null)
  }

  private toInfo(id: bigint, t: ValidatorTuple, baseApr: number | null, extra: ValidatorExtra | undefined): ValidatorInfo {
    const [authAddress, flags, stake, , commission, , consensusStake, consensusCommission] = t
    const found = authAddress !== zeroAddress
    const listed = this.validators === 'any' ? found : this.validators.some((v) => v.id === id)
    const active = found && flags === 0n && consensusStake > 0n
    const commissionPct = commissionToPercent(commission)
    const consensusPct = commissionToPercent(consensusCommission)
    const refusals: ValidatorRefusal[] = []
    if (this.validators !== 'any' && !listed) refusals.push('not-listed')
    if (!found) refusals.push('not-found')
    else {
      if (!active && !this._config.allowInactive) refusals.push('inactive')
      // Compared in the precompile's 1e18 scale: the percent shown is rounded to 0.01.
      const charged = commission > consensusCommission ? commission : consensusCommission
      if (charged > percentToCommission(this.maxCommission)) refusals.push('commission-above-max')
    }
    // Stake on a validator outside the consensus set earns nothing.
    const estimate = active && baseApr !== null ? baseApr * (1 - commissionPct / 100) : null
    const apr = typeof extra?.apr === 'number' ? extra.apr : estimate
    const info: ValidatorInfo = {
      id, name: this.nameOf(id, extra), authAddress, flags, stake, consensusStake,
      consensusCommission: consensusPct, commission: commissionPct, active, listed,
      eligible: refusals.length === 0, refusals, apr,
      aprSource: typeof extra?.apr === 'number' ? 'enrich' : estimate !== null ? 'estimate' : null,
    }
    if (extra) info.extra = extra
    return info
  }

  private async enrich(ids: bigint[]): Promise<Record<string, ValidatorExtra>> {
    if (!this._config.enrich || ids.length === 0) return {}
    try {
      return (await this._config.enrich(ids)) ?? {}
    } catch {
      return {} // decoration only: the on-chain checks stand without it
    }
  }

  /**
   * Network figures for the APR estimate: the consensus set's total stake (one `getValidator` per
   * validator, cached) and the block time measured over the last 50 000 blocks. Cached 10 minutes.
   */
  async getNetworkStats(): Promise<MonadNetworkStats> {
    if (this.networkCache && Date.now() - this.networkCache.at < NETWORK_TTL_MS) return await this.networkCache.value
    const value = (async () => {
      const ids = await this.consensusIds()
      const tuples = await pool(ids, this.concurrency, (id) => this.validatorTuple(id))
      const total = tuples.reduce((s, t) => s + t[6], 0n)
      const client = this.rpc()
      const head = await client.getBlock()
      const past = await client.getBlock({ blockNumber: head.number > BLOCK_TIME_SAMPLE ? head.number - BLOCK_TIME_SAMPLE : 0n })
      const span = head.number - past.number
      const blockTimeMs = span > 0n ? (bigintToNumber(head.timestamp - past.timestamp) * 1000) / bigintToNumber(span) : 400
      const blocksPerYear = (365.25 * 86_400_000) / blockTimeMs
      const apr = total > 0n ? (bigintToNumber(BLOCK_REWARD / 10n ** 9n) * blocksPerYear) / bigintToNumber(total / 10n ** 9n) * 100 : 0
      const stats = { consensusValidators: ids.length, totalConsensusStake: total, blockTimeMs, blocksPerYear, apr }
      this.networkSettled = stats
      return stats
    })()
    this.networkCache = { at: Date.now(), value }
    value.catch(() => { if (this.networkCache?.value === value) this.networkCache = undefined })
    return await value
  }

  /** One validator, read fresh: stake, commission, standing, APR, and whether the module may delegate to it. */
  async getValidator(id: bigint | number): Promise<ValidatorInfo> {
    const vid = toValidatorId(id)
    const [t, stats, extra] = await Promise.all([this.validatorTuple(vid, true), this.getNetworkStats().catch(() => null), this.enrich([vid])])
    return this.toInfo(vid, t, stats?.apr ?? null, extra[String(vid)])
  }

  /** The validator for a write decision: read fresh, no APR work (it would cost ~200 reads), no enrich. */
  private async validatorForWrite(id: bigint): Promise<ValidatorInfo> {
    return this.toInfo(id, await this.validatorTuple(id, true), this.networkSettled?.apr ?? null, undefined)
  }

  /**
   * The validators to offer: the configured list in its order, or in `'any'` mode the consensus set
   * by stake (`limit` to cut it). Each says whether it can take stake now and why not.
   */
  async listValidators(options: { limit?: number } = {}): Promise<ValidatorInfo[]> {
    const stats = this.getNetworkStats().catch(() => null)
    let ids: bigint[]
    if (this.validators === 'any') {
      const all = await this.consensusIds()
      const tuples = await pool(all, this.concurrency, (id) => this.validatorTuple(id))
      ids = all.map((id, i) => ({ id, stake: tuples[i]![6] })).sort((a, b) => (b.stake > a.stake ? 1 : b.stake < a.stake ? -1 : 0)).map((x) => x.id)
    } else {
      ids = this.validators.map((v) => v.id)
    }
    if (options.limit !== undefined) ids = ids.slice(0, options.limit)
    const [tuples, extra, s] = await Promise.all([pool(ids, this.concurrency, (id) => this.validatorTuple(id)), this.enrich(ids), stats])
    return ids.map((id, i) => this.toInfo(id, tuples[i]!, s?.apr ?? null, extra[String(id)]))
  }

  private async pickValidator(requested?: bigint | number): Promise<ValidatorInfo> {
    const id = requested !== undefined ? toValidatorId(requested) : this.defaultValidator
    if (id === undefined) {
      throw new Error(this.validators === 'any'
        ? "Pass `validator`: with validators: 'any' there is no default."
        : 'Pass `validator`, or set `defaultValidator` in the config (several validators are listed).')
    }
    const v = await this.validatorForWrite(id)
    if (!v.eligible) {
      const why = v.refusals.map((r) => (r === 'commission-above-max' ? `commission ${Math.max(v.commission, v.consensusCommission)} % > ${this.maxCommission} %` : r)).join(', ')
      throw new Error(`Validator ${id} cannot take stake: ${why}.`)
    }
    return v
  }

  /**
   * APR in percent for a validator (`validator`, else the default): `enrich`'s figure when it gives
   * one, else 18 MON × blocks per year ÷ consensus stake × (1 − commission). Without a validator in
   * `'any'` mode: the network figure before commission.
   */
  override async getApr(options: { validator?: bigint | number } = {}): Promise<number> {
    const id = options.validator ?? this.defaultValidator
    if (id !== undefined) return (await this.getValidator(id)).apr ?? 0
    if (this.validators === 'any') return (await this.getNetworkStats()).apr
    const first = (await this.listValidators()).find((v) => v.eligible)
    return first?.apr ?? 0
  }

  // ── Positions ────────────────────────────────────────────────────────────────

  /** Validators the wallet has stake with (the precompile drops a validator from this list once the wallet's stake there is zero). */
  private async delegatedIds(me: Address): Promise<bigint[]> {
    const ids = await paginate<bigint>(async (start) => this.read<readonly [boolean, bigint, readonly bigint[]]>('getDelegations', [me, start]), 0n)
    return [...new Set(ids)]
  }

  private async positionFor(me: Address, id: bigint, extra: ValidatorExtra | undefined): Promise<DelegatorPosition> {
    const [d, t] = await Promise.all([this.read<DelegatorTuple>('getDelegator', [id, me]), this.validatorTuple(id)])
    const v = this.toInfo(id, t, this.networkSettled?.apr ?? null, extra)
    const [stake, , rewards, delta, nextDelta, deltaEpoch, nextDeltaEpoch] = d
    return {
      validatorId: id, name: v.name, active: stake, activating: delta, activatingNext: nextDelta,
      activationEpoch: deltaEpoch > 0n ? deltaEpoch : null, nextActivationEpoch: nextDeltaEpoch > 0n ? nextDeltaEpoch : null,
      unclaimedRewards: rewards, validator: v,
    }
  }

  /**
   * The wallet's delegations (every validator it has stake with), with pending stake and unclaimed
   * rewards. `validator.apr` is filled only once `getNetworkStats()` has run (it costs ~200 reads).
   */
  async listPositions(): Promise<DelegatorPosition[]> {
    const me = await this.me()
    await this.chain()
    const ids = await this.delegatedIds(me)
    const extra = await this.enrich(ids)
    const rows = await pool(ids, this.concurrency, (id) => this.positionFor(me, id, extra[String(id)]))
    return rows.filter((p) => p.active > 0n || p.activating > 0n || p.activatingNext > 0n || p.unclaimedRewards > 0n)
  }

  /**
   * The position: `balance` is active stake, `total` active plus activating (rewards are not in it
   * until compounded; they are in `unclaimedRewards`). No wrapped form (`rate` 0).
   */
  override async getStakedBalance(): Promise<StakedBalance & { activating: bigint; unclaimedRewards: bigint }> {
    const positions = await this.listPositions()
    let balance = 0n, activating = 0n, rewards = 0n
    for (const p of positions) {
      balance += p.active
      activating += p.activating + p.activatingNext
      rewards += p.unclaimedRewards
    }
    return { balance, wrappedBalance: 0n, rate: 0n, total: balance + activating, activating, unclaimedRewards: rewards }
  }

  /** The most `stake` can take now: balance − reserve balance (the gas is paid out of the reserve, as Monad allows); 0 below 1 gwei. */
  async getMaxStakeable(): Promise<bigint> {
    const max = BigInt(await this._account.getBalance()) - this.reserveBalance
    return max >= DUST_THRESHOLD ? max : 0n
  }

  // ── Withdrawal slots ─────────────────────────────────────────────────────────

  private async slot(id: bigint, me: Address, withdrawId: number): Promise<{ amount: bigint; withdrawEpoch: bigint }> {
    const [amount, , withdrawEpoch] = await this.read<readonly [bigint, bigint, bigint]>('getWithdrawalRequest', [id, me, withdrawId])
    return { amount, withdrawEpoch }
  }

  /** The lowest free withdrawal slot for this validator (null when all are in use). */
  async nextWithdrawId(validatorId: bigint | number): Promise<number | null> {
    const id = toValidatorId(validatorId)
    const me = await this.me()
    for (let start = 0; start <= this.maxWithdrawId; start += this.concurrency) {
      const slots = Array.from({ length: Math.min(this.concurrency, this.maxWithdrawId - start + 1) }, (_, i) => start + i)
      const rows = await pool(slots, this.concurrency, (w) => this.slot(id, me, w))
      const free = rows.findIndex((r) => r.amount === 0n)
      if (free >= 0) return slots[free]!
    }
    return null
  }

  /**
   * Every slot 0…maxWithdrawId of one validator in one eth_call through Multicall3, or null when that
   * call fails (no Multicall3 on this chain, an RPC that refuses it): the caller then reads them one by one.
   */
  private async allSlots(id: bigint, me: Address): Promise<Array<{ amount: bigint; withdrawEpoch: bigint }> | null> {
    const contracts = Array.from({ length: this.maxWithdrawId + 1 }, (_, w) => ({ address: this.stakingAddress, abi: STAKING_ABI, functionName: 'getWithdrawalRequest' as const, args: [id, me, w] as const }))
    try {
      const rows = await this.rpc().multicall({ contracts: contracts as never, multicallAddress: this.multicallAddress, allowFailure: false, batchSize: 0 })
      return (rows as unknown as Array<readonly [bigint, bigint, bigint]>).map(([amount, , withdrawEpoch]) => ({ amount, withdrawEpoch }))
    } catch {
      return null
    }
  }

  /**
   * Used slots of one validator: all of them in one Multicall3 read (`'multicall'`, falling back to
   * `'full'`), every slot one call each (`'full'`), or until 32 empty ones past the last used (`'gap'`).
   */
  private async usedSlots(id: bigint, me: Address): Promise<Array<{ withdrawId: number; amount: bigint; withdrawEpoch: bigint }>> {
    if (this.withdrawScan === 'multicall') {
      const all = await this.allSlots(id, me)
      if (all) return all.flatMap((r, withdrawId) => (r.amount === 0n ? [] : [{ withdrawId, ...r }]))
    }
    const used: Array<{ withdrawId: number; amount: bigint; withdrawEpoch: bigint }> = []
    let last = -1
    for (let start = 0; start <= this.maxWithdrawId; start += this.concurrency) {
      if (this.withdrawScan === 'gap' && start > last + WITHDRAW_SCAN_GAP) break
      const slots = Array.from({ length: Math.min(this.concurrency, this.maxWithdrawId - start + 1) }, (_, i) => start + i)
      const rows = await pool(slots, this.concurrency, (w) => this.slot(id, me, w))
      rows.forEach((r, i) => {
        if (r.amount === 0n) return
        used.push({ withdrawId: slots[i]!, ...r })
        last = slots[i]!
      })
    }
    return used
  }

  /**
   * Pending withdrawals. `id` is `validatorId << 8 | withdrawId`; `claimable` once the epoch is past
   * the stake's deactivation (`withdrawableAtEpoch`); `timestamp` is 0 (the precompile does not keep it).
   *
   * Validators looked at: the wallet's delegations, the configured list, validators this instance
   * undelegated from, and `validators`. A validator the wallet fully exited drops out of
   * `getDelegations`, so in `'any'` mode pass it (from the activity feed or the `id` that
   * `requestWithdrawal` returned) or its withdrawal is not found. `validator` reads just one.
   */
  override async getWithdrawalRequests(options: MonadWithdrawalScanOptions = {}): Promise<MonadWithdrawalRequestsView> {
    const me = await this.me()
    await this.chain()
    const { epoch } = await this.getEpoch()
    let ids: bigint[]
    if (options.validator !== undefined) ids = [toValidatorId(options.validator)]
    else {
      const set = new Set(await this.delegatedIds(me))
      if (this.validators !== 'any') for (const v of this.validators) set.add(v.id)
      for (const v of this.unstakedFrom) set.add(v)
      for (const v of options.validators ?? []) set.add(toValidatorId(v))
      ids = [...set]
    }
    const requests: MonadWithdrawalRequest[] = []
    let pendingAmount = 0n, claimableAmount = 0n
    const claimableIds: bigint[] = []
    for (const validatorId of ids) {
      for (const r of await this.usedSlots(validatorId, me)) {
        const opens = withdrawableAtEpoch(r.withdrawEpoch)
        const claimable = epoch >= opens
        const id = packWithdrawalId(validatorId, r.withdrawId)
        requests.push({ id, amount: r.amount, timestamp: 0, claimable, validatorId, withdrawId: r.withdrawId, withdrawEpoch: r.withdrawEpoch, withdrawableAtEpoch: opens })
        if (claimable) { claimableAmount += r.amount; claimableIds.push(id) } else pendingAmount += r.amount
      }
    }
    requests.sort((a, b) => (b.withdrawEpoch > a.withdrawEpoch ? 1 : b.withdrawEpoch < a.withdrawEpoch ? -1 : 0))
    claimableIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return { requests, pendingAmount, claimableAmount, claimableIds }
  }

  // ── Writes ───────────────────────────────────────────────────────────────────

  private async planStake(o: MonadStakeOptions): Promise<{ tx: Tx; from: Address; quote: Omit<MonadStakeQuote, 'fee'> }> {
    const amount = toAmount(o?.amount)
    if (amount < DUST_THRESHOLD) throw new Error('A delegation must be at least 1 gwei (the precompile\'s minimum).')
    const from = await this.me()
    const chainId = await this.chain()
    const [validator, epoch, balance] = await Promise.all([this.pickValidator(o.validator), this.getEpoch(), this._account.getBalance()])
    if (BigInt(balance) - amount < this.reserveBalance) {
      throw new Error(`Not enough MON: staking ${mon(amount)} would leave ${mon(BigInt(balance) - amount)}, below Monad's ${mon(this.reserveBalance)} reserve balance (transfers that dip under it revert). Stake at most ${mon(await this.getMaxStakeable())}.`)
    }
    return { tx: this.tx('delegate', [validator.id], amount, chainId), from, quote: { amount, validator, activatesAtEpoch: epoch.activatesAtEpoch } }
  }

  /** Network fee and details of a stake; nothing is signed. The transaction is simulated. */
  override async quoteStake(options: MonadStakeOptions): Promise<MonadStakeQuote> {
    const { tx, from, quote } = await this.planStake(options)
    await this.simulate(tx, from)
    return { ...quote, fee: await this.quoteFee(tx) }
  }

  /** Delegates `amount` wei of MON to a validator (`delegate`, the amount as value). */
  override async stake(options: MonadStakeOptions): Promise<MonadStakeResult> {
    const account = this.requireSigningAccount('stake')
    const { tx, from, quote } = await this.planStake(options)
    await this.simulate(tx, from)
    return { ...quote, ...(await this.send(account, tx)) }
  }

  private async resolvePositionValidator(requested: bigint | number | undefined, me: Address): Promise<bigint> {
    if (requested !== undefined) return toValidatorId(requested)
    if (this.defaultValidator !== undefined) return this.defaultValidator
    const positions = await this.listPositions()
    if (positions.length === 1) return positions[0]!.validatorId
    throw new Error(positions.length === 0 ? `${me} has no delegation.` : 'Pass `validator`: the wallet has delegations with several validators.')
  }

  private async planUnstake(o: MonadUnstakeOptions): Promise<{ tx: Tx; from: Address; quote: Omit<MonadUnstakeQuote, 'fee'> }> {
    const amount = toAmount(o?.amount)
    const from = await this.me()
    const chainId = await this.chain()
    const validatorId = await this.resolvePositionValidator(o.validator, from)
    const [d, epoch] = await Promise.all([this.read<DelegatorTuple>('getDelegator', [validatorId, from]), this.getEpoch()])
    const [active, , , delta, nextDelta, deltaEpoch, nextDeltaEpoch] = d
    if (amount > active) {
      const pending = delta + nextDelta
      const when = [deltaEpoch, nextDeltaEpoch].filter((e) => e > 0n).map(String).join(' / ')
      throw new Error(`Only ${mon(active)} is active with validator ${validatorId}; asked to unstake ${mon(amount)}.${pending > 0n ? ` ${mon(pending)} is still activating (epoch ${when}) and can be unstaked once active.` : ''}`)
    }
    let withdrawId: number
    if (o.withdrawId !== undefined) {
      withdrawId = toWithdrawId(o.withdrawId)
      if (withdrawId > this.maxWithdrawId) throw new Error(`withdrawId ${withdrawId} is above maxWithdrawId ${this.maxWithdrawId}: the module would not find it again.`)
      if ((await this.slot(validatorId, from, withdrawId)).amount !== 0n) throw new Error(`Withdrawal id ${withdrawId} is in use with validator ${validatorId}: claim it first or pick another.`)
    } else {
      const free = await this.nextWithdrawId(validatorId)
      if (free === null) throw new Error(`All ${this.maxWithdrawId + 1} withdrawal slots with validator ${validatorId} are in use: claim finished withdrawals first.`)
      withdrawId = free
    }
    return {
      tx: this.tx('undelegate', [validatorId, amount, withdrawId], 0n, chainId),
      from,
      quote: { amount, validatorId, withdrawId, id: packWithdrawalId(validatorId, withdrawId), withdrawableAtEpoch: withdrawableAtEpoch(epoch.activatesAtEpoch) },
    }
  }

  /** Network fee and slot of an unstake; nothing is signed. The transaction is simulated. */
  override async quoteRequestWithdrawal(options: MonadUnstakeOptions): Promise<MonadUnstakeQuote> {
    const { tx, from, quote } = await this.planUnstake(options)
    await this.simulate(tx, from)
    return { ...quote, fee: await this.quoteFee(tx) }
  }

  /**
   * Undelegates `amount` wei of active stake into a withdrawal slot; claim it with `claimWithdrawals`
   * once it opens. Keep the returned `id`: after a full exit the validator no longer shows in
   * `getDelegations`, and `claimWithdrawals({ ids: [id] })` always works.
   */
  override async requestWithdrawal(options: MonadUnstakeOptions): Promise<MonadUnstakeResult> {
    const account = this.requireSigningAccount('requestWithdrawal')
    const { tx, from, quote } = await this.planUnstake(options)
    await this.simulate(tx, from)
    const sent = await this.send(account, tx)
    this.unstakedFrom.add(quote.validatorId)
    return { ...quote, ...sent, approveHash: null }
  }

  private async planClaim(o: MonadClaimOptions = {}): Promise<{ txs: Tx[]; from: Address; quote: Omit<MonadClaimQuote, 'fee'> }> {
    const from = await this.me()
    const chainId = await this.chain()
    let claims: MonadClaimQuote['claims']
    if (o.ids !== undefined) {
      const { epoch } = await this.getEpoch()
      claims = await pool([...new Set(o.ids.map((x) => BigInt(x)))], this.concurrency, async (packed) => {
        const { validatorId, withdrawId } = unpackWithdrawalId(packed)
        const s = await this.slot(validatorId, from, withdrawId)
        if (s.amount === 0n) throw new Error(`There is no pending withdrawal #${packed} (validator ${validatorId}, slot ${withdrawId}).`)
        if (epoch < withdrawableAtEpoch(s.withdrawEpoch)) throw new Error(`Withdrawal #${packed} opens at epoch ${withdrawableAtEpoch(s.withdrawEpoch)} (now ${epoch}).`)
        return { id: packed, validatorId, withdrawId, amount: s.amount }
      })
    } else {
      const view = await this.getWithdrawalRequests(o.validators ? { validators: o.validators } : {})
      claims = view.requests.filter((r) => r.claimable)
        .sort((a, b) => (a.withdrawEpoch < b.withdrawEpoch ? -1 : a.withdrawEpoch > b.withdrawEpoch ? 1 : 0)) // oldest first
        .map((r) => ({ id: r.id, validatorId: r.validatorId, withdrawId: r.withdrawId, amount: r.amount }))
    }
    if (claims.length === 0) throw new Error('Nothing is claimable yet.')
    return {
      txs: claims.map((c) => this.tx('withdraw', [c.validatorId, c.withdrawId], 0n, chainId)),
      from,
      quote: { amount: claims.reduce((s, c) => s + c.amount, 0n), claims },
    }
  }

  /** Total fee and amount of a claim (one `withdraw` per request); nothing is signed. Each transaction is simulated. */
  override async quoteClaimWithdrawals(options: MonadClaimOptions = {}): Promise<MonadClaimQuote> {
    const { txs, from, quote } = await this.planClaim(options)
    let fee = 0n
    for (const tx of txs) {
      await this.simulate(tx, from)
      fee += await this.quoteFee(tx)
    }
    return { ...quote, fee }
  }

  /**
   * Withdraws ready requests (all, or `ids`): one `withdraw` transaction each, sent in order. If one
   * fails midway, the error carries `sent` (the hashes that went out).
   */
  override async claimWithdrawals(options: MonadClaimOptions = {}): Promise<MonadClaimResult> {
    const account = this.requireSigningAccount('claimWithdrawals')
    const { txs, from, quote } = await this.planClaim(options)
    const hashes: string[] = []
    let fee = 0n
    for (const tx of txs) {
      try {
        await this.simulate(tx, from)
        const r = await this.send(account, tx)
        hashes.push(r.hash)
        fee += r.fee
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sent: [...hashes] })
      }
    }
    return { ...quote, fee, hash: hashes[0]!, hashes }
  }

  private async planRewards(kind: 'compound' | 'claimRewards', o: MonadRewardsOptions = {}): Promise<{ tx: Tx; from: Address; quote: Omit<MonadRewardsQuote, 'fee'> }> {
    const from = await this.me()
    const chainId = await this.chain()
    const validatorId = await this.resolvePositionValidator(o.validator, from)
    const [d, epoch] = await Promise.all([this.read<DelegatorTuple>('getDelegator', [validatorId, from]), this.getEpoch()])
    const rewards = d[2]
    if (rewards === 0n) throw new Error(`No rewards to ${kind === 'compound' ? 'compound' : 'claim'} with validator ${validatorId}.`)
    if (kind === 'compound') {
      if (rewards < DUST_THRESHOLD) throw new Error('Rewards are below the 1 gwei minimum delegation: claim them instead.')
      const v = await this.validatorForWrite(validatorId)
      if (!v.eligible) throw new Error(`Validator ${validatorId} cannot take more stake (${v.refusals.join(', ')}): claim the rewards instead.`)
    }
    return {
      tx: this.tx(kind, [validatorId], 0n, chainId),
      from,
      quote: { validatorId, amount: rewards, activatesAtEpoch: kind === 'compound' ? epoch.activatesAtEpoch : null },
    }
  }

  /** Network fee of {@link compound}; nothing is signed. */
  async quoteCompound(options: MonadRewardsOptions = {}): Promise<MonadRewardsQuote> {
    const { tx, from, quote } = await this.planRewards('compound', options)
    await this.simulate(tx, from)
    return { ...quote, fee: await this.quoteFee(tx) }
  }

  /** Re-delegates the rewards earned with a validator (active from `activatesAtEpoch`). */
  async compound(options: MonadRewardsOptions = {}): Promise<MonadRewardsResult> {
    const account = this.requireSigningAccount('compound')
    const { tx, from, quote } = await this.planRewards('compound', options)
    await this.simulate(tx, from)
    return { ...quote, ...(await this.send(account, tx)) }
  }

  /** Network fee of {@link claimRewards}; nothing is signed. */
  async quoteClaimRewards(options: MonadRewardsOptions = {}): Promise<MonadRewardsQuote> {
    const { tx, from, quote } = await this.planRewards('claimRewards', options)
    await this.simulate(tx, from)
    return { ...quote, fee: await this.quoteFee(tx) }
  }

  /** Sends the rewards earned with a validator to the wallet, right away. */
  async claimRewards(options: MonadRewardsOptions = {}): Promise<MonadRewardsResult> {
    const account = this.requireSigningAccount('claimRewards')
    const { tx, from, quote } = await this.planRewards('claimRewards', options)
    await this.simulate(tx, from)
    return { ...quote, ...(await this.send(account, tx)) }
  }

  /** Labels staking-precompile transactions (stake, unstake, withdraw, compound, claim rewards) offline; see `activity.ts`. */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeMonadStakingActivity(tx, ctx, { stakingAddress: this.stakingAddress, validators: this.validators === 'any' ? [] : this.validators })
  }
}
