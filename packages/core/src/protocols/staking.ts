// Our own protocol type (first shipped in the Lido / SSV / Tonstakers / Jito
// modules). Staking is not lending: unstaking is a TWO-PHASE exchange — a
// request enters a queue, finalizes out of band, and only then can be claimed.
// The interface names the queue instead of pretending `withdraw()` returns money.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

/** How much native coin to stake, in base units. */
export interface StakeOptions { amount: bigint | number }
/** The stake transaction and the fee it paid. */
export interface StakeResult { hash: string; fee: bigint }

/** How much staked token to put in the withdrawal queue. */
export interface WithdrawalRequestOptions {
  amount: bigint | number
  /** Which staked-token form to withdraw (e.g. "stETH" | "wstETH"). Defaults to the primary one. */
  token?: string
}
/** The withdrawal-request transaction. */
export interface WithdrawalRequestResult {
  hash: string
  /** Total gas, including a prior approval if the two-transaction fallback ran. */
  fee: bigint
  /** Hash of the approval sent first, or `null` when none was needed. */
  approveHash: string | null
}

/** One request in the protocol's withdrawal queue. */
export interface WithdrawalRequest {
  /** Request id, as the claim call takes it. */
  id: bigint
  /** Amount requested, base units. */
  amount: bigint
  /** Unix seconds. */
  timestamp: number
  /** Finalized and ready to claim. */
  claimable: boolean
}
/** The account's open withdrawal requests and what can be claimed now. */
export interface WithdrawalRequestsView {
  /** Open (unclaimed) requests, newest first. */
  requests: WithdrawalRequest[]
  /** Total still waiting to finalize. */
  pendingAmount: bigint
  /** Total ready to claim. */
  claimableAmount: bigint
  /** Finalized ids, in the ascending order the claim call expects. */
  claimableIds: bigint[]
}

/** Which finalized requests to claim; all claimable ones when `ids` is omitted. */
export interface ClaimWithdrawalsOptions { ids?: bigint[] }
/** The claim transaction and the fee it paid. */
export interface ClaimWithdrawalsResult { hash: string; fee: bigint }

/** The account's staked position. Amounts in base units. */
export interface StakedBalance {
  /** Primary staked token held (for Lido, stETH). */
  balance: bigint
  /** Non-rebasing wrapped form, 0n if the protocol has none. */
  wrappedBalance: bigint
  /** Primary staked tokens per wrapped token, 1e18 fixed point (0n if none). */
  rate: bigint
  /** Whole position in primary staked tokens. */
  total: bigint
}

/**
 * The staking interface every staking module implements. Unstaking has two phases:
 * `requestWithdrawal` puts an amount in the protocol's queue, and `claimWithdrawals` collects it
 * once finalized.
 */
export interface IStakingProtocol {
  /** Stake native coin and receive the protocol's staked token. */
  stake(options: StakeOptions): Promise<StakeResult>
  /** Network fee of {@link IStakingProtocol.stake}; nothing is signed. */
  quoteStake(options: StakeOptions): Promise<Omit<StakeResult, 'hash'>>
  /**
   * Put staked tokens in the withdrawal queue. Sends an approval first when the protocol needs one.
   */
  requestWithdrawal(options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult>
  /** Network fee of {@link IStakingProtocol.requestWithdrawal}. */
  quoteRequestWithdrawal(options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>
  /** The account's open requests, and which are claimable. */
  getWithdrawalRequests(): Promise<WithdrawalRequestsView>
  /** Claim finalized requests; the native coin returns to the account. */
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult>
  /** Network fee of {@link IStakingProtocol.claimWithdrawals}. */
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>>
  /** The account's staked position. */
  getStakedBalance(): Promise<StakedBalance>
  /** APR in percent: 2.5 = 2.5 % (every staking module and app reads it this way). */
  getApr(): Promise<number>
}

/**
 * Base class for staking modules: holds the account and config, and throws `NotImplementedError`
 * for every method a module leaves out.
 */
export class StakingProtocol<TConfig extends object = Record<string, never>>
  extends ProtocolBase<TConfig>
  implements IStakingProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async stake(_o: StakeOptions): Promise<StakeResult> { throw new NotImplementedError('stake(options)') }
  async quoteStake(_o: StakeOptions): Promise<Omit<StakeResult, 'hash'>> { throw new NotImplementedError('quoteStake(options)') }
  async requestWithdrawal(_o: WithdrawalRequestOptions): Promise<WithdrawalRequestResult> { throw new NotImplementedError('requestWithdrawal(options)') }
  async quoteRequestWithdrawal(_o: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>> { throw new NotImplementedError('quoteRequestWithdrawal(options)') }
  async getWithdrawalRequests(): Promise<WithdrawalRequestsView> { throw new NotImplementedError('getWithdrawalRequests()') }
  async claimWithdrawals(_o?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult> { throw new NotImplementedError('claimWithdrawals(options)') }
  async quoteClaimWithdrawals(_o?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>> { throw new NotImplementedError('quoteClaimWithdrawals(options)') }
  async getStakedBalance(): Promise<StakedBalance> { throw new NotImplementedError('getStakedBalance()') }
  async getApr(): Promise<number> { throw new NotImplementedError('getApr()') }
}
