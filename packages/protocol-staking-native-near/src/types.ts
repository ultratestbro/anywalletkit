import type {
  ClaimWithdrawalsOptions, HistorySource, StakedBalance, StakeOptions, TransferResult, WithdrawalRequest, WithdrawalRequestOptions,
  WithdrawalRequestsView, WriteOptions,
} from '@anywalletkit/core'
import type { NearProvider, NearTransaction } from '@anywalletkit/wallet-near'
import type { PoolFactory } from './constants.js'

/** The NEAR network the module works on. */
export type NearNetwork = 'mainnet' | 'testnet'

// ── Config ───────────────────────────────────────────────────────────────────

/** A pool the app allows, by account id (e.g. "astro-stakers.poolv1.near"), optionally named. */
export interface PoolConfig {
  id: string
  name?: string
}

/**
 * Which pools the module stakes into: a list of pool ids (or `{ id, name }`), or `'any'` for a wallet
 * whose users pick from the validator set. Required: there is no default list. Either way every
 * pool must be a factory pool (`*.poolv1.near` / `*.pool.near`, testnet `*.pool.f863973.m0`) with a
 * known code hash.
 */
export type PoolsOption = 'any' | ReadonlyArray<string | PoolConfig>

/** The validated `pools` option. */
export type NormalizedPools = 'any' | Array<{ id: string; name?: string }>

/** Extra data an app attaches to pools (an explorer's APR, a name, a logo, a country). */
export interface PoolExtra {
  /** APR in percent; replaces the module's estimate. */
  apr?: number
  name?: string
  logo?: string
  [key: string]: unknown
}

/** Supplies {@link PoolExtra} per pool id. */
export type PoolEnricher = (ids: string[]) => Promise<Record<string, PoolExtra>> | Record<string, PoolExtra>

/** Finds the pools an account has delegated to (for positions outside the configured list). */
export type PoolDiscovery = (accountId: string) => Promise<string[]>

/** Configuration of {@link NativeStakingProtocolNear}. Only `pools` is required. */
export interface NativeStakingNearConfig {
  /** Pool ids to stake into, or `'any'`. Required. */
  pools: PoolsOption
  /** Used when a call names no pool. A single-entry list is its own default. */
  defaultPool?: string
  /** Refuse pools whose reward fee is above this, percent (default 10). Read fresh at every write. */
  maxFee?: number
  /** Allow pools outside the current or next validator set (default false: their stake earns nothing). */
  allowInactive?: boolean
  /** Refuse pools whose uptime in the current epoch is below this, percent (default 0: off). */
  minUptime?: number
  /** Default: from the account's chain (`near:testnet` → testnet, else mainnet). */
  network?: NearNetwork
  /** RPC url(s) or transport(s); a list fails over. Default: the wallet-near account's own provider. */
  provider?: NearProvider | NearProvider[]
  /** Per-request timeout for url providers, ms (default 15 000). */
  timeoutMs?: number
  /** yoctoNEAR `stake` leaves on the account for gas and storage (default 0.02 NEAR). */
  reserve?: bigint | number
  /** Prepaid gas overrides (defaults: stake 50 Tgas, unstake 50 Tgas, withdraw 125 Tgas). */
  gas?: { stake?: bigint; unstake?: bigint; withdraw?: bigint }
  /** More staking-pool code hashes to accept, on top of KNOWN_POOL_CODE_HASHES (the app vouches for them). */
  codeHashes?: readonly string[]
  /** Adds data to pools (APR, names, logos). */
  enrich?: PoolEnricher
  /**
   * How positions outside the configured pools are found: `'fastnear'` (default) asks
   * api.fastnear.com (test.api.fastnear.com on testnet) which pools the account delegated to; a
   * function is the app's own lookup; `false` reads only listed pools and the `pools` passed to a call.
   * Discovered ids that are not factory pools are dropped without a read.
   */
  discover?: 'fastnear' | PoolDiscovery | false
  /** History of the account (e.g. wallet-near's createNearHistory): dates the last unstake for exact unlock epochs. */
  history?: HistorySource
  /** Reads in flight at once (default 4). */
  concurrency?: number
}

// ── Pools ────────────────────────────────────────────────────────────────────

/** Why a pool cannot take new stake (or be written to) right now. */
export type PoolRefusal =
  | 'not-listed'          // `pools` is a list and this id is not in it
  | 'not-factory-pool'    // the id has no staking-pool factory suffix
  | 'not-found'           // the account does not exist
  | 'unknown-code'        // its code_hash is not a known staking-pool build
  | 'pause-unknown'       // is_staking_paused is missing or failed: treated as paused
  | 'paused'
  | 'fee-unknown'         // get_reward_fee_fraction is missing or malformed
  | 'fee-above-max'
  | 'not-in-current-set'  // not producing this epoch (allowInactive lifts it)
  | 'not-in-next-set'     // leaving the set next epoch (allowInactive lifts it)
  | 'low-uptime'          // below `minUptime`

/** A staking pool as the chain reports it, with the module's verdict. Amounts in yoctoNEAR. */
export interface NearPoolInfo {
  id: string
  /** From the config or `enrich`. */
  name: string | null
  /** Factory by suffix; null for a non-factory id. */
  factory: PoolFactory | null
  /** True when code hash, fee and pause were read live (`getPool` / `getPools`); false in `listPools`. */
  details: boolean
  codeHash: string | null
  codeHashKnown: boolean | null
  /** Reward fee as the pool reports it (`get_reward_fee_fraction`). */
  fee: { numerator: number; denominator: number } | null
  feePercent: number | null
  /** `is_staking_paused`; null when not read or missing (a missing method is the 'pause-unknown' refusal). */
  paused: boolean | null
  /** Stake in the current validator set (0n when not in it). */
  stake: bigint
  inCurrentSet: boolean
  inNextSet: boolean
  /** Produced / expected blocks and chunks this epoch, percent; null when not in the current set. */
  uptime: number | null
  /** The pool's last-epoch reward ÷ its stake, annualized, before its fee, percent (`validator_reward_paid_prev_epoch`); null without data. */
  grossApr: number | null
  /** Delegator APR in percent: `enrich`'s, else `grossApr` after the fee, else the network average after the fee. Null until the fee is read (light listings). */
  apr: number | null
  aprSource: 'enrich' | 'protocol' | 'network' | null
  listed: boolean
  /** Can take new stake now: no refusals. */
  eligible: boolean
  refusals: PoolRefusal[]
  extra?: PoolExtra
}

/** Network figures behind the APR estimates. */
export interface NearNetworkStats {
  validators: number
  /** Total stake of the current set, yoctoNEAR. */
  totalStake: bigint
  /** Measured duration of the previous epoch, ms. */
  epochMs: number
  epochsPerYear: number
  /** Network gross APR before pool fees, percent (treasury.near excluded). */
  apr: number
}

// ── Epochs ───────────────────────────────────────────────────────────────────

/** The epoch clock. Heights are block heights; times are unix ms estimates. */
export interface NearEpoch {
  /** epoch_height. */
  height: bigint
  /** First block height of the epoch. */
  startBlock: bigint
  /** Epoch length in block heights (43 200). */
  length: bigint
  /** Latest final block height. */
  block: bigint
  blocksLeft: bigint
  /** Unix ms of the epoch's first block. */
  startedAt: number
  /** Measured duration of the previous epoch, ms (~6.9 h). */
  epochMs: number
  /** Unix ms estimate of the epoch's end. */
  endsAt: number
}

/** When an unstaked balance becomes withdrawable. */
export interface UnlockEstimate {
  /** Exact unlock epoch when known (from history, or from the contract for liquid staking). */
  epoch: bigint | null
  /** Earliest possible unlock epoch. */
  earliestEpoch: bigint
  /** Latest possible unlock epoch; null when no upper bound is known. */
  latestEpoch: bigint | null
  /** Unix ms estimates of the epochs above. */
  at: number | null
  earliestAt: number
  latestAt: number | null
  /** 'history': dated by the account's last unstake; 'contract': read from the contract; 'estimate': bounds only. */
  source: 'history' | 'contract' | 'estimate'
}

// ── Positions ────────────────────────────────────────────────────────────────

/** Something about a pool the account is already in that the app should show. */
export type PositionWarning = 'pool-fee-above-max' | 'pool-paused' | 'pool-leaving-set' | 'pool-not-in-set'

/** The account's position in one pool (`get_account`). Amounts in yoctoNEAR. */
export interface NearPoolPosition {
  pool: string
  name: string | null
  staked: bigint
  unstaked: bigint
  /** The pool's own `can_withdraw` flag. */
  canWithdraw: boolean
  /** Unstaked and withdrawable now (`canWithdraw ? unstaked : 0n`). */
  withdrawable: bigint
  /** For a locked unstaked balance; null when there is none or it is withdrawable. */
  unlock: UnlockEstimate | null
  /** Light pool info (from the validator set) plus the fee read for the position check. */
  poolInfo: NearPoolInfo | null
  warnings: PositionWarning[]
}

/** {@link StakedBalance} across pools: `balance` = staked, `total` = staked + unstaked. */
export interface NearStakedBalance extends StakedBalance {
  unstaked: bigint
  withdrawable: bigint
  positions: NearPoolPosition[]
}

// ── Writes ───────────────────────────────────────────────────────────────────

/** Codes of the warnings a quote carries for the confirmation screen. */
export type NearStakingWarningCode =
  | 'resets-unbonding-timer'    // a locked unstaked balance in the pool restarts its 4-epoch timer
  | 'withdraws-unlocked-first'  // the unlocked balance is withdrawn in the same transaction ([withdraw_all, unstake])
  | 'apr-network-fallback'      // the pool has no reward data yet: APR is the network average
  | 'pool-fee-above-max'        // (positions) the pool raised its fee after the stake

export interface NearStakingWarning {
  code: NearStakingWarningCode
  message: string
}

/** Options every write shares. */
export interface NearWriteOptions extends WriteOptions {
  /**
   * The `transactions` of the quote the user confirmed. The write re-plans with fresh reads and
   * refuses with `quote-changed` when the result differs, so the signer signs what was shown.
   */
  expected?: NearTransaction[]
}

export interface NearStakeOptions extends StakeOptions, NearWriteOptions {
  /** Pool id; default `defaultPool`. */
  pool?: string
}

export interface NearStakeQuote {
  /** Upper bound of the network fee, yoctoNEAR (prepaid gas × gas price; unused gas is refunded). */
  fee: bigint
  amount: bigint
  /** The pool, read live (`details: true`). */
  pool: NearPoolInfo
  apr: number | null
  /** What `stake` can send now: available − reserve − fee (never below 0). */
  maxStakeable: bigint
  /** Exactly what `stake` sends: receiverId + actions, no signer / nonce / block hash. */
  transactions: NearTransaction[]
  warnings: NearStakingWarning[]
}
export interface NearStakeResult extends NearStakeQuote {
  hash: string
  hashes: string[]
}

export interface NearUnstakeOptions extends Omit<WithdrawalRequestOptions, 'amount' | 'token'>, NearWriteOptions {
  /** yoctoNEAR of staked balance to unstake, or `'all'` (`unstake_all`). */
  amount: bigint | number | 'all'
  /** Pool id; default `defaultPool`, or the only pool with a staked balance. */
  pool?: string
}

export interface NearUnstakeQuote {
  fee: bigint
  /** yoctoNEAR moving from staked to unstaked (for 'all': the current staked balance). */
  amount: bigint
  pool: string
  /** The request's id for `claimWithdrawals({ ids })`: `poolRequestId(pool)`. */
  id: bigint
  /** Unlocked unstaked balance withdrawn first in the same transaction (0n when none). */
  withdrawsFirst: bigint
  /** A locked unstaked balance exists and its timer restarts. */
  resetsTimer: boolean
  /** Unlock of the whole unstaked balance after this unstake (epoch = current + 4). */
  unlock: UnlockEstimate
  transactions: NearTransaction[]
  warnings: NearStakingWarning[]
}
export interface NearUnstakeResult extends NearUnstakeQuote {
  hash: string
  hashes: string[]
  approveHash: null
}

/** One pool's unstaked balance as a withdrawal request (a pool keeps one balance per account). */
export interface NearWithdrawalRequest extends WithdrawalRequest {
  pool: string
  /** Null when claimable. */
  unlock: UnlockEstimate | null
}
export type NearWithdrawalRequestsView = Omit<WithdrawalRequestsView, 'requests'> & { requests: NearWithdrawalRequest[] }

export interface NearClaimOptions extends ClaimWithdrawalsOptions, NearWriteOptions {
  /** Also look at these pools (besides the listed and discovered ones). */
  pools?: string[]
}
export interface NearClaimQuote {
  fee: bigint
  amount: bigint
  claims: Array<{ id: bigint; pool: string; amount: bigint }>
  /** One `withdraw_all` transaction per pool. */
  transactions: NearTransaction[]
}
export interface NearClaimResult extends NearClaimQuote {
  hash: string
  hashes: string[]
}

// ── External signers ────────────────────────────────────────────────────────

/**
 * Optional account hook: sign and send several transactions with one approval (wallet-selector's
 * `signAndSendTransactions`). Writes that need more than one transaction use it when present.
 */
export interface NearTransactionsSender {
  sendTransactions(transactions: NearTransaction[], options?: WriteOptions): Promise<TransferResult[]>
}
