// Morpho Blue maths, ported from morpho-blue `SharesMathLib`, `MathLib`,
// `MarketParamsLib` and `Morpho._accrueInterest`, so positions and rates read
// off-chain match what the contract computes on the next touch.
import { bigintToNumber } from '@anywalletkit/core'
import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem'

export const WAD = 10n ** 18n
export const VIRTUAL_SHARES = 10n ** 6n
export const VIRTUAL_ASSETS = 1n
export const ORACLE_PRICE_SCALE = 10n ** 36n
export const SECONDS_PER_YEAR = 31_536_000

export interface MarketParams { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint }
export interface MarketState { totalSupplyAssets: bigint; totalSupplyShares: bigint; totalBorrowAssets: bigint; totalBorrowShares: bigint; lastUpdate: bigint; fee: bigint }

const mulDivDown = (x: bigint, y: bigint, d: bigint) => (x * y) / d
const mulDivUp = (x: bigint, y: bigint, d: bigint) => (x * y + (d - 1n)) / d

export const toSharesDown = (assets: bigint, totalAssets: bigint, totalShares: bigint) => mulDivDown(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)
export const toAssetsDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) => mulDivDown(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)
export const toSharesUp = (assets: bigint, totalAssets: bigint, totalShares: bigint) => mulDivUp(assets, totalShares + VIRTUAL_SHARES, totalAssets + VIRTUAL_ASSETS)
export const toAssetsUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) => mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES)

/** Third-order Taylor expansion of e^(x·n) − 1, as Morpho compounds interest. */
export function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const firstTerm = x * n
  const secondTerm = mulDivDown(firstTerm, firstTerm, 2n * WAD)
  const thirdTerm = mulDivDown(secondTerm, firstTerm, 3n * WAD)
  return firstTerm + secondTerm + thirdTerm
}

/** `Id` = keccak256(abi.encode(marketParams)). */
export function marketId(p: MarketParams): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
    [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
  ))
}

/**
 * The market state after the interest Morpho would accrue at `now` (what
 * `accrueInterest` does): borrow and supply assets grow by the compounded
 * borrow rate, the fee's share of the interest mints supply shares.
 */
export function accrue(m: MarketState, borrowRate: bigint, now: bigint): MarketState {
  const elapsed = now - m.lastUpdate
  if (elapsed <= 0n || borrowRate === 0n || m.totalBorrowAssets === 0n) return { ...m, lastUpdate: now }
  const interest = mulDivDown(m.totalBorrowAssets, wTaylorCompounded(borrowRate, elapsed), WAD)
  const totalBorrowAssets = m.totalBorrowAssets + interest
  const totalSupplyAssets = m.totalSupplyAssets + interest
  let totalSupplyShares = m.totalSupplyShares
  if (m.fee !== 0n) {
    const feeAmount = mulDivDown(interest, m.fee, WAD)
    totalSupplyShares += toSharesDown(feeAmount, totalSupplyAssets - feeAmount, totalSupplyShares)
  }
  return { totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares: m.totalBorrowShares, lastUpdate: now, fee: m.fee }
}

/** Per-second WAD rate → APY in percent (continuous compounding, as the Morpho UI shows). */
export function rateToApyPct(ratePerSecond: bigint): number {
  const r = bigintToNumber(ratePerSecond) / 1e18
  return (Math.exp(r * SECONDS_PER_YEAR) - 1) * 100
}

/** Supply APY = borrow APY × utilization × (1 − fee). */
export function supplyApyPct(borrowApyPct: number, m: MarketState): number {
  if (m.totalSupplyAssets === 0n) return 0
  const utilization = bigintToNumber(m.totalBorrowAssets) / bigintToNumber(m.totalSupplyAssets)
  return borrowApyPct * utilization * (1 - bigintToNumber(m.fee) / 1e18)
}

/** Loan-token value of `collateral` at the oracle price (1e36 scale), rounded down. */
export const collateralValue = (collateral: bigint, price: bigint) => mulDivDown(collateral, price, ORACLE_PRICE_SCALE)

/** The most a position may owe: collateral value × LLTV. */
export const maxBorrow = (collateral: bigint, price: bigint, lltv: bigint) => mulDivDown(collateralValue(collateral, price), lltv, WAD)
