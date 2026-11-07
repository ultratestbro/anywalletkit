import { activityBase, netTransfers, splitNet, type ActivityAsset, type ActivityItem, type ChainTx, type DescribeActivityContext } from '@anywalletkit/core'
import { NEAR_MAINNET, NEAR_TESTNET, YOCTO_PER_NEAR } from './constants.js'
import { factoryOf } from './pools.js'
import type { NearNetwork } from './types.js'

// Activity recognition for NEAR native staking: pure and offline.
//
// A transaction is this module's when the wallet itself signed it (`tx.from` is own) and it calls a
// factory pool (`call.to` passes factoryOf for the tx's network) with a delegator method. The kind
// comes from the methods in `call.programs`. NEAR paid back by `withdraw*` arrives in a receipt the
// pool sends: nearblocks rows show it as a transfer; an RPC-refined transaction keeps the receipts
// and the pool's "withdrawing N" log in `raw.rpc`, read here when no transfer shows the amount.

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-native-near'

const NEAR = { symbol: 'NEAR', decimals: 24 }

const STAKE: Record<string, string> = { deposit_and_stake: 'Staked NEAR', deposit: 'Deposited NEAR', stake: 'Restaked NEAR', stake_all: 'Restaked NEAR' }
const UNSTAKE = new Set(['unstake', 'unstake_all'])
const WITHDRAW = new Set(['withdraw', 'withdraw_all'])

const text = (yocto: bigint): string => {
  const whole = yocto / YOCTO_PER_NEAR
  const frac = (yocto % YOCTO_PER_NEAR).toString().padStart(24, '0').slice(0, 4).replace(/0+$/, '')
  return `${whole}${frac ? `.${frac}` : ''} NEAR`
}

interface RawRpc {
  receipts?: Array<{ predecessor_id?: string; receiver_id?: string; receipt?: { Action?: { actions?: Array<{ Transfer?: { deposit?: string } }> } } }>
  receipts_outcome?: Array<{ outcome?: { executor_id?: string; logs?: string[] } }>
}

const rpcOf = (tx: ChainTx): RawRpc | undefined => {
  const rpc = (tx.raw as { rpc?: unknown } | undefined)?.rpc
  return rpc && typeof rpc === 'object' ? (rpc as RawRpc) : undefined
}

/** NEAR the pool sent to `me` in this transaction's receipts (RPC-refined transactions only). */
function paidByPool(tx: ChainTx, pool: string, isOwn: (a: string) => boolean): bigint | null {
  const rpc = rpcOf(tx)
  if (!rpc) return null
  let total = 0n
  for (const r of rpc.receipts ?? []) {
    if (r.predecessor_id !== pool || !r.receiver_id || !isOwn(r.receiver_id)) continue
    for (const a of r.receipt?.Action?.actions ?? []) {
      const d = a.Transfer?.deposit
      if (typeof d === 'string' && /^\d+$/.test(d)) total += BigInt(d)
    }
  }
  if (total > 0n) return total
  // The pool's own log, when the receipts were not kept: "@alice.near withdrawing 123. New unstaked balance is 0".
  for (const o of rpc.receipts_outcome ?? []) {
    if (o.outcome?.executor_id !== pool) continue
    for (const log of o.outcome.logs ?? []) {
      const m = /^@(\S+) withdrawing (\d+)\./.exec(log)
      if (m && isOwn(m[1]!)) total += BigInt(m[2]!)
    }
  }
  return total > 0n ? total : null
}

/** Amount the pool logged as unstaked for `me` ("@alice.near unstaking 123. Spent …"), when the source kept the logs. */
function unstakedAmount(tx: ChainTx, pool: string, isOwn: (a: string) => boolean): bigint | null {
  let total = 0n
  for (const o of rpcOf(tx)?.receipts_outcome ?? []) {
    if (o.outcome?.executor_id !== pool) continue
    for (const log of o.outcome.logs ?? []) {
      const m = /^@(\S+) unstaking (\d+)\./.exec(log)
      if (m && isOwn(m[1]!)) total += BigInt(m[2]!)
    }
  }
  return total > 0n ? total : null
}

/** Describes a NEAR staking-pool transaction for the wallet's feed, or returns null when it is not one. */
export function describeNativeNearStakingActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  options: { network?: NearNetwork; pools?: ReadonlyArray<{ id: string; name?: string }> } = {},
): ActivityItem | null {
  const network: NearNetwork | null = tx.chain === NEAR_MAINNET ? 'mainnet' : tx.chain === NEAR_TESTNET ? 'testnet' : null
  if (!network || (options.network !== undefined && options.network !== network)) return null
  const call = tx.call
  if (!call || typeof call.to !== 'string' || factoryOf(call.to, network) === null) return null
  const isOwn = (a: string) => ctx.own.has(a) || ctx.own.has(a.toLowerCase())
  // Someone else's call on a pool (a ping, a deposit seen from the pool's side) is not the wallet's.
  if (!isOwn(tx.from)) return null

  const methods: string[] = call.programs && call.programs.length > 0 ? call.programs : call.method ? [call.method] : []
  let kind: ActivityItem['kind'] | null = null
  let title = ''
  if (methods.some((m) => UNSTAKE.has(m))) {
    kind = 'unstake'
    title = methods.some((m) => WITHDRAW.has(m)) ? 'Withdrew and requested unstake' : 'Requested unstake'
  } else if (methods.some((m) => WITHDRAW.has(m))) {
    kind = 'claim'
    title = 'Withdrew unstaked NEAR'
  } else {
    const first = methods.find((m) => STAKE[m] !== undefined)
    if (first) {
      kind = 'stake'
      title = STAKE[first]!
    }
  }
  if (!kind) return null // ping, owner methods, views sent as calls

  const pool = call.to
  const { assetsIn, assetsOut } = splitNet(netTransfers(tx, ctx.own), (token) => (token === null ? NEAR : undefined))
  if (assetsIn.length === 0 && methods.some((m) => WITHDRAW.has(m))) {
    const paid = paidByPool(tx, pool, isOwn)
    if (paid !== null) assetsIn.push({ token: null, amount: paid, ...NEAR } as ActivityAsset)
  }
  if (title === 'Requested unstake') {
    const amount = unstakedAmount(tx, pool, isOwn)
    if (amount !== null) title = `Requested unstake of ${text(amount)}`
  }

  const name = options.pools?.find((p) => p.id === pool)?.name ?? pool
  return activityBase(tx, kind, title, {
    protocol: MODULE_NAME,
    subtitle: `NEAR staking · ${name}`,
    counterparty: pool,
    assetsIn,
    assetsOut,
  })
}
