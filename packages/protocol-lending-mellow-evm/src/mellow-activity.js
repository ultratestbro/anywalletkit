'use strict'

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

import { Interface } from 'ethers'
import { activityBase, netTransfers, sameAddress, splitNet } from '@forgewallet/core'
import MELLOW_ADDRESS_MAP from './mellow-address-map.js'

/** @typedef {import('@forgewallet/core').ChainTx} ChainTx */
/** @typedef {import('@forgewallet/core').ActivityItem} ActivityItem */
/** @typedef {import('@forgewallet/core').ActivityKind} ActivityKind */
/** @typedef {import('@forgewallet/core').DescribeActivityContext} DescribeActivityContext */
/** @typedef {import('./mellow-address-map.js').MellowVaultPreset} MellowVaultPreset */

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-lending-mellow-evm'

const iface = new Interface([
  'function deposit(uint224 assets, address referral, bytes32[] merkleProof) payable',
  'function cancelDepositRequest()',
  'function claim(address account) returns (bool)',
  'function redeem(uint256 shares)',
  'function claim(address receiver, uint32[] timestamps) returns (uint256)'
])
// DepositQueue.claim(address) and RedeemQueue.claim(address,uint32[]) are overloads: look them up by full signature.
const sel = (signature) => iface.getFunction(signature).selector.toLowerCase()

/**
 * Queue selector → action. `principal` says which side of the wallet's net transfers names the asset in the title.
 * @type {Readonly<Record<string, { kind: ActivityKind, verb: string, principal: 'out' | 'in' | 'none' }>>}
 */
export const MELLOW_ACTIONS = Object.freeze({
  [sel('deposit(uint224,address,bytes32[])')]: { kind: 'supply', verb: 'Deposited', principal: 'out' },
  [sel('cancelDepositRequest()')]: { kind: 'withdraw', verb: 'Cancelled deposit of', principal: 'in' },
  [sel('claim(address)')]: { kind: 'claim', verb: 'Claimed', principal: 'in' },
  [sel('redeem(uint256)')]: { kind: 'withdraw', verb: 'Requested withdrawal of', principal: 'out' },
  [sel('claim(address,uint32[])')]: { kind: 'claim', verb: 'Claimed', principal: 'in' }
})

const CHAIN_NAMES = Object.freeze({ 1: 'Ethereum' })
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`

/**
 * Describe `tx` if it is a call on a Mellow queue of a known vault.
 *
 * @param {ChainTx} tx
 * @param {DescribeActivityContext} ctx
 * @param {{ chainId: number, vault?: string, shareManager?: string | null }} instance - The vault this instance targets (its share token when known).
 * @returns {ActivityItem | null}
 */
export function describeMellowActivity (tx, ctx, { chainId, vault, shareManager }) {
  const call = tx.call
  if (!call?.to || !call.selector || tx.chain !== `eip155:${chainId}`) return null
  const action = MELLOW_ACTIONS[call.selector.toLowerCase()]
  if (!action) return null

  /** @type {Array<{ vault: string, shareManager?: string, shareSymbol?: string, queues: string[] }>} */
  const known = Object.values(MELLOW_ADDRESS_MAP[chainId] ?? {}).map((p) => ({ vault: p.vault, shareManager: p.shareManager, shareSymbol: p.shareSymbol, queues: [...(p.queues?.deposit ?? []), ...(p.queues?.redeem ?? [])] }))
  if (vault && !known.some((k) => sameAddress(k.vault, vault))) known.push(shareManager ? { vault, shareManager, queues: [] } : { vault, queues: [] })

  const touches = (addr) => tx.transfers.some((t) => sameAddress(t.to, addr) || sameAddress(t.from, addr) || (t.token !== null && sameAddress(t.token, addr)))
  const match = known.find((k) => k.queues.some((q) => sameAddress(q, call.to)) || touches(k.vault) || (k.shareManager && touches(k.shareManager)))
  if (!match) return null

  const meta = (token) => {
    if (token === null) return { symbol: 'ETH', decimals: 18 }
    for (const k of known) if (k.shareManager && k.shareSymbol && sameAddress(token, k.shareManager)) return { symbol: k.shareSymbol, decimals: 18 }
    const t = tx.transfers.find((x) => x.token && sameAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m = {}
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
    assetsOut
  })
}
