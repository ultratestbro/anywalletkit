import type {
  ClaimWithdrawalsOptions, StakedBalance, StakeOptions, TransferResult, WithdrawalRequest, WithdrawalRequestOptions,
  WithdrawalRequestsView, WriteOptions,
} from '@anywalletkit/core'
import type { NearProvider, NearTransaction } from '@anywalletkit/wallet-near'
import type { LiquidPresetName } from './constants.js'

/** The NEAR network the module works on. */
export type NearNetwork = 'mainnet' | 'testnet'

// ── Config ───────────────────────────────────────────────────────────────────

/** A LiNEAR-family contract the app vouches for (same interface as linear-protocol.near). */
export interface LiquidPoolConfig {
  contract: string
  symbol: string
  name?: string
  /** code_hash values accepted for writes. Required: a contract upgrade is refused until the app pins the new build. */
  codeHashes: readonly string[]
}

/** Configuration of {@link LiquidStakingProtocolNear}. Only `pool` is required. */
export interface LiquidStakingNearConfig {
  /** `'linear'` (LiNEAR), `'rnear'` (Rhea rNEAR, mainnet only), or a family contract. Required. */
  pool: LiquidPresetName | LiquidPoolConfig
  /** Default: from the account's chain (`near:testnet` → testnet, else mainnet). */
  network?: NearNetwork
  /** RPC url(s) or transport(s); a list fails over. Default: the wallet-near account's own provider. */
  provider?: NearProvider | NearProvider[]
  /** Archival RPC for the APR's past price (default fastnear's archival endpoint for the network). */
  archivalProvider?: NearProvider | NearProvider[]
  /** Per-request timeout for url providers, ms (default 15 000). */
  timeoutMs?: number
  /** yoctoNEAR `stake` leaves on the account (default 0.02 NEAR); never less than one unstake's upfront gas. */
  reserve?: bigint | number
  /** Prepaid gas overrides (defaults: 30 Tgas each). All of it is bought upfront at min_gas_purchase_price: keep it small. */
  gas?: { stake?: bigint; unstake?: bigint; withdraw?: bigint }
  /** Replaces the price-based APR estimate (an app's or an indexer's figure), percent. */
  apr?: () => Promise<number> | number
  /** Epochs the APR estimate looks back over (default 24, ~7 days). */
  aprWindowEpochs?: number
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** The contract's state. Amounts in yoctoNEAR / token base units (24 decimals). */
export interface LiquidPoolInfo {
  contract: string
  symbol: string
  name: string
  decimals: 24
  /** yoctoNEAR per 1 whole token (`ft_price`, 10^24 = 1:1). */
  price: bigint
  /** NEAR staked by the contract (`get_summary.total_staked_near_amount`). */
  totalStaked: bigint
  /** Token supply (`get_summary.total_share_amount`). */
  totalShares: bigint
  validators: number
  /** `is_paused`; a missing method counts as paused. */
  paused: boolean
  codeHash: string
  /** The live code hash is one the module (or the app's config) pins. */
  codeHashKnown: boolean
  /** The contract's liquid balance (view_account.amount): what withdrawals are paid from. */
  liquidity: bigint
  /** What the contract cannot pay out: max(1 NEAR, its storage cost). A withdrawal needs liquidity − kept ≥ amount. */
  kept: bigint
  /** Protocol fee on rewards, basis points (sum of `get_beneficiaries`). */
  feeBps: number
}

/** The account in the contract (`get_account_details` + `ft_balance_of` + `storage_balance_of`). */
export interface LiquidAccountDetails {
  /** LST held, token base units. */
  shares: bigint
  /** `shares` valued in NEAR at the current price. */
  value: bigint
  /** NEAR unstaked and waiting (or ready) in the contract. */
  unstaked: bigint
  /** Epoch the unstaked balance unlocks at (exact, from the contract). */
  unlockEpoch: bigint
  /** The contract's own flag: unlock epoch reached. */
  canWithdraw: boolean
  /** NEP-145 registered (can receive the token by transfer). */
  registered: boolean
}

/** The epoch clock. Heights are block heights; times are unix ms estimates. */
export interface NearEpoch {
  height: bigint
  startBlock: bigint
  length: bigint
  block: bigint
  blocksLeft: bigint
  startedAt: number
  epochMs: number
  endsAt: number
}

/** When an unstaked balance becomes withdrawable (same shape as the native module's). */
export interface UnlockEstimate {
  epoch: bigint | null
  earliestEpoch: bigint
  latestEpoch: bigint | null
  at: number | null
  earliestAt: number
  latestAt: number | null
  source: 'history' | 'contract' | 'estimate'
}

/** Tonstakers-style balance: `balance` = token, `rate` = price (1e24), `total` = NEAR value. */
export interface LiquidStakedBalance extends StakedBalance {
  unstaked: bigint
  /** Unstaked, unlocked and payable now (contract liquidity checked). */
  withdrawable: bigint
  price: bigint
}

// ── Writes ───────────────────────────────────────────────────────────────────

export type LiquidStakingWarningCode =
  | 'resets-unbonding-timer'    // a locked unstaked balance restarts its timer (only with allowTimerReset)
  | 'withdraws-unlocked-first'  // the unlocked balance is withdrawn in the same transaction
  | 'relocks-unlocked'          // the unlocked balance cannot be paid now (liquidity) and would lock again: refused unless allowRelock
  | 'unlock-may-be-later'       // the contract may add epochs (large amounts, after settlement): the exact epoch is known after the unstake

export interface LiquidStakingWarning {
  code: LiquidStakingWarningCode
  message: string
}

/** Options every write shares. */
export interface LiquidWriteOptions extends WriteOptions {
  /** The `transactions` of the confirmed quote; the write refuses with `quote-changed` when the fresh plan differs. */
  expected?: NearTransaction[]
}

export interface LiquidStakeOptions extends StakeOptions, LiquidWriteOptions {}

export interface LiquidStakeQuote {
  /** Upper bound of the network fee, yoctoNEAR (all gas burnt, at the gas price + 10 %). Passes as `maxFee`. */
  fee: bigint
  /**
   * NEAR the node holds back when it accepts the transaction, beside the deposit: the prepaid gas,
   * bought at min_gas_purchase_price. The unburnt part comes back a few blocks later.
   */
  upfront: bigint
  /** NEAR the stake leaves on the account: the configured reserve, but at least one unstake's `upfront`. */
  reserve: bigint
  amount: bigint
  /** Tokens expected for `amount` at the current price (rounded down). */
  shares: bigint
  price: bigint
  apr: number | null
  /** available − reserve − upfront (never below 0). */
  maxStakeable: bigint
  /** One transaction: a single `deposit_and_stake` (it registers the account itself; no storage_deposit). */
  transactions: NearTransaction[]
  warnings: LiquidStakingWarning[]
}
export interface LiquidStakeResult extends LiquidStakeQuote {
  hash: string
  hashes: string[]
}

export interface LiquidUnstakeOptions extends Omit<WithdrawalRequestOptions, 'amount' | 'token'>, LiquidWriteOptions {
  /** Token base units to unstake, or `'all'` (`unstake_all`). */
  amount: bigint | number | 'all'
  /** Accept that an unlocked balance the contract cannot pay now locks again (default false: refused). */
  allowRelock?: boolean
  /**
   * Accept that an unstaked balance still unbonding restarts its wait (4+ epochs) together with this
   * amount (default false: refused with 'timer-reset-refused'). Never accepted below MIN_STAKE.
   */
  allowTimerReset?: boolean
}

export interface LiquidUnstakeQuote {
  fee: bigint
  /** See {@link LiquidStakeQuote.upfront}: the account must hold this much NEAR to send the unstake. */
  upfront: bigint
  /** Tokens burnt (for 'all': the whole balance). */
  shares: bigint
  /** NEAR moving to unstaked: what `unstake(amount)` is called with (shares × price, rounded down). */
  amount: bigint
  /** The request id: `poolRequestId(contract)`. */
  id: bigint
  withdrawsFirst: bigint
  resetsTimer: boolean
  /** Unlocked NEAR that locks again because the contract cannot pay it now (only with allowRelock). */
  relocks: bigint
  /** earliest = current + 4; latestEpoch null (the contract decides); exact after the unstake via getAccountDetails. */
  unlock: UnlockEstimate
  transactions: NearTransaction[]
  warnings: LiquidStakingWarning[]
}
export interface LiquidUnstakeResult extends LiquidUnstakeQuote {
  hash: string
  hashes: string[]
  approveHash: null
}

/** The account's unstaked balance as one request. */
export interface LiquidWithdrawalRequest extends WithdrawalRequest {
  contract: string
  unlockEpoch: bigint
  /** Unlocked, but the contract's liquidity is below amount + `kept`: waiting for the epoch_withdraw bot. */
  awaitingLiquidity: boolean
  unlock: UnlockEstimate | null
}
export type LiquidWithdrawalRequestsView = Omit<WithdrawalRequestsView, 'requests'> & { requests: LiquidWithdrawalRequest[] }

export interface LiquidClaimOptions extends ClaimWithdrawalsOptions, LiquidWriteOptions {}
export interface LiquidClaimQuote {
  fee: bigint
  /** See {@link LiquidStakeQuote.upfront}. */
  upfront: bigint
  amount: bigint
  /** One `withdraw_all` transaction. */
  transactions: NearTransaction[]
}
export interface LiquidClaimResult extends LiquidClaimQuote {
  hash: string
  hashes: string[]
}

/** Optional account hook: several transactions with one approval (wallet-selector's signAndSendTransactions). */
export interface NearTransactionsSender {
  sendTransactions(transactions: NearTransaction[], options?: WriteOptions): Promise<TransferResult[]>
}
