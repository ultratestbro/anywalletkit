import type { Eip1193Provider, Provider } from "ethers"

export type ApprovalStandard =
  | "erc20" | "erc721" | "erc721-token" | "erc1155" | "permit2" | "eip7702"
  | "trc20" | "spl" | "spl-2022" | "authz"

export type ApprovalRisk = "unlimited" | "eoa-spender" | "expired" | "permanent"

/** One permission the account has granted a third party over its tokens. */
export interface Approval {
  /** Deterministic key: `chainId:standard:token:spender[:tokenId]`. */
  id: string
  standard: ApprovalStandard
  chainId: number | string
  /** Token contract; for `eip7702` the account itself. */
  token: string
  /** Spender / operator / delegate contract. */
  spender: string
  /** Allowance in base units; null for operator approvals and delegations. */
  amount: bigint | null
  unlimited: boolean
  tokenId?: string
  /** Unix seconds; Permit2 only on evm. */
  expiration?: number
  grantedAt?: { block?: number; txHash?: string }
  risks: ApprovalRisk[]
  /** Verified contract name of the spender, when a `labels` resolver is configured. */
  spenderLabel?: SpenderLabel
}

export interface SpenderLabel {
  name: string
  url?: string
}

export interface SpenderLabelResolver {
  resolve(addresses: string[]): Promise<Record<string, SpenderLabel>>
}

export interface ApprovalsCoverage {
  source: string
  fromBlock?: number
  toBlock?: number
  /** False when a block range stayed too large to fetch — the list may miss approvals. */
  complete: boolean
  gaps?: Array<[number, number]>
}

export interface ApprovalsResult {
  approvals: Approval[]
  coverage: ApprovalsCoverage
}

export interface GetApprovalsOptions {
  standards?: ApprovalStandard[]
  tokens?: string[]
  spenders?: string[]
  /** Also return zero / expired entries (default false). */
  includeZero?: boolean
  fromBlock?: number
  toBlock?: number
}

export interface RevokeResult {
  ids: string[]
  hash?: string
  fee?: bigint
  error?: Error
}

export type ApprovalsErrorReason =
  | "account-required" | "provider-required" | "unsupported-standard" | "invalid-approval" | "source-failed"

export class ApprovalsError extends Error {
  reason: ApprovalsErrorReason
  details: Record<string, unknown>
  constructor(message: string, reason: ApprovalsErrorReason, details?: Record<string, unknown>)
}

/** A `(token, spender)` pair seen in the account's events. Plain JSON, safe to persist. */
export interface Candidate {
  kind: "erc20" | "erc721-token" | "nft-operator" | "permit2"
  token: string
  spender: string
  tokenId?: string
  block: number
  txHash: string
  logIndex: number
}

export interface CollectResult {
  candidates: Candidate[]
  complete: boolean
  gaps: Array<[number, number]>
}

/** Discovery source contract: turn a block range into candidate pairs. */
export interface ApprovalSource {
  name: string
  collect(owner: string, range: { fromBlock: number; toBlock: number }): Promise<CollectResult>
}

export interface CacheEntry {
  fromBlock: number
  toBlock: number
  candidates: Candidate[]
}

export interface ApprovalsCache {
  get(key: string): Promise<CacheEntry | undefined | null> | CacheEntry | undefined | null
  set(key: string, value: CacheEntry): Promise<void> | void
}

export interface ApprovalsProtocolEvmConfig {
  /** RPC URL or EIP-1193 provider; defaults to the account's. */
  provider?: string | Eip1193Provider
  chainId?: number
  /** Where a cold scan starts (ideally the wallet's creation block). Default 0. */
  fromBlock?: number
  /** Pre-chunk `eth_getLogs` to this many blocks (QuickNode: 10 000). Default null: whole range, split on refusal. */
  blockRange?: number | null
  source?: ApprovalSource
  cache?: ApprovalsCache
  /** Multicall3 address, or false to always use single `eth_call`s. */
  multicall?: string | false
  /** The account takes `sendTransaction(tx[])` as one operation (ERC-4337 / 7702 accounts). Default false. */
  batch?: boolean
  /** Report the account's EIP-7702 delegation. Default true. */
  includeDelegation?: boolean
  concurrency?: number
  retryDelay?: number
  /** Spender label resolver (e.g. EtherscanLabels); failures never fail the scan. */
  labels?: SpenderLabelResolver
}

export interface RevokeTransaction {
  to: string
  data: string
  value: bigint
}

/** Minimal account surface the protocol reads from. */
export interface ReadOnlyAccountLike {
  getAddress(): Promise<string>
  _config?: { provider?: string | Eip1193Provider }
}

/** Account surface the protocol writes through (a @forgewallet/wallet-evm account). */
export interface AccountLike extends ReadOnlyAccountLike {
  sendTransaction(tx: RevokeTransaction | RevokeTransaction[]): Promise<{ hash: string; fee?: bigint } | string>
  quoteSendTransaction?(tx: RevokeTransaction): Promise<{ fee: bigint }>
  approve?(options: { token: string; spender: string; amount: bigint }): Promise<{ hash: string; fee?: bigint } | string>
  revokeDelegation?(): Promise<{ hash: string; fee?: bigint } | string>
  quoteRevokeDelegation?(): Promise<{ fee: bigint }>
}

export class IApprovalsProtocol {
  getSupportedStandards(): Promise<ApprovalStandard[]>
  getApprovals(options?: GetApprovalsOptions): Promise<ApprovalsResult>
  quoteRevoke(approval: Approval): Promise<{ fee: bigint }>
  revoke(approval: Approval): Promise<{ hash: string; fee: bigint }>
  revokeAll(approvals: Approval[]): Promise<RevokeResult[]>
}

export class ApprovalsProtocol implements IApprovalsProtocol {
  protected _account: ReadOnlyAccountLike | AccountLike
  constructor(account: ReadOnlyAccountLike | AccountLike)
  getSupportedStandards(): Promise<ApprovalStandard[]>
  getApprovals(options?: GetApprovalsOptions): Promise<ApprovalsResult>
  quoteRevoke(approval: Approval): Promise<{ fee: bigint }>
  revoke(approval: Approval): Promise<{ hash: string; fee: bigint }>
  revokeAll(approvals: Approval[]): Promise<RevokeResult[]>
}

export class RpcLogsSource implements ApprovalSource {
  name: string
  /** `eth_getLogs` requests issued by the last `collect` (diagnostics). */
  requests: number
  constructor(options: { provider: Provider; blockRange?: number | null; concurrency?: number; retries?: number; retryDelay?: number })
  collect(owner: string, range: { fromBlock: number; toBlock: number }): Promise<CollectResult>
}

export interface IndexerSourceOptions {
  perTopic?: boolean
  fetch?: typeof fetch
  headers?: Record<string, string>
  concurrency?: number
  retries?: number
  retryDelay?: number
  maxRetryWait?: number
}

/** Shared engine of the Etherscan-dialect sources: one `topic1 = owner` request per range, halved on a full page. */
export abstract class IndexerLogsSource implements ApprovalSource {
  name: string
  requests: number
  constructor(name: string, options?: IndexerSourceOptions)
  collect(owner: string, range: { fromBlock: number; toBlock: number }): Promise<CollectResult>
}

export const BLOCKSCOUT_HOSTS: Readonly<Record<number, string>>

/** Discovery through a public Blockscout instance (keyless, ~10 requests per window per IP). */
export class BlockscoutSource extends IndexerLogsSource {
  constructor(options?: IndexerSourceOptions & { baseUrl?: string; chainId?: number; apiKey?: string })
}

export const ETHERSCAN_V2_URL: string

/** Discovery through the Etherscan V2 API (key required; `baseUrl` may be your own proxy). */
export class EtherscanSource extends IndexerLogsSource {
  constructor(options: IndexerSourceOptions & { chainId: number; apiKey?: string; baseUrl?: string })
}

/** Spender labels from Etherscan V2 `getsourcecode` (verified contract name), one request per unique spender, memoised. */
export class EtherscanLabels implements SpenderLabelResolver {
  constructor(options: { chainId: number; apiKey?: string; baseUrl?: string; explorerUrl?: string; fetch?: typeof fetch; headers?: Record<string, string>; cache?: { get(key: string): unknown; set(key: string, value: unknown): unknown }; concurrency?: number })
  resolve(addresses: string[]): Promise<Record<string, SpenderLabel>>
}

export function parseApprovalLog(
  log: { address: string; topics: string[]; data: string; blockNumber: number | string; transactionHash: string; index?: number; logIndex?: number },
  owner: string
): Candidate | null

export class StateVerifier {
  constructor(options: { provider: Provider; multicall?: string | false; batchSize?: number; concurrency?: number })
  verify(owner: string, candidates: Candidate[], options: { chainId: number | string; includeZero?: boolean; now?: number }): Promise<Approval[]>
}

export interface PolicyRule {
  name: string
  operation: string | string[]
  action: "ALLOW" | "DENY"
  conditions: Array<(context: { operation: string; wallet: string; account: number; args: unknown[] }) => boolean>
}

export interface Policy {
  id: string
  name: string
  scope: string
  rules: PolicyRule[]
}

export function approvalsHygienePolicy(options?: {
  id?: string; name?: string; scope?: string; unlimitedThreshold?: bigint; denyUnlimited?: boolean
}): Policy
export function isRevokeCalldata(data: string | undefined): boolean
export function isUnlimitedAmount(amount: unknown, threshold?: bigint): boolean

export namespace STANDARDS {
  const PERMIT2_ADDRESS: string
  const MULTICALL3_ADDRESS: string
  const UNLIMITED_THRESHOLD: bigint
  const MAX_UINT160: bigint
  const MAX_UINT256: bigint
  const EIP7702_PREFIX: string
  const TOPICS: Readonly<{ approval: string; approvalForAll: string; permit2Approval: string; permit2Permit: string; permit2Lockdown: string }>
  const DISCOVERY_TOPICS: readonly string[]
  const SELECTORS: Readonly<{ approve: string; setApprovalForAll: string; lockdown: string }>
  function ownerTopic(owner: string): string
  function topicAddress(topic: string): string
}

/** Token approvals for evm accounts: discover, flag, revoke. */
export default class ApprovalsProtocolEvm extends ApprovalsProtocol {
  constructor(account: ReadOnlyAccountLike | AccountLike, config?: ApprovalsProtocolEvmConfig)
  /** The raw transaction that revokes an approval; several Permit2 approvals fold into one `lockdown`. */
  buildRevokeTransaction(approval: Approval | Approval[]): RevokeTransaction
}
