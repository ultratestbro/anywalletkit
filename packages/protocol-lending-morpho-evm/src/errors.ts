// Morpho (Blue) reverts with `Error(string)` from its ErrorsLib; MetaMorpho,
// Vault V2 and the OpenZeppelin ERC-4626 / ERC-20 they build on revert with
// custom errors. All become one readable MorphoError.
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, toFunctionSelector, type Hex } from 'viem'

export class MorphoError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'MorphoError'
    this.code = code
  }
}

/** Morpho Blue ErrorsLib strings → what they mean for a wallet. */
export const BLUE_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  'market not created': 'This market does not exist on Morpho (wrong params or chain)',
  'inconsistent input': 'Pass either assets or shares, not both',
  'zero assets': 'Amount must be greater than 0',
  'zero address': 'Zero address is not allowed',
  unauthorized: 'The account is not authorized to act for that address (setAuthorization)',
  'insufficient collateral': 'Not enough collateral: the position would exceed the market LLTV',
  'insufficient liquidity': 'The market has not enough liquidity right now (borrowed out) — try a smaller amount or later',
  'position is healthy': 'The position is healthy and cannot be liquidated',
  'transfer reverted': 'Token transfer reverted',
  'transferFrom reverted': 'Token transferFrom reverted (allowance or balance)',
  'transferFrom returned false': 'Token transferFrom returned false (allowance or balance)',
})

/** Custom errors (name → message), selectors computed from the signatures. */
const CUSTOM_ERRORS: ReadonlyArray<[signature: string, message: string]> = [
  // OpenZeppelin ERC-4626 / ERC-20
  ['ERC4626ExceededMaxDeposit(address,uint256,uint256)', 'Deposit exceeds the vault’s current deposit limit (caps reached)'],
  ['ERC4626ExceededMaxMint(address,uint256,uint256)', 'Mint exceeds the vault’s current limit'],
  ['ERC4626ExceededMaxWithdraw(address,uint256,uint256)', 'Withdrawal exceeds what the vault can pay out right now'],
  ['ERC4626ExceededMaxRedeem(address,uint256,uint256)', 'Redemption exceeds what the vault can pay out right now'],
  ['ERC20InsufficientBalance(address,uint256,uint256)', 'Insufficient balance'],
  ['ERC20InsufficientAllowance(address,uint256,uint256)', 'Insufficient allowance'],
  // MetaMorpho (Vault V1)
  ['AllCapsReached()', 'Every market in the vault’s supply queue is at its cap — deposits are closed right now'],
  ['NotEnoughLiquidity()', 'The vault cannot withdraw that much from its markets right now'],
  ['ZeroAddress()', 'Zero address is not allowed'],
  ['InconsistentAsset(bytes32)', 'The vault refuses a market whose loan token is not its asset'],
  ['UnauthorizedMarket(bytes32)', 'Market not enabled in this vault'],
  // Vault V2 gates and liquidity
  ['CannotReceiveShares()', 'This vault gates deposits: the receiver is not allowed to hold its shares'],
  ['CannotSendShares()', 'This vault gates withdrawals: the account may not send its shares'],
  ['CannotReceiveAssets()', 'This vault gates withdrawals: the receiver may not receive assets'],
  ['CannotSendAssets()', 'This vault gates deposits: the account may not send assets in'],
  ['Unauthorized()', 'Not authorized'],
  ['ZeroAssets()', 'Amount must be greater than 0'],
  ['AbsoluteCapExceeded()', 'An allocation cap of the vault is exceeded'],
  ['RelativeCapExceeded()', 'A relative allocation cap of the vault is exceeded'],
  ['NotEnoughIdle()', 'Not enough idle liquidity in the vault right now'],
  ['CannotForceDeallocate()', 'Force-deallocation is not allowed for that adapter'],
]
const SELECTORS: ReadonlyMap<string, { name: string; message: string }> = new Map(
  CUSTOM_ERRORS.map(([sig, message]) => [toFunctionSelector(sig).toLowerCase(), { name: sig.slice(0, sig.indexOf('(')), message }]),
)

const ERROR_STRING_ABI = [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }] as const
const PANIC_ABI = [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }] as const

export function decodeMorphoRevert(data: Hex): { message: string; code?: string } {
  const selector = data.slice(0, 10).toLowerCase()
  if (selector === '0x08c379a0') {
    try {
      const text = String(decodeErrorResult({ abi: ERROR_STRING_ABI, data }).args?.[0] ?? '')
      const known = BLUE_ERRORS[text]
      return known ? { message: `${known} (Morpho: "${text}")`, code: text } : { message: text || 'reverted' }
    } catch { /* fall through */ }
  }
  if (selector === '0x4e487b71') {
    try { return { message: `panic 0x${BigInt(decodeErrorResult({ abi: PANIC_ABI, data }).args?.[0] ?? 0).toString(16)}` } } catch { /* fall through */ }
  }
  const custom = SELECTORS.get(selector)
  if (custom) return { message: `${custom.message} (${custom.name})`, code: custom.name }
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

/** A viem call failure → MorphoError when it is a revert; otherwise rethrow. */
export function toMorphoError(e: unknown, action: string): never {
  const data = extractRevertData(e)
  if (data && data !== '0x') {
    const { message, code } = decodeMorphoRevert(data)
    throw new MorphoError(`${action} would revert: ${message}`, code)
  }
  const text = e instanceof BaseError ? e.shortMessage || e.message : e instanceof Error ? e.message : String(e)
  if (/revert|execution reverted/i.test(text)) throw new MorphoError(`${action} would revert: ${text}`)
  throw e
}
