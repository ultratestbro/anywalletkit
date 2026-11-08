import {
  InsufficientFundsError, NetworkError, StakingProtocol, bigintToNumber,
  type ActivityItem, type ChainTx, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult, type WriteOptions,
} from '@anywalletkit/core'
import {
  NearRpc, NearRpcError, STORAGE_PRICE_PER_BYTE, createClient, toBase64, type NearAction, type NearTransaction,
} from '@anywalletkit/wallet-near'
import { describeLiquidNearStakingActivity } from './activity.js'
import {
  CONTRACT_MIN_RESERVE_BALANCE, DEFAULT_APR_WINDOW_EPOCHS, DEFAULT_ARCHIVAL_RPC, DEFAULT_GAS, DEFAULT_RESERVE, EPOCH_LENGTH, MIN_EPOCHS_TO_UNLOCK,
  MIN_STAKE, NEAR_MAINNET, NEAR_TESTNET, TGAS, UNSTAKED_DUST, YOCTO_PER_NEAR,
} from './constants.js'
import { blockAt, epochStartsAt, readEpoch, readEpochNumbers, type EpochNumbers } from './epoch.js'
import { LiquidStakingError } from './errors.js'
import { GasPricer, costOf, type GasCost, type GasPrices } from './fees.js'
import { aprFromPrices, nearForShares, sharesForNear, valueAtPrice } from './math.js'
import { poolRequestId, resolvePool, validatePoolConfig, type ResolvedLiquidPool } from './pool.js'
import { resolveRpc } from './rpc.js'
import { assertLiquidPlan, fc, sameTransactions } from './transactions.js'
import type {
  LiquidAccountDetails, LiquidClaimOptions, LiquidClaimQuote, LiquidClaimResult, LiquidPoolInfo, LiquidStakedBalance, LiquidStakeOptions,
  LiquidStakeQuote, LiquidStakeResult, LiquidStakingNearConfig, LiquidStakingWarning, LiquidUnstakeOptions, LiquidUnstakeQuote, LiquidUnstakeResult,
  LiquidWithdrawalRequest, LiquidWithdrawalRequestsView, NearEpoch, NearNetwork, UnlockEstimate,
} from './types.js'

/** How long the epoch numbers (one ~375 KB `validators` answer) are reused; they change only at epoch boundaries. */
const EPOCH_NUMBERS_TTL_MS = 60_000
/** How long the price-based APR is reused. */
const APR_TTL_MS = 10 * 60_000
/** Window of the APR fallback on the regular RPC when the archival one fails (regular nodes keep ~5 epochs). */
const APR_FALLBACK_EPOCHS = 2n
/** Heights tried after a skipped one for a past-block read. */
const SKIP_TRIES = 10
/** The protocol's gas cap per function call. */
const MAX_CALL_GAS = 300n * TGAS

/** The account's state in the contract plus what the writes need beside it. */
interface AccountState extends LiquidAccountDetails {
  /** `get_account_details.staked_balance`: what `unstake_all` moves, in NEAR. */
  stakedNear: bigint
}

const near = (yocto: bigint): string => {
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 5).replace(/0+$/, '')
  return `${yocto / YOCTO_PER_NEAR}${frac ? `.${frac}` : ''} NEAR`
}

/** A u128 decimal string (or a small JSON number, as u64 fields come) from a contract answer. */
function amountOf(v: unknown, what: string): bigint {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v)
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v)
  throw new NetworkError(`${what}: expected a non-negative integer, got ${String(JSON.stringify(v)).slice(0, 60)}`)
}

/** A bigint or a safe integer above zero, else 'invalid-amount'. */
function positiveAmount(v: unknown, unit: string): bigint {
  if (typeof v !== 'bigint' && !(typeof v === 'number' && Number.isSafeInteger(v))) {
    throw new LiquidStakingError('invalid-amount', `'amount' must be a bigint or a safe integer (${unit}).`)
  }
  const amount = BigInt(v)
  if (amount <= 0n) throw new LiquidStakingError('invalid-amount', "'amount' must be greater than zero.")
  return amount
}

/** The longest `unstake` argument (a u128), so the exit probe never undercounts gas. */
const MAX_U128_DIGITS = '9'.repeat(39)

/** A fresh copy, so an account that rewrites what it is handed cannot change the quote the app holds. */
const copyTx = (tx: NearTransaction): NearTransaction => ({
  receiverId: tx.receiverId,
  actions: tx.actions.map((a) => ('functionCall' in a ? { functionCall: { ...a.functionCall, args: { ...(a.functionCall.args as Record<string, unknown>) } } } : a)),
})

/**
 * Liquid NEAR staking through the LiNEAR contract family (LiNEAR, Rhea rNEAR): `deposit_and_stake`
 * mints the token, `unstake` starts the delayed exit (4+ epochs, exact epoch from the contract),
 * `withdraw_all` pays out once unlocked and the contract holds the NEAR. See the package README.
 *
 * Never builds `ft_transfer_call` or `ft_transfer` into the contract (it has no `ft_on_transfer`:
 * tokens sent that way are lost), and nothing but function calls to the pinned contract. Writes
 * refuse a paused contract or one whose code hash is not pinned. Every quote returns the exact
 * transactions; a write given `expected` refuses when its fresh plan differs.
 */
export class LiquidStakingProtocolNear extends StakingProtocol<LiquidStakingNearConfig> {
  readonly reserve: bigint
  readonly gas: { stake: bigint; unstake: bigint; withdraw: bigint }
  readonly aprWindowEpochs: number
  private readonly configuredNetwork: NearNetwork | undefined
  protected readonly rpc: NearRpc | undefined
  private archival: NearRpc | undefined
  private numbersCache: { at: number; value: Promise<EpochNumbers> } | undefined
  private readonly blockTimes = new Map<bigint, number>()
  private aprCache: { at: number; value: Promise<number> } | undefined
  private readonly pricer = new GasPricer(() => this.client())

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: LiquidStakingNearConfig) {
    super(account, config)
    if (!config || typeof config !== 'object') throw new LiquidStakingError('invalid-config', "LiquidStakingProtocolNear needs a config with `pool` ('linear', 'rnear' or a contract).")
    validatePoolConfig(config.pool)
    if (config.network !== undefined && config.network !== 'mainnet' && config.network !== 'testnet') {
      throw new LiquidStakingError('invalid-config', "network must be 'mainnet' or 'testnet'.")
    }
    this.configuredNetwork = config.network
    if (config.reserve !== undefined && typeof config.reserve !== 'bigint' && !(typeof config.reserve === 'number' && Number.isSafeInteger(config.reserve))) {
      throw new LiquidStakingError('invalid-config', 'reserve must be a bigint or a safe integer (yoctoNEAR).')
    }
    this.reserve = BigInt(config.reserve ?? DEFAULT_RESERVE)
    if (this.reserve < 0n) throw new LiquidStakingError('invalid-config', 'reserve must not be negative.')
    this.gas = { stake: config.gas?.stake ?? DEFAULT_GAS.stake, unstake: config.gas?.unstake ?? DEFAULT_GAS.unstake, withdraw: config.gas?.withdraw ?? DEFAULT_GAS.withdraw }
    for (const [k, g] of Object.entries(this.gas)) {
      if (typeof g !== 'bigint' || g <= 0n || g > MAX_CALL_GAS) throw new LiquidStakingError('invalid-config', `gas.${k} must be a bigint above 0 and at most 300 Tgas.`)
    }
    if (this.gas.withdraw + this.gas.unstake > MAX_CALL_GAS) throw new LiquidStakingError('invalid-config', 'gas.withdraw + gas.unstake must fit in one transaction (300 Tgas): an unstake may carry both.')
    this.aprWindowEpochs = config.aprWindowEpochs ?? DEFAULT_APR_WINDOW_EPOCHS
    if (!Number.isInteger(this.aprWindowEpochs) || this.aprWindowEpochs < 1) throw new LiquidStakingError('invalid-config', 'aprWindowEpochs must be a positive integer.')
    if (config.apr !== undefined && typeof config.apr !== 'function') throw new LiquidStakingError('invalid-config', 'apr must be a function returning the APR in percent.')
    this.rpc = resolveRpc(account, config)
  }

  /** The configured network, else the account's (`near:testnet` → testnet, anything else → mainnet). */
  get network(): NearNetwork {
    return this.configuredNetwork ?? (this._account.chain === NEAR_TESTNET ? 'testnet' : 'mainnet')
  }

  /** Contract, symbol and pinned code hashes on the current network (throws 'unsupported-network'). */
  get pool(): ResolvedLiquidPool {
    return resolvePool(this._config.pool, this.network)
  }

  // ── Plumbing ───────────────────────────────────────────────────────────────

  private client(): NearRpc {
    if (!this.rpc) throw new LiquidStakingError('no-provider', 'LiquidStakingProtocolNear needs a NEAR RPC: pass `provider`, or a wallet-near account configured with one.')
    return this.rpc
  }

  private archivalClient(): NearRpc {
    if (!this.archival) {
      const fetch = createClient({
        provider: this._config.archivalProvider ?? DEFAULT_ARCHIVAL_RPC[this.network],
        ...(this._config.timeoutMs !== undefined ? { timeoutMs: this._config.timeoutMs } : {}),
      })
      if (!fetch) throw new LiquidStakingError('no-provider', 'No archival RPC for the APR estimate: pass `archivalProvider` or an `apr` hook.')
      this.archival = new NearRpc(fetch)
    }
    return this.archival
  }

  /** The account id, after checking the account is on the module's NEAR network. */
  private async me(): Promise<string> {
    const want = this.network === 'testnet' ? NEAR_TESTNET : NEAR_MAINNET
    if (this._account.chain !== want) throw new LiquidStakingError('wrong-chain', `LiquidStakingProtocolNear works on ${want}; the account is on ${this._account.chain}.`)
    return await this._account.getAddress()
  }

  private view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
    return this.client().callFunction<T>(this.pool.contract, method, args)
  }

  private epochNumbers(): Promise<EpochNumbers> {
    const hit = this.numbersCache
    if (hit && Date.now() - hit.at < EPOCH_NUMBERS_TTL_MS) return hit.value
    const value = readEpochNumbers(this.client())
    this.numbersCache = { at: Date.now(), value }
    value.catch(() => { if (this.numbersCache?.value === value) this.numbersCache = undefined })
    return value
  }

  /** Spendable NEAR of the account: amount − locked − storage, never below 0 (0 for an account that does not exist yet). */
  private async available(me: string): Promise<bigint> {
    const v = await this.client().viewAccount(me)
    if (!v) return 0n
    const free = amountOf(v.amount, 'view_account.amount') - amountOf(v.locked, 'view_account.locked') - amountOf(v.storage_usage, 'view_account.storage_usage') * STORAGE_PRICE_PER_BYTE
    return free > 0n ? free : 0n
  }

  /** Fee (upper bound) and upfront charge of the transactions at the current prices (see fees.ts). */
  private async costs(transactions: NearTransaction[]): Promise<GasCost & { prices: GasPrices }> {
    const prices = await this.pricer.prices()
    return { ...costOf(transactions, prices), prices }
  }

  /** What `stake` leaves on the account: `reserve`, but never less than the upfront gas of the exit it will need. */
  private reserveAt(prices: GasPrices): bigint {
    const gas = this.gas.unstake > this.gas.withdraw ? this.gas.unstake : this.gas.withdraw
    const exit = costOf([{ receiverId: this.pool.contract, actions: [fc('unstake', { amount: MAX_U128_DIGITS }, gas, 0n)] }], prices).upfront
    return exit > this.reserve ? exit : this.reserve
  }

  private tx(actions: NearAction[]): NearTransaction {
    const tx = { receiverId: this.pool.contract, actions }
    assertLiquidPlan([tx], this.pool.contract)
    return tx
  }

  private assertWritable(info: LiquidPoolInfo): void {
    if (!info.codeHashKnown) {
      throw new LiquidStakingError('unknown-contract-code', `${info.contract} runs code ${info.codeHash || '(none)'}, which is not pinned. A contract upgrade needs a new pin before the module writes to it again.`, { details: { codeHash: info.codeHash, pinned: [...this.pool.codeHashes] } })
    }
    if (info.paused) throw new LiquidStakingError('contract-paused', `${info.name} (${info.contract}) is paused: it rejects every call until it resumes.`)
  }

  private async readAccount(me: string, price: bigint): Promise<AccountState> {
    const [balance, details, storage] = await Promise.all([
      this.view<unknown>('ft_balance_of', { account_id: me }),
      this.view<Record<string, unknown> | null>('get_account_details', { account_id: me }),
      this.view<unknown>('storage_balance_of', { account_id: me }),
    ])
    if (!details || typeof details !== 'object') throw new NetworkError(`${this.pool.contract}.get_account_details: no account details in the answer`)
    if (typeof details.can_withdraw !== 'boolean') throw new NetworkError(`${this.pool.contract}.get_account_details: can_withdraw is not a boolean`)
    const shares = amountOf(balance, 'ft_balance_of')
    return {
      shares,
      value: valueAtPrice(shares, price),
      unstaked: amountOf(details.unstaked_balance, 'get_account_details.unstaked_balance'),
      unlockEpoch: amountOf(details.unstaked_available_epoch_height, 'get_account_details.unstaked_available_epoch_height'),
      canWithdraw: details.can_withdraw,
      registered: storage !== null && storage !== undefined,
      stakedNear: amountOf(details.staked_balance, 'get_account_details.staked_balance'),
    }
  }

  private contractUnlock(epoch: NearEpoch, unlockEpoch: bigint): UnlockEstimate {
    const at = epochStartsAt(epoch, unlockEpoch)
    return { epoch: unlockEpoch, earliestEpoch: unlockEpoch, latestEpoch: unlockEpoch, at, earliestAt: at, latestAt: at, source: 'contract' }
  }

  /**
   * The contract can pay `amount` now: its liquid balance minus what it must keep covers it. It
   * keeps 1 NEAR itself, and the runtime refuses a receipt that leaves it below its storage cost
   * (the whole transaction would fail, on every retry).
   */
  private static payable(info: LiquidPoolInfo, amount: bigint): boolean {
    return info.liquidity - info.kept >= amount
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The epoch clock: height, start, measured duration (~6.9 h on mainnet), estimated end. */
  async getEpoch(): Promise<NearEpoch> {
    return readEpoch(this.client(), { numbers: () => this.epochNumbers(), blockTimes: this.blockTimes })
  }

  /** Contract state: price, totals, pause flag, live code hash, liquidity, fee. Read fresh every time. */
  async getPoolInfo(): Promise<LiquidPoolInfo> {
    const pool = this.pool
    const rpc = this.client()
    const [meta, summary, paused, account, beneficiaries] = await Promise.all([
      this.view<{ symbol?: unknown; decimals?: unknown } | null>('ft_metadata'),
      this.view<Record<string, unknown> | null>('get_summary'),
      // A contract answer other than `false` (a missing method, a panic, a non-boolean) counts as paused; a transport failure is thrown.
      this.view<unknown>('is_paused').then((v) => v !== false, (e: unknown) => {
        if (e instanceof NearRpcError) return true
        throw e
      }),
      rpc.viewAccount(pool.contract),
      this.view<Record<string, unknown> | null>('get_beneficiaries').catch((e: unknown) => {
        if (e instanceof NearRpcError) return null
        throw e
      }),
    ])
    if (!summary || typeof summary !== 'object') throw new NetworkError(`${pool.contract}.get_summary: no summary in the answer`)
    if (meta?.decimals !== 24) throw new NetworkError(`${pool.contract}.ft_metadata: expected 24 decimals, got ${String(meta?.decimals)}`)
    let feeBps = 0
    for (const bps of Object.values(beneficiaries ?? {})) if (typeof bps === 'number' && Number.isInteger(bps) && bps >= 0) feeBps += bps
    const codeHash = typeof account?.code_hash === 'string' ? account.code_hash : ''
    const storageCost = account ? amountOf(account.storage_usage, 'view_account.storage_usage') * STORAGE_PRICE_PER_BYTE : 0n
    return {
      contract: pool.contract,
      symbol: typeof meta.symbol === 'string' ? meta.symbol : pool.symbol,
      name: pool.name,
      decimals: 24,
      price: amountOf(summary.ft_price, 'get_summary.ft_price'),
      totalStaked: amountOf(summary.total_staked_near_amount, 'get_summary.total_staked_near_amount'),
      totalShares: amountOf(summary.total_share_amount, 'get_summary.total_share_amount'),
      validators: typeof summary.validators_num === 'number' ? summary.validators_num : 0,
      paused,
      codeHash,
      codeHashKnown: codeHash !== '' && pool.codeHashes.includes(codeHash),
      liquidity: account ? amountOf(account.amount, 'view_account.amount') : 0n,
      kept: storageCost > CONTRACT_MIN_RESERVE_BALANCE ? storageCost : CONTRACT_MIN_RESERVE_BALANCE,
      feeBps,
    }
  }

  /** The account in the contract: tokens, their NEAR value, unstaked NEAR, exact unlock epoch, registration. */
  async getAccountDetails(): Promise<LiquidAccountDetails> {
    const me = await this.me()
    const price = amountOf(await this.view<unknown>('ft_price'), 'ft_price')
    const a = await this.readAccount(me, price)
    return { shares: a.shares, value: a.value, unstaked: a.unstaked, unlockEpoch: a.unlockEpoch, canWithdraw: a.canWithdraw, registered: a.registered }
  }

  /** What `stake` can send now: available − reserve − the stake's upfront gas (never below 0). */
  async getMaxStakeable(): Promise<bigint> {
    const me = await this.me()
    const [available, cost] = await Promise.all([this.available(me), this.costs([this.tx([fc('deposit_and_stake', {}, this.gas.stake, MIN_STAKE)])])])
    return LiquidStakingProtocolNear.maxStakeable(available, this.reserveAt(cost.prices), cost.upfront)
  }

  private static maxStakeable(available: bigint, reserve: bigint, upfront: bigint): bigint {
    const max = available - reserve - upfront
    return max > 0n ? max : 0n
  }

  /**
   * APR in percent: the `apr` hook, else the token price's growth over `aprWindowEpochs` (default 24,
   * ~7 days), annualized by the two blocks' timestamps. The past price comes from the archival RPC;
   * when that fails, from a 2-epoch window on the regular RPC. Cached for 10 minutes.
   */
  override async getApr(): Promise<number> {
    if (this._config.apr) return await this._config.apr()
    const hit = this.aprCache
    if (hit && Date.now() - hit.at < APR_TTL_MS) return await hit.value
    const value = this.priceApr()
    this.aprCache = { at: Date.now(), value }
    value.catch(() => { if (this.aprCache?.value === value) this.aprCache = undefined })
    return await value
  }

  private async priceApr(): Promise<number> {
    const rpc = this.client()
    const now = await this.priceAt(rpc)
    try {
      const past = await this.priceAt(this.archivalClient(), now.height - BigInt(this.aprWindowEpochs) * EPOCH_LENGTH)
      return aprFromPrices(past.price, now.price, past.ms, now.ms)
    } catch (archivalError) {
      try {
        const past = await this.priceAt(rpc, now.height - APR_FALLBACK_EPOCHS * EPOCH_LENGTH)
        return aprFromPrices(past.price, now.price, past.ms, now.ms)
      } catch {
        throw archivalError
      }
    }
  }

  /** `ft_price` at a height (the next produced block when it was skipped), or at the final block, with that block's time. */
  private async priceAt(rpc: NearRpc, height?: bigint): Promise<{ price: bigint; height: bigint; ms: number }> {
    const contract = this.pool.contract
    const args = toBase64(new TextEncoder().encode('{}'))
    const query = async (blockRef: Record<string, unknown>) => {
      const r = (await rpc.fetch('query', { request_type: 'call_function', account_id: contract, method_name: 'ft_price', args_base64: args, ...blockRef })) as { result?: number[]; error?: string; block_height?: number } | null
      if (!r || r.error || !Array.isArray(r.result) || typeof r.block_height !== 'number') throw new NetworkError(`${contract}.ft_price: no result${r?.error ? ` (${r.error})` : ''}`)
      return { price: amountOf(JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result))), 'ft_price'), height: BigInt(r.block_height) }
    }
    let read: { price: bigint; height: bigint } | undefined
    if (height === undefined) read = await query({ finality: 'final' })
    else {
      let last: unknown
      for (let i = 0n; i <= BigInt(SKIP_TRIES) && !read; i++) {
        try {
          read = await query({ block_id: bigintToNumber(height + i) })
        } catch (e) {
          // Only a skipped height moves on.
          if (!(e instanceof NearRpcError) || !/UNKNOWN_BLOCK/i.test(e.errorName ?? '')) throw e
          last = e
        }
      }
      if (!read) throw last
    }
    const known = this.blockTimes.get(read.height)
    const ms = known ?? (await blockAt(rpc, read.height)).ms
    this.blockTimes.set(read.height, ms)
    return { ...read, ms }
  }

  /**
   * The position, Tonstakers-style: `balance` = tokens held, `rate` = price (yoctoNEAR per token,
   * 10^24 = 1:1), `total` = their NEAR value; `unstaked` and `withdrawable` (unlocked and payable
   * from the contract's liquid balance now) beside.
   */
  override async getStakedBalance(): Promise<LiquidStakedBalance> {
    const me = await this.me()
    const info = await this.getPoolInfo()
    const a = await this.readAccount(me, info.price)
    const unstaked = a.unstaked > UNSTAKED_DUST ? a.unstaked : 0n
    const withdrawable = unstaked > 0n && a.canWithdraw && LiquidStakingProtocolNear.payable(info, unstaked) ? unstaked : 0n
    return { balance: a.shares, wrappedBalance: 0n, rate: info.price, total: a.value, unstaked, withdrawable, price: info.price }
  }

  /**
   * The account's unstaked NEAR as one request (a contract keeps one unstaked balance per account):
   * id `poolRequestId(contract)`, `unlockEpoch` exact from the contract. `claimable` needs the epoch
   * reached and the contract's liquid balance to cover it (`awaitingLiquidity` otherwise).
   * `timestamp` is 0: the contract does not keep the unstake time.
   */
  override async getWithdrawalRequests(): Promise<LiquidWithdrawalRequestsView> {
    const me = await this.me()
    const info = await this.getPoolInfo()
    const a = await this.readAccount(me, info.price)
    if (a.unstaked <= UNSTAKED_DUST) return { requests: [], pendingAmount: 0n, claimableAmount: 0n, claimableIds: [] }
    const awaitingLiquidity = a.canWithdraw && !LiquidStakingProtocolNear.payable(info, a.unstaked)
    const claimable = a.canWithdraw && !awaitingLiquidity
    const id = poolRequestId(info.contract)
    const request: LiquidWithdrawalRequest = {
      id, amount: a.unstaked, timestamp: 0, claimable, contract: info.contract, unlockEpoch: a.unlockEpoch, awaitingLiquidity,
      unlock: claimable ? null : this.contractUnlock(await this.getEpoch(), a.unlockEpoch),
    }
    return {
      requests: [request],
      pendingAmount: claimable ? 0n : a.unstaked,
      claimableAmount: claimable ? a.unstaked : 0n,
      claimableIds: claimable ? [id] : [],
    }
  }

  // ── Writes ─────────────────────────────────────────────────────────────────

  /** Plans with fresh reads, compares with `expected`, then sends each transaction in order. */
  private async send<Q extends { transactions: NearTransaction[]; fee: bigint }>(
    method: string, plan: () => Promise<Q>, o: { expected?: NearTransaction[]; maxFee?: bigint } | undefined,
  ): Promise<Q & { fee: bigint; hash: string; hashes: string[] }> {
    const account = this.requireSigningAccount(method)
    const quote = await plan()
    assertLiquidPlan(quote.transactions, this.pool.contract)
    if (o?.expected !== undefined && !sameTransactions(o.expected, quote.transactions)) {
      throw new LiquidStakingError('quote-changed', 'The transactions changed since the quote (the contract or the account moved on): review the new ones and confirm again.', { details: { transactions: quote.transactions } })
    }
    // The module checks maxFee itself: wallet-selector adapters ignore it.
    if (o?.maxFee !== undefined && quote.fee > BigInt(o.maxFee)) {
      throw new LiquidStakingError('max-fee-exceeded', `The network fee may reach ${near(quote.fee)}, above the maximum of ${near(BigInt(o.maxFee))} for this write.`, { details: { fee: quote.fee, maxFee: BigInt(o.maxFee) } })
    }
    const options: WriteOptions | undefined = o?.maxFee !== undefined ? { maxFee: o.maxFee } : undefined
    const hashes: string[] = []
    let fee = 0n
    for (const tx of quote.transactions) {
      let r: TransferResult
      try {
        r = await account.sendTransaction(copyTx(tx), options)
      } catch (e) {
        throw Object.assign(e instanceof Error ? e : new Error(String(e)), { sent: [...hashes] })
      }
      hashes.push(r.hash)
      fee += BigInt(r.fee ?? 0)
    }
    return { ...quote, fee, hash: hashes[0]!, hashes }
  }

  private async planStake(o: LiquidStakeOptions): Promise<LiquidStakeQuote> {
    const amount = positiveAmount(o?.amount, 'yoctoNEAR')
    if (amount < MIN_STAKE) throw new LiquidStakingError('below-minimum', `A stake must be at least ${near(MIN_STAKE)}.`)
    const me = await this.me()
    const info = await this.getPoolInfo()
    this.assertWritable(info)
    // deposit_and_stake creates the account's entry in the contract (real deposits on both contracts
    // carry no storage_deposit); NEP-145 registration only matters for receiving the token by transfer.
    const transactions = [this.tx([fc('deposit_and_stake', {}, this.gas.stake, amount)])]
    const [available, { fee, upfront, prices }, apr] = await Promise.all([this.available(me), this.costs(transactions), this.getApr().catch(() => null)])
    const reserve = this.reserveAt(prices)
    const required = amount + upfront + reserve
    if (required > available) throw new InsufficientFundsError(required, available, 'NEAR')
    return {
      fee, upfront, reserve, amount, shares: sharesForNear(amount, info), price: info.price, apr,
      maxStakeable: LiquidStakingProtocolNear.maxStakeable(available, reserve, upfront), transactions, warnings: [],
    }
  }

  /** The stake's transaction, fee, tokens expected and APR; nothing is signed. */
  override async quoteStake(options: LiquidStakeOptions): Promise<LiquidStakeQuote> {
    return this.planStake(options)
  }

  /**
   * Stakes exactly `amount` yoctoNEAR (`deposit_and_stake`) for the token. There is no "stake
   * everything": pass the amount (at most `getMaxStakeable()`).
   */
  override async stake(options: LiquidStakeOptions): Promise<LiquidStakeResult> {
    return this.send('stake', () => this.planStake(options), options)
  }

  private async planUnstake(o: LiquidUnstakeOptions): Promise<LiquidUnstakeQuote> {
    const requested = o?.amount === 'all' ? 'all' : positiveAmount(o?.amount, 'token base units')
    const me = await this.me()
    const info = await this.getPoolInfo()
    this.assertWritable(info)
    const [a, epoch] = await Promise.all([this.readAccount(me, info.price), this.getEpoch()])
    if (a.shares === 0n) throw new LiquidStakingError('nothing-staked', `${me} holds no ${info.symbol}.`)
    if (requested !== 'all' && requested > a.shares) {
      throw new LiquidStakingError('exceeds-balance', `Asked to unstake ${requested} ${info.symbol} base units; the balance is ${a.shares}.`, { details: { balance: a.shares } })
    }
    const all = requested === 'all' || requested === a.shares
    const shares = all ? a.shares : requested
    // The contract takes NEAR, not tokens. This value burns at most `shares` (the contract rounds the burnt shares up from it).
    const amount = all ? a.stakedNear : nearForShares(shares, info)
    if (amount === 0n) throw new LiquidStakingError('below-minimum', `${shares} ${info.symbol} base units are worth less than 1 yoctoNEAR.`)
    const unstake = all ? fc('unstake_all', {}, this.gas.unstake, 0n) : fc('unstake', { amount: String(amount) }, this.gas.unstake, 0n)

    const warnings: LiquidStakingWarning[] = []
    const actions: NearAction[] = []
    let withdrawsFirst = 0n, relocks = 0n, resetsTimer = false
    if (a.unstaked > UNSTAKED_DUST && a.canWithdraw) {
      if (LiquidStakingProtocolNear.payable(info, a.unstaked)) {
        // A new unstake sets the unlock epoch of the whole unstaked balance: withdraw the unlocked part first.
        actions.push(fc('withdraw_all', {}, this.gas.withdraw, 0n))
        withdrawsFirst = a.unstaked
        warnings.push({ code: 'withdraws-unlocked-first', message: `${near(a.unstaked)} already unlocked is withdrawn to the account in the same transaction, so the new unstake does not lock it again.` })
      } else if (!o.allowRelock || amount < MIN_STAKE) {
        throw new LiquidStakingError('relock-refused', `${near(a.unstaked)} is unlocked, but ${info.name} cannot pay it out yet (it is waiting for its payout). A new unstake now would lock it again for 4+ epochs: claim it first${amount < MIN_STAKE ? '' : ', or pass allowRelock'}.`, { details: { unstaked: a.unstaked, liquidity: info.liquidity, kept: info.kept } })
      } else {
        relocks = a.unstaked
        warnings.push({ code: 'relocks-unlocked', message: `${near(a.unstaked)} already unlocked locks again with this unstake (the contract cannot pay it out yet): the whole unstaked balance waits 4+ more epochs.` })
      }
    } else if (a.unstaked > UNSTAKED_DUST) {
      // The contract keeps one unlock epoch per account: this unstake moves it for everything already unbonding.
      if (amount < MIN_STAKE || !o.allowTimerReset) {
        throw new LiquidStakingError('timer-reset-refused', `${near(a.unstaked)} is still unbonding (unlocks at epoch ${a.unlockEpoch}). A new unstake restarts the wait for the whole unstaked balance: 4+ epochs from now${amount < MIN_STAKE ? '' : '. Wait until it unlocks and claim it, or pass allowTimerReset'}.`, { details: { unstaked: a.unstaked, unlockEpoch: a.unlockEpoch, amount } })
      }
      resetsTimer = true
      warnings.push({ code: 'resets-unbonding-timer', message: `${near(a.unstaked)} is already unstaking (unlocks at epoch ${a.unlockEpoch}). A new unstake restarts the wait for the whole unstaked balance: 4+ epochs from now.` })
    }
    actions.push(unstake)
    warnings.push({ code: 'unlock-may-be-later', message: 'Unstaking takes 4 or more epochs (~6.9 h each, about 21–35 h or more): the contract may add epochs for large amounts or after its epoch settlement. The exact epoch is known after the unstake.' })

    const transactions = [this.tx(actions)]
    const [{ fee, upfront }, available] = await Promise.all([this.costs(transactions), this.available(me)])
    if (upfront > available) throw new InsufficientFundsError(upfront, available, 'NEAR')
    const earliestEpoch = epoch.height + MIN_EPOCHS_TO_UNLOCK
    return {
      fee, upfront, shares, amount, id: poolRequestId(info.contract), withdrawsFirst, resetsTimer, relocks,
      unlock: { epoch: null, earliestEpoch, latestEpoch: null, at: null, earliestAt: epochStartsAt(epoch, earliestEpoch), latestAt: null, source: 'estimate' },
      transactions, warnings,
    }
  }

  /** The unstake's transaction, fee and unlock estimate; nothing is signed. `amount` is in token base units. */
  override async quoteRequestWithdrawal(options: LiquidUnstakeOptions): Promise<LiquidUnstakeQuote> {
    return this.planUnstake(options)
  }

  /**
   * Unstakes `amount` token base units (`unstake` with their NEAR value), or `'all'` (`unstake_all`).
   * An unlocked balance is withdrawn in the same transaction first. Once it is final,
   * `getAccountDetails().unlockEpoch` is the exact epoch the NEAR unlocks at; reads use final blocks,
   * so right after the send they still show the previous one (show the result's `unlock` meanwhile).
   */
  override async requestWithdrawal(options: LiquidUnstakeOptions): Promise<LiquidUnstakeResult> {
    return { ...(await this.send('requestWithdrawal', () => this.planUnstake(options), options)), approveHash: null }
  }

  private async planClaim(o: LiquidClaimOptions = {}): Promise<LiquidClaimQuote> {
    const me = await this.me()
    const info = await this.getPoolInfo()
    this.assertWritable(info)
    const a = await this.readAccount(me, info.price)
    const id = poolRequestId(info.contract)
    if (o.ids !== undefined) {
      if (!Array.isArray(o.ids)) throw new LiquidStakingError('unknown-request', '`ids` must be a list of request ids.')
      const ids = [...new Set(o.ids.map((x) => BigInt(x)))]
      const unknown = ids.filter((x) => x !== id)
      if (unknown.length > 0) throw new LiquidStakingError('unknown-request', `Unknown request id ${unknown.join(', ')}: ${info.contract} keeps one request per account, id ${id}.`, { details: { ids: unknown } })
      if (ids.length === 0) throw new LiquidStakingError('nothing-to-claim', 'No request ids were given.')
    }
    if (a.unstaked <= UNSTAKED_DUST) throw new LiquidStakingError('nothing-to-claim', `${me} has no unstaked NEAR in ${info.contract}.`)
    if (!a.canWithdraw) {
      const unlock = this.contractUnlock(await this.getEpoch(), a.unlockEpoch)
      throw new LiquidStakingError('not-withdrawable', `${near(a.unstaked)} unlocks at epoch ${a.unlockEpoch}.`, { details: { unlock, amount: a.unstaked } })
    }
    if (!LiquidStakingProtocolNear.payable(info, a.unstaked)) {
      throw new LiquidStakingError('awaiting-liquidity', `${near(a.unstaked)} is unlocked; ${info.name} is waiting for its payout from the validators before it can pay it (it holds ${near(info.liquidity)} and keeps ${near(info.kept)} for its own storage).`, { details: { amount: a.unstaked, liquidity: info.liquidity, kept: info.kept } })
    }
    const transactions = [this.tx([fc('withdraw_all', {}, this.gas.withdraw, 0n)])]
    const [{ fee, upfront }, available] = await Promise.all([this.costs(transactions), this.available(me)])
    if (upfront > available) throw new InsufficientFundsError(upfront, available, 'NEAR')
    return { fee, upfront, amount: a.unstaked, transactions }
  }

  /** The claim's transaction (`withdraw_all`) and fee; nothing is signed. */
  override async quoteClaimWithdrawals(options: LiquidClaimOptions = {}): Promise<LiquidClaimQuote> {
    return this.planClaim(options)
  }

  /** Withdraws the unstaked NEAR (`withdraw_all`) once unlocked and payable. */
  override async claimWithdrawals(options: LiquidClaimOptions = {}): Promise<LiquidClaimResult> {
    return this.send('claimWithdrawals', () => this.planClaim(options), options)
  }

  // ── Activity ───────────────────────────────────────────────────────────────

  /** Labels LiNEAR-family staking transactions offline; see `activity.ts`. */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    const pool = typeof this._config.pool === 'string' ? undefined : this._config.pool
    return describeLiquidNearStakingActivity(tx, ctx, pool ? { contracts: [{ contract: pool.contract, symbol: pool.symbol, ...(pool.name ? { name: pool.name } : {}) }] } : {})
  }
}
