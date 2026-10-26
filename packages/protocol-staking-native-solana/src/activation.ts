import type { ClusterStake, Delegation } from './codec.js'
import { U64_MAX } from './constants.js'

// Stake warm-up and cool-down, the same rules as solana-program/stake
// (`Delegation::stake_activating_and_deactivating_v2` and `warmup_cooldown_allowance.rs`). It
// is integer math: bigint here, u128 with saturation there, so results match the program to the
// lamport. Each epoch a delegation may move its share of `rate × cluster effective stake`; the
// share is its part of all stake activating (or deactivating) in the previous epoch.

/** How much of a delegation is effective, still activating, or cooling down at an epoch. */
export interface ActivationStatus { effective: bigint; activating: bigint; deactivating: bigint }

/** Where a stake account is in its lifecycle. `inactive` means nothing is delegated and every lamport can be withdrawn. */
export type StakeStatus = 'activating' | 'active' | 'deactivating' | 'inactive'

/** Cluster stake per epoch (the StakeHistory sysvar). */
export type StakeHistory = ReadonlyMap<bigint, ClusterStake>

const BPS = 10_000n
const ORIGINAL_RATE_BPS = 2_500n
const TOWER_RATE_BPS = 900n
const U128_MAX = (1n << 128n) - 1n

/** Warm-up / cool-down rate in basis points: 25 % before the `reduce_stake_warmup_cooldown` epoch, 9 % from it on. */
export function warmupCooldownRateBps(epoch: bigint, rateChangeEpoch: bigint | null): bigint {
  return rateChangeEpoch !== null && epoch >= rateChangeEpoch ? TOWER_RATE_BPS : ORIGINAL_RATE_BPS
}

const satMul = (a: bigint, b: bigint): bigint => (a * b > U128_MAX ? U128_MAX : a * b)

function allowance(epoch: bigint, accountPortion: bigint, clusterPortion: bigint, clusterEffective: bigint, rateChangeEpoch: bigint | null): bigint {
  if (accountPortion === 0n || clusterPortion === 0n || clusterEffective === 0n) return 0n
  const numerator = satMul(satMul(accountPortion, clusterEffective), warmupCooldownRateBps(epoch, rateChangeEpoch))
  const delta = numerator / satMul(clusterPortion, BPS)
  return delta < accountPortion ? delta : accountPortion
}

function effectiveAndActivating(d: Delegation, target: bigint, history: StakeHistory, rateChangeEpoch: bigint | null): [bigint, bigint] {
  const delegated = d.stake
  if (d.activationEpoch === U64_MAX) return [delegated, 0n] // bootstrap stake
  if (d.activationEpoch === d.deactivationEpoch) return [0n, 0n] // deactivated within its activation epoch
  if (target === d.activationEpoch) return [0n, delegated]
  if (target < d.activationEpoch) return [0n, 0n]
  let prev = history.get(d.activationEpoch)
  if (!prev) return [delegated, 0n] // older than the history: fully effective
  let prevEpoch = d.activationEpoch
  let activated = 0n
  for (;;) {
    const epoch = prevEpoch + 1n
    if (prev.activating === 0n) break
    const step = allowance(epoch, delegated - activated, prev.activating, prev.effective, rateChangeEpoch)
    activated += step > 0n ? step : 1n
    if (activated >= delegated) { activated = delegated; break }
    if (epoch >= target || epoch >= d.deactivationEpoch) break
    const next = history.get(epoch)
    if (!next) break
    prevEpoch = epoch
    prev = next
  }
  return [activated, delegated - activated]
}

/** Effective, activating and deactivating stake of a delegation at `target` epoch. */
export function activationStatus(d: Delegation, target: bigint, history: StakeHistory, rateChangeEpoch: bigint | null): ActivationStatus {
  const [effective, activating] = effectiveAndActivating(d, target, history, rateChangeEpoch)
  if (target < d.deactivationEpoch) return { effective, activating, deactivating: 0n }
  if (target === d.deactivationEpoch) return { effective, activating: 0n, deactivating: effective }
  let prev = history.get(d.deactivationEpoch)
  if (!prev) return { effective: 0n, activating: 0n, deactivating: 0n } // older than the history: fully deactivated
  let prevEpoch = d.deactivationEpoch
  let remaining = effective
  for (;;) {
    const epoch = prevEpoch + 1n
    if (prev.deactivating === 0n) break
    const step = allowance(epoch, remaining, prev.deactivating, prev.effective, rateChangeEpoch)
    remaining = remaining > (step > 0n ? step : 1n) ? remaining - (step > 0n ? step : 1n) : 0n
    if (remaining === 0n) break
    if (epoch >= target) break
    const next = history.get(epoch)
    if (!next) break
    prevEpoch = epoch
    prev = next
  }
  return { effective: remaining, activating: 0n, deactivating: remaining }
}

/** The lifecycle label of an activation status (a non-delegated account is `inactive`). */
export function statusOf(s: ActivationStatus | null): StakeStatus {
  if (!s) return 'inactive'
  if (s.deactivating > 0n) return 'deactivating'
  if (s.activating > 0n) return 'activating'
  if (s.effective > 0n) return 'active'
  return 'inactive'
}

/**
 * The first epoch at which the account settles — fully active after a delegation, fully inactive
 * after a deactivation — projected by replaying the latest known cluster stake. Returns the current
 * epoch when it has already settled and null when the projection does not settle within `horizon`
 * epochs (only when a large share of the whole cluster is moving at once).
 */
export function settlesAt(d: Delegation, current: bigint, history: StakeHistory, rateChangeEpoch: bigint | null, horizon = 16): bigint | null {
  const settled = (s: ActivationStatus) => (d.deactivationEpoch === U64_MAX ? s.activating === 0n : s.deactivating === 0n && s.effective === 0n)
  if (settled(activationStatus(d, current, history, rateChangeEpoch))) return current
  let latestEpoch = -1n
  for (const e of history.keys()) if (e > latestEpoch) latestEpoch = e
  const latest = history.get(latestEpoch)
  if (!latest) return current + 1n
  // Extend the history with the latest entry for the epochs it does not cover yet.
  const projected = new Map(history)
  for (let e = latestEpoch + 1n; e <= current + BigInt(horizon); e++) projected.set(e, latest)
  for (let e = current + 1n; e <= current + BigInt(horizon); e++) {
    if (settled(activationStatus(d, e, projected, rateChangeEpoch))) return e
  }
  return null
}
