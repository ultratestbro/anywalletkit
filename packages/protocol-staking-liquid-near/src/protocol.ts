import {
  NotImplementedError, StakingProtocol,
  type ActivityItem, type ChainTx, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly,
} from '@anywalletkit/core'
import type { NearRpc } from '@anywalletkit/wallet-near'
import { describeLiquidNearStakingActivity } from './activity.js'
import { DEFAULT_APR_WINDOW_EPOCHS, DEFAULT_GAS, DEFAULT_RESERVE, NEAR_TESTNET } from './constants.js'
import { LiquidStakingError } from './errors.js'
import { resolvePool, validatePoolConfig, type ResolvedLiquidPool } from './pool.js'
import { resolveRpc } from './rpc.js'
import type {
  LiquidAccountDetails, LiquidClaimOptions, LiquidClaimQuote, LiquidClaimResult, LiquidPoolInfo, LiquidStakedBalance,
  LiquidStakeOptions, LiquidStakeQuote, LiquidStakeResult, LiquidStakingNearConfig, LiquidUnstakeOptions, LiquidUnstakeQuote,
  LiquidUnstakeResult, LiquidWithdrawalRequestsView, NearEpoch, NearNetwork,
} from './types.js'

/**
 * Liquid NEAR staking through the LiNEAR contract family (LiNEAR, Rhea rNEAR): `deposit_and_stake`
 * mints the token, `unstake` starts the delayed exit (4+ epochs, exact epoch from the contract),
 * `withdraw_all` pays out once unlocked and the contract holds the NEAR. See NEAR-STAKING-API.md.
 *
 * Never builds `ft_transfer_call` into the contract (it has no `ft_on_transfer`: tokens sent that way
 * are lost). Writes refuse a paused contract or one whose code hash is not pinned.
 */
export class LiquidStakingProtocolNear extends StakingProtocol<LiquidStakingNearConfig> {
  readonly reserve: bigint
  readonly gas: { stake: bigint; unstake: bigint; withdraw: bigint; storage: bigint }
  readonly aprWindowEpochs: number
  private readonly configuredNetwork: NearNetwork | undefined
  protected readonly rpc: NearRpc | undefined

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: LiquidStakingNearConfig) {
    super(account, config)
    if (!config || typeof config !== 'object') throw new LiquidStakingError('invalid-config', "LiquidStakingProtocolNear needs a config with `pool` ('linear', 'rnear' or a contract).")
    validatePoolConfig(config.pool)
    if (config.network !== undefined && config.network !== 'mainnet' && config.network !== 'testnet') {
      throw new LiquidStakingError('invalid-config', "network must be 'mainnet' or 'testnet'.")
    }
    this.configuredNetwork = config.network
    this.reserve = BigInt(config.reserve ?? DEFAULT_RESERVE)
    if (this.reserve < 0n) throw new LiquidStakingError('invalid-config', 'reserve must not be negative.')
    this.gas = { ...DEFAULT_GAS, ...config.gas }
    this.aprWindowEpochs = config.aprWindowEpochs ?? DEFAULT_APR_WINDOW_EPOCHS
    if (!Number.isInteger(this.aprWindowEpochs) || this.aprWindowEpochs < 1) throw new LiquidStakingError('invalid-config', 'aprWindowEpochs must be a positive integer.')
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

  // ── Reads ──────────────────────────────────────────────────────────────────

  async getEpoch(): Promise<NearEpoch> { throw new NotImplementedError('getEpoch()') }
  /** Contract state: price, totals, pause flag, live code hash, liquidity, fee. */
  async getPoolInfo(): Promise<LiquidPoolInfo> { throw new NotImplementedError('getPoolInfo()') }
  /** The account in the contract: tokens, unstaked NEAR, exact unlock epoch, registration. */
  async getAccountDetails(): Promise<LiquidAccountDetails> { throw new NotImplementedError('getAccountDetails()') }
  /** What `stake` can send now: available − reserve − fee − storage registration if needed (never below 0). */
  async getMaxStakeable(): Promise<bigint> { throw new NotImplementedError('getMaxStakeable()') }
  /** APR in percent: the `apr` hook, else the price change over `aprWindowEpochs` (archival RPC), annualized. */
  override async getApr(): Promise<number> { throw new NotImplementedError('getApr()') }
  override async getStakedBalance(): Promise<LiquidStakedBalance> { throw new NotImplementedError('getStakedBalance()') }
  /** One request (id `poolRequestId(contract)`) when the account has unstaked NEAR in the contract. */
  override async getWithdrawalRequests(): Promise<LiquidWithdrawalRequestsView> { throw new NotImplementedError('getWithdrawalRequests()') }

  // ── Writes ─────────────────────────────────────────────────────────────────

  override async quoteStake(_options: LiquidStakeOptions): Promise<LiquidStakeQuote> { throw new NotImplementedError('quoteStake(options)') }

  override async stake(_options: LiquidStakeOptions): Promise<LiquidStakeResult> {
    this.requireSigningAccount('stake')
    throw new NotImplementedError('stake(options)')
  }

  override async quoteRequestWithdrawal(_options: LiquidUnstakeOptions): Promise<LiquidUnstakeQuote> { throw new NotImplementedError('quoteRequestWithdrawal(options)') }

  override async requestWithdrawal(_options: LiquidUnstakeOptions): Promise<LiquidUnstakeResult> {
    this.requireSigningAccount('requestWithdrawal')
    throw new NotImplementedError('requestWithdrawal(options)')
  }

  override async quoteClaimWithdrawals(_options: LiquidClaimOptions = {}): Promise<LiquidClaimQuote> { throw new NotImplementedError('quoteClaimWithdrawals(options)') }

  override async claimWithdrawals(_options: LiquidClaimOptions = {}): Promise<LiquidClaimResult> {
    this.requireSigningAccount('claimWithdrawals')
    throw new NotImplementedError('claimWithdrawals(options)')
  }

  // ── Activity ───────────────────────────────────────────────────────────────

  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    const pool = typeof this._config.pool === 'string' ? undefined : this._config.pool
    return describeLiquidNearStakingActivity(tx, ctx, pool ? { contracts: [{ contract: pool.contract, symbol: pool.symbol, ...(pool.name ? { name: pool.name } : {}) }] } : {})
  }
}
