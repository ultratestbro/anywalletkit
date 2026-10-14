'use strict'

// Activity recognition for SSV Network staking: pure and offline. A transaction is
// SSV's when it calls the SSVNetwork proxy this module is configured with and the
// selector is one of the staking module's methods; amounts come from the receipt's
// transfers (SSV in / out, cSSV minted / burned, ETH rewards paid), net for the wallet.

import { Interface } from 'ethers'
import { activityBase, netTransfers, sameAddress, splitNet } from '@forgewallet/core'

/** @typedef {import('@forgewallet/core').ChainTx} ChainTx */
/** @typedef {import('@forgewallet/core').ActivityItem} ActivityItem */
/** @typedef {import('@forgewallet/core').ActivityKind} ActivityKind */
/** @typedef {import('@forgewallet/core').DescribeActivityContext} DescribeActivityContext */

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-staking-ssv-evm'

const iface = new Interface([
  'function stake(uint256 amount)',
  'function requestUnstake(uint256 amount)',
  'function withdrawUnlocked()',
  'function claimEthRewards()'
])
const sel = (name) => iface.getFunction(name).selector.toLowerCase()

/**
 * Selector → action on SSVNetwork (contracts/modules/SSVStaking.sol, ssv-network v2.0.0).
 * @type {Readonly<Record<string, { kind: ActivityKind, title: string }>>}
 */
export const SSV_ACTIONS = Object.freeze({
  [sel('stake')]: { kind: 'stake', title: 'Staked SSV' },
  [sel('requestUnstake')]: { kind: 'unstake', title: 'Requested unstake' },
  [sel('withdrawUnlocked')]: { kind: 'claim', title: 'Withdrew SSV' },
  [sel('claimEthRewards')]: { kind: 'claim', title: 'Claimed ETH rewards' }
})

const CHAIN_NAMES = Object.freeze({ 1: 'Ethereum', 560048: 'Hoodi' })

/**
 * Describe `tx` if it is a staking call on this deployment's SSVNetwork.
 *
 * @param {ChainTx} tx
 * @param {DescribeActivityContext} ctx
 * @param {{ chainId: number, addresses: { network: string, ssvToken?: string, cssvToken?: string } }} deployment
 * @returns {ActivityItem | null}
 */
export function describeSsvActivity (tx, ctx, { chainId, addresses }) {
  const call = tx.call
  if (!call?.to || !call.selector || tx.chain !== `eip155:${chainId}`) return null
  if (!sameAddress(call.to, addresses.network)) return null
  const action = SSV_ACTIONS[call.selector.toLowerCase()]
  if (!action) return null // operator / cluster management on the same proxy is not wallet staking

  const meta = (token) => {
    if (token === null) return { symbol: 'ETH', decimals: 18 }
    if (addresses.ssvToken && sameAddress(token, addresses.ssvToken)) return { symbol: 'SSV', decimals: 18 }
    if (addresses.cssvToken && sameAddress(token, addresses.cssvToken)) return { symbol: 'cSSV', decimals: 18 }
    const t = tx.transfers.find((x) => x.token && sameAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m = {}
    if (t.symbol !== undefined) m.symbol = t.symbol
    if (t.decimals !== undefined) m.decimals = t.decimals
    return m
  }
  const { assetsIn, assetsOut } = splitNet(netTransfers(tx, ctx.own), meta)
  return activityBase(tx, action.kind, action.title, {
    protocol: MODULE_NAME,
    subtitle: `SSV Network · ${CHAIN_NAMES[chainId] ?? `eip155:${chainId}`}`,
    counterparty: call.to,
    assetsIn,
    assetsOut
  })
}
