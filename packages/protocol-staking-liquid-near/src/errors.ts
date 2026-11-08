/** Why a liquid staking call was refused before anything was signed. */
export type LiquidStakingErrorCode =
  | 'wrong-chain'           // the account is not on the configured NEAR network
  | 'no-provider'
  | 'unsupported-network'   // the preset has no contract on this network (rNEAR on testnet)
  | 'invalid-amount'
  | 'below-minimum'
  | 'unknown-contract-code' // the contract's live code_hash is not pinned
  | 'contract-paused'       // is_paused true or missing, or a feature the plan calls paused (pa_all_paused)
  | 'exceeds-balance'       // unstake larger than the token balance
  | 'nothing-staked'
  | 'relock-refused'        // see LiquidUnstakeOptions.allowRelock
  | 'timer-reset-refused'   // see LiquidUnstakeOptions.allowTimerReset
  | 'max-fee-exceeded'      // the fresh plan's fee is above the write's `maxFee`
  | 'not-withdrawable'      // unlock epoch not reached; see `details.unlock`
  | 'awaiting-liquidity'    // unlocked, but the contract cannot pay yet
  | 'nothing-to-claim'
  | 'unknown-request'
  | 'quote-changed'
  | 'invalid-config'

/** A refusal with a code an app can branch on and a sentence it can show. */
export class LiquidStakingError extends Error {
  readonly code: LiquidStakingErrorCode
  readonly details: Record<string, unknown> | undefined
  constructor(code: LiquidStakingErrorCode, message: string, extra: { details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined)
    this.name = 'LiquidStakingError'
    this.code = code
    this.details = extra.details
  }
}
