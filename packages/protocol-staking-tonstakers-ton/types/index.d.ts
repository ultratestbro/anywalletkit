import type {Address, Cell} from "@ton/core"

export interface StakeOptions {
  /** Amount in nanotons, excluding the 1 GRAM fee reserve the module attaches. */
  amount: number | bigint
}

export interface StakeResult {
  hash: string
  fee: bigint
}

export type UnstakeMode = "standard" | "instant" | "bestRate"

export interface WithdrawalRequestOptions {
  /** tsTON in base units. */
  amount: number | bigint
  /** Accepted for interface parity; tsTON is the only staked form. */
  token?: string
  /** Exit path — default "standard". */
  mode?: UnstakeMode
}

export interface WithdrawalRequestResult {
  hash: string
  fee: bigint
  /** Always null — a burn needs no approval. */
  approveHash: null
}

export interface WithdrawalRequest {
  /** The payout bill NFT's index in its collection. */
  id: bigint
  /** tsTON the bill settles (base units). */
  amount: bigint
  /** Unix seconds — the round's start. */
  timestamp: number
  /** Always false: bills are settled by the pool, never claimed. */
  claimable: boolean
}

export interface TonstakersBill extends WithdrawalRequest {
  /** Bill NFT address. */
  nft: string
  /** Unix seconds — when the round ends. */
  roundEnd: number
  /** Unix seconds — round end plus the pool's settlement lag. */
  estimatedPayout: number
}

export interface WithdrawalRequestsView {
  requests: TonstakersBill[]
  pendingAmount: bigint
  /** Always 0n. */
  claimableAmount: bigint
  /** Always empty. */
  claimableIds: bigint[]
}

export interface ClaimWithdrawalsOptions {
  ids?: bigint[]
}

export interface ClaimWithdrawalsResult {
  hash: string
  fee: bigint
}

export interface StakedBalance {
  /** tsTON balance. */
  balance: bigint
  /** Always 0n. */
  wrappedBalance: bigint
  /** GRAM per tsTON, 1e9 fixed point. */
  rate: bigint
  /** The position valued in GRAM at `rate`. */
  total: bigint
}

export interface PoolData {
  halted: boolean
  depositsOpen: boolean
  totalBalance: bigint
  supply: bigint
  jettonMinter: Address | null
  withdrawalPayout: Address | null
  projectedBalance: bigint
  projectedSupply: bigint
  rate: bigint
  projectedRate: bigint
}

export interface Rewards {
  /** GRAM earned on the tsTON still held, at the current rate (nanotons). */
  earned: bigint
  /** Weighted average GRAM per tsTON the position was entered at (1e9 fixed). */
  entryRate: bigint
  deposited: bigint
  minted: bigint
  /** Unix seconds. */
  firstStakeAt: number | null
}

export interface TonClientConfig {
  url: string
  secretKey?: string
}

/**
 * The account surface the protocol needs. Writable methods are optional —
 * views work with a read-only account that only implements getAddress.
 */
export interface StakingWalletAccount {
  getAddress(): Promise<string>
  sendTransaction?(tx: {to: string; value: bigint; body?: Cell; bounceable?: boolean}): Promise<{hash: string; fee?: bigint}>
  quoteSendTransaction?(tx: {to: string; value: bigint; body?: Cell; bounceable?: boolean}): Promise<{fee: bigint}>
  _tonClient?: unknown
  _config?: {tonClient?: unknown}
}

export interface TonstakersProtocolConfig {
  /** A @ton/ton TonClient, a {url, secretKey} config, or an array of either (tried in order). Defaults to the account's client. */
  tonClient?: unknown
  /** "-239" mainnet (default) or "-3" testnet. */
  network?: string
  addresses?: {pool?: string; jetton?: string}
  partnerCode?: bigint | number
  /** Set a key to null to disable that feature. */
  endpoints?: {tonapi?: string | null; withdrawalPayouts?: string | null}
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

export declare const OP_STAKE: number
export declare const OP_UNSTAKE: number
export declare const STAKE_FEE_RESERVE: bigint
export declare const UNSTAKE_FEE_RESERVE: bigint
export declare const MIN_STAKE: bigint
export declare function buildStakeBody(partnerCode: bigint | number): Cell
export declare function buildUnstakeBody(amount: bigint, owner: Address, mode?: UnstakeMode): Cell

export declare const TONSTAKERS_ADDRESS_MAP: Record<string, {
  pool: string
  jetton?: string
  partnerCode: bigint
  endpoints: {tonapi: string; withdrawalPayouts: string}
}>

export default class TonstakersProtocolTon extends StakingProtocol {
  constructor(account: StakingWalletAccount, config?: TonstakersProtocolConfig)
  getPoolData(): Promise<PoolData>
  getJettonWallet(): Promise<Address>
  getTokenBalance(): Promise<bigint>
  getInstantLiquidity(): Promise<bigint>
  getRates(): Promise<{rate: bigint; projectedRate: bigint}>
  getRewards(): Promise<Rewards | null>
  /** Always rejects: the pool settles bills itself. */
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<never>
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<never>
}
