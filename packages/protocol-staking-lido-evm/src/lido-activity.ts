// Activity recognition for Lido: pure and offline. A transaction is Lido's when it
// calls one of the three contracts this module is configured with (stETH, wstETH,
// WithdrawalQueue) and the 4-byte selector is one of the methods below; token
// amounts come from the receipt's transfers, net per token for the wallet.

import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainTx, type DescribeActivityContext,
} from '@forgewallet/core'
import { getAbiItem, parseAbi, toFunctionSelector } from 'viem'

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-staking-lido-evm'

const ACTIVITY_ABI = parseAbi([
  'function submit(address _referral) payable returns (uint256)',
  'function wrap(uint256 _stETHAmount) returns (uint256)',
  'function unwrap(uint256 _wstETHAmount) returns (uint256)',
  'function requestWithdrawals(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function requestWithdrawalsWstETH(uint256[] _amounts, address _owner) returns (uint256[])',
  'function requestWithdrawalsWstETHWithPermit(uint256[] _amounts, address _owner, (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) _permit) returns (uint256[])',
  'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints)',
  'function claimWithdrawalsTo(uint256[] _requestIds, uint256[] _hints, address _recipient)',
  'function claimWithdrawal(uint256 _requestId)',
])
type ActivityFn = (typeof ACTIVITY_ABI)[number]['name']
const sel = (name: ActivityFn): string => toFunctionSelector(getAbiItem({ abi: ACTIVITY_ABI, name })).toLowerCase()

export type LidoContractKey = 'stEth' | 'wstEth' | 'withdrawalQueue'

export interface LidoAction { kind: ActivityKind; title: string }

/** Selector → action, per contract. Computed from the signatures above at module load. */
const act = (kind: ActivityKind, title: string): LidoAction => ({ kind, title })

/** Selector → action, per contract. Computed from the signatures above at module load. */
export const LIDO_ACTIONS: Readonly<Record<LidoContractKey, Readonly<Record<string, LidoAction>>>> = Object.freeze({
  stEth: Object.freeze({
    [sel('submit')]: act('stake', 'Staked ETH'),
  }),
  wstEth: Object.freeze({
    [sel('wrap')]: act('wrap', 'Wrapped stETH'),
    [sel('unwrap')]: act('unwrap', 'Unwrapped wstETH'),
  }),
  withdrawalQueue: Object.freeze({
    [sel('requestWithdrawals')]: act('unstake', 'Requested withdrawal'),
    [sel('requestWithdrawalsWithPermit')]: act('unstake', 'Requested withdrawal'),
    [sel('requestWithdrawalsWstETH')]: act('unstake', 'Requested withdrawal'),
    [sel('requestWithdrawalsWstETHWithPermit')]: act('unstake', 'Requested withdrawal'),
    [sel('claimWithdrawals')]: act('claim', 'Claimed ETH'),
    [sel('claimWithdrawalsTo')]: act('claim', 'Claimed ETH'),
    [sel('claimWithdrawal')]: act('claim', 'Claimed ETH'),
  }),
})

const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze({ 1: 'Ethereum', 560048: 'Hoodi' })

/** The deployment the recognizer matches calls against. */
export interface LidoActivityDeployment {
  chainId: number
  addresses: { stEth?: string; wstEth?: string; withdrawalQueue?: string }
}

/**
 * Describe `tx` if it is a call to this deployment's stETH / wstETH / WithdrawalQueue.
 */
export function describeLidoActivity(tx: ChainTx, ctx: DescribeActivityContext, { chainId, addresses }: LidoActivityDeployment): ActivityItem | null {
  const call = tx.call
  if (!call?.to || !call.selector || tx.chain !== `eip155:${chainId}`) return null
  const selector = call.selector.toLowerCase()
  const contract = (['stEth', 'wstEth', 'withdrawalQueue'] as const).find((k) => addresses[k] && sameAddress(call.to, addresses[k]))
  if (!contract) return null
  const action = LIDO_ACTIONS[contract][selector]
  if (!action) return null // approve / transfer on stETH or wstETH are not Lido operations

  const net = netTransfers(tx, ctx.own)
  // Sources that leave the top-level value out of `transfers`: count it once.
  if (tx.nativeValue > 0n && !tx.transfers.some((t) => t.token === null && sameAddress(t.from, tx.from) && sameAddress(t.to, call.to) && t.amount === tx.nativeValue)) {
    net.set(null, (net.get(null) ?? 0n) - tx.nativeValue)
  }
  const meta = (token: string | null): Partial<ActivityAsset> | undefined => {
    if (token === null) return { symbol: 'ETH', decimals: 18 }
    if (addresses.stEth && sameAddress(token, addresses.stEth)) return { symbol: 'stETH', decimals: 18 }
    if (addresses.wstEth && sameAddress(token, addresses.wstEth)) return { symbol: 'wstETH', decimals: 18 }
    if (addresses.withdrawalQueue && sameAddress(token, addresses.withdrawalQueue)) return { symbol: 'unstETH', decimals: 0 }
    const t = tx.transfers.find((x) => x.token && sameAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m: Partial<ActivityAsset> = {}
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
    assetsOut,
  })
}
