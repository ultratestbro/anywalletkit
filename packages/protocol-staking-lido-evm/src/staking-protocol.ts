// The StakingProtocol base class lives in @anywalletkit/core (one copy for every staking
// module). This file keeps the runtime IStakingProtocol marker class, the option /
// result shapes as this module documents them, and re-exports the base.

import { NotImplementedError, StakingProtocol } from '@anywalletkit/core'

export interface StakeOptions {
  /** Amount in base units (wei). */
  amount: number | bigint
}

export interface StakeResult {
  hash: string
  fee: bigint
}

export interface WithdrawalRequestOptions {
  amount: number | bigint
  /** Which staked-token form to withdraw. Defaults to "stETH". */
  token?: 'stETH' | 'wstETH'
}

export interface WithdrawalRequestResult {
  hash: string
  /** Total gas cost, including a prior approval transaction if one was needed. */
  fee: bigint
  /** Hash of the approval transaction if the two-transaction fallback ran. */
  approveHash: string | null
}

export interface WithdrawalRequest {
  id: bigint
  /** Staked-token amount locked in this request (base units). */
  amount: bigint
  /** Unix seconds at which the request was created. */
  timestamp: number
  claimable: boolean
}

export interface WithdrawalRequestsView {
  /** Open (unclaimed) requests, newest first. */
  requests: WithdrawalRequest[]
  pendingAmount: bigint
  claimableAmount: bigint
  /** Ascending, as the claim call expects. */
  claimableIds: bigint[]
}

export interface ClaimWithdrawalsOptions {
  /** Defaults to every claimable request. */
  ids?: bigint[]
}

export interface ClaimWithdrawalsResult {
  hash: string
  fee: bigint
}

export interface StakedBalance {
  balance: bigint
  wrappedBalance: bigint
  /** Primary staked tokens per wrapped token, 1e18 fixed point. */
  rate: bigint
  /** Whole position in primary staked tokens. */
  total: bigint
}

/** The staking interface as a runtime marker class: every method throws NotImplementedError. */
export class IStakingProtocol {
  /**
   * Stakes native tokens into the protocol; staked tokens land on the account.
   */
  async stake(_options: StakeOptions): Promise<StakeResult> {
    throw new NotImplementedError('stake(options)')
  }

  /** Quotes the costs of a stake operation. */
  async quoteStake(_options: StakeOptions): Promise<Omit<StakeResult, 'hash'>> {
    throw new NotImplementedError('quoteStake(options)')
  }

  /**
   * Queues staked tokens for withdrawal. The request finalizes out of band;
   * once {@link IStakingProtocol#getWithdrawalRequests} reports it claimable,
   * {@link IStakingProtocol#claimWithdrawals} exchanges it for native tokens.
   */
  async requestWithdrawal(_options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult> {
    throw new NotImplementedError('requestWithdrawal(options)')
  }

  /** Quotes the costs of a withdrawal request. */
  async quoteRequestWithdrawal(_options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>> {
    throw new NotImplementedError('quoteRequestWithdrawal(options)')
  }

  /** The account's live withdrawal queue: open requests, pending and claimable. */
  async getWithdrawalRequests(): Promise<WithdrawalRequestsView> {
    throw new NotImplementedError('getWithdrawalRequests()')
  }

  /** Claims finalized withdrawal requests — native tokens land on the account. */
  async claimWithdrawals(_options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult> {
    throw new NotImplementedError('claimWithdrawals(options)')
  }

  /** Quotes the costs of a claim operation. */
  async quoteClaimWithdrawals(_options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>> {
    throw new NotImplementedError('quoteClaimWithdrawals(options)')
  }

  /** The account's staked position. */
  async getStakedBalance(): Promise<StakedBalance> {
    throw new NotImplementedError('getStakedBalance()')
  }

  /** The protocol's current staking APR, in percent (e.g. 2.7 for 2.7%). */
  async getApr(): Promise<number> {
    throw new NotImplementedError('getApr()')
  }
}

export default StakingProtocol
