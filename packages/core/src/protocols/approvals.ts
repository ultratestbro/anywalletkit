// Our own protocol type (first shipped in protocol-approvals-evm): discover the
// token approvals an account has granted, flag the risky ones, revoke them.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

export type ApprovalStandard =
  | 'erc20' | 'erc721' | 'erc721-token' | 'erc1155' | 'permit2' | 'eip7702'
  | 'trc20' | 'spl' | 'spl-2022' | 'authz'
export type ApprovalRisk = 'unlimited' | 'eoa-spender' | 'expired' | 'permanent'

export interface Approval {
  /** Deterministic key: `chainId:standard:token:spender[:tokenId]`. */
  id: string
  standard: ApprovalStandard
  chainId: number | string
  /** Token contract (or mint); for `eip7702` the account itself. */
  token: string
  spender: string
  /** Allowance in base units; null for operator approvals and delegations. */
  amount: bigint | null
  unlimited: boolean
  tokenId?: string
  /** Unix seconds; Permit2 and authz only. */
  expiration?: number
  grantedAt?: { block?: number; txHash?: string }
  risks: ApprovalRisk[]
  spenderLabel?: { name: string; url?: string }
}

export interface ApprovalsCoverage {
  /** `rpc-logs`, `state`, or a custom source name. */
  source: string
  fromBlock?: number
  toBlock?: number
  /** False when some block range could not be scanned — the list may miss approvals. */
  complete: boolean
  gaps?: Array<[number, number]>
}

export interface ApprovalsResult { approvals: Approval[]; coverage: ApprovalsCoverage }

export interface GetApprovalsOptions {
  standards?: ApprovalStandard[]
  tokens?: string[]
  spenders?: string[]
  includeZero?: boolean
  fromBlock?: number
  toBlock?: number
}

export interface RevokeResult {
  ids: string[]
  hash?: string
  fee?: bigint
  /** Why this item could not be revoked (`revokeAll` continues past failures). */
  error?: Error
}

export type ApprovalsErrorReason =
  | 'account-required' | 'provider-required' | 'unsupported-standard' | 'invalid-approval' | 'source-failed'

export class ApprovalsError extends Error {
  readonly reason: ApprovalsErrorReason
  readonly details: Record<string, unknown>
  constructor(message: string, reason: ApprovalsErrorReason, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ApprovalsError'
    this.reason = reason
    this.details = details
  }
}

export interface IApprovalsProtocol {
  getSupportedStandards(): Promise<ApprovalStandard[]>
  getApprovals(options?: GetApprovalsOptions): Promise<ApprovalsResult>
  quoteRevoke(approval: Approval): Promise<{ fee: bigint }>
  revoke(approval: Approval): Promise<RevokeResult>
  revokeAll(approvals: Approval[]): Promise<RevokeResult[]>
}

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
