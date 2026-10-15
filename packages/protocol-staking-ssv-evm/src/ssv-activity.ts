// Activity recognition for SSV Network staking: pure and offline. A transaction is
// SSV's when it calls the SSVNetwork proxy this module is configured with and the
// selector is one of the staking module's methods; amounts come from the receipt's
// transfers (SSV in / out, cSSV minted / burned, ETH rewards paid), net for the wallet.

import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainTx, type DescribeActivityContext,
} from '@forgewallet/core'
import { toFunctionSelector } from 'viem'

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-staking-ssv-evm'

const sel = (signature: string): string => toFunctionSelector(`function ${signature}`).toLowerCase()

/** Selector → action on SSVNetwork (contracts/modules/SSVStaking.sol, ssv-network v2.0.0). */
export const SSV_ACTIONS: Readonly<Record<string, { kind: ActivityKind; title: string }>> = Object.freeze({
  [sel('stake(uint256 amount)')]: { kind: 'stake', title: 'Staked SSV' },
  [sel('requestUnstake(uint256 amount)')]: { kind: 'unstake', title: 'Requested unstake' },
  [sel('withdrawUnlocked()')]: { kind: 'claim', title: 'Withdrew SSV' },
  [sel('claimEthRewards()')]: { kind: 'claim', title: 'Claimed ETH rewards' },
})

const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze({ 1: 'Ethereum', 560048: 'Hoodi' })

export interface SsvActivityDeployment {
  chainId: number
  addresses: { network: string; ssvToken?: string; cssvToken?: string }
}

/**
 * Describe `tx` if it is a staking call on this deployment's SSVNetwork.
 */
export function describeSsvActivity(tx: ChainTx, ctx: DescribeActivityContext, { chainId, addresses }: SsvActivityDeployment): ActivityItem | null {
  const call = tx.call
  if (!call?.to || !call.selector || tx.chain !== `eip155:${chainId}`) return null
  if (!sameAddress(call.to, addresses.network)) return null
  const action = SSV_ACTIONS[call.selector.toLowerCase()]
  if (!action) return null // operator / cluster management on the same proxy is not wallet staking

  const meta = (token: string | null): Partial<ActivityAsset> | undefined => {
    if (token === null) return { symbol: 'ETH', decimals: 18 }
    if (addresses.ssvToken && sameAddress(token, addresses.ssvToken)) return { symbol: 'SSV', decimals: 18 }
    if (addresses.cssvToken && sameAddress(token, addresses.cssvToken)) return { symbol: 'cSSV', decimals: 18 }
    const t = tx.transfers.find((x) => x.token && sameAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m: Partial<ActivityAsset> = {}
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
    assetsOut,
  })
}
