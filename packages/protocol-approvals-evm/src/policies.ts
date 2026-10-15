import { decodeAbiParameters, type Hex } from 'viem'

import { SELECTORS, UNLIMITED_THRESHOLD } from './standards.js'

/** What a policy condition receives. */
export interface PolicyContext {
  operation: string
  wallet: string
  account: number
  args: unknown[]
}

export interface PolicyRule {
  name: string
  operation: string | string[]
  action: 'ALLOW' | 'DENY'
  conditions: Array<(context: PolicyContext) => boolean>
}

export interface Policy {
  id: string
  name: string
  scope: string
  rules: PolicyRule[]
}

export interface ApprovalsHygienePolicyOptions {
  id?: string
  name?: string
  scope?: string
  unlimitedThreshold?: bigint
  denyUnlimited?: boolean
}

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

const amountOf = (args: unknown[]): unknown => (args[0] as { amount?: unknown } | undefined)?.amount

/**
 * A policy for a `registerPolicy(...)` engine (conditions receive
 * `{ operation, wallet, account, args }`)
 * that keeps a governed account able to clean up after itself:
 *
 * - `allow-revoke`: `approve` with amount 0 and `revokeDelegation` are allowed.
 * - `allow-revoke-calldata`: `sendTransaction` whose calldata is
 *   `setApprovalForAll(false)`, `approve(…, 0)` or Permit2 `lockdown` is allowed.
 * - `deny-unlimited-approve`: `approve` at or above `unlimitedThreshold` is denied.
 *
 * The engine is default-deny, so without the first two rules `revoke()` on a
 * governed account fails with `no-applicable-rule`.
 */
export function approvalsHygienePolicy ({ id = 'approvals-hygiene', name = 'Approvals hygiene', scope = 'project', unlimitedThreshold = UNLIMITED_THRESHOLD, denyUnlimited = true }: ApprovalsHygienePolicyOptions = {}): Policy {
  const rules: PolicyRule[] = [
    {
      name: 'allow-revoke',
      operation: ['approve', 'revokeDelegation'],
      action: 'ALLOW',
      conditions: [({ operation, args }) => operation === 'revokeDelegation' || (() => { try { return BigInt((amountOf(args ?? []) ?? 1) as bigint) === 0n } catch { return false } })()]
    },
    {
      name: 'allow-revoke-calldata',
      operation: 'sendTransaction',
      action: 'ALLOW',
      conditions: [({ args }) => {
        const first = args?.[0]
        const txs = (Array.isArray(first) ? first : [first]) as Array<{ data?: string } | null | undefined>
        return txs.length > 0 && txs.every((tx) => isRevokeCalldata(tx?.data))
      }]
    }
  ]
  if (denyUnlimited) {
    rules.push({
      name: 'deny-unlimited-approve',
      operation: 'approve',
      action: 'DENY',
      conditions: [({ args }) => isUnlimitedAmount(amountOf(args ?? []), unlimitedThreshold)]
    })
  }
  return { id, name, scope, rules }
}
