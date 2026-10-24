// ReserveConfigurationMap bit layout (aave-v3-origin
// `protocol/libraries/configuration/ReserveConfiguration.sol`) and the rate
// maths of the Aave UI (ray = 1e27, APY compounded per second).
import { bigintToNumber } from '@anywalletkit/core'
import type { Address } from 'viem'

export const RAY = 10n ** 27n
export const WAD = 10n ** 18n
export const SECONDS_PER_YEAR = 31_536_000

const mask = (bits: number) => (1n << BigInt(bits)) - 1n

export interface ReserveConfiguration {
  /** Loan-to-value as a fraction (0.75 = 75 %). 0 means the asset cannot be collateral. */
  ltv: number
  liquidationThreshold: number
  /** Bonus the liquidator receives, as a fraction over 1 (0.05 = 5 %). */
  liquidationBonus: number
  decimals: number
  active: boolean
  frozen: boolean
  borrowingEnabled: boolean
  paused: boolean
  borrowableInIsolation: boolean
  siloedBorrowing: boolean
  flashloanEnabled: boolean
  reserveFactor: number
  /** Whole tokens; 0 = no cap. */
  borrowCap: bigint
  supplyCap: bigint
  liquidationProtocolFee: number
  /** Isolation-mode debt ceiling in base currency with 2 decimals; 0 = not isolated. */
  debtCeiling: bigint
}

export function parseReserveConfiguration(data: bigint): ReserveConfiguration {
  const bit = (n: number) => ((data >> BigInt(n)) & 1n) === 1n
  const field = (shift: number, bits: number) => (data >> BigInt(shift)) & mask(bits)
  const bonus = Number(field(32, 16))
  return {
    ltv: Number(field(0, 16)) / 10_000,
    liquidationThreshold: Number(field(16, 16)) / 10_000,
    liquidationBonus: bonus === 0 ? 0 : (bonus - 10_000) / 10_000,
    decimals: Number(field(48, 8)),
    active: bit(56),
    frozen: bit(57),
    borrowingEnabled: bit(58),
    paused: bit(60),
    borrowableInIsolation: bit(61),
    siloedBorrowing: bit(62),
    flashloanEnabled: bit(63),
    reserveFactor: Number(field(64, 16)) / 10_000,
    borrowCap: field(80, 36),
    supplyCap: field(116, 36),
    liquidationProtocolFee: Number(field(152, 16)) / 10_000,
    debtCeiling: field(212, 40),
  }
}

/** UserConfigurationMap: bit 2·id = borrowing, bit 2·id + 1 = used as collateral. */
export function userFlags(data: bigint, reserveId: number): { borrowing: boolean; collateral: boolean } {
  const base = BigInt(reserveId) * 2n
  return { borrowing: ((data >> base) & 1n) === 1n, collateral: ((data >> (base + 1n)) & 1n) === 1n }
}

/** Ray rate → APR in percent. */
export function rayToAprPct(rate: bigint): number {
  return (bigintToNumber(rate) / 1e27) * 100
}

/**
 * Ray rate → APY in percent, compounded per second the way the Aave UI shows it.
 * expm1(n·log1p(x)) rather than pow(1 + x, n): with x ≈ 1e-9 and n = 31 536 000 the
 * pow form depends on the engine's libm (Hermes on Linux drifted past 0.01 %).
 */
export function rayToApyPct(rate: bigint): number {
  const apr = bigintToNumber(rate) / 1e27
  return Math.expm1(SECONDS_PER_YEAR * Math.log1p(apr / SECONDS_PER_YEAR)) * 100
}

export interface ReserveInfo extends ReserveConfiguration {
  asset: Address
  symbol: string
  id: number
  aToken: Address
  variableDebtToken: Address
  /** Ray (1e27). */
  liquidityRate: bigint
  variableBorrowRate: bigint
  liquidityIndex: bigint
  variableBorrowIndex: bigint
  lastUpdateTimestamp: number
  accruedToTreasury: bigint
  isolationModeTotalDebt: bigint
  supplyApr: number
  supplyApy: number
  borrowApr: number
  borrowApy: number
}

/** Health factor as a number; Aave returns uint256.max when there is no debt → Infinity. */
export function healthFactorToNumber(hf: bigint): number {
  if (hf >= 1n << 128n) return Number.POSITIVE_INFINITY
  return bigintToNumber(hf) / 1e18
}
