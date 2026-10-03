// Our own protocol type (first shipped in the Lido / SSV / Tonstakers / Jito
// modules). Staking is not lending: unstaking is a TWO-PHASE exchange — a
// request enters a queue, finalizes out of band, and only then can be claimed.
// The interface names the queue instead of pretending `withdraw()` returns money.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

export interface StakeOptions { amount: bigint | number }
export interface StakeResult { hash: string; fee: bigint }

export interface WithdrawalRequestOptions {
  amount: bigint | number
  /** Which staked-token form to withdraw (e.g. "stETH" | "wstETH"). Defaults to the primary one. */
  token?: string
}
export interface WithdrawalRequestResult {
  hash: string
  /** Total gas, including a prior approval if the two-transaction fallback ran. */
  fee: bigint
  approveHash: string | null
}

export interface WithdrawalRequest {
  id: bigint
  amount: bigint
  /** Unix seconds. */
  timestamp: number
  claimable: boolean
}
export interface WithdrawalRequestsView {
  /** Open (unclaimed) requests, newest first. */
  requests: WithdrawalRequest[]
  pendingAmount: bigint
  claimableAmount: bigint
  /** Finalized ids, in the ascending order the claim call expects. */
  claimableIds: bigint[]
}

export interface ClaimWithdrawalsOptions { ids?: bigint[] }
export interface ClaimWithdrawalsResult { hash: string; fee: bigint }

export interface StakedBalance {
  balance: bigint
  /** Non-rebasing wrapped form, 0n if the protocol has none. */
  wrappedBalance: bigint
  /** Primary staked tokens per wrapped token, 1e18 fixed point (0n if none). */
  rate: bigint
  /** Whole position in primary staked tokens. */
  total: bigint
}

export interface IStakingProtocol {
  stake(options: StakeOptions): Promise<StakeResult>
  quoteStake(options: StakeOptions): Promise<Omit<StakeResult, 'hash'>>
  requestWithdrawal(options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult>
  quoteRequestWithdrawal(options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>
  getWithdrawalRequests(): Promise<WithdrawalRequestsView>
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult>
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>>
  getStakedBalance(): Promise<StakedBalance>
  /** Decimal APR, 0.03 = 3 %. */
  getApr(): Promise<number>
}

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
