// scrvUSD yield maths, bigint until the final display figure.
//
// VaultV3 does not pay profit out at report time: a report locks the profit as shares held by
// the vault and burns them linearly until `fullProfitUnlockDate` (profitMaxUnlockTime = 7 days
// for scrvUSD), which raises the price per share continuously. `profitUnlockingRate` is the
// burn rate in shares per second scaled by MAX_BPS_EXTENDED (1e12). While unlocking runs,
//   APR = profitUnlockingRate / 1e12 × seconds per year / totalSupply
// and APY = e^APR − 1 (continuous). It is a projection from the latest weekly report and moves
// with every deposit (totalSupply), so it only means something together with the block it was
// read at. After `fullProfitUnlockDate` nothing unlocks until the next report: 0.
import { bigintToNumber } from '@anywalletkit/core'

export const WAD = 10n ** 18n
export const MAX_BPS_EXTENDED = 10n ** 12n
export const SECONDS_PER_YEAR = 31_536_000n

export interface UnlockState {
  profitUnlockingRate: bigint
  fullProfitUnlockDate: bigint
  totalSupply: bigint
  /** Unix seconds (the block's timestamp). */
  now: bigint
}

/** Projected APR, WAD-scaled (1e18 = 100 %). */
export function scrvUsdAprWad(s: UnlockState): bigint {
  if (s.totalSupply === 0n || s.fullProfitUnlockDate <= s.now) return 0n
  return (s.profitUnlockingRate * SECONDS_PER_YEAR * WAD) / (MAX_BPS_EXTENDED * s.totalSupply)
}

/** WAD APR → continuously compounded APY in percent (display only). */
export function aprWadToApyPct(aprWad: bigint): number {
  return (Math.exp(bigintToNumber(aprWad) / 1e18) - 1) * 100
}

/** How far an API APY may sit from the on-chain projection before it is clamped: 0.5 percentage points or 10 % of it, whichever is larger. */
export const APY_TOLERANCE = { absolutePct: 0.5, relative: 0.1 } as const

/**
 * Bounds an API APY by the on-chain one: inside the tolerance band it stands, outside it is
 * clamped to the band's edge, and a missing API figure gives the on-chain one.
 */
export function clampApy(apiPct: number | null, chainPct: number): { apy: number; source: 'api' | 'api-clamped' | 'chain' } {
  if (apiPct === null || !Number.isFinite(apiPct)) return { apy: chainPct, source: 'chain' }
  const tol = Math.max(APY_TOLERANCE.absolutePct, Math.abs(chainPct) * APY_TOLERANCE.relative)
  const lo = Math.max(0, chainPct - tol), hi = chainPct + tol
  if (apiPct >= lo && apiPct <= hi) return { apy: apiPct, source: 'api' }
  return { apy: apiPct < lo ? lo : hi, source: 'api-clamped' }
}
