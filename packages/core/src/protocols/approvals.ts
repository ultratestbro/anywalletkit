// Our own protocol type (first shipped in protocol-approvals-evm): discover the
// token approvals an account has granted, flag the risky ones, revoke them.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

/**
 * Kinds of approval the approvals interface covers: EVM token allowances, NFT operators, Permit2,
 * EIP-7702 delegations, and their Tron, Solana and Cosmos counterparts.
 */
export type ApprovalStandard =
  | 'erc20' | 'erc721' | 'erc721-token' | 'erc1155' | 'permit2' | 'eip7702'
  | 'trc20' | 'spl' | 'spl-2022' | 'authz'
/**
 * Why an approval is flagged: an unlimited amount, a spender that is a plain address (not a
 * contract), an expired permit still on record, or no expiry at all.
 */
export type ApprovalRisk = 'unlimited' | 'eoa-spender' | 'expired' | 'permanent'

/** One live approval the account granted. */
export interface Approval {
  /** Deterministic key: `chainId:standard:token:spender[:tokenId]`. */
  id: string
  /** Which kind of approval. */
  standard: ApprovalStandard
  /** Chain it lives on. */
  chainId: number | string
  /** Token contract (or mint); for `eip7702` the account itself. */
  token: string
  /** Who may spend: the spender, operator or delegate. */
  spender: string
  /** Allowance in base units; null for operator approvals and delegations. */
  amount: bigint | null
  /** The allowance is effectively unbounded. */
  unlimited: boolean
  /** NFT id, for a per-token approval. */
  tokenId?: string
  /** Unix seconds; Permit2 and authz only. */
  expiration?: number
  /** Where the approval was granted, when the source knows. */
  grantedAt?: { block?: number; txHash?: string }
  /** Every risk that applies; empty when none. */
  risks: ApprovalRisk[]
  /** Known name of the spender, when a label source has one. */
  spenderLabel?: { name: string; url?: string }
}

/** How much history the scan covered. Show a warning when `complete` is false. */
export interface ApprovalsCoverage {
  /** `rpc-logs`, `state`, or a custom source name. */
  source: string
  /** First block scanned. */
  fromBlock?: number
  /** Last block scanned. */
  toBlock?: number
  /** False when some block range could not be scanned — the list may miss approvals. */
  complete: boolean
  /** Block ranges that could not be scanned. */
  gaps?: Array<[number, number]>
}

/** The approvals found and how complete the scan was. */
export interface ApprovalsResult { approvals: Approval[]; coverage: ApprovalsCoverage }

/** Filters for {@link IApprovalsProtocol.getApprovals}. */
export interface GetApprovalsOptions {
  /** Only these kinds. */
  standards?: ApprovalStandard[]
  /** Only these token contracts or mints. */
  tokens?: string[]
  /** Only these spenders. */
  spenders?: string[]
  /** Also return approvals already set to zero. */
  includeZero?: boolean
  /** Scan from this block. */
  fromBlock?: number
  /** Scan up to this block. */
  toBlock?: number
}

/** Outcome of one revoke transaction. */
export interface RevokeResult {
  /** Ids of the approvals this transaction revoked. */
  ids: string[]
  /** Transaction hash, when it was sent. */
  hash?: string
  /** Network fee paid. */
  fee?: bigint
  /** Why this item could not be revoked (`revokeAll` continues past failures). */
  error?: Error
}

/**
 * Why an approvals call failed: a signing account or an RPC provider is missing, the standard is
 * not supported, the approval object is invalid, or the history source failed.
 */
export type ApprovalsErrorReason =
  | 'account-required' | 'provider-required' | 'unsupported-standard' | 'invalid-approval' | 'source-failed'

/** Thrown by approvals modules with a machine-readable {@link ApprovalsErrorReason}. */
export class ApprovalsError extends Error {
  /** Machine-readable reason. */
  readonly reason: ApprovalsErrorReason
  /** Extra context for logs (never secrets). */
  readonly details: Record<string, unknown>
  constructor(message: string, reason: ApprovalsErrorReason, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApprovalsError'
    this.reason = reason
    this.details = details
  }
}

/** Find the approvals an account granted, flag the risky ones, and revoke them. */
export interface IApprovalsProtocol {
  /** Approval kinds this module can find and revoke. */
  getSupportedStandards(): Promise<ApprovalStandard[]>
  /** Live approvals of the account, with risks and scan coverage. */
  getApprovals(options?: GetApprovalsOptions): Promise<ApprovalsResult>
  /** Network fee of revoking one approval. */
  quoteRevoke(approval: Approval): Promise<{ fee: bigint }>
  /** Revoke one approval. */
  revoke(approval: Approval): Promise<RevokeResult>
  /**
   * Revoke several, batching where the standard allows. Continues past failures; each result
   * carries its own `error`.
   */
  revokeAll(approvals: Approval[]): Promise<RevokeResult[]>
}

/** Base class for approvals modules. */
export class ApprovalsProtocol<TConfig extends object = Record<string, never>>
  extends ProtocolBase<TConfig>
  implements IApprovalsProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async getSupportedStandards(): Promise<ApprovalStandard[]> { throw new NotImplementedError('getSupportedStandards()') }
  async getApprovals(_o?: GetApprovalsOptions): Promise<ApprovalsResult> { throw new NotImplementedError('getApprovals(options)') }
  async quoteRevoke(_a: Approval): Promise<{ fee: bigint }> { throw new NotImplementedError('quoteRevoke(approval)') }
  async revoke(_a: Approval): Promise<RevokeResult> { throw new NotImplementedError('revoke(approval)') }
  async revokeAll(_a: Approval[]): Promise<RevokeResult[]> { throw new NotImplementedError('revokeAll(approvals)') }
}
