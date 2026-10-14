'use strict'

// Activity recognition for Lido: pure and offline. A transaction is Lido's when it
// calls one of the three contracts this module is configured with (stETH, wstETH,
// WithdrawalQueue) and the 4-byte selector is one of the methods below; token
// amounts come from the receipt's transfers, net per token for the wallet.

import { Interface } from 'ethers'
import { activityBase, netTransfers, sameAddress, splitNet } from '@forgewallet/core'

/** @typedef {import('@forgewallet/core').ChainTx} ChainTx */
/** @typedef {import('@forgewallet/core').ActivityItem} ActivityItem */
/** @typedef {import('@forgewallet/core').ActivityKind} ActivityKind */
/** @typedef {import('@forgewallet/core').DescribeActivityContext} DescribeActivityContext */

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-staking-lido-evm'

const iface = new Interface([
  'function submit(address _referral) payable returns (uint256)',
  'function wrap(uint256 _stETHAmount) returns (uint256)',
  'function unwrap(uint256 _wstETHAmount) returns (uint256)',
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETHWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)',
  'function claimWithdrawalsTo(uint256[] _requestIds, uint256[] _hints, address _recipient)',
  'function claimWithdrawal(uint256 _requestId)'
])
const sel = (name) => iface.getFunction(name).selector.toLowerCase()

/**
 * Selector → action, per contract. Computed from the signatures above at module load.
 * @type {Readonly<Record<'stEth' | 'wstEth' | 'withdrawalQueue', Readonly<Record<string, { kind: ActivityKind, title: string }>>>>}
 */
export const LIDO_ACTIONS = Object.freeze({
  stEth: Object.freeze({
    [sel('submit')]: { kind: 'stake', title: 'Staked ETH' }
  }),
  wstEth: Object.freeze({
    [sel('wrap')]: { kind: 'wrap', title: 'Wrapped stETH' },
    [sel('unwrap')]: { kind: 'unwrap', title: 'Unwrapped wstETH' }
  }),
  withdrawalQueue: Object.freeze({
    [sel('requestWithdrawals')]: { kind: 'unstake', title: 'Requested withdrawal' },
    [sel('requestWithdrawalsWithPermit')]: { kind: 'unstake', title: 'Requested withdrawal' },
    [sel('requestWithdrawalsWstETH')]: { kind: 'unstake', title: 'Requested withdrawal' },
    [sel('requestWithdrawalsWstETHWithPermit')]: { kind: 'unstake', title: 'Requested withdrawal' },
    [sel('claimWithdrawals')]: { kind: 'claim', title: 'Claimed ETH' },
    [sel('claimWithdrawalsTo')]: { kind: 'claim', title: 'Claimed ETH' },
    [sel('claimWithdrawal')]: { kind: 'claim', title: 'Claimed ETH' }
  })
})

const CHAIN_NAMES = Object.freeze({ 1: 'Ethereum', 560048: 'Hoodi' })

/**
 * Describe `tx` if it is a call to this deployment's stETH / wstETH / WithdrawalQueue.
 *
 * @param {ChainTx} tx
 * @param {DescribeActivityContext} ctx
 * @param {{ chainId: number, addresses: { stEth?: string, wstEth?: string, withdrawalQueue?: string } }} deployment
 * @returns {ActivityItem | null}
 */
export function describeLidoActivity (tx, ctx, { chainId, addresses }) {
  const call = tx.call
  if (!call?.to || !call.selector || tx.chain !== `eip155:${chainId}`) return null
  const selector = call.selector.toLowerCase()
  const contract = /** @type {Array<'stEth' | 'wstEth' | 'withdrawalQueue'>} */ (['stEth', 'wstEth', 'withdrawalQueue']).find((k) => addresses[k] && sameAddress(call.to, addresses[k]))
  if (!contract) return null
  const action = LIDO_ACTIONS[contract][selector]
  if (!action) return null // approve / transfer on stETH or wstETH are not Lido operations

  const net = netTransfers(tx, ctx.own)
  // Sources that leave the top-level value out of `transfers`: count it once.
  if (tx.nativeValue > 0n && !tx.transfers.some((t) => t.token === null && sameAddress(t.from, tx.from) && sameAddress(t.to, call.to) && t.amount === tx.nativeValue)) {
    net.set(null, (net.get(null) ?? 0n) - tx.nativeValue)
  }
  const meta = (token) => {
    if (token === null) return { symbol: 'ETH', decimals: 18 }
    if (addresses.stEth && sameAddress(token, addresses.stEth)) return { symbol: 'stETH', decimals: 18 }
    if (addresses.wstEth && sameAddress(token, addresses.wstEth)) return { symbol: 'wstETH', decimals: 18 }
    if (addresses.withdrawalQueue && sameAddress(token, addresses.withdrawalQueue)) return { symbol: 'unstETH', decimals: 0 }
    const t = tx.transfers.find((x) => x.token && sameAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m = {}
    if (t.symbol !== undefined) m.symbol = t.symbol
    if (t.decimals !== undefined) m.decimals = t.decimals
    return m
  }
  const { assetsIn, assetsOut } = splitNet(net, meta)
  return activityBase(tx, action.kind, action.title, {
    protocol: MODULE_NAME,
    subtitle: `Lido · ${CHAIN_NAMES[chainId] ?? `eip155:${chainId}`}`,
    counterparty: call.to,
    assetsIn,
    assetsOut
  })
}
