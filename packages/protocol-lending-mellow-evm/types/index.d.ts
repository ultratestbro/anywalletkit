import type {Eip1193Provider} from "ethers"

export interface SupplyOptions {
  /** Asset address, or "native" for ETH. */
  token: string
  /** Amount in the asset's base units. */
  amount: number | bigint
  /** Not supported — the queues credit the depositor. */
  onBehalfOf?: string
}

export interface SupplyResult {
  hash: string
  fee: bigint
  /** True when the synchronous queue minted shares in this transaction. */
  instant: boolean
  /** The deposit queue used. */
  queue: string
  /** Approval transactions sent (awaited) before the deposit. */
  approveHashes: string[]
}

export interface WithdrawOptions {
  /** Payout asset address, or "native". */
  token: string
  /** Vault SHARES to redeem (18 decimals). */
  amount: number | bigint
  /** Not supported — the redeem queue pays the requesting account. */
  to?: string
}

export interface WithdrawResult {
  hash: string
  fee: bigint
  /** The redeem queue used. */
  queue: string
  /** Estimated payout at the latest report, after the redeem fee. */
  assetsOut: bigint
}

export interface QueueInfo {
  address: string
  paused: boolean
}
export interface DepositQueueInfo extends QueueInfo {
  kind: "async" | "sync"
}
export interface RedeemQueueInfo extends QueueInfo {
  kind: "async" | "signature"
}

export interface VaultAsset {
  address: string
  native: boolean
  depositQueues: DepositQueueInfo[]
  redeemQueues: RedeemQueueInfo[]
}

export interface VaultData {
  vault: string
  shareManager: string
  feeManager: string
  oracle: string
  riskManager: string
  assets: VaultAsset[]
  /** Percent. */
  fees: {depositPct: number; redeemPct: number; performancePct: number; protocolPct: number}
  /** Seconds. */
  oracleParams: {timeout: number; depositInterval: number; redeemInterval: number}
  flags: {hasWhitelist: boolean; hasMintPause: boolean; hasBurnPause: boolean}
}

export interface OracleReport {
  /** Shares per one unit of the asset, 1e18 fixed point. */
  priceD18: bigint
  /** Unix seconds. */
  timestamp: number
  suspicious: boolean
}

export interface PendingDeposit {
  token: string
  queue: string
  requestedAt: number
  assets: bigint
}

export interface RedeemRequest {
  token: string
  queue: string
  /** Unix seconds — the request's id inside its queue. */
  timestamp: number
  shares: bigint
  claimable: boolean
  /** Priced after the report; 0 until then. */
  assets: bigint
}

export interface Position {
  /** Shares held (18 decimals), including those priced but not yet claimed. */
  shares: bigint
  /** Asset the shares are valued in. */
  token: string
  priceD18: bigint
  /** Value of the shares in `token` at the latest report. */
  value: bigint
  reportAt: number
  suspicious: boolean
  claimableShares: bigint
  pendingDeposits: PendingDeposit[]
  redeemRequests: RedeemRequest[]
}

export interface WithdrawalRequestsView {
  requests: Array<RedeemRequest & {id: string}>
  pendingShares: bigint
  claimable: Array<{token: string; queue: string; assets: bigint; timestamps: number[]}>
}

export interface Stats {
  id: string
  name: string
  apy: number | null
  tvlUsd: number | null
  withdrawAvgSeconds: number | null
}

export interface MellowVaultPreset {
  vault: string
  registryId: string
  name: string
  shareSymbol: string
  /** Caveats known when the preset was added (e.g. a deposit whitelist). */
  note?: string
}

export interface MellowProtocolConfig {
  vault?: string
  preset?: string
  chainId?: number
  provider?: string | Eip1193Provider
  registry?: string | null
  instant?: boolean
  referral?: string
  maxRedeemRequests?: number
}

export declare const MELLOW_ADDRESS_MAP: Record<number, Record<string, MellowVaultPreset>>
export declare const NATIVE_ASSET: string
export declare const DEFAULT_REGISTRY: string
export declare function toAsset(token?: string | null): string

export default class MellowProtocolEvm {
  constructor(account: unknown, config?: MellowProtocolConfig)
  readonly vault: string

  getVaultData(options?: {refresh?: boolean}): Promise<VaultData>
  getReport(token?: string): Promise<OracleReport>
  getShares(): Promise<bigint>
  getPosition(options?: {token?: string}): Promise<Position>

  supply(options: SupplyOptions): Promise<SupplyResult>
  quoteSupply(options: SupplyOptions): Promise<{fee: bigint; sharesOut: bigint; instant: boolean; queue: string}>
  cancelSupply(options?: {token?: string}): Promise<{hash: string; fee: bigint}>
  claimShares(options?: {token?: string}): Promise<{hash: string; fee: bigint}>

  withdraw(options: WithdrawOptions): Promise<WithdrawResult>
  quoteWithdraw(options: WithdrawOptions): Promise<{fee: bigint; assetsOut: bigint; queue: string}>
  getWithdrawalRequests(): Promise<WithdrawalRequestsView>
  claimWithdrawals(options?: {token?: string; timestamps?: number[]}): Promise<{hashes: string[]; fee: bigint; assets: Array<{token: string; amount: bigint}>}>

  /** Always rejects with NotImplementedError: a vault does not lend. */
  borrow(options: unknown): Promise<never>
  quoteBorrow(options: unknown): Promise<never>
  repay(options: unknown): Promise<never>
  quoteRepay(options: unknown): Promise<never>

  getStats(): Promise<Stats | null>
  getApr(): Promise<number>

  protected _getSupplyPlan(token: string, amount: bigint, options?: {instant?: boolean}): Promise<{queue: DepositQueueInfo; approvals: Array<{to: string; data: string}>; tx: {to: string; data: string; value: bigint}; sharesOut: bigint; instant: boolean}>
  protected _getWithdrawPlan(token: string, shares: bigint): Promise<{queue: string; tx: {to: string; data: string; value: bigint}; assetsOut: bigint}>
}
