import {
  ApprovalsError, ApprovalsProtocol as CoreApprovalsProtocol, NotImplementedError,
  type ActivityItem, type Approval, type ApprovalStandard, type ApprovalsResult, type ChainTx, type DescribeActivityContext,
  type GetApprovalsOptions, type RevokeResult,
} from '@forgewallet/core'

export type {
  Approval, ApprovalRisk, ApprovalStandard, ApprovalsCoverage, ApprovalsErrorReason, ApprovalsResult, GetApprovalsOptions, RevokeResult,
} from '@forgewallet/core'
export { ApprovalsError }

/** Verified contract name of a spender, when a `labels` resolver is configured. */
export interface SpenderLabel {
  name: string
  url?: string
}

export interface SpenderLabelResolver {
  /** Lowercase address → label; unknown addresses are absent. */
  resolve(addresses: string[]): Promise<Record<string, SpenderLabel>>
}

/** An EIP-1193 provider: anything with `request({ method, params })` — viem's `EIP1193Provider`, a wallet's injected provider, a thin wrapper over a viem client. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>
}

/** RPC url, or an EIP-1193 provider. */
export type EvmProvider = string | Eip1193Provider

export interface RevokeTransaction {
  to: string
  data: string
  value: bigint
}

/** What an account's `sendTransaction` / `approve` / `revokeDelegation` may resolve to: a hash, or `{ hash, fee }`. */
export type SendResult = { hash: string; fee?: bigint } | string

/** Minimal account surface the protocol reads from. */
export interface ReadOnlyAccountLike {
  getAddress(): Promise<string>
  /** A @forgewallet/wallet-evm account carries its provider here; used when `config.provider` is absent. */
  _config?: { provider?: EvmProvider }
}

/** Account surface the protocol writes through (a @forgewallet/wallet-evm account, or anything shaped like one). */
export interface AccountLike extends ReadOnlyAccountLike {
  sendTransaction(tx: RevokeTransaction | RevokeTransaction[]): Promise<SendResult>
  quoteSendTransaction?(tx: RevokeTransaction): Promise<{ fee: bigint }>
  approve?(options: { token: string; spender: string; amount: bigint }): Promise<SendResult>
  revokeDelegation?(): Promise<SendResult>
  quoteRevokeDelegation?(): Promise<{ fee: bigint }>
}

/**
 * The approvals protocol interface — the shape a chain implementation fills.
 *
 * Revokes go through the account's own methods (`approve`, `sendTransaction`,
 * `revokeDelegation`), so on an account from the kit's `Wallet.getAccount(...)`
 * they pass the wallet's policies like any other write.
 */
export class IApprovalsProtocol {
  /** The standards this implementation can discover and revoke. */
  async getSupportedStandards (): Promise<ApprovalStandard[]> { throw new NotImplementedError('getSupportedStandards()') }

  /** Finds the approvals the account has granted. A read-only account is enough. */
  async getApprovals (_options?: GetApprovalsOptions): Promise<ApprovalsResult> { throw new NotImplementedError('getApprovals(options)') }

  /** Estimates the cost of revoking one approval. */
  async quoteRevoke (_approval: Approval): Promise<{ fee: bigint }> { throw new NotImplementedError('quoteRevoke(approval)') }

  /** Revokes one approval. */
  async revoke (_approval: Approval): Promise<{ hash: string; fee: bigint }> { throw new NotImplementedError('revoke(approval)') }

  /**
   * Revokes several approvals, folding what the chain lets it fold (Permit2 pairs
   * into one `lockdown`, everything into one user operation on batching accounts).
   * Never throws for a single failed item: see {@link RevokeResult.error}.
   */
  async revokeAll (_approvals: Approval[]): Promise<RevokeResult[]> { throw new NotImplementedError('revokeAll(approvals)') }
}

/**
 * What an implementation inherits from core's `ApprovalsProtocol` (`ProtocolBase`
 * underneath): the account and config it was built with, the activity hook, and
 * the five protocol methods throwing `NotImplementedError` until overridden.
 *
 * Typed here for the minimal account surface this module needs (`{ getAddress }`
 * for reads, plus `sendTransaction` & co. for writes) and the `{ hash, fee }` a
 * revoke resolves to.
 */
export interface ApprovalsProtocolBase<TConfig extends object = Record<string, never>> {
  readonly _account: ReadOnlyAccountLike | AccountLike
  readonly _config: TConfig
  getSupportedStandards(): Promise<ApprovalStandard[]>
  getApprovals(options?: GetApprovalsOptions): Promise<ApprovalsResult>
  quoteRevoke(approval: Approval): Promise<{ fee: bigint }>
  revoke(approval: Approval): Promise<{ hash: string; fee: bigint }>
  revokeAll(approvals: Approval[]): Promise<RevokeResult[]>
  /** Recognize this module's transactions for a wallet's history; null for anything else. Pure and synchronous. */
  describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null
}

export interface ApprovalsProtocolConstructor {
  new <TConfig extends object = Record<string, never>>(account: ReadOnlyAccountLike | AccountLike, config?: TConfig): ApprovalsProtocolBase<TConfig>
}

/**
 * Core's `ApprovalsProtocol` base class (so `instanceof` and `ProtocolBase`
 * plumbing hold), typed for this module's account surface.
 */
const ApprovalsProtocol: ApprovalsProtocolConstructor = CoreApprovalsProtocol as unknown as ApprovalsProtocolConstructor

export { ApprovalsProtocol }
export default ApprovalsProtocol
