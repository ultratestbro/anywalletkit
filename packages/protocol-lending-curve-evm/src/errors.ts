// Curve's vaults are Vyper: VaultV3 (scrvUSD) reverts with `Error(string)` from plain asserts.
// The strings below are VaultV3.vy 3.0.4's; every revert becomes one readable CurveLendingError.
import { BaseError, ContractFunctionRevertedError, decodeErrorResult, isHex, type Hex } from 'viem'

export class CurveLendingError extends Error {
  readonly code: string | undefined
  constructor(message: string, code?: string) {
    super(message)
    this.name = 'CurveLendingError'
    this.code = code
  }
}

export type ScrvUsdCheck = 'chain' | 'clone' | 'implementation' | 'apiVersion' | 'asset'

/**
 * What the read RPC reports at the scrvUSD address is not the vault this module pins: the RPC is
 * not on Ethereum, the code is not the EIP-1167 clone of the pinned implementation, the
 * implementation's code hash differs, or the vault answers another `apiVersion()` / `asset()`. `code` is `'ScrvUsdVerificationFailed'`;
 * `check` names what failed, `expected` / `observed` the values compared. Nothing is approved or
 * sent once this is thrown, withdrawals included.
 */
export class ScrvUsdVerificationError extends CurveLendingError {
  readonly check: ScrvUsdCheck
  readonly expected: string
  readonly observed: string
  constructor(p: { vault: string; check: ScrvUsdCheck; expected: string; observed: string }) {
    super(`${p.vault} failed the scrvUSD ${p.check} check (expected ${p.expected}, got ${p.observed}) — refusing to use it.`, 'ScrvUsdVerificationFailed')
    this.name = 'ScrvUsdVerificationError'
    this.check = p.check
    this.expected = p.expected
    this.observed = p.observed
  }
}

/** The vault's `isShutdown()` is true: it takes no deposits. Withdrawals stay open. `code` is `'VaultShutdown'`. */
export class VaultShutdownError extends CurveLendingError {
  constructor(label: string) {
    super(`${label} is shut down: it takes no deposits (withdrawals stay open).`, 'VaultShutdown')
    this.name = 'VaultShutdownError'
  }
}

/** VaultV3 assert strings → what they mean for a wallet. */
export const VAULT_V3_ERRORS: Readonly<Record<string, string>> = Object.freeze({
  'exceed deposit limit': 'The deposit exceeds the vault’s deposit limit',
  'cannot deposit zero': 'Amount must be greater than 0',
  'cannot mint zero': 'Amount must be greater than 0',
  'exceed withdraw limit': 'The withdrawal exceeds what the vault can pay out right now',
  'insufficient shares to redeem': 'Not enough shares for this withdrawal',
  'no shares to redeem': 'Amount too small: it redeems no shares',
  'no assets to withdraw': 'Amount too small: it pays out nothing',
  'insufficient assets in vault': 'The vault does not hold enough assets right now',
  'too much loss': 'The withdrawal would realise a loss above max_loss (0)',
  'max loss': 'Invalid max_loss',
  'insufficient allowance': 'Insufficient share allowance for the owner',
  'transfer failed': 'Token transfer failed (allowance or balance)',
})

const ERROR_STRING_ABI = [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }] as const
const PANIC_ABI = [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }] as const

export function decodeCurveRevert(data: Hex): { message: string; code?: string } {
  const selector = data.slice(0, 10).toLowerCase()
  if (selector === '0x08c379a0') {
    try {
      const text = String(decodeErrorResult({ abi: ERROR_STRING_ABI, data }).args?.[0] ?? '')
      const known = VAULT_V3_ERRORS[text]
      return known ? { message: `${known} (vault: "${text}")`, code: text } : { message: text || 'reverted' }
    } catch { /* fall through */ }
  }
  if (selector === '0x4e487b71') {
    try { return { message: `panic 0x${BigInt(decodeErrorResult({ abi: PANIC_ABI, data }).args?.[0] ?? 0).toString(16)}` } } catch { /* fall through */ }
  }
  return { message: `reverted with ${selector}` }
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

/** A viem call failure → CurveLendingError when it is a revert; otherwise (network, RPC) rethrow. */
export function toCurveError(e: unknown, action: string): never {
  const data = extractRevertData(e)
  if (data && data !== '0x') {
    const { message, code } = decodeCurveRevert(data)
    throw new CurveLendingError(`${action} would revert: ${message}`, code)
  }
  const text = e instanceof BaseError ? e.shortMessage || e.message : e instanceof Error ? e.message : String(e)
  if (/revert|execution reverted/i.test(text)) throw new CurveLendingError(`${action} would revert: ${text}`)
  throw e
}
