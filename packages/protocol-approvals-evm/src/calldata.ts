import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, type Hex } from 'viem'

import { PERMIT2_ABI, PERMIT2_ADDRESS, SELECTORS, UNLIMITED_THRESHOLD } from './standards.js'

/** True when an `approve` amount should count as unlimited (>= 2^255 by default). */
export function isUnlimitedAmount (amount: unknown, threshold: bigint = UNLIMITED_THRESHOLD): boolean {
  try { return BigInt((amount ?? 0) as bigint) >= threshold } catch { return false }
}

/**
 * True when raw calldata is a revoke: `approve(spender, 0)`,
 * `setApprovalForAll(operator, false)` or Permit2 `lockdown(...)`.
 */
export function isRevokeCalldata (data: string | undefined): boolean {
  if (typeof data !== 'string' || data.length < 10 || !/^0x[0-9a-fA-F]*$/.test(data)) return false
  const selector = data.slice(0, 10).toLowerCase()
  const args = ('0x' + data.slice(10)) as Hex
  try {
    // Exactly two static words: no trailing bytes for a look-alike to hide in.
    if (selector === SELECTORS.approve) return data.length === 10 + 128 && decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], args)[1] === 0n
    if (selector === SELECTORS.setApprovalForAll) {
      return data.length === 10 + 128 && /^0{64}$/.test(data.slice(74)) && decodeAbiParameters([{ type: 'address' }, { type: 'bool' }], args)[1] === false
    }
    if (selector === SELECTORS.lockdown) {
      // Canonical encoding only: decode and re-encode must give the same bytes.
      const { args: decoded } = decodeFunctionData({ abi: PERMIT2_ABI, data: data as Hex })
      return encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'lockdown', args: decoded as never }).toLowerCase() === data.toLowerCase()
    }
  } catch {}
  return false
}

/**
 * True when a whole transaction is a revoke, not just its calldata: no native
 * value, no EIP-7702 authorization, strict revoke calldata, Permit2 `lockdown`
 * only to Permit2, and — when the host passes `targets` (the token contracts
 * its own approvals scan reported) — `approve` / `setApprovalForAll` only to one
 * of those. Without `targets`, `approve(x, 0)` to an arbitrary contract passes:
 * on an ERC-721 that call approves `x` for token #0, so hosts governing NFTs
 * should pass `targets`. Use this, not {@link isRevokeCalldata}, to let a
 * transaction through a policy.
 */
export function isRevokeTransaction (
  tx: { to?: string; value?: unknown; data?: string; type?: unknown; authorizationList?: unknown[] } | undefined,
  { targets }: { targets?: Iterable<string> } = {}
): boolean {
  if (!tx || typeof tx !== 'object' || typeof tx.to !== 'string') return false
  try { if (tx.value !== undefined && tx.value !== null && BigInt(tx.value as bigint) !== 0n) return false } catch { return false }
  if (tx.authorizationList !== undefined && !(Array.isArray(tx.authorizationList) && tx.authorizationList.length === 0)) return false
  if (tx.type !== undefined && tx.type !== null && (tx.type === 'eip7702' || Number(tx.type) === 4)) return false
  if (!isRevokeCalldata(tx.data)) return false
  const to = tx.to.toLowerCase()
  if (tx.data!.slice(0, 10).toLowerCase() === SELECTORS.lockdown) return to === PERMIT2_ADDRESS.toLowerCase()
  if (targets !== undefined) return [...targets].some((t) => String(t).toLowerCase() === to)
  return true
}
