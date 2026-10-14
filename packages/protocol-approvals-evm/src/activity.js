'use strict'

// Activity recognition for token approvals: pure and offline, on every EVM chain.
//
// Recognized calls (by 4-byte selector, on any contract — the called contract is the
// token):
//  - ERC-20 / ERC-721 `approve(address,uint256)` 0x095ea7b3 — amount 0 → `revoke`,
//    else `approve`. (ERC-721 shares the selector; a tokenId of 0 would read as a
//    revoke — the only case the selector cannot tell apart offline.)
//  - `setApprovalForAll(address,bool)` 0xa22cb465 — false → `revoke`, true → `approve`.
//  - Permit2 (0x000000000022D4…8BA3) `approve(address,address,uint160,uint48)` — amount
//    0 → `revoke`, else `approve`; `lockdown(...)` → `revoke`.
// Calldata is needed to read the spender and the amount; with only the selector the
// item is still returned as `approve`, titled without the amount verdict.

import { AbiCoder } from 'ethers'
import { activityBase, sameAddress } from '@forgewallet/core'
import { PERMIT2_ABI, PERMIT2_ADDRESS, SELECTORS } from './standards.js'

/** @typedef {import('@forgewallet/core').ChainTx} ChainTx */
/** @typedef {import('@forgewallet/core').ActivityItem} ActivityItem */
/** @typedef {import('@forgewallet/core').DescribeActivityContext} DescribeActivityContext */

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-approvals-evm'

const coder = AbiCoder.defaultAbiCoder()
const PERMIT2_APPROVE = PERMIT2_ABI.getFunction('approve').selector.toLowerCase()

/** Chain labels for the subtitle; anything else prints as `eip155:N`. */
export const CHAIN_NAMES = Object.freeze({
  1: 'Ethereum', 10: 'OP Mainnet', 56: 'BNB Chain', 100: 'Gnosis', 130: 'Unichain', 137: 'Polygon', 146: 'Sonic', 324: 'zkSync Era',
  480: 'World Chain', 999: 'HyperEVM', 1088: 'Metis', 1329: 'Sei', 1868: 'Soneium', 5000: 'Mantle', 8453: 'Base', 9745: 'Plasma',
  42161: 'Arbitrum', 42220: 'Celo', 43114: 'Avalanche', 57073: 'Ink', 59144: 'Linea', 80094: 'Berachain', 98866: 'Plume', 534352: 'Scroll'
})

/** Well-known spenders, so the title can say "for Permit2" instead of an address. */
export const SPENDER_LABELS = Object.freeze({
  [PERMIT2_ADDRESS.toLowerCase()]: 'Permit2'
})

const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
const word = (data, i) => data.length >= 10 + 64 * (i + 1) ? '0x' + data.slice(10 + 64 * i, 10 + 64 * (i + 1)) : null
const addressWord = (data, i) => { const w = word(data, i); return w ? '0x' + w.slice(26) : null }

/**
 * Describe `tx` if it is an approval or a revoke.
 *
 * @param {ChainTx} tx
 * @param {DescribeActivityContext} ctx
 * @param {{ tokens?: Record<string, { symbol?: string, decimals?: number }> }} [options] - Optional token labels (lowercase address → symbol) for titles.
 * @returns {ActivityItem | null}
 */
export function describeApprovalActivity (tx, ctx, options = {}) {
  const call = tx.call
  if (!call?.to || !call.selector) return null
  const m = /^eip155:(\d+)$/.exec(tx.chain)
  if (!m) return null
  const chainId = Number(m[1])
  const selector = call.selector.toLowerCase()
  const data = typeof call.data === 'string' && call.data.length >= 10 ? call.data : null
  const isPermit2 = sameAddress(call.to, PERMIT2_ADDRESS)

  /** @type {{ revoke: boolean | null, spender: string | null, token: string, amount: bigint | null }} */
  let r
  if (isPermit2 && selector === PERMIT2_APPROVE) {
    const token = addressWord(data, 0)
    if (!token) return null
    const amount = word(data, 2) !== null ? BigInt(word(data, 2)) : null
    r = { revoke: amount === null ? null : amount === 0n, spender: addressWord(data, 1), token, amount }
  } else if (isPermit2 && selector === SELECTORS.lockdown) {
    let token = null, spender = null
    try {
      const [pairs] = coder.decode(['(address token, address spender)[]'], '0x' + data.slice(10))
      if (pairs.length === 1) { token = pairs[0].token; spender = pairs[0].spender }
    } catch {}
    r = { revoke: true, spender, token: token ?? PERMIT2_ADDRESS, amount: 0n }
  } else if (selector === SELECTORS.approve && !isPermit2) {
    const amount = word(data, 1) !== null ? BigInt(word(data, 1)) : null
    r = { revoke: amount === null ? null : amount === 0n, spender: addressWord(data, 0), token: call.to, amount }
  } else if (selector === SELECTORS.setApprovalForAll) {
    const flag = word(data, 1)
    r = { revoke: flag === null ? null : BigInt(flag) === 0n, spender: addressWord(data, 0), token: call.to, amount: null }
  } else {
    return null
  }

  const label = options.tokens?.[r.token.toLowerCase()]?.symbol ?? (sameAddress(r.token, PERMIT2_ADDRESS) ? 'Permit2 allowances' : short(r.token))
  const spender = r.spender ? (SPENDER_LABELS[r.spender.toLowerCase()] ?? short(r.spender)) : null
  const kind = r.revoke ? 'revoke' : 'approve'
  const title = r.revoke ? `Revoked ${label}${spender ? ` for ${spender}` : ''}` : `Approved ${label}${spender ? ` for ${spender}` : ''}`
  const extra = { protocol: MODULE_NAME, subtitle: `${isPermit2 ? 'Permit2' : 'Token approval'} · ${CHAIN_NAMES[chainId] ?? `eip155:${chainId}`}` }
  if (r.spender) extra.counterparty = r.spender
  return activityBase(tx, kind, title, extra)
}
