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

export interface RewardTotals {
  totalRewards: bigint
  averageApr: number | null
}

export interface RewardEvent {
  /** Unix seconds. */
  timestamp: number
  /** Base units. */
  reward: bigint
  apr: number | null
}

/**
 * The account surface the protocol needs. Writable methods are optional —
 * views work with a read-only account that only implements getAddress.
 */
export interface StakingWalletAccount {
  getAddress(): Promise<string>
  signTypedData?(typedData: {
    domain: Record<string, unknown>
    types: Record<string, unknown>
    message: Record<string, unknown>
  }): Promise<string>
  sendTransaction?(tx: {to: string; data?: string; value?: bigint}): Promise<{hash: string; fee?: bigint}>
  quoteSendTransaction?(tx: {to: string; data?: string; value?: bigint}): Promise<{fee: bigint}>
  _config?: {provider?: unknown}
}

export interface LidoProtocolConfig {
  /** RPC url or EIP-1193 provider; defaults to the account's provider. */
  provider?: unknown
  /** Default 1. Other chains must also pass addresses and permitDomains. */
  chainId?: number
  /** Lido Rewards-Share referral forwarded to submit(). */
  referral?: string
  addresses?: {stEth?: string; wstEth?: string; withdrawalQueue?: string}
  permitDomains?: {
    stEth?: {name: string; version: string}
    wstEth?: {name: string; version: string}
  }
  endpoints?: {apr?: string; withdrawalQueueApi?: string; rewardHistory?: string}
}

export declare class IStakingProtocol {
  stake(options: StakeOptions): Promise<StakeResult>
  quoteStake(options: StakeOptions): Promise<Omit<StakeResult, 'hash'>>
  requestWithdrawal(options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult>
  quoteRequestWithdrawal(options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, 'hash' | 'approveHash'>>
  getWithdrawalRequests(): Promise<WithdrawalRequestsView>
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult>
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, 'hash'>>
  getStakedBalance(): Promise<StakedBalance>
  getApr(): Promise<number>
}

export declare class StakingProtocol extends IStakingProtocol {
  protected _account: StakingWalletAccount
  constructor(account: StakingWalletAccount)
}

export declare function splitWithdrawalAmounts(amount: bigint, cap: bigint): bigint[]

export declare const LIDO_ADDRESS_MAP: Record<number, {
  stEth: string
  wstEth: string
  withdrawalQueue: string
  permitDomains: {stEth: {name: string; version: string}; wstEth: {name: string; version: string}}
  endpoints: {apr: string; withdrawalQueueApi: string; rewardHistory: string}
}>

export default class LidoProtocolEvm extends StakingProtocol {
  constructor(account: StakingWalletAccount, config?: LidoProtocolConfig)
  wrap(options: StakeOptions): Promise<WithdrawalRequestResult>
  unwrap(options: StakeOptions): Promise<StakeResult>
  getWithdrawalEta(ids: bigint[]): Promise<Map<string, number>>
  getWithdrawalEtaForAmount(amount: number | bigint): Promise<number | null>
  getRewards(): Promise<RewardTotals | null>
  getRewardHistory(options?: {limit?: number}): Promise<RewardEvent[]>
}
