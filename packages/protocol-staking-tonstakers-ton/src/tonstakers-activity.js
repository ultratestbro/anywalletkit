'use strict'

// Activity recognition for Tonstakers: pure and offline.
//
// Three shapes, all checked against the deployment this instance is configured with
// (pool + tsTON jetton master; addresses compared in raw form so friendly and raw
// spellings match):
//  - stake:   an outgoing message to the pool whose op is OP_STAKE (0x47d54391) — or
//             whose op the source did not decode. Net TON out, tsTON minted in.
//  - unstake: an outgoing burn (OP_UNSTAKE 0x595f07bc) with a tsTON jetton transfer
//             leaving the wallet. The destination is the wallet's own jetton wallet,
//             which cannot be known statically, so the jetton movement is the proof.
//  - claim:   an incoming message from the pool that carries TON (the withdrawal
//             payout, op 0x0a77535c when decoded) with no call of ours.
// Everything else is null.

import { Address } from '@ton/core'
import { activityBase, netTransfers, splitNet } from '@forgewallet/core'

/** @typedef {import('@forgewallet/core').ChainTx} ChainTx */
/** @typedef {import('@forgewallet/core').ActivityItem} ActivityItem */
/** @typedef {import('@forgewallet/core').DescribeActivityContext} DescribeActivityContext */

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-staking-tonstakers-ton'

export const OP_STAKE = 0x47d54391
export const OP_UNSTAKE = 0x595f07bc
/** Pool → staker payout of a finished withdrawal (`tonstake_pool_withdrawal`). */
export const OP_WITHDRAWAL_PAYOUT = 0x0a77535c

/** The chain's native coin ticker (TON's coin is GRAM since 2026-06-15; the chain id stays `ton:-239`). */
export const NATIVE_SYMBOL = 'GRAM'

const CHAIN_NAMES = Object.freeze({ '-239': 'TON', '-3': 'TON testnet' })

/** Raw `wc:hex` form of any TON address spelling, or null when unparsable. */
export function rawAddress (a) {
  if (typeof a !== 'string' || a.length === 0) return null
  try { return Address.parse(a).toRawString().toLowerCase() } catch { return null }
}

const sameTonAddress = (a, b) => { const x = rawAddress(a); return x !== null && x === rawAddress(b) }

/** Op code of a call as the source recorded it: hex / decimal string in `data`, or a decoded name in `method`. */
export function readOp (call) {
  if (!call) return null
  if (typeof call.data === 'string') {
    if (/^0x[0-9a-f]+$/i.test(call.data)) return Number.parseInt(call.data, 16)
    if (/^\d+$/.test(call.data)) return Number(call.data)
  }
  if (typeof call.method === 'string') {
    const m = call.method.toLowerCase()
    if (m === 'stake' || m === 'deposit' || m === 'tonstake_pool_deposit') return OP_STAKE
    if (m === 'burn' || m === 'unstake' || m === 'jetton_burn') return OP_UNSTAKE
    if (m === 'tonstake_pool_withdrawal') return OP_WITHDRAWAL_PAYOUT
  }
  return null
}

/**
 * @param {ChainTx} tx
 * @param {DescribeActivityContext} ctx
 * @param {{ network: string | number, addresses: { pool: string, jetton?: string } }} deployment
 * @returns {ActivityItem | null}
 */
export function describeTonstakersActivity (tx, ctx, { network, addresses }) {
  if (tx.chain !== `ton:${network}`) return null
  const own = new Set([...ctx.own].map(rawAddress).filter((a) => a !== null))
  const isOwn = (a) => { const r = rawAddress(a); return r !== null && own.has(r) }
  // Compare in raw form: normalize every address the net uses.
  const normalized = { ...tx, transfers: tx.transfers.map((t) => ({ ...t, from: rawAddress(t.from) ?? t.from, to: rawAddress(t.to) ?? t.to, token: t.token === null ? null : (rawAddress(t.token) ?? t.token) })) }
  const meta = (token) => {
    if (token === null) return { symbol: NATIVE_SYMBOL, decimals: 9 }
    if (addresses.jetton && sameTonAddress(token, addresses.jetton)) return { symbol: 'tsTON', decimals: 9 }
    const t = tx.transfers.find((x) => x.token && sameTonAddress(x.token, token) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m = {}
    if (t.symbol !== undefined) m.symbol = t.symbol
    if (t.decimals !== undefined) m.decimals = t.decimals
    return m
  }
  const finish = (kind, title, counterparty) => {
    const { assetsIn, assetsOut } = splitNet(netTransfers(normalized, own), meta)
    return activityBase(tx, kind, title, { protocol: MODULE_NAME, subtitle: `Tonstakers · ${CHAIN_NAMES[String(network)] ?? `ton:${network}`}`, counterparty, assetsIn, assetsOut })
  }
  const op = readOp(tx.call)
  const fromUs = isOwn(tx.from)

  // claim: payout from the pool to us
  if (!fromUs && sameTonAddress(tx.from, addresses.pool) && (op === null || op === OP_WITHDRAWAL_PAYOUT) && tx.nativeValue > 0n) {
    return finish('claim', `Received unstaked ${NATIVE_SYMBOL}`, addresses.pool)
  }
  if (!fromUs) return null

  // stake: message to the pool
  const target = tx.call?.to ?? tx.to
  if (target && sameTonAddress(target, addresses.pool) && (op === null || op === OP_STAKE)) {
    return finish('stake', `Staked ${NATIVE_SYMBOL}`, addresses.pool)
  }

  // unstake: burn of tsTON from our jetton wallet
  if (op === OP_UNSTAKE && addresses.jetton && tx.transfers.some((t) => t.token !== null && sameTonAddress(t.token, addresses.jetton) && isOwn(t.from) && !isOwn(t.to))) {
    return finish('unstake', 'Requested unstake', addresses.pool)
  }
  return null
}
