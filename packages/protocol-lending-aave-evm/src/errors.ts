// Aave reverts in two dialects: markets on v3.0–3.3 revert with `Error(string)`
// carrying a numeric code ('35'); v3.4+ reverts with parameterless custom
// errors (`HealthFactorLowerThanLiquidationThreshold()`). Both are decoded
// into one readable message so the wallet never shows a bare "35".
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, toFunctionSelector, type Hex } from 'viem'

export class AaveError extends Error {
  /** Aave's own identifier: the numeric code or the custom error name. */
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'AaveError'
    this.code = code
  }
}

/** Numeric codes of Errors.sol in Aave v3.0–3.3 (the user-facing ones). */
export const AAVE_ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  '26': 'Amount must be greater than 0',
  '27': 'Action requires an active reserve',
  '28': 'Action cannot be performed because the reserve is frozen',
  '29': 'Action cannot be performed because the reserve is paused',
  '30': 'Borrowing is not enabled for this asset',
  '31': 'Stable borrowing is not enabled',
  '32': 'Cannot withdraw more than the available balance',
  '33': 'Invalid interest rate mode selected',
  '34': 'Collateral balance is zero',
  '35': 'Health factor would fall below the liquidation threshold',
  '36': 'Not enough collateral to cover the new borrow',
  '37': 'Collateral is the same as the borrowing currency',
  '38': 'Amount is bigger than the max loan size (stable)',
  '39': 'No debt of the selected type to repay',
  '40': 'Repaying on behalf of a user needs an explicit amount',
  '41': 'No outstanding stable debt',
  '42': 'No outstanding variable debt',
  '43': 'Underlying balance is zero',
  '45': 'Health factor is not below the threshold',
  '46': 'The collateral chosen cannot be liquidated',
  '47': 'User did not borrow the specified currency',
  '49': 'Borrow cap is exceeded',
  '50': 'Supply cap is exceeded',
  '51': 'Unbacked mint cap is exceeded',
  '52': 'Debt ceiling is exceeded',
  '56': 'LTV validation failed',
  '57': 'Inconsistent eMode category',
  '58': 'Price oracle sentinel check failed',
  '59': 'Asset is not borrowable in isolation mode',
  '61': 'User is in isolation mode or the asset has zero LTV',
  '76': 'Asset is not listed',
  '85': 'Siloed borrowing violation',
  '89': 'Withdrawing to the aToken is not allowed',
  '90': 'Supplying to the aToken is not allowed',
  '93': 'Liquidation grace sentinel check failed',
  '96': 'Asset is not borrowable in this eMode',
  '99': 'Must not leave dust: take the full position',
  '100': 'User cannot have debt for this action',
})

/** Custom errors of Errors.sol in Aave v3.4+ (name → message). */
export const AAVE_CUSTOM_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  InvalidAmount: 'Amount must be greater than 0',
  ReserveInactive: 'Action requires an active reserve',
  ReserveFrozen: 'Action cannot be performed because the reserve is frozen',
  ReservePaused: 'Action cannot be performed because the reserve is paused',
  BorrowingNotEnabled: 'Borrowing is not enabled for this asset',
  NotEnoughAvailableUserBalance: 'Cannot withdraw more than the available balance',
  InvalidInterestRateModeSelected: 'Invalid interest rate mode selected',
  HealthFactorLowerThanLiquidationThreshold: 'Health factor would fall below the liquidation threshold',
  CollateralCannotCoverNewBorrow: 'Not enough collateral to cover the new borrow',
  NoDebtOfSelectedType: 'No debt of the selected type to repay',
  NoExplicitAmountToRepayOnBehalf: 'Repaying on behalf of a user needs an explicit amount',
  UnderlyingBalanceZero: 'Underlying balance is zero',
  HealthFactorNotBelowThreshold: 'Health factor is not below the threshold',
  CollateralCannotBeLiquidated: 'The collateral chosen cannot be liquidated',
  SpecifiedCurrencyNotBorrowedByUser: 'User did not borrow the specified currency',
  BorrowCapExceeded: 'Borrow cap is exceeded',
  SupplyCapExceeded: 'Supply cap is exceeded',
  LtvValidationFailed: 'LTV validation failed',
  InconsistentEModeCategory: 'Inconsistent eMode category',
  UserHasAssetWithZeroLtv: 'User has an asset with zero LTV',
  InvalidSignature: 'Invalid permit signature',
  InvalidExpiration: 'Permit deadline is invalid or expired',
  OperationNotSupported: 'Operation not supported',
  AssetNotListed: 'Asset is not listed',
  WithdrawToAToken: 'Withdrawing to the aToken is not allowed',
  SupplyToAToken: 'Supplying to the aToken is not allowed',
  LiquidationGraceSentinelCheckFailed: 'Liquidation grace sentinel check failed',
  NotBorrowableInEMode: 'Asset is not borrowable in this eMode',
  MustNotLeaveDust: 'Must not leave dust: take the full position',
  UserCannotHaveDebt: 'User cannot have debt for this action',
  SelfLiquidation: 'Self-liquidation is not allowed',
  CallerNotPositionManager: 'Caller is not an enabled position manager of that user',
  InvalidCollateralInEmode: 'Invalid collateral asset for this eMode',
  InvalidDebtInEmode: 'Invalid debt asset for this eMode',
})

const SELECTOR_TO_NAME: ReadonlyMap<string, string> = new Map(
  Object.keys(AAVE_CUSTOM_ERRORS).map((name) => {
    const sig = name === 'InvalidCollateralInEmode' || name === 'InvalidDebtInEmode' ? `${name}(address,uint256)` : `${name}()`
    return [toFunctionSelector(sig).toLowerCase(), name]
  }),
)

const ERROR_STRING_ABI = [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }] as const
const PANIC_ABI = [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }] as const

/** Revert bytes → Aave message (and code) when they are Aave's; otherwise a generic reason. */
export function decodeAaveRevert(data: Hex): { message: string; code?: string } {
  const selector = data.slice(0, 10).toLowerCase()
  if (selector === '0x08c379a0') {
    try {
      const d = decodeErrorResult({ abi: ERROR_STRING_ABI, data })
      const text = String(d.args?.[0] ?? '')
      const known = AAVE_ERROR_CODES[text]
      return known ? { message: `${known} (Aave error ${text})`, code: text } : { message: text || 'reverted' }
    } catch { /* fall through */ }
  }
  if (selector === '0x4e487b71') {
    try {
      const d = decodeErrorResult({ abi: PANIC_ABI, data })
      return { message: `panic 0x${Number(d.args?.[0] ?? 0).toString(16)}` }
    } catch { /* fall through */ }
  }
  const name = SELECTOR_TO_NAME.get(selector)
  if (name) return { message: `${AAVE_CUSTOM_ERRORS[name]} (Aave error ${name})`, code: name }
  return { message: `reverted with custom error ${selector}` }
}

function extractRevertData(e: unknown): Hex | undefined {
  if (e instanceof BaseError) {
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
    if (reverted?.raw) return reverted.raw
  }
  let cur: unknown = e
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    const bag = cur as { data?: unknown; cause?: unknown }
    if (typeof bag.data === 'string' && isHex(bag.data)) return bag.data as Hex
    if (bag.data && typeof bag.data === 'object' && typeof (bag.data as { data?: unknown }).data === 'string') return (bag.data as { data: Hex }).data
    cur = bag.cause
  }
  return undefined
}

/** Turn a viem call/estimate failure into an AaveError when it is a revert; otherwise rethrow. */
export function toAaveError(e: unknown, action: string): never {
  const data = extractRevertData(e)
  if (data && data !== '0x') {
    const { message, code } = decodeAaveRevert(data)
    throw new AaveError(`${action} would revert: ${message}`, code)
  }
  const text = e instanceof BaseError ? e.shortMessage || e.message : e instanceof Error ? e.message : String(e)
  if (/revert|execution reverted/i.test(text)) throw new AaveError(`${action} would revert: ${text}`)
  throw e
}
