import { activityBase, netTransfers, splitNet, type ActivityAsset, type ActivityItem, type ChainTx, type DescribeActivityContext } from '@anywalletkit/core'
import { LIQUID_PRESETS, LST_DECIMALS, NEAR_MAINNET, NEAR_TESTNET } from './constants.js'
import type { NearNetwork } from './types.js'

// Activity recognition for LiNEAR-family liquid staking: pure and offline.
//
// A transaction is this module's when the wallet sent it (`tx.from` is own) and `call.to` is a family
// contract (a preset for the transaction's network, or one the app configured), with a staking
// method among `call.programs`. Amounts come from the transfers the history source reported:
// the attached deposit of `deposit_and_stake`, the token minted or burnt (NEP-141 events), the NEAR
// paid back by `withdraw*`. An RPC-mapped transaction does not list receipt transfers, so a
// withdrawal's amount is then read from the contract's own `withdraw` event in the kept outcome.
// A lone `storage_deposit`, `ft_transfer` or `ft_transfer_call` is left to the generic fallback.

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-liquid-near'

/** Labels for the preset contracts, as feeds show them ("Rhea rNEAR liquid staking"). */
const LABELS: Record<keyof typeof LIQUID_PRESETS, string> = { linear: 'LiNEAR', rnear: 'Rhea rNEAR' }

const NEAR = { symbol: 'NEAR', decimals: 24 }

interface Known { contract: string; symbol: string; label: string }

function knownContracts(network: NearNetwork, extra: ReadonlyArray<{ contract: string; symbol: string; name?: string }>): Known[] {
  const out: Known[] = []
  for (const [key, preset] of Object.entries(LIQUID_PRESETS) as Array<[keyof typeof LIQUID_PRESETS, (typeof LIQUID_PRESETS)[keyof typeof LIQUID_PRESETS]]>) {
    const on = (preset.contracts as Partial<Record<NearNetwork, { contract: string }>>)[network]
    if (on) out.push({ contract: on.contract, symbol: preset.symbol, label: LABELS[key] })
  }
  for (const c of extra) out.push({ contract: c.contract, symbol: c.symbol, label: c.name ?? c.symbol })
  return out
}

/** NEAR paid out by the contract's `withdraw` event (standards `linear` / `rhea_lst`) in a kept RPC outcome. */
function withdrawnFromLogs(tx: ChainTx, contract: string, me: string): bigint {
  const rpc = (tx.raw as { rpc?: { receipts_outcome?: Array<{ outcome?: { executor_id?: string; logs?: string[] } }> } } | undefined)?.rpc
  let sum = 0n
  for (const r of rpc?.receipts_outcome ?? []) {
    if (r.outcome?.executor_id !== contract) continue
    for (const log of r.outcome.logs ?? []) {
      if (!log.startsWith('EVENT_JSON:')) continue
      try {
        const ev = JSON.parse(log.slice('EVENT_JSON:'.length)) as { event?: string; data?: Array<{ account_id?: string; amount?: string }> }
        if (ev.event !== 'withdraw') continue
        for (const d of ev.data ?? []) if (d.account_id === me && typeof d.amount === 'string' && /^\d+$/.test(d.amount)) sum += BigInt(d.amount)
      } catch { /* not an event */ }
    }
  }
  return sum
}

/** Describes a LiNEAR / rNEAR staking transaction for the wallet's feed, or returns null when it is not one. */
export function describeLiquidNearStakingActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  options: { contracts?: ReadonlyArray<{ contract: string; symbol: string; name?: string }> } = {},
): ActivityItem | null {
  const network: NearNetwork | null = tx.chain === NEAR_MAINNET ? 'mainnet' : tx.chain === NEAR_TESTNET ? 'testnet' : null
  const call = tx.call
  if (!network || !call) return null
  const known = knownContracts(network, options.contracts ?? []).find((c) => c.contract === call.to)
  if (!known || !ctx.own.has(tx.from)) return null

  const methods = call.programs?.length ? call.programs : [call.method ?? '']
  const has = (...names: string[]) => names.some((n) => methods.includes(n))
  let kind: ActivityItem['kind'], title: string
  if (has('deposit_and_stake')) {
    kind = 'stake'
    title = `Staked NEAR for ${known.symbol}`
  } else if (has('stake', 'stake_all')) {
    kind = 'stake'
    title = `Restaked NEAR for ${known.symbol}`
  } else if (has('unstake', 'unstake_all')) {
    kind = 'unstake'
    title = has('withdraw', 'withdraw_all') ? 'Withdrew and requested unstake' : 'Requested unstake'
  } else if (has('withdraw', 'withdraw_all')) {
    kind = 'claim'
    title = 'Withdrew unstaked NEAR'
  } else return null

  const meta = (token: string | null) => (token === null ? NEAR : token === known.contract ? { symbol: known.symbol, decimals: LST_DECIMALS } : undefined)
  const { assetsIn, assetsOut } = splitNet(netTransfers(tx, ctx.own), meta)
  if (kind === 'stake' && !assetsOut.some((a) => a.token === null) && tx.nativeValue > 0n) {
    assetsOut.push({ token: null, amount: tx.nativeValue, ...NEAR } as ActivityAsset)
  }
  if (has('withdraw', 'withdraw_all') && !assetsIn.some((a) => a.token === null)) {
    const paid = withdrawnFromLogs(tx, known.contract, tx.from)
    if (paid > 0n) assetsIn.push({ token: null, amount: paid, ...NEAR } as ActivityAsset)
  }
  return activityBase(tx, kind, title, {
    protocol: MODULE_NAME,
    subtitle: `${known.label} liquid staking`,
    counterparty: call.to,
    assetsIn,
    assetsOut,
  })
}
