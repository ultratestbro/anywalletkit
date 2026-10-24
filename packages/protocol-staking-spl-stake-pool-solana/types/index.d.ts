import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core"
import type {Address} from "@solana/addresses"
import type {Instruction} from "@solana/instructions"

export interface StakeOptions {
  /** SOL to deposit, in lamports. */
  amount: number | bigint
}

export interface StakeResult {
  hash: string
  fee: bigint
}

export type UnstakeMode = "instant" | "delayed"

export interface WithdrawalRequestOptions {
  /** Pool tokens to burn, in base units (9 decimals). */
  amount: number | bigint
  /** Accepted for interface parity; the pool token is the only staked form. */
  token?: string
  /** Exit path — default "delayed". */
  mode?: UnstakeMode
}

export interface WithdrawalRequestResult {
  hash: string
  fee: bigint
  /** Always null — a burn needs no approval. */
  approveHash: null
  /** Lamports the exit yields after the pool fee (paid now for instant, into the stake account for delayed). */
  amountOut: bigint
  /** The seed-derived stake account (delayed mode), else null. */
  stakeAccount: string | null
}

export type StakeActivation = "inactive" | "activating" | "active" | "deactivating"

export interface WithdrawalRequest {
  /** The unstake slot index. */
  id: bigint
  /** Lamports the stake account holds (rent included — all of it returns on claim). */
  amount: bigint
  /** Not knowable from state alone; always 0. */
  timestamp: number
  /** True once the stake account is fully inactive. */
  claimable: boolean
  address: string
  status: StakeActivation
  deactivationEpoch: bigint | null
}

export interface WithdrawalRequestsView {
  requests: WithdrawalRequest[]
  pendingAmount: bigint
  claimableAmount: bigint
  claimableIds: bigint[]
}

export interface ClaimWithdrawalsOptions {
  /** Slot indexes to claim; default every claimable one. */
  ids?: bigint[]
}

export interface ClaimWithdrawalsResult {
  hash: string
  fee: bigint
  /** Lamports swept back to the account. */
  amount: bigint
}

export interface StakedBalance {
  /** Pool tokens held (base units). */
  balance: bigint
  /** Always 0n. */
  wrappedBalance: bigint
  /** Lamports per pool token, 1e9 fixed point. */
  rate: bigint
  /** The position valued in lamports. */
  total: bigint
}

export interface StakePoolConfig {
  /** Short name; lower-cased into the seed of the wallet's unstake accounts. */
  name: string
  pool: string
  mint: string
  symbol: string
}

export interface PoolFee {
  denominator: bigint
  numerator: bigint
}

export interface StakePoolState {
  manager: Address
  staker: Address
  stakeDepositAuthority: Address
  validatorList: Address
  reserveStake: Address
  poolMint: Address
  managerFeeAccount: Address
  tokenProgram: Address
  totalLamports: bigint
  poolTokenSupply: bigint
  lastUpdateEpoch: bigint
  epochFee: PoolFee
  preferredDepositValidator: Address | null
  preferredWithdrawValidator: Address | null
  stakeDepositFee: PoolFee
  stakeWithdrawalFee: PoolFee
  stakeReferralFee: number
  solDepositAuthority: Address | null
  solDepositFee: PoolFee
  solReferralFee: number
  solWithdrawAuthority: Address | null
  solWithdrawalFee: PoolFee
  lastEpochPoolTokenSupply: bigint
  lastEpochTotalLamports: bigint
}

export type ValidatorStatus = "active" | "deactivatingTransient" | "readyForRemoval" | "deactivatingValidator" | "deactivatingAll"

export interface ValidatorStakeInfo {
  activeStakeLamports: bigint
  transientStakeLamports: bigint
  lastUpdateEpoch: bigint
  transientSeedSuffix: bigint
  validatorSeedSuffix: number
  status: ValidatorStatus
  voteAccount: Address
}

export interface StakeAccountData {
  state: "uninitialized" | "initialized" | "stake" | "rewardsPool"
  rentExemptReserve: bigint
  staker: Address | null
  withdrawer: Address | null
  delegation: {voter: Address; stake: bigint; activationEpoch: bigint; deactivationEpoch: bigint} | null
}

export interface WithdrawSource {
  kind: "validator" | "reserve"
  account: Address
  voteAccount: Address | null
  lamports: bigint
}

export interface PoolData {
  state: StakePoolState
  withdrawAuthority: string
  epoch: bigint
  /** Reconciled for the current epoch — deposits and exits go through. */
  updated: boolean
  /** Lamports per pool token now, 1e9 fixed point. */
  rate: bigint
  /** The same rate one epoch earlier. */
  previousRate: bigint
  totalLamports: bigint
  poolTokenSupply: bigint
  reserveLamports: bigint
  /** Reserve minus its rent — what instant exits can pay. */
  instantLiquidity: bigint
  rentExempt: bigint
  minimumDelegation: bigint
  /** Smallest delayed exit (lamports out) the stake program accepts. */
  minimumStakeLamports: bigint
  fees: {solDepositPct: number; solWithdrawalPct: number; stakeWithdrawalPct: number; epochPct: number}
}

export interface EpochInfo {
  epoch: bigint
  slotIndex: number
  slotsInEpoch: number
  /** 0..1 through the epoch. */
  progress: number
  /** Projected unix-ms of the epoch boundary. */
  endsAt: number
}

export interface StakeParams {
  rentExempt: bigint
  minimumDelegation: bigint
  minimumStakeLamports: bigint
}

export interface Rewards {
  earned: bigint
  entryRate: bigint
  deposited: bigint
  minted: bigint
  /** Unix seconds of the first deposit found, or null. */
  firstStakeAt: number | null
}

export interface RpcRequester {
  request(method: string, params?: unknown[]): Promise<unknown>
}

export interface SplStakePoolProtocolConfig {
  /** A key of SPL_STAKE_POOL_ADDRESS_MAP ("jito" by default) or an explicit pool. */
  pool?: string | StakePoolConfig
  /** JSON-RPC URL(s), a @solana/rpc client, or a `{request}` object; default the account's own RPC. */
  provider?: string | string[] | RpcRequester | object | Array<string | RpcRequester | object>
  commitment?: "processed" | "confirmed" | "finalized"
  slippageBps?: number
  computeUnitLimit?: number
  computeUnitPrice?: bigint | number
  unstakeSlots?: number
  /** Provider APY in percent (Jito stats, …); without it getApr estimates from the last two epochs. */
  apr?: () => Promise<number>
}

export interface IStakingProtocol {
  stake(options: StakeOptions): Promise<StakeResult>
  quoteStake(options: StakeOptions): Promise<Omit<StakeResult, "hash">>
  requestWithdrawal(options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult>
  quoteRequestWithdrawal(options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, "hash" | "approveHash">>
  getWithdrawalRequests(): Promise<WithdrawalRequestsView>
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult>
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, "hash">>
  getStakedBalance(): Promise<StakedBalance>
  getApr(): Promise<number>
}

export declare class StakingProtocol implements IStakingProtocol {
  constructor(account: unknown)
  protected _account: unknown
  stake(options: StakeOptions): Promise<StakeResult>
  quoteStake(options: StakeOptions): Promise<Omit<StakeResult, "hash">>
  requestWithdrawal(options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult>
  quoteRequestWithdrawal(options: WithdrawalRequestOptions): Promise<Omit<WithdrawalRequestResult, "hash" | "approveHash">>
  getWithdrawalRequests(): Promise<WithdrawalRequestsView>
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult>
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<Omit<ClaimWithdrawalsResult, "hash">>
  getStakedBalance(): Promise<StakedBalance>
  getApr(): Promise<number>
}

export declare const SPL_STAKE_POOL_ADDRESS_MAP: Record<string, StakePoolConfig>
export declare const DEFAULT_COMPUTE_UNIT_LIMIT: number
export declare const DEFAULT_COMPUTE_UNIT_PRICE: bigint
export declare const DEFAULT_SLIPPAGE_BPS: number
export declare const DEFAULT_UNSTAKE_SLOTS: number

export declare function parseDepositSol(tx: unknown, wallet: string, ata: string): {lamports: bigint; minted: bigint} | null
export declare function base58Decode(s: string): Uint8Array

/** Pure SPL Stake Pool mechanics: decoders, arithmetic, PDAs and instruction encoders. */
export declare namespace codec {
  const STAKE_POOL_PROGRAM: Address
  const STAKE_PROGRAM: Address
  const SYSTEM_PROGRAM: Address
  const TOKEN_PROGRAM: Address
  const ATA_PROGRAM: Address
  const COMPUTE_BUDGET_PROGRAM: Address
  const SYSVAR_CLOCK: Address
  const SYSVAR_STAKE_HISTORY: Address
  const STAKE_ACCOUNT_SPACE: number
  const POOL_MINIMUM_ACTIVE_STAKE: bigint
  function addressToBytes(address: string): Uint8Array
  function bytesToAddress(bytes: Uint8Array): Address
  function applyFee(fee: PoolFee, amount: bigint): bigint
  function feePercent(fee: PoolFee): number
  function decodeStakePool(data: Uint8Array): StakePoolState
  function decodeValidatorList(data: Uint8Array): {maxValidators: number; validators: ValidatorStakeInfo[]}
  function decodeStakeAccount(data: Uint8Array): StakeAccountData
  function stakeActivation(account: StakeAccountData, epoch: bigint): StakeActivation
  function poolTokensForLamports(pool: {totalLamports: bigint; poolTokenSupply: bigint}, lamports: bigint): bigint
  function lamportsForPoolTokens(pool: {totalLamports: bigint; poolTokenSupply: bigint}, poolTokens: bigint): bigint
  function poolRate(pool: {totalLamports: bigint; poolTokenSupply: bigint}): bigint
  function quoteDepositSol(pool: StakePoolState, lamports: bigint): {poolTokens: bigint; feeTokens: bigint}
  function quoteWithdrawSol(pool: StakePoolState, poolTokens: bigint): {lamports: bigint; feeTokens: bigint; burnt: bigint}
  function quoteWithdrawStake(pool: StakePoolState, poolTokens: bigint): {lamports: bigint; feeTokens: bigint; burnt: bigint}
  function minimumStakeLamports(rentExempt: bigint, minimumDelegation: bigint): bigint
  function findWithdrawAuthority(pool: string): Promise<Address>
  function findValidatorStakeAccount(pool: string, voteAccount: string, seedSuffix: number): Promise<Address>
  function findAta(owner: string, mint: string): Promise<Address>
  function unstakeSeed(poolName: string, index: number): string
  function findUnstakeAccount(wallet: string, poolName: string, index: number): Promise<Address>
  function ixSetComputeUnitLimit(units: number): Instruction
  function ixSetComputeUnitPrice(microLamports: bigint): Instruction
  function ixCreateAtaIdempotent(p: {payer: string; ata: string; owner: string; mint: string}): Instruction
  function ixDepositSol(p: {pool: string; state: StakePoolState; withdrawAuthority: string; from: string; destination: string; lamports: bigint; minimumPoolTokensOut?: bigint}): Instruction
  function ixWithdrawSol(p: {pool: string; state: StakePoolState; withdrawAuthority: string; owner: string; source: string; poolTokens: bigint; minimumLamportsOut?: bigint}): Instruction
  function ixWithdrawStake(p: {pool: string; state: StakePoolState; withdrawAuthority: string; owner: string; source: string; splitFrom: string; splitTo: string; poolTokens: bigint; minimumLamportsOut?: bigint}): Instruction
  function ixCreateAccountWithSeed(p: {from: string; newAccount: string; base: string; seed: string; lamports: bigint; space: bigint; owner: string}): Instruction
  function ixStakeDeactivate(p: {stake: string; authority: string}): Instruction
  function ixStakeWithdraw(p: {stake: string; recipient: string; authority: string; lamports: bigint}): Instruction
  function selectWithdrawSource(p: {pool: string; state: StakePoolState; validators: ValidatorStakeInfo[]; lamports: bigint; rentExempt: bigint; minimumDelegation: bigint; reserveLamports: bigint}): Promise<WithdrawSource>
}

export default class SplStakePoolProtocolSolana extends StakingProtocol {
  constructor(account: unknown, config?: SplStakePoolProtocolConfig)
  /** Recognize this module's transactions for a wallet's history; null for anything else. Pure and synchronous. */
  describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null
  readonly pool: StakePoolConfig
  getEpochInfo(): Promise<EpochInfo>
  getStakeParams(): Promise<StakeParams>
  getPoolData(): Promise<PoolData>
  getNativeBalance(): Promise<bigint>
  getTokenAccount(): Promise<string>
  getTokenBalance(): Promise<bigint>
  getInstantLiquidity(): Promise<bigint>
  getRewards(options?: {limit?: number}): Promise<Rewards | null>
  awaitConfirmation(hash: string, options?: {timeoutMs?: number; intervalMs?: number}): Promise<"confirmed" | "finalized">
  quoteStake(options: StakeOptions): Promise<{fee: bigint; amountOut: bigint}>
  requestWithdrawal(options: WithdrawalRequestOptions): Promise<WithdrawalRequestResult>
  quoteRequestWithdrawal(options: WithdrawalRequestOptions): Promise<{fee: bigint; amountOut: bigint; feeTokens: bigint}>
  claimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<ClaimWithdrawalsResult>
  quoteClaimWithdrawals(options?: ClaimWithdrawalsOptions): Promise<{fee: bigint; amount: bigint}>
  /** The message handed to the account: compute budget, then the operation. */
  protected _message(instructions: Instruction[]): {version: 0; instructions: Instruction[]}
  protected _rpc(method: string, params?: unknown[]): Promise<any>
  protected _getStakeInstructions(lamports: bigint): Promise<{instructions: Instruction[]; poolTokens: bigint}>
  protected _getUnstakeInstructions(poolTokens: bigint, mode: UnstakeMode): Promise<{instructions: Instruction[]; lamportsOut: bigint; feeTokens: bigint; stakeAccount: string | null; source: WithdrawSource | null}>
  protected _getClaimInstructions(ids?: bigint[]): Promise<{instructions: Instruction[]; lamports: bigint}>
}

export declare function describeStakePoolActivity(tx: ChainTx, ctx: DescribeActivityContext, instance?: {pool?: StakePoolConfig}): ActivityItem | null
export declare const INSTRUCTION_ACTIONS: Readonly<Record<number, {kind: ActivityItem['kind']; verb: string; mode: 'deposit' | 'instant' | 'delayed'}>>
