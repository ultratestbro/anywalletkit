'use strict'

// The StakingProtocol base class lives in @forgewallet/core (one copy for every staking
// module). This file keeps the runtime IStakingProtocol marker class and re-exports the base.

import { NotImplementedError, StakingProtocol } from '@forgewallet/core'

/** @typedef {import('@forgewallet/core').IWalletAccount} IWalletAccount */
/** @typedef {import('@forgewallet/core').IWalletAccountReadOnly} IWalletAccountReadOnly */

/**
 * @typedef {Object} StakeOptions
 * @property {number | bigint} amount - The amount of native tokens to stake (in base unit).
 */

/**
 * @typedef {Object} StakeResult
 * @property {string} hash - The hash of the stake transaction.
 * @property {bigint} fee - The gas cost.
 */

/**
 * @typedef {Object} WithdrawalRequestOptions
 * @property {number | bigint} amount - The amount of staked tokens to queue for withdrawal (in base unit).
 * @property {string} [token] - Which staked-token form to withdraw (protocol specific, e.g. "stETH" or "wstETH"). Defaults to the protocol's primary staked token.
 */

/**
 * @typedef {Object} WithdrawalRequestResult
 * @property {string} hash - The hash of the withdrawal-request transaction.
 * @property {bigint} fee - The total gas cost (including a prior approval transaction, if one was needed).
 * @property {string | null} approveHash - The hash of the approval transaction if the two-transaction fallback ran, otherwise null.
 */

/**
 * @typedef {Object} WithdrawalRequest
 * @property {bigint} id - The queue's identifier for this request.
 * @property {bigint} amount - The amount of staked tokens locked in this request (in base unit).
 * @property {number} timestamp - Unix seconds at which the request was created.
 * @property {boolean} claimable - Whether the request has finalized and can be claimed.
 */

/**
 * @typedef {Object} WithdrawalRequestsView
 * @property {WithdrawalRequest[]} requests - Open (unclaimed) requests, newest first.
 * @property {bigint} pendingAmount - Staked tokens still waiting for finalization (in base unit).
 * @property {bigint} claimableAmount - Native tokens ready to claim right now (in base unit).
 * @property {bigint[]} claimableIds - Ids of the finalized requests, in the ascending order the claim call expects.
 */

/**
 * @typedef {Object} ClaimWithdrawalsOptions
 * @property {bigint[]} [ids] - The request ids to claim. Defaults to every claimable request.
 */

/**
 * @typedef {Object} ClaimWithdrawalsResult
 * @property {string} hash - The hash of the claim transaction.
 * @property {bigint} fee - The gas cost.
 */

/**
 * @typedef {Object} StakedBalance
 * @property {bigint} balance - The primary staked token balance (in base unit).
 * @property {bigint} wrappedBalance - The non-rebasing wrapped form's balance, 0n if the protocol has none.
 * @property {bigint} rate - Primary staked tokens per wrapped token, 1e18 fixed point (0n if no wrapped form).
 * @property {bigint} total - The whole position expressed in primary staked tokens (balance + unwrapped wrappedBalance).
 */

/** @interface */
export class IStakingProtocol {
  /**
   * Stakes native tokens into the protocol; staked tokens land on the account.
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<StakeResult>} The stake's result.
   */
  async stake (options) {
    throw new NotImplementedError('stake(options)')
  }

  /**
   * Quotes the costs of a stake operation.
   *
   * @param {StakeOptions} options - The stake's options.
   * @returns {Promise<Omit<StakeResult, 'hash'>>} The stake's costs.
   */
  async quoteStake (options) {
    throw new NotImplementedError('quoteStake(options)')
  }

  /**
   * Queues staked tokens for withdrawal. The request finalizes out of band;
   * once {@link IStakingProtocol#getWithdrawalRequests} reports it claimable,
   * {@link IStakingProtocol#claimWithdrawals} exchanges it for native tokens.
   *
   * @param {WithdrawalRequestOptions} options - The request's options.
   * @returns {Promise<WithdrawalRequestResult>} The request's result.
   */
  async requestWithdrawal (options) {
    throw new NotImplementedError('requestWithdrawal(options)')
  }

  /**
   * Quotes the costs of a withdrawal request.
   *
   * @param {WithdrawalRequestOptions} options - The request's options.
   * @returns {Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>} The request's costs.
   */
  async quoteRequestWithdrawal (options) {
    throw new NotImplementedError('quoteRequestWithdrawal(options)')
  }

  /**
   * Returns the account's live withdrawal queue: open requests, what is still
   * pending and what is ready to claim.
   *
   * @returns {Promise<WithdrawalRequestsView>} The queue view.
   */
  async getWithdrawalRequests () {
    throw new NotImplementedError('getWithdrawalRequests()')
  }

  /**
   * Claims finalized withdrawal requests — native tokens land on the account.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<ClaimWithdrawalsResult>} The claim's result.
   */
  async claimWithdrawals (options) {
    throw new NotImplementedError('claimWithdrawals(options)')
  }

  /**
   * Quotes the costs of a claim operation.
   *
   * @param {ClaimWithdrawalsOptions} [options] - The claim's options.
   * @returns {Promise<Omit<ClaimWithdrawalsResult, 'hash'>>} The claim's costs.
   */
  async quoteClaimWithdrawals (options) {
    throw new NotImplementedError('quoteClaimWithdrawals(options)')
  }

  /**
   * Returns the account's staked position.
   *
   * @returns {Promise<StakedBalance>} The staked balances.
   */
  async getStakedBalance () {
    throw new NotImplementedError('getStakedBalance()')
  }

  /**
   * Returns the protocol's current staking APR, in percent.
   *
   * @returns {Promise<number>} The APR (e.g. 2.7 for 2.7%).
   */
  async getApr () {
    throw new NotImplementedError('getApr()')
  }
}

export default StakingProtocol
