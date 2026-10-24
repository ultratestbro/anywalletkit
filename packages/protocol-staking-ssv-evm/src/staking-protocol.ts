// The StakingProtocol base class lives in @anywalletkit/core (one copy for every staking
// module). This file keeps the runtime IStakingProtocol marker class, the module's own
// types (the SSV-specific queue view) and re-exports the base.

import { NotImplementedError, StakingProtocol } from '@anywalletkit/core'
import type {
  ClaimWithdrawalsOptions, ClaimWithdrawalsResult, StakeOptions, StakeResult, StakedBalance,
  WithdrawalRequest, WithdrawalRequestOptions, WithdrawalRequestResult,
} from '@anywalletkit/core'

export type {
  ClaimWithdrawalsOptions, ClaimWithdrawalsResult, StakeOptions, StakeResult, StakedBalance,
  WithdrawalRequest, WithdrawalRequestOptions, WithdrawalRequestResult,
}

export interface SsvWithdrawalRequest extends WithdrawalRequest {
  /** Unix seconds at which the cooldown ends (on-chain value). */
  unlockTime: number
}

export interface WithdrawalRequestsView {
  /** Open entries, latest unlock first. */
  requests: SsvWithdrawalRequest[]
  /** SSV still cooling down. */
  pendingAmount: bigint
  /** SSV `withdrawUnlocked()` pays right now. */
  claimableAmount: bigint
  claimableIds: bigint[]
}

/** @interface */
export class IStakingProtocol {
  /**
   * Stakes native tokens into the protocol; staked tokens land on the account.
   *
   * @param _options - The stake's options.
   * @returns The stake's result.
   */
  async stake(_options: StakeOptions): Promise<StakeResult> {
    throw new NotImplementedError('stake(options)')
  }

  /**
   * Quotes the costs of a stake operation.
   *
   * @param _options - The stake's options.
   * @returns The stake's costs.
   */
  async quoteStake(_options: StakeOptions): Promise<Omit<StakeResult, 'hash'>> {
    throw new NotImplementedError('quoteStake(options)')
  }

  /**
   * Queues staked tokens for withdrawal. The request finalizes out of band;
   * once {@link IStakingProtocol#getWithdrawalRequests} reports it claimable,
   * {@link IStakingProtocol#claimWithdrawals} exchanges it for native tokens.
   *
   * @param _options - The request's options.
   * @returns The request's result.
   */
  async requestWithdrawal(_options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult> {
    throw new NotImplementedError('requestWithdrawal(options)')
  }

  /**
   * Quotes the costs of a withdrawal request.
   *
   * @param _options - The request's options.
   * @returns The request's costs.
   */
  async quoteRequestWithdrawal(_options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>> {
    throw new NotImplementedError('quoteRequestWithdrawal(options)')
  }

  /**
   * Returns the account's live withdrawal queue: open requests, what is still
   * pending and what is ready to claim.
   *
   * @returns The queue view.
   */
  async getWithdrawalRequests(): Promise<WithdrawalRequestsView> {
    throw new NotImplementedError('getWithdrawalRequests()')
  }

  /**
   * Claims finalized withdrawal requests — native tokens land on the account.
   *
   * @param _options - The claim's options.
   * @returns The claim's result.
   */
  async claimWithdrawals(_options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult> {
    throw new NotImplementedError('claimWithdrawals(options)')
  }

  /**
   * Quotes the costs of a claim operation.
   *
   * @param _options - The claim's options.
   * @returns The claim's costs.
   */
  async quoteClaimWithdrawals(_options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>> {
    throw new NotImplementedError('quoteClaimWithdrawals(options)')
  }

  /**
   * Returns the account's staked position.
   *
   * @returns The staked balances.
   */
  async getStakedBalance(): Promise<StakedBalance> {
    throw new NotImplementedError('getStakedBalance()')
  }

  /**
   * Returns the protocol's current staking APR, in percent.
   *
   * @returns The APR (e.g. 2.7 for 2.7%).
   */
  async getApr(): Promise<number> {
    throw new NotImplementedError('getApr()')
  }
}

export default StakingProtocol
