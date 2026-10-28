import { decodeAbiParameters, decodeFunctionData, encodeFunctionData, type Hex } from 'viem'

import type { ApprovalStandard } from './approvals-protocol.js'

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
 * The token contracts a host's own approvals scan reported, with their standards: the `Approval` list
 * itself, a map from address to standard, or bare addresses (standard unknown).
 */
export type RevokeTargets =
  | Iterable<{ token: string; standard: ApprovalStandard | string }>
  | ReadonlyMap<string, ApprovalStandard | string>
  | Readonly<Record<string, ApprovalStandard | string>>
  | Iterable<string>

const NFT_STANDARDS: ReadonlySet<string> = new Set(['erc721', 'erc721-token', 'erc1155'])

/**
 * True when a whole transaction is a revoke, not just its calldata: no native value, no EIP-7702
 * authorization, strict revoke calldata, and a target whose standard makes that calldata a revoke
 * (scan 2026-10-27 modules, F31):
 *
 * - Permit2 `lockdown` only to Permit2 (no `targets` needed);
 * - `approve(spender, 0)` only to a target the host knows as an ERC-20 — on an ERC-721 the same
 *   calldata APPROVES `spender` for token #0;
 * - `approve(0x0, id)` and `setApprovalForAll(operator, false)` to an NFT target (ERC-721 / ERC-1155),
 *   or to a bare-address target whose standard is unknown (neither grants anything on any standard).
 *
 * Without `targets` only a `lockdown` is a revoke. Use this, not {@link isRevokeCalldata}, to let a
 * transaction through a policy.
 */
export function isRevokeTransaction (
  tx: { to?: string; value?: unknown; data?: string; type?: unknown; authorizationList?: unknown[] } | undefined,
  { targets }: { targets?: RevokeTargets } = {}
): boolean {
  if (!tx || typeof tx !== 'object' || typeof tx.to !== 'string') return false
  try { if (tx.value !== undefined && tx.value !== null && BigInt(tx.value as bigint) !== 0n) return false } catch { return false }
  if (tx.authorizationList !== undefined && !(Array.isArray(tx.authorizationList) && tx.authorizationList.length === 0)) return false
  if (tx.type !== undefined && tx.type !== null && (tx.type === 'eip7702' || Number(tx.type) === 4)) return false
  const data = typeof tx.data === 'string' ? tx.data : ''
  const selector = data.slice(0, 10).toLowerCase()
  // ERC-721 approve(0x0, tokenId) clears one token's approval: exactly two words, the first zero.
  const clearsToken = selector === SELECTORS.approve && /^0x[0-9a-fA-F]{136}$/.test(data) && /^0{64}$/.test(data.slice(10, 74))
  if (!clearsToken && !isRevokeCalldata(data)) return false
  const to = tx.to.toLowerCase()
  if (selector === SELECTORS.lockdown) return to === PERMIT2_ADDRESS.toLowerCase()
  if (targets === undefined) return false
  const standards = standardsOf(targets, to)
  if (standards === null) return false // not a contract the host's scan reported
  const nft = [...standards].some((s) => NFT_STANDARDS.has(s))
  const known = standards.size > 0
  if (selector === SELECTORS.setApprovalForAll) return nft || !known
  // approve(0x0, x) grants nothing on any standard; approve(spender, 0) revokes only an ERC-20 allowance.
  if (clearsToken) return nft || !known || (standards.has('erc20') && /^0{64}$/.test(data.slice(74)))
  return standards.has('erc20') && !nft
}

/**
 * The standards `targets` give for `to` (empty: listed without one), or `null` when `to` is not listed. Takes
 * `{token, standard}` entries, bare addresses, `[address, standard]` pairs, a `Map` (or any iterable of pairs) and a
 * plain object from address to standard; anything else lists nothing. Never throws: a revoke check must not.
 */
function standardsOf (targets: RevokeTargets, to: string): Set<string> | null {
  let listed = false
  const out = new Set<string>()
  const add = (token: unknown, standard: unknown) => {
    if (typeof token !== 'string' || token.toLowerCase() !== to) return
    listed = true
    if (typeof standard === 'string') out.add(standard)
  }
  try {
    const t = targets as unknown
    if (t === null || typeof t !== 'object') return null
    if (typeof (t as Iterable<unknown>)[Symbol.iterator] !== 'function') {
      for (const [token, standard] of Object.entries(t as Record<string, unknown>)) add(token, standard)
    } else {
      for (const e of t as Iterable<unknown>) {
        if (typeof e === 'string') add(e, undefined)
        else if (Array.isArray(e)) add(e[0], e[1])
        else if (e !== null && typeof e === 'object') add((e as { token?: unknown }).token, (e as { standard?: unknown }).standard)
      }
    }
  } catch {
    return null
  }
  return listed ? out : null
}
