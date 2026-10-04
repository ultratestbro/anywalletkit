'use strict'

import { ApprovalsError, ApprovalsProtocol, NotImplementedError } from '@forgewallet/core'

/** @typedef {import('@forgewallet/core').IWalletAccount} IWalletAccount */
/** @typedef {import('@forgewallet/core').IWalletAccountReadOnly} IWalletAccountReadOnly */

/**
 * @typedef {'erc20' | 'erc721' | 'erc721-token' | 'erc1155' | 'permit2' | 'eip7702' | 'trc20' | 'spl' | 'spl-2022' | 'authz'} ApprovalStandard
 */

/**
 * @typedef {'unlimited' | 'eoa-spender' | 'expired' | 'permanent'} ApprovalRisk
 */

/**
 * One permission the account has granted a third party over its tokens.
 *
 * @typedef {Object} Approval
 * @property {string} id - Deterministic key: `chainId:standard:token:spender[:tokenId]`.
 * @property {ApprovalStandard} standard
 * @property {number | string} chainId - The chain the approval lives on.
 * @property {string} token - Token contract (or mint); for `eip7702` the account itself.
 * @property {string} spender - Spender / operator / delegate contract.
 * @property {bigint | null} amount - Allowance in base units; null for operator approvals and delegations.
 * @property {boolean} unlimited - True when the allowance is effectively infinite.
 * @property {string} [tokenId] - For per-token NFT approvals.
 * @property {number} [expiration] - Unix seconds; Permit2 and authz only.
 * @property {{ block?: number, txHash?: string }} [grantedAt] - The last event that set it, when known.
 * @property {ApprovalRisk[]} risks
 * @property {{ name: string, url?: string }} [spenderLabel] - Verified contract name of the spender, when a `labels` resolver is configured.
 */

/**
 * @typedef {Object} ApprovalsCoverage
 * @property {string} source - Which discovery source produced the candidates (`rpc-logs`, `state`, a custom name).
 * @property {number} [fromBlock]
 * @property {number} [toBlock]
 * @property {boolean} complete - False when some block range could not be scanned (too active) — the list may miss approvals.
 * @property {Array<[number, number]>} [gaps] - Block ranges skipped when `complete` is false.
 */

/**
 * @typedef {Object} ApprovalsResult
 * @property {Approval[]} approvals
 * @property {ApprovalsCoverage} coverage
 */

/**
 * @typedef {Object} GetApprovalsOptions
 * @property {ApprovalStandard[]} [standards] - Restrict to these standards.
 * @property {string[]} [tokens] - Restrict to these token contracts.
 * @property {string[]} [spenders] - Restrict to these spenders.
 * @property {boolean} [includeZero] - Also return approvals whose current allowance is zero or expired (default false).
 * @property {number} [fromBlock] - Start of the log scan (overrides the cache and the config).
 * @property {number} [toBlock] - End of the log scan (default: latest).
 */

/**
 * @typedef {Object} RevokeResult
 * @property {string[]} ids - The approvals revoked by this transaction.
 * @property {string} [hash] - The transaction hash (absent when `error` is set).
 * @property {bigint} [fee] - The gas cost.
 * @property {Error} [error] - Why this item could not be revoked (`revokeAll` continues past failures).
 */

/**
 * @typedef {'account-required' | 'provider-required' | 'unsupported-standard' | 'invalid-approval' | 'source-failed'} ApprovalsErrorReason
 */

export { ApprovalsError }

/**
 * The approvals protocol interface — the shape a chain implementation fills.
 *
 * This base ships with the module
 * and implementations are constructed directly: `new ApprovalsProtocolEvm(account, config)`.
 * Revokes go through the account's own governed methods (`approve`,
 * `sendTransaction`, `revokeDelegation`), so an account obtained from
 * a policy engine stays governed without any core change.
 */
export class IApprovalsProtocol {
  /** @returns {Promise<ApprovalStandard[]>} The standards this implementation can discover and revoke. */
  async getSupportedStandards () { throw new NotImplementedError('getSupportedStandards()') }

  /**
   * Finds the approvals the account has granted. A read-only account is enough.
   *
   * @param {GetApprovalsOptions} [options]
   * @returns {Promise<ApprovalsResult>}
   */
  async getApprovals (options) { throw new NotImplementedError('getApprovals(options)') }

  /**
   * Estimates the cost of revoking one approval.
   *
   * @param {Approval} approval
   * @returns {Promise<{ fee: bigint }>}
   */
  async quoteRevoke (approval) { throw new NotImplementedError('quoteRevoke(approval)') }

  /**
   * Revokes one approval.
   *
   * @param {Approval} approval
   * @returns {Promise<{ hash: string, fee: bigint }>}
   */
  async revoke (approval) { throw new NotImplementedError('revoke(approval)') }

  /**
   * Revokes several approvals, folding what the chain lets it fold (Permit2 pairs
   * into one `lockdown`, everything into one user operation on batching accounts).
   * Never throws for a single failed item: see {@link RevokeResult.error}.
   *
   * @param {Approval[]} approvals
   * @returns {Promise<RevokeResult[]>}
   */
  async revokeAll (approvals) { throw new NotImplementedError('revokeAll(approvals)') }
}

export default ApprovalsProtocol
