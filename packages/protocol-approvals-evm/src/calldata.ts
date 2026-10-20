import { decodeAbiParameters, type Hex } from 'viem'

import { SELECTORS, UNLIMITED_THRESHOLD } from './standards.js'

/** True when an `approve` amount should count as unlimited (>= 2^255 by default). */
export function isUnlimitedAmount (amount: unknown, threshold: bigint = UNLIMITED_THRESHOLD): boolean {
  try { return BigInt((amount ?? 0) as bigint) >= threshold } catch { return false }
}

/**
 * True when raw calldata is a revoke: `approve(spender, 0)`,
 * `setApprovalForAll(operator, false)` or Permit2 `lockdown(...)`.
 */
export function isRevokeCalldata (data: string | undefined): boolean {
  if (typeof data !== 'string' || data.length < 10) return false
  const selector = data.slice(0, 10).toLowerCase()
  const args = ('0x' + data.slice(10)) as Hex
  try {
    if (selector === SELECTORS.approve) return decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], args)[1] === 0n
    if (selector === SELECTORS.setApprovalForAll) return decodeAbiParameters([{ type: 'address' }, { type: 'bool' }], args)[1] === false
    if (selector === SELECTORS.lockdown) return true
  } catch {}
  return false
}
