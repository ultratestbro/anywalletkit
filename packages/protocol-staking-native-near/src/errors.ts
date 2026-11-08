import type { PoolRefusal } from './types.js'

/** Why a NEAR staking call was refused before anything was signed. */
export type NearStakingErrorCode =
  | 'wrong-chain'          // the account is not on the configured NEAR network
  | 'no-provider'          // no RPC: pass `provider`, or use a wallet-near account that has one
  | 'invalid-amount'       // not a positive bigint / safe integer
  | 'below-minimum'        // under MIN_STAKE
  | 'pool-required'        // several pools allowed, no default, and the call named none
  | 'pool-not-allowed'     // see `refusals`
  | 'exceeds-staked'       // unstake larger than the staked balance
  | 'timer-reset-refused'  // the unstake would restart the wait of a balance still unbonding; see NearUnstakeOptions.allowTimerReset
  | 'max-fee-exceeded'     // the fresh plan's fee is above the write's `maxFee`
  | 'nothing-staked'
  | 'not-withdrawable'     // unstaked balance still locked; see `unlock`
  | 'nothing-to-claim'
  | 'unknown-request'      // a claim id that matches no known pool
  | 'quote-changed'        // `expected` differs from the fresh plan
  | 'invalid-config'

/** A refusal with a code an app can branch on and a sentence it can show. */
export class NearStakingError extends Error {
  readonly code: NearStakingErrorCode
  /** For 'pool-not-allowed'. */
  readonly refusals: PoolRefusal[] | undefined
  /** Code-specific data (pool id, unlock estimate, the fresh transactions for 'quote-changed'…). */
  readonly details: Record<string, unknown> | undefined
  constructor(code: NearStakingErrorCode, message: string, extra: { refusals?: PoolRefusal[]; details?: Record<string, unknown>; cause?: unknown } = {}) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined)
    this.name = 'NearStakingError'
    this.code = code
    this.refusals = extra.refusals
    this.details = extra.details
  }
}
