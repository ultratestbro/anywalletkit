'use strict'

// Activity recognition for SPL stake pools: pure and offline.
//
// A transaction is this module's when the SPL Stake Pool program is among the
// programs it invoked (`call.programs`, or `call.to`). The instruction tag — the
// first byte of the stake-pool instruction's data when the source passes it in
// `call.data` (base58) — picks the kind: DepositSol (14) / DepositSolWithSlippage
// (25) → stake, WithdrawSol (16 / 26) → unstake (instant), WithdrawStake (10 / 24)
// → unstake (delayed). Without data the direction of the pool-token movement
// decides: pool tokens minted to the wallet → stake, burned from it → unstake.
// The pool token (`mint`) of every pool in SPL_STAKE_POOL_ADDRESS_MAP and of the
// pool this instance targets is labelled; an unknown pool on the same program is
// still recognized ("SPL Stake Pool"). Sweeping a finished delayed unstake is a
// plain Stake-program withdraw from a derived account and is not recognized here.
//
// `ctx.own` should hold the wallet AND its token accounts (sources normalize SPL
// movements to owners, but a source that keeps token-account addresses still works
// when the ATA is in `own`).

import { activityBase, netTransfers, splitNet } from '@anywalletkit/core'
import { STAKE_POOL_PROGRAM } from './spl-stake-pool-codec.js'
import SPL_STAKE_POOL_ADDRESS_MAP from './spl-stake-pool-address-map.js'

/** @typedef {import('@anywalletkit/core').ChainTx} ChainTx */
/** @typedef {import('@anywalletkit/core').ActivityItem} ActivityItem */
/** @typedef {import('@anywalletkit/core').DescribeActivityContext} DescribeActivityContext */
/** @typedef {import('./spl-stake-pool-address-map.js').StakePoolConfig} StakePoolConfig */

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-spl-stake-pool-solana'

/** Instruction tag → action (program/src/instruction.rs of solana-program-library stake-pool). */
export const INSTRUCTION_ACTIONS = Object.freeze({
  14: { kind: 'stake', verb: 'Staked SOL', mode: 'deposit' },
  25: { kind: 'stake', verb: 'Staked SOL', mode: 'deposit' },
  16: { kind: 'unstake', verb: 'Unstaked', mode: 'instant' },
  26: { kind: 'unstake', verb: 'Unstaked', mode: 'instant' },
  10: { kind: 'unstake', verb: 'Requested unstake of', mode: 'delayed' },
  24: { kind: 'unstake', verb: 'Requested unstake of', mode: 'delayed' }
})

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
/** First byte of a base58 payload (enough for the instruction tag), or null. */
export function base58FirstByte (s) {
  if (typeof s !== 'string' || s.length === 0) return null
  let n = 0n
  for (const c of s) { const v = B58.indexOf(c); if (v < 0) return null; n = n * 58n + BigInt(v) }
  const hex = n.toString(16)
  const bytes = (hex.length % 2 ? '0' : '') + hex
  let leading = 0
  for (const c of s) { if (c !== '1') break; leading++ }
  if (leading > 0) return 0
  return Number.parseInt(bytes.slice(0, 2), 16)
}

/**
 * @param {ChainTx} tx
 * @param {DescribeActivityContext} ctx
 * @param {{ pool?: StakePoolConfig }} instance - The pool this instance targets, labelled first.
 * @returns {ActivityItem | null}
 */
export function describeStakePoolActivity (tx, ctx, { pool } = {}) {
  if (!tx.chain.startsWith('solana:')) return null
  const call = tx.call
  if (!call) return null
  const programs = [call.to, ...(call.programs ?? [])]
  if (!programs.includes(STAKE_POOL_PROGRAM)) return null

  const pools = [...(pool ? [pool] : []), ...Object.values(SPL_STAKE_POOL_ADDRESS_MAP)]
  const meta = (token) => {
    if (token === null) return { symbol: 'SOL', decimals: 9 }
    const known = pools.find((p) => p.mint === token)
    if (known) return { symbol: known.symbol, decimals: 9 }
    const t = tx.transfers.find((x) => x.token === token && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const m = {}
    if (t.symbol !== undefined) m.symbol = t.symbol
    if (t.decimals !== undefined) m.decimals = t.decimals
    return m
  }
  const { assetsIn, assetsOut } = splitNet(netTransfers(tx, ctx.own), meta)
  const lstIn = assetsIn.find((a) => a.token !== null)
  const lstOut = assetsOut.find((a) => a.token !== null)
  const lst = lstIn ?? lstOut
  const known = lst ? pools.find((p) => p.mint === lst.token) : undefined

  let action = INSTRUCTION_ACTIONS[base58FirstByte(call.data) ?? -1]
  if (!action) {
    if (lstIn && !lstOut) action = INSTRUCTION_ACTIONS[14]
    else if (lstOut) action = assetsIn.some((a) => a.token === null) ? INSTRUCTION_ACTIONS[16] : INSTRUCTION_ACTIONS[10]
    else return null
  }
  const label = lst ? (lst.symbol ?? 'pool tokens') : 'pool tokens'
  const title = action.mode === 'deposit' ? action.verb : `${action.verb} ${label}`
  return activityBase(tx, action.kind, title, {
    protocol: MODULE_NAME,
    subtitle: `${known ? known.name : 'SPL Stake Pool'} · Solana`,
    counterparty: known?.pool ?? STAKE_POOL_PROGRAM,
    assetsIn,
    assetsOut
  })
}
