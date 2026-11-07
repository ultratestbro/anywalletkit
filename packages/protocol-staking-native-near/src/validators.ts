import { NetworkError, bigintToNumber } from '@anywalletkit/core'
import type { NearRpc } from '@anywalletkit/wallet-near'
import { TREASURY_ACCOUNT } from './constants.js'
import { u128 } from './rpc.js'

// The `validators` RPC: who produces this epoch and the next, their stake, production counts and
// last epoch's payouts. Parsed strictly (amounts must be decimal strings) so a malformed answer
// fails instead of turning into zeros.

/** One current validator's production this epoch. */
export interface ValidatorEntry {
  stake: bigint
  /** Average of the block, chunk and endorsement production rates that apply, percent; null when nothing was expected yet. */
  uptime: number | null
}

/** The parsed `validators` answer. */
export interface ValidatorSet {
  epochHeight: bigint
  epochStartHeight: bigint
  current: Map<string, ValidatorEntry>
  next: Map<string, bigint>
  /** `validator_reward_paid_prev_epoch`: total paid to each pool last epoch, yoctoNEAR (treasury.near included as the node reports it). */
  rewards: Map<string, bigint>
}

const count = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined)

function uptimeOf(v: Record<string, unknown>): number | null {
  const rates: number[] = []
  for (const kind of ['blocks', 'chunks', 'endorsements']) {
    const produced = count(v[`num_produced_${kind}`]), expected = count(v[`num_expected_${kind}`])
    if (produced !== undefined && expected !== undefined && expected > 0) rates.push(Math.min(1, produced / expected))
  }
  return rates.length === 0 ? null : (rates.reduce((s, r) => s + r, 0) / rates.length) * 100
}

/** Parses a `validators` RPC result. */
export function parseValidators(raw: unknown): ValidatorSet {
  const r = raw as Record<string, unknown> | null
  if (!r || typeof r !== 'object') throw new NetworkError('validators: empty answer')
  const height = count(r.epoch_height), start = count(r.epoch_start_height)
  if (height === undefined || start === undefined) throw new NetworkError('validators: no epoch_height / epoch_start_height')
  if (!Array.isArray(r.current_validators) || !Array.isArray(r.next_validators)) throw new NetworkError('validators: no validator lists')
  const current = new Map<string, ValidatorEntry>()
  for (const v of r.current_validators as Array<Record<string, unknown>>) {
    if (typeof v?.account_id !== 'string') continue
    current.set(v.account_id, { stake: u128(v.stake, `validators: stake of ${v.account_id}`), uptime: uptimeOf(v) })
  }
  const next = new Map<string, bigint>()
  for (const v of r.next_validators as Array<Record<string, unknown>>) {
    if (typeof v?.account_id !== 'string') continue
    next.set(v.account_id, u128(v.stake, `validators: next stake of ${v.account_id}`))
  }
  const rewards = new Map<string, bigint>()
  const paid = r.validator_reward_paid_prev_epoch
  if (paid && typeof paid === 'object') {
    for (const [id, amount] of Object.entries(paid as Record<string, unknown>)) rewards.set(id, u128(amount, `validators: reward of ${id}`))
  }
  return { epochHeight: BigInt(height), epochStartHeight: BigInt(start), current, next, rewards }
}

/** Reads and parses `validators [null]` (the current epoch). */
export async function readValidators(rpc: NearRpc): Promise<ValidatorSet> {
  return parseValidators(await rpc.fetch('validators', [null]))
}

const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000
const FIXED = 10n ** 18n

/** Epochs per year at a measured epoch duration. */
export const epochsPerYear = (epochMs: number): number => MS_PER_YEAR / epochMs

/** `reward / stake` annualized, percent; the ratio is taken in bigint fixed point so 10^30-scale amounts stay exact. */
export function annualize(reward: bigint, stake: bigint, epochMs: number): number {
  if (stake <= 0n || reward < 0n) return 0
  return (bigintToNumber((reward * FIXED) / stake) / 1e18) * epochsPerYear(epochMs) * 100
}

/** A pool's gross APR from last epoch's payout, before its fee; null without a reward entry (a pool new to the set). */
export function poolGrossApr(set: ValidatorSet, id: string, epochMs: number): number | null {
  const reward = set.rewards.get(id)
  const stake = set.current.get(id)?.stake ?? set.next.get(id) ?? 0n
  if (reward === undefined || stake === 0n) return null
  return annualize(reward, stake, epochMs)
}

/** Network gross APR: Σ rewards ÷ Σ stake over current validators with a reward entry, the treasury excluded. */
export function networkGrossApr(set: ValidatorSet, epochMs: number): { apr: number; totalStake: bigint; validators: number } {
  let rewards = 0n, staked = 0n, totalStake = 0n
  for (const [id, v] of set.current) {
    totalStake += v.stake
    if (id === TREASURY_ACCOUNT) continue
    const reward = set.rewards.get(id)
    if (reward === undefined) continue
    rewards += reward
    staked += v.stake
  }
  return { apr: annualize(rewards, staked, epochMs), totalStake, validators: set.current.size }
}
