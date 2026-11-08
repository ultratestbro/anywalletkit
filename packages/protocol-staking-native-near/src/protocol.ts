import {
  InsufficientFundsError, NetworkError, StakingProtocol,
  type ActivityItem, type ChainTx, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult, type WriteOptions,
} from '@anywalletkit/core'
import type { NearAction, NearRpc, NearTransaction } from '@anywalletkit/wallet-near'
import { describeNativeNearStakingActivity } from './activity.js'
import {
  DEFAULT_CONCURRENCY, DEFAULT_GAS, DEFAULT_MAX_FEE, DEFAULT_RESERVE, DISPLAY_TTL_MS, FASTNEAR_API, KNOWN_POOL_CODE_HASHES, MIN_STAKE,
  NEAR_MAINNET, NEAR_TESTNET, NUM_EPOCHS_TO_UNLOCK, STAKING_FARM_CODE_HASHES, TYPICAL_EPOCH_MS, UNSTAKED_DUST, UPGRADING_FACTORIES, YOCTO_PER_NEAR,
} from './constants.js'
import { epochOfHeight, epochStartsAt, headerAt, readEpoch } from './epoch.js'
import { NearStakingError } from './errors.js'
import { GasPricer, costOf, type GasCost, type GasPrices } from './fees.js'
import { factoryOf, normalizePools, poolRequestId } from './pools.js'
import { getJson, isMissingAccount, mapLimit, resolveRpc, u128 } from './rpc.js'
import { canSendBatch, sameTransactions } from './transactions.js'
import type {
  NativeStakingNearConfig, NearClaimOptions, NearClaimQuote, NearClaimResult, NearEpoch, NearNetwork, NearNetworkStats, NearPoolInfo,
  NearPoolPosition, NearStakedBalance, NearStakeOptions, NearStakeQuote, NearStakeResult, NearStakingWarning, NearUnstakeOptions,
  NearUnstakeQuote, NearUnstakeResult, NearWithdrawalRequest, NearWithdrawalRequestsView, NearWriteOptions, NormalizedPools, PoolExtra,
  PoolRefusal, PositionWarning, UnlockEstimate,
} from './types.js'
import { epochsPerYear, networkGrossApr, poolGrossApr, readValidators, type ValidatorSet } from './validators.js'

/** How long the validator set is reused: it changes only at epoch boundaries, and the answer is ~375 KB. */
const VALIDATORS_TTL_MS = 60_000
/** Default timeout of the fastnear discovery request, ms. */
const DISCOVERY_TIMEOUT_MS = 15_000
/** Unstakes older than this many heights before an estimated epoch start are dated by arithmetic; closer ones are checked against the chain. */
const BOUNDARY_MARGIN = 50n
/** yoctoNEAR per byte of account storage (protocol constant). */
const STORAGE_PRICE_PER_BYTE = 10n ** 19n
/** Heights before an epoch's end within which an unstake's receipt may run in the next epoch (it runs a block or more after the transaction). */
const RECEIPT_MARGIN = 3n
/** The longest `unstake` argument (a u128), so the exit probe never undercounts gas. */
const MAX_U128_DIGITS = '9'.repeat(39)

type Fee = { numerator: number; denominator: number }
/** The current fee and, for staking-farm pools, the one scheduled for the next epoch. */
interface Fees { fee: Fee; next: Fee | null }
/** a/b ≥ c/d, in integers. */
const feeAtLeast = (a: Fee, b: Fee): boolean => BigInt(a.numerator) * BigInt(b.denominator) >= BigInt(b.numerator) * BigInt(a.denominator)
const higherFee = (f: Fees): Fee => (f.next && !feeAtLeast(f.fee, f.next) ? f.next : f.fee)
interface PoolAccount { staked: bigint; unstaked: bigint; canWithdraw: boolean }

const fc = (methodName: string, args: Record<string, unknown>, gas: bigint, deposit: bigint): NearAction =>
  ({ functionCall: { methodName, args, gas, deposit } })

const near = (yocto: bigint): string => {
  const whole = yocto / YOCTO_PER_NEAR
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 5).replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''} NEAR`
}

function toAmount(amount: unknown): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new NearStakingError('invalid-amount', "'amount' must be a bigint or a safe integer (yoctoNEAR).")
  }
  const v = BigInt(amount)
  if (v <= 0n) throw new NearStakingError('invalid-amount', "'amount' must be greater than zero.")
  return v
}

/** A fresh copy, so an account that rewrites what it is handed cannot change the quote the app holds. */
const copyTx = (tx: NearTransaction): NearTransaction => ({
  receiverId: tx.receiverId,
  actions: tx.actions.map((a) => ('functionCall' in a ? { functionCall: { ...a.functionCall, args: { ...(a.functionCall.args as Record<string, unknown>) } } } : a)),
})

const feeValid = (v: unknown): v is Fee => {
  const f = v as Partial<Fee> | null
  return !!f && typeof f === 'object' && Number.isSafeInteger(f.numerator) && Number.isSafeInteger(f.denominator) &&
    f.numerator! >= 0 && f.denominator! > 0 && f.numerator! <= f.denominator!
}

/**
 * Native NEAR staking: `deposit_and_stake` into standard staking pools, unstake with the 4-epoch
 * unbonding, `withdraw_all` once unlocked. See NEAR-STAKING-API.md for the full contract.
 *
 * Fail-closed before anything is signed: the pool must be allowed (`pools` list or `'any'`), carry a
 * staking-pool factory suffix, run known staking-pool code, answer `is_staking_paused` with false,
 * charge at most `maxFee` (now and as scheduled for the next epoch), and sit in the current and
 * next validator sets (unless `allowInactive`). Balance checks count the prepaid gas the node buys
 * upfront (fees.ts), and the stake leaves at least one exit's worth of it on the account. An unstake
 * withdraws an unlocked balance first in the same transaction so it is never locked again, and
 * refuses to restart the wait of a balance still unbonding unless `allowTimerReset`. Exits (unstake,
 * claim) need only the factory suffix and known (or factory-allowed) code, so a user can always
 * leave a pool that was paused or raised its fee.
 */
export class NativeStakingProtocolNear extends StakingProtocol<NativeStakingNearConfig> {
  readonly pools: NormalizedPools
  readonly defaultPool: string | undefined
  readonly maxFee: number
  readonly reserve: bigint
  readonly gas: { stake: bigint; unstake: bigint; withdraw: bigint }
  readonly concurrency: number
  /** Explicit network, or undefined to follow the account's chain at call time. */
  private readonly configuredNetwork: NearNetwork | undefined
  protected readonly rpc: NearRpc | undefined
  private readonly minUptime: number
  private validatorCache: { at: number; value: Promise<ValidatorSet> } | undefined
  private readonly blockTimes = new Map<bigint, number>()
  private readonly displayCache = new Map<string, { at: number; value: Promise<NearPoolInfo> }>()
  private readonly epochIds = new Map<string, bigint>()
  /** The last measured epoch duration, so light listings need no block reads. */
  private lastEpochMs = TYPICAL_EPOCH_MS
  /** Pools this instance staked into or unstaked from: the discovery index may lag behind them. */
  private readonly touched = new Set<string>()
  private readonly pricer = new GasPricer(() => this.requireRpc())

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: NativeStakingNearConfig) {
    super(account, config)
    if (!config || typeof config !== 'object') throw new NearStakingError('invalid-config', 'NativeStakingProtocolNear needs a config with `pools`.')
    this.pools = normalizePools(config.pools)

    if (config.network !== undefined && config.network !== 'mainnet' && config.network !== 'testnet') {
      throw new NearStakingError('invalid-config', "network must be 'mainnet' or 'testnet'.")
    }
    this.configuredNetwork = config.network

    if (config.defaultPool !== undefined) {
      if (this.pools !== 'any' && !this.pools.some((p) => p.id === config.defaultPool)) throw new NearStakingError('invalid-config', 'defaultPool must be one of `pools`.')
      this.defaultPool = config.defaultPool
    } else {
      this.defaultPool = this.pools !== 'any' && this.pools.length === 1 ? this.pools[0]!.id : undefined
    }

    const maxFee = config.maxFee ?? DEFAULT_MAX_FEE
    if (typeof maxFee !== 'number' || !(maxFee >= 0 && maxFee <= 100)) throw new NearStakingError('invalid-config', 'maxFee must be a percentage between 0 and 100.')
    this.maxFee = maxFee

    const minUptime = config.minUptime ?? 0
    if (typeof minUptime !== 'number' || !(minUptime >= 0 && minUptime <= 100)) throw new NearStakingError('invalid-config', 'minUptime must be a percentage between 0 and 100.')
    this.minUptime = minUptime

    if (typeof config.reserve === 'number' && !Number.isSafeInteger(config.reserve)) throw new NearStakingError('invalid-config', 'reserve must be a bigint or a safe integer (yoctoNEAR).')
    this.reserve = BigInt(config.reserve ?? DEFAULT_RESERVE)
    if (this.reserve < 0n) throw new NearStakingError('invalid-config', 'reserve must not be negative.')
    this.gas = { ...DEFAULT_GAS, ...config.gas }
    for (const [k, g] of Object.entries(this.gas)) {
      if (typeof g !== 'bigint' || g <= 0n || g > 300n * 10n ** 12n) throw new NearStakingError('invalid-config', `gas.${k} must be a bigint between 1 gas and 300 Tgas.`)
    }
    if (this.gas.withdraw + this.gas.unstake > 300n * 10n ** 12n) throw new NearStakingError('invalid-config', 'gas.withdraw + gas.unstake must fit in one transaction (300 Tgas): an unstake may carry both.')
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1) throw new NearStakingError('invalid-config', 'concurrency must be a positive integer.')
    if (config.codeHashes !== undefined && (!Array.isArray(config.codeHashes) || config.codeHashes.some((h) => typeof h !== 'string' || h.length === 0))) {
      throw new NearStakingError('invalid-config', 'codeHashes must be a list of base58 code hashes.')
    }
    if (config.discover !== undefined && config.discover !== false && config.discover !== 'fastnear' && typeof config.discover !== 'function') {
      throw new NearStakingError('invalid-config', "discover must be 'fastnear', a function or false.")
    }
    if (config.enrich !== undefined && typeof config.enrich !== 'function') throw new NearStakingError('invalid-config', 'enrich must be a function.')
    this.rpc = resolveRpc(account, config)
  }

  /** The configured network, else the account's (`near:testnet` → testnet, anything else → mainnet). */
  get network(): NearNetwork {
    return this.configuredNetwork ?? (this._account.chain === NEAR_TESTNET ? 'testnet' : 'mainnet')
  }

  /** The factory a pool id belongs to on this network (local suffix check). */
  factoryOf(poolId: string): ReturnType<typeof factoryOf> {
    return factoryOf(poolId, this.network)
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private requireRpc(): NearRpc {
    if (!this.rpc) throw new NearStakingError('no-provider', 'NativeStakingProtocolNear needs a NEAR RPC: pass `provider`, or use a wallet-near account configured with one.')
    return this.rpc
  }

  /** The account id, after checking the account is on this module's NEAR network. */
  private async me(): Promise<string> {
    const want = `near:${this.network}`
    if (this._account.chain !== want) throw new NearStakingError('wrong-chain', `NativeStakingProtocolNear works on ${want}; the account is on ${this._account.chain}.`)
    this.requireRpc()
    return this._account.getAddress()
  }

  private validators(): Promise<ValidatorSet> {
    const now = Date.now()
    if (this.validatorCache && now - this.validatorCache.at < VALIDATORS_TTL_MS) return this.validatorCache.value
    const value = readValidators(this.requireRpc())
    const entry = { at: now, value }
    this.validatorCache = entry
    value.catch(() => { if (this.validatorCache === entry) this.validatorCache = undefined })
    return value
  }

  private listed(id: string): boolean {
    return this.pools === 'any' || this.pools.some((p) => p.id === id)
  }

  private configuredName(id: string): string | null {
    return this.pools === 'any' ? null : (this.pools.find((p) => p.id === id)?.name ?? null)
  }

  private knownCode(hash: string): boolean {
    return KNOWN_POOL_CODE_HASHES[this.network].includes(hash) || (this._config.codeHashes ?? []).includes(hash)
  }

  private async enrich(ids: string[]): Promise<Record<string, PoolExtra>> {
    if (!this._config.enrich || ids.length === 0) return {}
    try {
      const out = await this._config.enrich(ids)
      return out && typeof out === 'object' ? out : {}
    } catch {
      return {} // extras decorate; a failing enricher never blocks a read
    }
  }

  private async available(me: string): Promise<bigint> {
    const view = await this.requireRpc().viewAccount(me)
    if (!view) return 0n
    const free = u128(view.amount, 'view_account amount') - u128(view.locked, 'view_account locked') - BigInt(view.storage_usage) * STORAGE_PRICE_PER_BYTE
    return free > 0n ? free : 0n
  }

  /** Fee (upper bound) and upfront charge of the transactions at the current prices. */
  private async costs(txs: NearTransaction[]): Promise<GasCost & { prices: GasPrices }> {
    const prices = await this.pricer.prices()
    return { ...costOf(txs, prices), prices }
  }

  /** What `stake` leaves on the account: `reserve`, but never less than the upfront gas of the exit it will need. */
  private reserveAt(prices: GasPrices): bigint {
    const gas = this.gas.unstake > this.gas.withdraw ? this.gas.unstake : this.gas.withdraw
    const exit = costOf([{ receiverId: this.defaultPool ?? '', actions: [fc('unstake', { amount: MAX_U128_DIGITS }, gas, 0n)] }], prices).upfront
    return exit > this.reserve ? exit : this.reserve
  }

  /** The module's own `maxFee` check: wallet-selector adapters ignore it. */
  private checkMaxFee(o: WriteOptions | undefined, fee: bigint): void {
    if (o?.maxFee === undefined) return
    if (fee > BigInt(o.maxFee)) throw new NearStakingError('max-fee-exceeded', `The network fee may reach ${near(fee)}, above the maximum of ${near(BigInt(o.maxFee))} for this write.`, { details: { fee, maxFee: BigInt(o.maxFee) } })
  }

  private async readAccount(pool: string, me: string): Promise<PoolAccount> {
    const r = await this.requireRpc().callFunction<Record<string, unknown> | null>(pool, 'get_account', { account_id: me })
    if (!r || typeof r !== 'object' || typeof r.can_withdraw !== 'boolean') throw new NetworkError(`${pool}.get_account: malformed answer`)
    return { staked: u128(r.staked_balance, `${pool}.get_account staked_balance`), unstaked: u128(r.unstaked_balance, `${pool}.get_account unstaked_balance`), canWithdraw: r.can_withdraw }
  }

  /** `is_staking_paused`: true / false, or null when the method is missing, fails or answers something else. */
  private async readPaused(pool: string): Promise<boolean | null> {
    try {
      const v = await this.requireRpc().callFunction<unknown>(pool, 'is_staking_paused')
      return typeof v === 'boolean' ? v : null
    } catch {
      return null
    }
  }

  /**
   * The pool's fee, or null when missing or malformed. staking-farm builds (by code hash, or by the
   * pool.near suffix when the code was not read) answer `get_pool_summary` with the fee scheduled
   * for the next epoch beside the current one; a farm build that does not is 'fee-unknown'.
   */
  private async readFee(pool: string, codeHash?: string | null): Promise<Fees | null> {
    const rpc = this.requireRpc()
    const farm = codeHash ? STAKING_FARM_CODE_HASHES[this.network].includes(codeHash) : factoryOf(pool, this.network) === 'pool'
    if (farm) {
      try {
        const v = await rpc.callFunction<Record<string, unknown> | null>(pool, 'get_pool_summary')
        if (v && feeValid(v.reward_fee_fraction) && feeValid(v.next_reward_fee_fraction)) {
          const f = v.reward_fee_fraction, n = v.next_reward_fee_fraction
          return { fee: { numerator: f.numerator, denominator: f.denominator }, next: { numerator: n.numerator, denominator: n.denominator } }
        }
      } catch { /* below */ }
      if (codeHash) return null
    }
    try {
      const v = await rpc.callFunction<unknown>(pool, 'get_reward_fee_fraction')
      return feeValid(v) ? { fee: { numerator: v.numerator, denominator: v.denominator }, next: null } : null
    } catch {
      return null
    }
  }

  /** Integer comparison: the higher of the current and the scheduled fee > maxFee %. */
  private feeAboveMax(fees: Fees): boolean {
    const fee = higherFee(fees)
    return BigInt(fee.numerator) * 10_000n > BigInt(Math.round(this.maxFee * 100)) * BigInt(fee.denominator)
  }

  /** Refusals the validator set decides: sets (unless allowInactive) and uptime. */
  private setRefusals(id: string, set: ValidatorSet): PoolRefusal[] {
    const out: PoolRefusal[] = []
    const cur = set.current.get(id)
    if (!this._config.allowInactive) {
      if (!cur) out.push('not-in-current-set')
      if (!set.next.has(id)) out.push('not-in-next-set')
    }
    if (this.minUptime > 0 && cur && cur.uptime !== null && cur.uptime < this.minUptime) out.push('low-uptime')
    return out
  }

  /** Pool info from the validator set alone (plus fee and pause when the caller read them). */
  private poolInfo(id: string, set: ValidatorSet | null, epochMs: number, extra: PoolExtra | undefined, read: { codeHash?: string | null; fees?: Fees | null; paused?: boolean | null; details: boolean; refusals: PoolRefusal[] }): NearPoolInfo {
    const cur = set?.current.get(id)
    const fee = read.fees?.fee ?? null
    const grossApr = set ? poolGrossApr(set, id, epochMs) : null
    // The APR looks forward: a fee already scheduled for the next epoch counts when it is higher.
    const charged = read.fees ? higherFee(read.fees) : null
    const feeShare = charged ? charged.numerator / charged.denominator : null
    let apr: number | null = null
    let aprSource: NearPoolInfo['aprSource'] = null
    if (typeof extra?.apr === 'number' && Number.isFinite(extra.apr)) {
      apr = extra.apr
      aprSource = 'enrich'
    } else if (feeShare !== null && set) {
      const gross = grossApr ?? networkGrossApr(set, epochMs).apr
      apr = gross * (1 - feeShare)
      aprSource = grossApr !== null ? 'protocol' : 'network'
    }
    const name = this.configuredName(id) ?? (typeof extra?.name === 'string' ? extra.name : null)
    const info: NearPoolInfo = {
      id,
      name,
      factory: factoryOf(id, this.network),
      details: read.details,
      codeHash: read.codeHash ?? null,
      codeHashKnown: read.codeHash ? this.knownCode(read.codeHash) : null,
      fee,
      feePercent: fee === null ? null : (fee.numerator / fee.denominator) * 100,
      nextFee: read.fees?.next ?? null,
      paused: read.paused ?? null,
      stake: cur?.stake ?? 0n,
      inCurrentSet: !!cur,
      inNextSet: set?.next.has(id) ?? false,
      uptime: cur?.uptime ?? null,
      grossApr,
      apr,
      aprSource,
      listed: this.listed(id),
      eligible: read.refusals.length === 0,
      refusals: read.refusals,
    }
    if (extra) info.extra = extra
    return info
  }

  /**
   * Exits (unstake, claim) need only these: a factory pool id and known staking-pool code, read
   * fresh. A pool.near pool may upgrade itself to code its factory allows; an exit still goes
   * through when `pool.near.is_contract_allowed` says so (exits carry no deposit).
   */
  private async exitCheck(pool: string): Promise<void> {
    const factory = factoryOf(pool, this.network)
    if (factory === null) throw new NearStakingError('pool-not-allowed', `${pool} is not a staking-pool factory account on ${this.network}.`, { refusals: ['not-factory-pool'], details: { pool } })
    const view = await this.requireRpc().viewAccount(pool)
    if (!view) throw new NearStakingError('pool-not-allowed', `${pool} does not exist.`, { refusals: ['not-found'], details: { pool } })
    if (view.code_hash && this.knownCode(view.code_hash)) return
    const factoryAccount = UPGRADING_FACTORIES[this.network]?.[factory]
    if (view.code_hash && factoryAccount && (await this.factoryAllows(factoryAccount, view.code_hash))) return
    throw new NearStakingError('pool-not-allowed', `${pool} runs code ${view.code_hash ?? '(none)'}, not a known staking-pool build.`, { refusals: ['unknown-code'], details: { pool, codeHash: view.code_hash ?? null } })
  }

  /** `is_contract_allowed` on the factory; any failure is a no. */
  private async factoryAllows(factory: string, codeHash: string): Promise<boolean> {
    try {
      return (await this.requireRpc().callFunction<unknown>(factory, 'is_contract_allowed', { code_hash: codeHash })) === true
    } catch {
      return false
    }
  }

  private checkExpected(o: NearWriteOptions | undefined, fresh: NearTransaction[]): void {
    if (o?.expected === undefined) return
    if (!Array.isArray(o.expected) || !sameTransactions(o.expected, fresh)) {
      throw new NearStakingError('quote-changed', 'The transactions changed since the quote (a balance unlocked, a pool changed, or the amount differs): show the new ones and confirm again.', { details: { transactions: fresh } })
    }
  }

  /** Sends the plan: one approval for several transactions when the account can, else one by one. */
  private async send(account: IWalletAccount, txs: NearTransaction[], o: WriteOptions | undefined): Promise<{ hashes: string[]; fee: bigint }> {
    const options: WriteOptions | undefined = o?.maxFee !== undefined ? { maxFee: o.maxFee } : undefined
    if (txs.length > 1 && canSendBatch(account)) {
      const results: TransferResult[] = await account.sendTransactions(txs.map(copyTx), options)
      if (!Array.isArray(results) || results.length !== txs.length || results.some((r) => typeof r?.hash !== 'string')) {
        const sent = Array.isArray(results) ? results.filter((r) => typeof r?.hash === 'string').map((r) => r.hash) : []
        throw Object.assign(new Error(`sendTransactions returned ${Array.isArray(results) ? results.length : 'no'} results for ${txs.length} transactions.`), { sent })
      }
      return { hashes: results.map((r) => r.hash), fee: results.reduce((s, r) => s + BigInt(r.fee ?? 0n), 0n) }
    }
    const hashes: string[] = []
    let fee = 0n
    for (const tx of txs) {
      try {
        const r = await account.sendTransaction(copyTx(tx), options)
        hashes.push(r.hash)
        fee += BigInt(r.fee ?? 0n)
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sent: [...hashes] })
      }
    }
    return { hashes, fee }
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The epoch clock (height, start, blocks left, measured epoch length, estimated end). */
  async getEpoch(): Promise<NearEpoch> {
    const epoch = await readEpoch(this.requireRpc(), { validators: () => this.validators(), blockTimes: this.blockTimes })
    this.lastEpochMs = epoch.epochMs
    return epoch
  }

  /** Network stake, measured epoch length and gross APR (treasury excluded). */
  async getNetworkStats(): Promise<NearNetworkStats> {
    const [set, epoch] = await Promise.all([this.validators(), this.getEpoch()])
    const { apr, totalStake, validators } = networkGrossApr(set, epoch.epochMs)
    return { validators, totalStake, epochMs: epoch.epochMs, epochsPerYear: epochsPerYear(epoch.epochMs), apr }
  }

  /** Factory pools in the current or next validator set, by stake: light info from the `validators` RPC only (`details: false`). */
  async listPools(): Promise<NearPoolInfo[]> {
    const set = await this.validators()
    const ids = [...new Set([...set.current.keys(), ...set.next.keys()])].filter((id) => factoryOf(id, this.network) !== null)
    const stakeOf = (id: string) => set.current.get(id)?.stake ?? 0n
    ids.sort((a, b) => {
      const d = stakeOf(b) - stakeOf(a) || (set.next.get(b) ?? 0n) - (set.next.get(a) ?? 0n)
      return d > 0n ? 1 : d < 0n ? -1 : a < b ? -1 : a > b ? 1 : 0
    })
    const extras = await this.enrich(ids)
    return ids.map((id) => {
      const refusals: PoolRefusal[] = this.listed(id) ? [] : ['not-listed']
      refusals.push(...this.setRefusals(id, set))
      return this.poolInfo(id, set, this.lastEpochMs, extras[id], { details: false, refusals })
    })
  }

  /** One pool with live checks (code hash, fee, pause, sets): what every write uses. Never cached. */
  async getPool(id: string): Promise<NearPoolInfo> {
    const refusals: PoolRefusal[] = []
    if (!this.listed(id)) refusals.push('not-listed')
    if (typeof id !== 'string' || factoryOf(id, this.network) === null) {
      // Local verdict: a foreign contract never gets a single RPC call.
      refusals.push('not-factory-pool')
      return this.poolInfo(String(id), null, this.lastEpochMs, undefined, { details: false, refusals })
    }
    const rpc = this.requireRpc()
    const [view, set, epoch, extras] = await Promise.all([rpc.viewAccount(id), this.validators(), this.getEpoch(), this.enrich([id])])
    const extra = extras[id]
    if (!view) {
      refusals.push('not-found', ...this.setRefusals(id, set))
      return this.poolInfo(id, set, epoch.epochMs, extra, { details: true, refusals })
    }
    const codeHash = view.code_hash ?? null
    if (!codeHash || !this.knownCode(codeHash)) {
      // Unknown code is never called, not even for views.
      refusals.push('unknown-code', ...this.setRefusals(id, set))
      return this.poolInfo(id, set, epoch.epochMs, extra, { details: true, codeHash, refusals })
    }
    const [paused, fees] = await Promise.all([this.readPaused(id), this.readFee(id, codeHash)])
    if (paused === null) refusals.push('pause-unknown')
    else if (paused) refusals.push('paused')
    if (fees === null) refusals.push('fee-unknown')
    else if (this.feeAboveMax(fees)) refusals.push('fee-above-max')
    refusals.push(...this.setRefusals(id, set))
    return this.poolInfo(id, set, epoch.epochMs, extra, { details: true, codeHash, fees, paused, refusals })
  }

  /** Several pools with live checks, concurrency-limited; cached for display (DISPLAY_TTL_MS). */
  async getPools(ids: string[]): Promise<NearPoolInfo[]> {
    return mapLimit([...new Set(ids)], this.concurrency, (id) => {
      const now = Date.now()
      const hit = this.displayCache.get(id)
      if (hit && now - hit.at < DISPLAY_TTL_MS) return hit.value
      const value = this.getPool(id)
      const entry = { at: now, value }
      this.displayCache.set(id, entry)
      value.catch(() => { if (this.displayCache.get(id) === entry) this.displayCache.delete(id) })
      return value
    })
  }

  /**
   * Pools that may hold the account's balance: listed, discovered, passed, and touched by this
   * instance. Factory pools only. A failed discovery leaves the others (`partial`).
   */
  private async candidatePools(me: string, extra: readonly string[] = []): Promise<{ ids: string[]; discoveryError: unknown }> {
    const out = new Set<string>()
    if (this.pools !== 'any') for (const p of this.pools) out.add(p.id)
    let discoveryError: unknown
    try {
      for (const p of await this.discover(me)) out.add(p)
    } catch (e) {
      discoveryError = e ?? new Error('pool discovery failed')
    }
    for (const p of extra) out.add(p)
    for (const p of this.touched) out.add(p)
    return { ids: [...out].filter((id) => typeof id === 'string' && factoryOf(id, this.network) !== null), discoveryError }
  }

  private async discover(me: string): Promise<string[]> {
    const d = this._config.discover ?? 'fastnear'
    if (d === false) return []
    const found = typeof d === 'function'
      ? await d(me)
      : ((await getJson(`${FASTNEAR_API[this.network]}/v1/account/${encodeURIComponent(me)}/staking`, this._config.timeoutMs ?? DISCOVERY_TIMEOUT_MS)) as { pools?: Array<{ pool_id?: unknown }> } | null)?.pools?.map((p) => p?.pool_id)
    if (found !== undefined && !Array.isArray(found)) throw new NetworkError('pool discovery: malformed answer')
    return (found ?? []).filter((p): p is string => typeof p === 'string')
  }

  /** The epoch a block belongs to: arithmetic from the current epoch, checked against the chain near a boundary. */
  private async epochOfBlock(block: bigint, epoch: NearEpoch): Promise<bigint> {
    const guess = epochOfHeight(epoch, block)
    if (guess >= epoch.height) return guess
    // A skipped height at a boundary moves later epochs' starts: a block just before the estimated start may already be in the next epoch.
    const estimatedNextStart = epoch.startBlock - (epoch.height - guess - 1n) * epoch.length
    if (estimatedNextStart - block > BOUNDARY_MARGIN) return guess
    try {
      const h = await headerAt(this.requireRpc(), block)
      if (h.epochId) {
        const known = this.epochIds.get(h.epochId)
        if (known !== undefined) return known
        const r = (await this.requireRpc().fetch('validators', { epoch_id: h.epochId })) as { epoch_height?: unknown } | null
        if (typeof r?.epoch_height === 'number' && Number.isSafeInteger(r.epoch_height)) {
          const height = BigInt(r.epoch_height)
          this.epochIds.set(h.epochId, height)
          return height
        }
      }
    } catch { /* pruned block or epoch: keep the arithmetic */ }
    return guess
  }

  private estimate(epoch: NearEpoch, earliest: bigint, latest: bigint | null): UnlockEstimate {
    return {
      epoch: null,
      earliestEpoch: earliest,
      latestEpoch: latest,
      at: null,
      earliestAt: epochStartsAt(epoch, earliest),
      latestAt: latest === null ? null : epochStartsAt(epoch, latest),
      source: 'estimate',
    }
  }

  /** Positions plus the unix seconds of the unstake that history dated, per pool. */
  private async positionsDated(extra: readonly string[] = []): Promise<{ positions: NearPoolPosition[]; dated: Map<string, number>; epoch: NearEpoch | null; partial: boolean; discoveryError: unknown }> {
    const me = await this.me()
    const { ids, discoveryError } = await this.candidatePools(me, extra)
    const partial = discoveryError !== undefined
    const accounts = await mapLimit(ids, this.concurrency, async (id) => {
      try {
        return await this.readAccount(id, me)
      } catch (e) {
        if (isMissingAccount(e)) return null // a pool account deleted since discovery indexed it
        throw e
      }
    })
    const held = ids.flatMap((id, i) => {
      const a = accounts[i]
      return a && (a.staked > 0n || a.unstaked >= UNSTAKED_DUST) ? [{ id, a }] : []
    })
    const dated = new Map<string, number>()
    if (held.length === 0) return { positions: [], dated, epoch: null, partial, discoveryError }

    const [set, epoch, extras, reads] = await Promise.all([
      this.validators(),
      this.getEpoch(),
      this.enrich(held.map((h) => h.id)),
      mapLimit(held, this.concurrency, async ({ id }) => Promise.all([this.readFee(id), this.readPaused(id)])),
    ])

    let history: ChainTx[] | null = null
    if (this._config.history && held.some(({ a }) => a.unstaked >= UNSTAKED_DUST && !a.canWithdraw)) {
      try {
        history = (await this._config.history.listActivity(me, { limit: 100 })).items
      } catch {
        history = null // nearblocks rate limits: the estimate below still holds
      }
    }

    const positions: NearPoolPosition[] = []
    for (const [i, { id, a }] of held.entries()) {
      const [fees, paused] = reads[i]!
      const refusals: PoolRefusal[] = this.listed(id) ? [] : ['not-listed']
      if (paused === null) refusals.push('pause-unknown')
      else if (paused) refusals.push('paused')
      if (fees === null) refusals.push('fee-unknown')
      else if (this.feeAboveMax(fees)) refusals.push('fee-above-max')
      refusals.push(...this.setRefusals(id, set))
      const poolInfo = this.poolInfo(id, set, epoch.epochMs, extras[id], { details: false, fees, paused, refusals })

      let unlock: UnlockEstimate | null = null
      if (a.unstaked >= UNSTAKED_DUST && !a.canWithdraw) {
        unlock = this.estimate(epoch, epoch.height + 1n, epoch.height + NUM_EPOCHS_TO_UNLOCK)
        const last = history?.find((tx) => tx.status === 'confirmed' && tx.from === me && tx.call?.to === id &&
          (tx.call.programs ?? (tx.call.method ? [tx.call.method] : [])).some((m) => m === 'unstake' || m === 'unstake_all'))
        if (last?.block !== undefined) {
          const unstakedIn = await this.epochOfBlock(last.block, epoch)
          // The pool's receipt runs a block or more after the transaction's block: in an epoch's last heights it may run in the next epoch.
          const nextStart = epoch.startBlock + (unstakedIn + 1n - epoch.height) * epoch.length
          const straddles = nextStart > last.block && nextStart - last.block <= RECEIPT_MARGIN
          const opens = unstakedIn + NUM_EPOCHS_TO_UNLOCK
          const latest = straddles ? opens + 1n : opens
          // The pool says it is still locked: an unlock epoch already reached means history missed a later unstake (or the receipt ran late).
          if (latest > epoch.height) {
            const earliest = opens > epoch.height ? opens : latest
            const at = epochStartsAt(epoch, earliest)
            unlock = earliest === latest
              ? { epoch: earliest, earliestEpoch: earliest, latestEpoch: earliest, at, earliestAt: at, latestAt: at, source: 'history' }
              : { epoch: null, earliestEpoch: earliest, latestEpoch: latest, at: null, earliestAt: at, latestAt: epochStartsAt(epoch, latest), source: 'history' }
            dated.set(id, last.time)
          }
        }
      }

      const warnings: PositionWarning[] = []
      if (fees !== null && this.feeAboveMax(fees)) warnings.push('pool-fee-above-max')
      if (paused === true) warnings.push('pool-paused')
      if (poolInfo.inCurrentSet && !poolInfo.inNextSet) warnings.push('pool-leaving-set')
      if (!poolInfo.inCurrentSet && !poolInfo.inNextSet) warnings.push('pool-not-in-set')

      positions.push({
        pool: id,
        name: poolInfo.name,
        staked: a.staked,
        unstaked: a.unstaked,
        canWithdraw: a.canWithdraw,
        withdrawable: a.canWithdraw && a.unstaked >= UNSTAKED_DUST ? a.unstaked : 0n,
        unlock,
        poolInfo,
        warnings,
      })
    }
    return { positions, dated, epoch, partial, discoveryError }
  }

  /**
   * The account's position in every listed, discovered and passed pool with a non-zero balance.
   * Throws when discovery fails, so a lookup outage never reads as "no stake"; `getStakedBalance`,
   * `getWithdrawalRequests` and claims carry on with the listed, passed and touched pools instead
   * and say so with `partial`.
   */
  async listPositions(options: { pools?: string[] } = {}): Promise<NearPoolPosition[]> {
    const r = await this.positionsDated(options.pools)
    if (r.partial) throw r.discoveryError
    return r.positions
  }

  /** What `stake` can send now: available − reserve − the stake's upfront gas (never below 0). */
  async getMaxStakeable(): Promise<bigint> {
    const me = await this.me()
    // The gas depends on the actions only, not on the receiver or the deposit.
    const probe: NearTransaction = { receiverId: this.defaultPool ?? '', actions: [fc('deposit_and_stake', {}, this.gas.stake, 0n)] }
    const [available, cost] = await Promise.all([this.available(me), this.costs([probe])])
    const max = available - this.reserveAt(cost.prices) - cost.upfront
    return max > 0n ? max : 0n
  }

  /** Delegator APR in percent: of `pool`, else `defaultPool`, else the network average after a typical fee. */
  override async getApr(options: { pool?: string } = {}): Promise<number> {
    const id = options.pool ?? this.defaultPool
    if (id === undefined) {
      const stats = await this.getNetworkStats()
      return stats.apr * (1 - DEFAULT_MAX_FEE / 100)
    }
    const [info] = await this.getPools([id])
    if (info!.apr === null) throw new NearStakingError('pool-not-allowed', `No APR for ${id}: ${info!.refusals.join(', ') || 'its fee could not be read'}.`, { refusals: info!.refusals, details: { pool: id } })
    return info!.apr
  }

  /** Staked across pools (`balance`), staked + unstaked (`total`), with the positions. */
  override async getStakedBalance(): Promise<NearStakedBalance> {
    const { positions, partial } = await this.positionsDated()
    let balance = 0n, unstaked = 0n, withdrawable = 0n
    for (const p of positions) {
      balance += p.staked
      unstaked += p.unstaked
      withdrawable += p.withdrawable
    }
    return { balance, wrappedBalance: 0n, rate: 0n, total: balance + unstaked, unstaked, withdrawable, positions, partial }
  }

  /** One request per pool holding an unstaked balance; ids are `poolRequestId(pool)`. */
  override async getWithdrawalRequests(options: { pools?: string[] } = {}): Promise<NearWithdrawalRequestsView> {
    const { positions, dated, partial } = await this.positionsDated(options.pools)
    const requests: NearWithdrawalRequest[] = []
    let pendingAmount = 0n, claimableAmount = 0n
    const claimableIds: bigint[] = []
    for (const p of positions) {
      if (p.unstaked < UNSTAKED_DUST) continue
      const id = poolRequestId(p.pool)
      requests.push({ id, amount: p.unstaked, timestamp: dated.get(p.pool) ?? 0, claimable: p.canWithdraw, pool: p.pool, unlock: p.unlock })
      if (p.canWithdraw) {
        claimableAmount += p.unstaked
        claimableIds.push(id)
      } else pendingAmount += p.unstaked
    }
    // Newest first: by the dated unstake time, then by the latest possible unlock.
    const opens = (r: NearWithdrawalRequest) => r.unlock?.latestEpoch ?? r.unlock?.earliestEpoch ?? 0n
    requests.sort((a, b) => b.timestamp - a.timestamp || (opens(b) > opens(a) ? 1 : opens(b) < opens(a) ? -1 : 0))
    claimableIds.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    return { requests, pendingAmount, claimableAmount, claimableIds, partial }
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  private async planStake(o: NearStakeOptions): Promise<NearStakeQuote> {
    const amount = toAmount(o?.amount)
    if (amount < MIN_STAKE) throw new NearStakingError('below-minimum', `A stake must be at least ${near(MIN_STAKE)}.`, { details: { minimum: MIN_STAKE } })
    const me = await this.me()
    const poolId = o?.pool ?? this.defaultPool
    if (poolId === undefined) throw new NearStakingError('pool-required', 'Name the pool to stake into: several pools are allowed and none is the default.')
    const pool = await this.getPool(poolId)
    if (!pool.eligible) throw new NearStakingError('pool-not-allowed', `${poolId} cannot take new stake: ${pool.refusals.join(', ')}.`, { refusals: pool.refusals, details: { pool: poolId } })
    const transactions: NearTransaction[] = [{ receiverId: poolId, actions: [fc('deposit_and_stake', {}, this.gas.stake, amount)] }]
    const [{ fee, upfront, prices }, available] = await Promise.all([this.costs(transactions), this.available(me)])
    const reserve = this.reserveAt(prices)
    if (amount + upfront + reserve > available) throw new InsufficientFundsError(amount + upfront + reserve, available, 'NEAR')
    const max = available - reserve - upfront
    const warnings: NearStakingWarning[] = []
    if (pool.aprSource === 'network') {
      warnings.push({ code: 'apr-network-fallback', message: `${poolId} has no reward data for the last epoch yet (it is new in the validator set): the APR shown is the network average after its fee.` })
    }
    return { fee, upfront, reserve, amount, pool, apr: pool.apr, maxStakeable: max > 0n ? max : 0n, transactions, warnings }
  }

  /** The exact stake transaction, its fee and the pool's live checks; nothing is signed. */
  override async quoteStake(options: NearStakeOptions): Promise<NearStakeQuote> {
    return this.planStake(options)
  }

  /** `deposit_and_stake` of exactly `amount` into the pool, after fresh checks; refuses when the plan differs from `expected`. */
  override async stake(options: NearStakeOptions): Promise<NearStakeResult> {
    const account = this.requireSigningAccount('stake')
    const quote = await this.planStake(options)
    this.checkExpected(options, quote.transactions)
    this.checkMaxFee(options, quote.fee)
    const { hashes, fee } = await this.send(account, quote.transactions, options)
    this.touched.add(quote.pool.id)
    return { ...quote, fee, hash: hashes[0]!, hashes }
  }

  /** The one pool with a real stake (share-rounding dust below MIN_STAKE does not count); refuses to guess after a failed discovery. */
  private async onlyStakedPool(): Promise<string> {
    const { positions, partial } = await this.positionsDated()
    const staked = positions.filter((p) => p.staked >= MIN_STAKE)
    if (staked.length === 1 && !partial) return staked[0]!.pool
    const message = partial
      ? 'Name the pool: pool discovery failed, so the module cannot tell which pools hold stake.'
      : staked.length === 0 ? 'The account has no staked balance in any known pool.' : 'Name the pool: the account has stake in several pools.'
    throw new NearStakingError('pool-required', message, { details: { pools: staked.map((p) => p.pool), partial } })
  }

  private async planUnstake(o: NearUnstakeOptions): Promise<NearUnstakeQuote> {
    const all = o?.amount === 'all'
    const requested = all ? null : toAmount(o?.amount)
    const me = await this.me()
    const pool = o?.pool ?? this.defaultPool ?? (await this.onlyStakedPool())
    await this.exitCheck(pool)
    const [acc, epoch, available] = await Promise.all([this.readAccount(pool, me), this.getEpoch(), this.available(me)])
    if (acc.staked === 0n) throw new NearStakingError('nothing-staked', `Nothing is staked in ${pool}.`, { details: { pool } })
    if (requested !== null && requested > acc.staked) {
      throw new NearStakingError('exceeds-staked', `Only ${near(acc.staked)} is staked in ${pool}; asked to unstake ${near(requested)}.`, { details: { pool, staked: acc.staked } })
    }
    const amount = requested ?? acc.staked
    const unstake = all ? fc('unstake_all', {}, this.gas.unstake, 0n) : fc('unstake', { amount: amount.toString() }, this.gas.unstake, 0n)
    const warnings: NearStakingWarning[] = []
    let withdrawsFirst = 0n
    let resetsTimer = false
    let actions: NearAction[] = [unstake]
    const pending = acc.unstaked >= UNSTAKED_DUST
    if (pending && acc.canWithdraw) {
      // A new unstake would lock the already unlocked balance for four more epochs: take it out first, in the same transaction.
      actions = [fc('withdraw_all', {}, this.gas.withdraw, 0n), unstake]
      withdrawsFirst = acc.unstaked
      warnings.push({ code: 'withdraws-unlocked-first', message: `${near(acc.unstaked)} already unlocked in ${pool} is withdrawn to your account in the same transaction, so this unstake does not lock it again.` })
    } else if (pending) {
      // A pool keeps one unlock time per account: this unstake restarts the wait of everything already unbonding.
      if (amount < MIN_STAKE) {
        throw new NearStakingError('timer-reset-refused', `Unstaking ${near(amount)} would restart the 4-epoch wait of the ${near(acc.unstaked)} already unbonding in ${pool}.`, { details: { pool, unstaked: acc.unstaked, amount } })
      }
      if (!o.allowTimerReset) {
        throw new NearStakingError('timer-reset-refused', `${near(acc.unstaked)} is still unbonding in ${pool}. A new unstake restarts its 4-epoch wait (about 21–28 h) together with this amount: wait until it unlocks and claim it, or pass allowTimerReset.`, { details: { pool, unstaked: acc.unstaked, amount } })
      }
      resetsTimer = true
      warnings.push({ code: 'resets-unbonding-timer', message: `${near(acc.unstaked)} already unstaking in ${pool} restarts its 4-epoch wait (about 21–28 h) together with this amount: a pool keeps one unlock time per account.` })
    }
    const transactions: NearTransaction[] = [{ receiverId: pool, actions }]
    const { fee, upfront } = await this.costs(transactions)
    if (upfront > available) throw new InsufficientFundsError(upfront, available, 'NEAR')
    // Unlocks at current + 4; + 5 if the transaction lands after this epoch ends.
    const unlock = this.estimate(epoch, epoch.height + NUM_EPOCHS_TO_UNLOCK, epoch.height + NUM_EPOCHS_TO_UNLOCK + 1n)
    return { fee, upfront, amount, pool, id: poolRequestId(pool), withdrawsFirst, resetsTimer, unlock, transactions, warnings }
  }

  /** The exact unstake transaction (with `withdraw_all` first when an unlocked balance waits); nothing is signed. */
  override async quoteRequestWithdrawal(options: NearUnstakeOptions): Promise<NearUnstakeQuote> {
    return this.planUnstake(options)
  }

  /** Unstakes `amount` (or `'all'`) from the pool; claim it with `claimWithdrawals` after 4 epochs (~21–28 h). */
  override async requestWithdrawal(options: NearUnstakeOptions): Promise<NearUnstakeResult> {
    const account = this.requireSigningAccount('requestWithdrawal')
    const quote = await this.planUnstake(options)
    this.checkExpected(options, quote.transactions)
    this.checkMaxFee(options, quote.fee)
    const { hashes, fee } = await this.send(account, quote.transactions, options)
    this.touched.add(quote.pool)
    return { ...quote, fee, hash: hashes[0]!, hashes, approveHash: null }
  }

  private async planClaim(o: NearClaimOptions = {}): Promise<NearClaimQuote> {
    const me = await this.me()
    const { positions, epoch } = await this.positionsDated(o?.pools)
    const candidates = positions.filter((p) => p.unstaked >= UNSTAKED_DUST)
    let chosen: NearPoolPosition[]
    if (o?.ids !== undefined) {
      if (!Array.isArray(o.ids)) throw new NearStakingError('unknown-request', '`ids` must be a list of request ids from getWithdrawalRequests.')
      const byId = new Map(candidates.map((p) => [poolRequestId(p.pool), p]))
      chosen = []
      for (const raw of new Set(o.ids.map((x) => BigInt(x)))) {
        const p = byId.get(raw)
        if (!p) throw new NearStakingError('unknown-request', `No pool holds an unstaked balance for request ${raw}.`, { details: { id: raw } })
        if (!p.canWithdraw) throw new NearStakingError('not-withdrawable', `${near(p.unstaked)} in ${p.pool} is still unbonding.`, { details: { pool: p.pool, unlock: p.unlock } })
        chosen.push(p)
      }
    } else {
      chosen = candidates.filter((p) => p.canWithdraw)
      if (chosen.length === 0) {
        const locked = candidates.map((p) => p.unlock).filter((u): u is UnlockEstimate => u !== null)
        const soonest = locked.sort((a, b) => (a.at ?? a.earliestAt) - (b.at ?? b.earliestAt))[0] ?? null
        throw new NearStakingError('nothing-to-claim', soonest ? 'Nothing is withdrawable yet: the unstaked NEAR is still unbonding.' : 'There is no unstaked NEAR to withdraw.', { details: { soonest, epoch } })
      }
    }
    chosen.sort((a, b) => {
      const x = poolRequestId(a.pool), y = poolRequestId(b.pool)
      return x < y ? -1 : x > y ? 1 : 0
    })
    await mapLimit(chosen, this.concurrency, (p) => this.exitCheck(p.pool))
    const transactions: NearTransaction[] = chosen.map((p) => ({ receiverId: p.pool, actions: [fc('withdraw_all', {}, this.gas.withdraw, 0n)] }))
    const [{ fee, upfront }, available] = await Promise.all([this.costs(transactions), this.available(me)])
    // Sent with one approval the transactions are accepted together; one by one, each one's refund
    // arrives before the next in the usual case, but the batch is what must fit.
    if (upfront > available) throw new InsufficientFundsError(upfront, available, 'NEAR')
    const claims = chosen.map((p) => ({ id: poolRequestId(p.pool), pool: p.pool, amount: p.unstaked }))
    return { fee, upfront, amount: claims.reduce((s, c) => s + c.amount, 0n), claims, transactions }
  }

  /** One `withdraw_all` per pool with an unlocked balance (all, or `ids`); nothing is signed. */
  override async quoteClaimWithdrawals(options: NearClaimOptions = {}): Promise<NearClaimQuote> {
    return this.planClaim(options)
  }

  /**
   * Withdraws unlocked balances: one `withdraw_all` per pool, with one approval when the account
   * can send several transactions at once, else in order. If one fails midway, the error carries
   * `sent` (the hashes that went out).
   */
  override async claimWithdrawals(options: NearClaimOptions = {}): Promise<NearClaimResult> {
    const account = this.requireSigningAccount('claimWithdrawals')
    const quote = await this.planClaim(options)
    this.checkExpected(options, quote.transactions)
    this.checkMaxFee(options, quote.fee)
    const { hashes, fee } = await this.send(account, quote.transactions, options)
    return { ...quote, fee, hash: hashes[0]!, hashes }
  }

  // ── Activity ───────────────────────────────────────────────────────────────

  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    const chain = this._account.chain
    const network = this.configuredNetwork ?? (chain === NEAR_MAINNET ? 'mainnet' : chain === NEAR_TESTNET ? 'testnet' : undefined)
    return describeNativeNearStakingActivity(tx, ctx, { ...(network ? { network } : {}), ...(this.pools !== 'any' ? { pools: this.pools } : {}) })
  }
}
