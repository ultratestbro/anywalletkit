import {
  NotImplementedError, StakingProtocol,
  type ActivityItem, type ChainTx, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly,
} from '@anywalletkit/core'
import type { NearRpc } from '@anywalletkit/wallet-near'
import { describeNativeNearStakingActivity } from './activity.js'
import { DEFAULT_CONCURRENCY, DEFAULT_GAS, DEFAULT_MAX_FEE, DEFAULT_RESERVE, NEAR_TESTNET } from './constants.js'
import { NearStakingError } from './errors.js'
import { factoryOf, normalizePools } from './pools.js'
import { resolveRpc } from './rpc.js'
import type {
  NativeStakingNearConfig, NearClaimOptions, NearClaimQuote, NearClaimResult, NearEpoch, NearNetwork, NearNetworkStats, NearPoolInfo,
  NearPoolPosition, NearStakedBalance, NearStakeOptions, NearStakeQuote, NearStakeResult, NearUnstakeOptions, NearUnstakeQuote,
  NearUnstakeResult, NearWithdrawalRequestsView, NormalizedPools,
} from './types.js'

/**
 * Native NEAR staking: `deposit_and_stake` into standard staking pools, unstake with the 4-epoch
 * unbonding, `withdraw_all` once unlocked. See NEAR-STAKING-API.md for the full contract.
 *
 * Fail-closed before anything is signed: the pool must be allowed (`pools` list or `'any'`), carry a
 * staking-pool factory suffix, run known staking-pool code, answer `is_staking_paused` with false,
 * charge at most `maxFee`, and sit in the current and next validator sets (unless `allowInactive`);
 * the stake leaves `reserve` + fee on the account; an unstake withdraws an unlocked balance first in
 * the same transaction so it is never locked again.
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

    this.reserve = BigInt(config.reserve ?? DEFAULT_RESERVE)
    if (this.reserve < 0n) throw new NearStakingError('invalid-config', 'reserve must not be negative.')
    this.gas = { ...DEFAULT_GAS, ...config.gas }
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
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

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The epoch clock (height, start, blocks left, measured epoch length, estimated end). */
  async getEpoch(): Promise<NearEpoch> { throw new NotImplementedError('getEpoch()') }

  /** Network stake, measured epoch length and gross APR (treasury excluded). */
  async getNetworkStats(): Promise<NearNetworkStats> { throw new NotImplementedError('getNetworkStats()') }

  /** Factory pools in the current or next validator set, by stake: light info from the `validators` RPC only (`details: false`). */
  async listPools(): Promise<NearPoolInfo[]> { throw new NotImplementedError('listPools()') }

  /** One pool with live checks (code hash, fee, pause, sets): what every write uses. Never cached. */
  async getPool(_id: string): Promise<NearPoolInfo> { throw new NotImplementedError('getPool(id)') }

  /** Several pools with live checks, concurrency-limited; cached for display (DISPLAY_TTL_MS). */
  async getPools(_ids: string[]): Promise<NearPoolInfo[]> { throw new NotImplementedError('getPools(ids)') }

  /** The account's position in every listed, discovered and passed pool with a non-zero balance. */
  async listPositions(_options: { pools?: string[] } = {}): Promise<NearPoolPosition[]> { throw new NotImplementedError('listPositions(options)') }

  /** What `stake` can send now: available − reserve − stake fee (never below 0). */
  async getMaxStakeable(): Promise<bigint> { throw new NotImplementedError('getMaxStakeable()') }

  /** Delegator APR in percent: of `pool`, else `defaultPool`, else the network average after a typical fee. */
  override async getApr(_options: { pool?: string } = {}): Promise<number> { throw new NotImplementedError('getApr(options)') }

  /** Staked across pools (`balance`), staked + unstaked (`total`), with the positions. */
  override async getStakedBalance(): Promise<NearStakedBalance> { throw new NotImplementedError('getStakedBalance()') }

  /** One request per pool holding an unstaked balance; ids are `poolRequestId(pool)`. */
  override async getWithdrawalRequests(_options: { pools?: string[] } = {}): Promise<NearWithdrawalRequestsView> { throw new NotImplementedError('getWithdrawalRequests(options)') }

  // ── Writes ─────────────────────────────────────────────────────────────────

  override async quoteStake(_options: NearStakeOptions): Promise<NearStakeQuote> { throw new NotImplementedError('quoteStake(options)') }

  override async stake(_options: NearStakeOptions): Promise<NearStakeResult> {
    this.requireSigningAccount('stake')
    throw new NotImplementedError('stake(options)')
  }

  override async quoteRequestWithdrawal(_options: NearUnstakeOptions): Promise<NearUnstakeQuote> { throw new NotImplementedError('quoteRequestWithdrawal(options)') }

  override async requestWithdrawal(_options: NearUnstakeOptions): Promise<NearUnstakeResult> {
    this.requireSigningAccount('requestWithdrawal')
    throw new NotImplementedError('requestWithdrawal(options)')
  }

  override async quoteClaimWithdrawals(_options: NearClaimOptions = {}): Promise<NearClaimQuote> { throw new NotImplementedError('quoteClaimWithdrawals(options)') }

  override async claimWithdrawals(_options: NearClaimOptions = {}): Promise<NearClaimResult> {
    this.requireSigningAccount('claimWithdrawals')
    throw new NotImplementedError('claimWithdrawals(options)')
  }

  // ── Activity ───────────────────────────────────────────────────────────────

  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return describeNativeNearStakingActivity(tx, ctx, { network: this.network, ...(this.pools !== 'any' ? { pools: this.pools } : {}) })
  }
}
