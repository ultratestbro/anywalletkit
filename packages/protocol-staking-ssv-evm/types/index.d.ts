import type {ActivityItem, ChainTx, DescribeActivityContext} from "@forgewallet/core"
export interface StakeOptions {
  /** Amount in base units (wei of SSV). */
  amount: number | bigint
}

export interface StakeResult {
  hash: string
  fee: bigint
}

export interface WithdrawalRequestOptions {
  amount: number | bigint
  /** Accepted for interface parity; SSV has a single staked form (cSSV). */
  token?: string
}

export interface WithdrawalRequestResult {
  hash: string
  /** Total gas cost, including a prior approval transaction if one was needed. */
  fee: bigint
  /** Hash of the approval transaction if one ran (stake), otherwise null. */
  approveHash: string | null
}

export interface WithdrawalRequest {
  /** Position in the account's cooldown list — re-read after every write. */
  id: bigint
  /** SSV locked in this entry (base units). */
  amount: bigint
  /** Unix seconds; derived as unlockTime − current cooldown. */
  timestamp: number
  claimable: boolean
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

export interface ClaimWithdrawalsOptions {
  /** Informational: `withdrawUnlocked()` always pays every unlocked entry. */
  ids?: bigint[]
}

export interface ClaimWithdrawalsResult {
  hash: string
  fee: bigint
}

export interface StakedBalance {
  /** cSSV balance (= staked SSV). */
  balance: bigint
  /** Always 0n: cSSV is the only staked form. */
  wrappedBalance: bigint
  /** Always 1e18: cSSV is 1:1 with SSV. */
  rate: bigint
  total: bigint
}

export interface NetworkStats {
  totalStaked: bigint
  rewardsPool: bigint
  accEthPerShare: bigint
}

export interface AprSample {
  /** Unix seconds. */
  timestamp: number
  /** Percent. */
  apr: number
  ssvPriceUsd: number | null
  ethPriceUsd: number | null
}

/**
 * The account surface the protocol needs. Writable methods are optional —
 * views work with a read-only account that only implements getAddress.
 */
export interface StakingWalletAccount {
  getAddress(): Promise<string>
  sendTransaction?(tx: {to: string; data?: string; value?: bigint}): Promise<{hash: string; fee?: bigint}>
  quoteSendTransaction?(tx: {to: string; data?: string; value?: bigint}): Promise<{fee: bigint}>
  _config?: {provider?: unknown}
}

export interface SsvProtocolConfig {
  /** RPC url or EIP-1193 provider; defaults to the account's provider. */
  provider?: unknown
  /** Default 1. Other chains must also pass addresses. */
  chainId?: number
  addresses?: {network?: string; views?: string; ssvToken?: string; cssvToken?: string}
  endpoints?: {apr?: string; aprHistory?: string}
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

export declare const MINIMAL_STAKING_AMOUNT: bigint
export declare const ETH_CLAIM_UNIT: bigint
/** Custom-error selector → human message. */
export declare const SSV_ERRORS: Readonly<Record<string, string>>
export declare function describeRevert(error: unknown): Error & {selector?: string}

export declare const SSV_ADDRESS_MAP: Record<number, {
  network: string
  views: string
  ssvToken: string
  cssvToken: string
  endpoints: {apr: string; aprHistory: string}
}>

export default class SsvProtocolEvm extends StakingProtocol {
  constructor(account: StakingWalletAccount, config?: SsvProtocolConfig)
  /** Recognize this module's transactions for a wallet's history; null for anything else. Pure and synchronous. */
  describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null
  stake(options: StakeOptions): Promise<StakeResult & {approveHash: string | null}>
  getTokenBalance(): Promise<bigint>
  getClaimableRewards(): Promise<bigint>
  claimRewards(): Promise<ClaimWithdrawalsResult>
  quoteClaimRewards(): Promise<Omit<ClaimWithdrawalsResult, 'hash'>>
  getCooldown(): Promise<number>
  getNetworkStats(): Promise<NetworkStats>
  getAprHistory(options?: {limit?: number}): Promise<AprSample[]>
}

export declare function describeSsvActivity(tx: ChainTx, ctx: DescribeActivityContext, deployment: {chainId: number; addresses: {network: string; ssvToken?: string; cssvToken?: string}}): ActivityItem | null
export declare const SSV_ACTIONS: Readonly<Record<string, {kind: ActivityItem['kind']; title: string}>>
