import { bigintToNumber } from '@anywalletkit/core'
import { MAX_COMMISSION, MAX_WITHDRAW_ID, WITHDRAWAL_DELAY } from './constants.js'

const U64_MAX = 0xffff_ffff_ffff_ffffn

/** A validator id as the precompile takes it (uint64). Accepts bigint or a safe non-negative integer. */
export function toValidatorId(value: unknown, what = 'validator'): bigint {
  const ok = typeof value === 'bigint' || (typeof value === 'number' && Number.isSafeInteger(value))
  if (!ok) throw new Error(`${what} must be a validator id (bigint or safe integer), got ${String(value)}.`)
  const id = BigInt(value as bigint | number)
  if (id <= 0n || id > U64_MAX) throw new Error(`${what} ${id} is not a valid validator id (1..2^64-1).`)
  return id
}

/** A withdrawal slot (uint8). */
export function toWithdrawId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_WITHDRAW_ID) {
    throw new Error(`withdrawId must be an integer from 0 to ${MAX_WITHDRAW_ID}, got ${String(value)}.`)
  }
  return value
}

/**
 * Packs (validatorId, withdrawId) into one withdrawal-request id: `validatorId << 8 | withdrawId`,
 * so `claimWithdrawals({ ids })` never mixes up the same slot number on two validators.
 */
export function packWithdrawalId(validatorId: bigint, withdrawId: number): bigint {
  return (toValidatorId(validatorId) << 8n) | BigInt(toWithdrawId(withdrawId))
}

/** The inverse of {@link packWithdrawalId}. */
export function unpackWithdrawalId(id: bigint | number): { validatorId: bigint; withdrawId: number } {
  const v = typeof id === 'bigint' ? id : BigInt(id)
  if (v < 256n) throw new Error(`Withdrawal id ${v} does not name a validator.`)
  return { validatorId: v >> 8n, withdrawId: Number(v & 0xffn) }
}

/** Commission in the precompile's 1e18 scale → percent (5e16 → 5). */
export function commissionToPercent(commission: bigint): number {
  // Two decimals of a percent are exact in 1e14 steps; anything finer is display noise.
  const bps100 = (commission * 10_000n) / MAX_COMMISSION // hundredths of a percent
  return bigintToNumber(bps100) / 100
}

/** Percent → the precompile's 1e18 scale (5 → 5e16). */
export function percentToCommission(percent: number): bigint {
  if (!(percent >= 0 && percent <= 100)) throw new Error('Commission must be a percentage between 0 and 100.')
  return (BigInt(Math.round(percent * 10_000)) * MAX_COMMISSION) / 1_000_000n
}

/** The epoch a stake change made now takes effect in: n+1 before the boundary block, n+2 after it. */
export function activatesAtEpoch(epoch: { epoch: bigint; inEpochDelayPeriod: boolean }): bigint {
  return epoch.epoch + (epoch.inEpochDelayPeriod ? 2n : 1n)
}

/** The first epoch a withdrawal can be claimed in (its `withdrawEpoch` is when the stake deactivates). */
export function withdrawableAtEpoch(withdrawEpoch: bigint): bigint {
  return withdrawEpoch + WITHDRAWAL_DELAY
}
