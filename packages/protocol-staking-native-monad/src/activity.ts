import { activityBase, netTransfers, splitNet, type ActivityAsset, type ActivityItem, type ChainTx, type DescribeActivityContext } from '@anywalletkit/core'
import { decodeEventLog, decodeFunctionData, type Hex } from 'viem'
import { SELECTORS, STAKING_ABI } from './abi.js'
import { MONAD_CHAIN_IDS, STAKING_PRECOMPILE } from './constants.js'

// Activity recognition for Monad native staking: pure and offline.
//
// A transaction is this module's when it calls the staking precompile directly (`call.to`) with one
// of the delegator selectors. The kind comes from the selector; the validator id (and, for an
// unstake, the amount) from the calldata. MON paid back by `withdraw` / `claimRewards` is credited
// by the precompile without an internal call, so explorers often show no transfer: the amount is
// then read from the Withdraw / ClaimRewards event when the source kept the receipt (`raw.tx.receipt`,
// as history-evm's RPC path does). Calls made through a smart wallet (call.to = the wallet) are not
// matched.

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-native-monad'

const ACTIONS: Record<string, { fn: keyof typeof SELECTORS; kind: ActivityItem['kind']; title: string }> = {
  [SELECTORS.delegate]: { fn: 'delegate', kind: 'stake', title: 'Staked MON' },
  [SELECTORS.undelegate]: { fn: 'undelegate', kind: 'unstake', title: 'Requested unstake' },
  [SELECTORS.withdraw]: { fn: 'withdraw', kind: 'claim', title: 'Withdrew unstaked MON' },
  [SELECTORS.compound]: { fn: 'compound', kind: 'stake', title: 'Compounded staking rewards' },
  [SELECTORS.claimRewards]: { fn: 'claimRewards', kind: 'claim', title: 'Claimed staking rewards' },
}

const MON = { symbol: 'MON', decimals: 18 }

const text = (wei: bigint) => {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 4)
  return `${whole}${frac ? `.${frac}` : ''} MON`
}

/** Amount of the first matching precompile event in a kept receipt (`raw.tx.receipt.logs`). */
function eventAmount(tx: ChainTx, staking: string, eventName: 'Withdraw' | 'ClaimRewards' | 'Delegate'): bigint | null {
  const receipt = (tx.raw as { tx?: { receipt?: { logs?: unknown[] } } } | undefined)?.tx?.receipt
  const logs = Array.isArray(receipt?.logs) ? receipt.logs : []
  for (const raw of logs) {
    const log = raw as { address?: string; topics?: Hex[]; data?: Hex }
    if (typeof log.address !== 'string' || log.address.toLowerCase() !== staking || !Array.isArray(log.topics) || typeof log.data !== 'string') continue
    try {
      const ev = decodeEventLog({ abi: STAKING_ABI, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      if (ev.eventName === eventName) return (ev.args as { amount: bigint }).amount
    } catch { /* not ours */ }
  }
  return null
}

/** Describes a Monad staking transaction for the wallet's feed, or returns null when it is not one. */
export function describeMonadStakingActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  options: { stakingAddress?: string; validators?: ReadonlyArray<{ id: bigint; name?: string }> } = {},
): ActivityItem | null {
  const chainId = /^eip155:(\d+)$/.exec(tx.chain)?.[1]
  if (!chainId || !MONAD_CHAIN_IDS.includes(Number(chainId) as (typeof MONAD_CHAIN_IDS)[number])) return null
  const staking = (options.stakingAddress ?? STAKING_PRECOMPILE).toLowerCase()
  const call = tx.call
  if (!call || call.to.toLowerCase() !== staking || !call.selector) return null
  const action = ACTIONS[call.selector.toLowerCase()]
  if (!action) return null

  let validatorId: bigint | null = null
  let unstaked: bigint | null = null
  if (typeof call.data === 'string') {
    try {
      const { args } = decodeFunctionData({ abi: STAKING_ABI, data: call.data as Hex })
      if (Array.isArray(args) && typeof args[0] === 'bigint') validatorId = args[0]
      if (action.fn === 'undelegate' && Array.isArray(args) && typeof args[1] === 'bigint') unstaked = args[1]
    } catch { /* keep the kind, skip the details */ }
  }

  const { assetsIn, assetsOut } = splitNet(netTransfers(tx, ctx.own), (token) => (token === null ? MON : undefined))
  if (assetsIn.length === 0 && (action.fn === 'withdraw' || action.fn === 'claimRewards')) {
    const amount = eventAmount(tx, staking, action.fn === 'withdraw' ? 'Withdraw' : 'ClaimRewards')
    if (amount !== null && amount > 0n) assetsIn.push({ token: null, amount, ...MON } as ActivityAsset)
  }

  const name = validatorId === null ? null : options.validators?.find((v) => v.id === validatorId)?.name ?? `validator #${validatorId}`
  const title = action.fn === 'undelegate' && unstaked !== null ? `Requested unstake of ${text(unstaked)}` : action.title
  return activityBase(tx, action.kind, title, {
    protocol: MODULE_NAME,
    subtitle: `Monad staking${name ? ` · ${name}` : ''}`,
    counterparty: call.to,
    assetsIn,
    assetsOut,
  })
}
