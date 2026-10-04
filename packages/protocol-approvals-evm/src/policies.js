'use strict'

import { AbiCoder } from 'ethers'

import { SELECTORS, UNLIMITED_THRESHOLD } from './standards.js'

const coder = AbiCoder.defaultAbiCoder()

/** True when an `approve` amount should count as unlimited (>= 2^255 by default). */
export function isUnlimitedAmount (amount, threshold = UNLIMITED_THRESHOLD) {
  try { return BigInt(amount ?? 0) >= threshold } catch { return false }
}

/**
 * True when raw calldata is a revoke: `approve(spender, 0)`,
 * `setApprovalForAll(operator, false)` or Permit2 `lockdown(...)`.
 *
 * @param {string | undefined} data
 */
export function isRevokeCalldata (data) {
  if (typeof data !== 'string' || data.length < 10) return false
  const selector = data.slice(0, 10).toLowerCase()
  try {
    if (selector === SELECTORS.approve) return coder.decode(['address', 'uint256'], '0x' + data.slice(10))[1] === 0n
    if (selector === SELECTORS.setApprovalForAll) return coder.decode(['address', 'bool'], '0x' + data.slice(10))[1] === false
    if (selector === SELECTORS.lockdown) return true
  } catch {}
  return false
}

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
 *
 * @param {{ id?: string, name?: string, scope?: string, unlimitedThreshold?: bigint, denyUnlimited?: boolean }} [options]
 */
export function approvalsHygienePolicy ({ id = 'approvals-hygiene', name = 'Approvals hygiene', scope = 'project', unlimitedThreshold = UNLIMITED_THRESHOLD, denyUnlimited = true } = {}) {
  const rules = [
    {
      name: 'allow-revoke',
      operation: ['approve', 'revokeDelegation'],
      action: 'ALLOW',
      conditions: [({ operation, args }) => operation === 'revokeDelegation' || (() => { try { return BigInt(args?.[0]?.amount ?? 1) === 0n } catch { return false } })()]
    },
    {
      name: 'allow-revoke-calldata',
      operation: 'sendTransaction',
      action: 'ALLOW',
      conditions: [({ args }) => {
        const txs = Array.isArray(args?.[0]) ? args[0] : [args?.[0]]
        return txs.length > 0 && txs.every((tx) => isRevokeCalldata(tx?.data))
      }]
    }
  ]
  if (denyUnlimited) {
    rules.push({
      name: 'deny-unlimited-approve',
      operation: 'approve',
      action: 'DENY',
      conditions: [({ args }) => isUnlimitedAmount(args?.[0]?.amount, unlimitedThreshold)]
    })
  }
  return { id, name, scope, rules }
}
