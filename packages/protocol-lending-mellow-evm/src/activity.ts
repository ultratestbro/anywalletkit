// Activity recognition for Mellow Core Vaults: pure and offline.
//
// Deposits and redemptions are calls on the vault's *queues* (DepositQueue /
// RedeemQueue contracts), not on the vault, and queues are discovered on-chain.
// Offline, a transaction is Mellow's when the selector is a queue method AND either
//  - the called contract is a queue a preset listed when it was last verified
//    (`MELLOW_ADDRESS_MAP[chainId][key].queues`), or
//  - the receipt touches a known vault or its share token (a preset's `vault` /
//    `shareManager`, or the vault this instance is configured with): a native /
//    ERC-20 transfer to the vault (deposit) or a mint / burn of the share token.
// Amounts come from the receipt's transfers, net per token for the wallet.
import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainTx, type DescribeActivityContext,
} from '@anywalletkit/core'
import { toFunctionSelector } from 'viem'
import { MELLOW_ADDRESS_MAP } from './address-map.js'

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-lending-mellow-evm'

export interface MellowAction {
  kind: ActivityKind
  verb: string
  /** Which side of the wallet's net transfers names the asset in the title. */
  principal: 'out' | 'in' | 'none'
}

// DepositQueue.claim(address) and RedeemQueue.claim(address,uint32[]) are overloads: look them up by full signature.
const sel = (signature: string): string => toFunctionSelector(`function ${signature}`).toLowerCase()

/** Queue selector → action. `principal` says which side of the wallet's net transfers names the asset in the title. */
export const MELLOW_ACTIONS: Readonly<Record<string, MellowAction>> = Object.freeze({
  [sel('deposit(uint224,address,bytes32[])')]: { kind: 'supply', verb: 'Deposited', principal: 'out' },
  [sel('cancelDepositRequest()')]: { kind: 'withdraw', verb: 'Cancelled deposit of', principal: 'in' },
  [sel('claim(address)')]: { kind: 'claim', verb: 'Claimed', principal: 'in' },
  [sel('redeem(uint256)')]: { kind: 'withdraw', verb: 'Requested withdrawal of', principal: 'out' },
  [sel('claim(address,uint32[])')]: { kind: 'claim', verb: 'Claimed', principal: 'in' },
})

const CHAIN_NAMES: Readonly<Record<number, string>> = Object.freeze({ 1: 'Ethereum' })
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

/** The vault this instance targets (its share token when known). */
export interface MellowActivityInstance {
  chainId: number
  vault?: string
  shareManager?: string | null
}

interface KnownVault {
  vault: string
  shareManager?: string
  shareSymbol?: string
  queues: string[]
}

/**
 * Describe `tx` if it is a call on a Mellow queue of a known vault.
 */
export function describeMellowActivity(tx: ChainTx, ctx: DescribeActivityContext, { chainId, vault, shareManager }: MellowActivityInstance): ActivityItem | null {
  const call = tx.call
  if (!call?.to || !call.selector || tx.chain !== `eip155:${chainId}`) return null
  const action = MELLOW_ACTIONS[call.selector.toLowerCase()]
  if (!action) return null

  const known: KnownVault[] = Object.values(MELLOW_ADDRESS_MAP[chainId] ?? {}).map((p) => ({
    vault: p.vault,
    ...(p.shareManager !== undefined ? { shareManager: p.shareManager } : {}),
    shareSymbol: p.shareSymbol,
    queues: [...(p.queues?.deposit ?? []), ...(p.queues?.redeem ?? [])],
  }))
  if (vault && !known.some((k) => sameAddress(k.vault, vault))) known.push(shareManager ? { vault, shareManager, queues: [] } : { vault, queues: [] })

  const touches = (addr: string): boolean => tx.transfers.some((t) => sameAddress(t.to, addr) || sameAddress(t.from, addr) || (t.token !== null && sameAddress(t.token, addr)))
  const match = known.find((k) => k.queues.some((q) => sameAddress(q, call.to)) || touches(k.vault) || (k.shareManager && touches(k.shareManager)))
  if (!match) return null

  const meta = (token: string | null): Partial<ActivityAsset> | undefined => {
    if (token === null) return { symbol: 'ETH', decimals: 18 }
    for (const k of known) if (k.shareManager && k.shareSymbol && sameAddress(token, k.shareManager)) return { symbol: k.shareSymbol, decimals: 18 }
    const t = tx.transfers.find((x) => x.token && sameAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m: Partial<ActivityAsset> = {}
    if (t.symbol !== undefined) m.symbol = t.symbol
    if (t.decimals !== undefined) m.decimals = t.decimals
    return m
  }
  const net = netTransfers(tx, ctx.own)
  if (tx.nativeValue > 0n && !tx.transfers.some((t) => t.token === null && sameAddress(t.from, tx.from) && sameAddress(t.to, call.to) && t.amount === tx.nativeValue)) {
    net.set(null, (net.get(null) ?? 0n) - tx.nativeValue)
  }
  const { assetsIn, assetsOut } = splitNet(net, meta)
  const side = action.principal === 'out' ? assetsOut : action.principal === 'in' ? assetsIn : []
  const principal = side[0]
  const label = principal ? (principal.symbol ?? (principal.token ? short(principal.token) : '')) : ''
  return activityBase(tx, action.kind, label ? `${action.verb} ${label}` : action.verb, {
    protocol: MODULE_NAME,
    subtitle: `Mellow · ${CHAIN_NAMES[chainId] ?? `eip155:${chainId}`}`,
    counterparty: call.to,
    assetsIn,
    assetsOut,
  })
}
