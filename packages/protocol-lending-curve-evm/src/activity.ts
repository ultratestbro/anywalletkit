// Activity recognition for Curve lending (scrvUSD so far): pure and offline.
//
// Rules, on a chain with a scrvUSD vault (Ethereum):
//  - the called contract is the pinned scrvUSD vault and the selector is a VaultV3 entry point:
//    deposit / mint → `supply`, withdraw / redeem (every Vyper arity: 3, 4 or 5 arguments) → `withdraw`;
//  - the called contract is crvUSD and the call is `approve(scrvUSD, amount)` → `approve`
//    (`revoke` for amount 0): the allowance a deposit needs;
//  - otherwise, the receipt shows scrvUSD shares minted to (deposit) or burned from (withdrawal)
//    one of the wallet's addresses: a deposit or withdrawal made through another contract (a smart
//    wallet, a multicall). A swap that buys or sells scrvUSD moves existing shares, so it never
//    mints or burns for the wallet and is not matched.
// The principal is crvUSD from the wallet's net transfers, never the share token.
import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainTx, type DescribeActivityContext,
} from '@anywalletkit/core'
import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem'
import { CURVE_LENDING_CHAINS } from './chains.js'

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-lending-curve-evm'

const ZERO = '0x0000000000000000000000000000000000000000'
const sel = (signature: string): string => toFunctionSelector(`function ${signature}`).toLowerCase()
const APPROVE = sel('approve(address,uint256)')
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount) returns (bool)'])

export interface Action { kind: ActivityKind; verb: string; principal: 'out' | 'in' }

/** VaultV3 entry points, every arity Vyper's default arguments compile to. */
export const SCRVUSD_ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  [sel('deposit(uint256,address)')]: { kind: 'supply', verb: 'Deposited', principal: 'out' },
  [sel('mint(uint256,address)')]: { kind: 'supply', verb: 'Deposited', principal: 'out' },
  [sel('withdraw(uint256,address,address)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel('withdraw(uint256,address,address,uint256)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel('withdraw(uint256,address,address,uint256,address[])')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel('redeem(uint256,address,address)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel('redeem(uint256,address,address,uint256)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel('redeem(uint256,address,address,uint256,address[])')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
})

export function parseEvmChainId(chain: string): number | null {
  const m = /^eip155:(\d+)$/.exec(chain)
  return m ? Number(m[1]) : null
}

const META: Readonly<Record<string, Partial<ActivityAsset>>> = Object.freeze({ crvusd: { symbol: 'crvUSD', decimals: 18 }, scrvusd: { symbol: 'scrvUSD', decimals: 18 } })

function transferMeta(tx: ChainTx, crvUsd: string, scrvUsd: string): (token: string | null) => Partial<ActivityAsset> | undefined {
  return (token) => {
    const t = tx.transfers.find((x) => (x.token === token || (x.token && token && sameAddress(x.token, token))) && (x.symbol !== undefined || x.decimals !== undefined))
    if (t) {
      const meta: Partial<ActivityAsset> = {}
      if (t.symbol !== undefined) meta.symbol = t.symbol
      if (t.decimals !== undefined) meta.decimals = t.decimals
      return meta
    }
    if (token && sameAddress(token, crvUsd)) return META['crvusd']
    if (token && sameAddress(token, scrvUsd)) return META['scrvusd']
    return undefined
  }
}

function sharesMoved(tx: ChainTx, own: Set<string>, vault: string): 'minted' | 'burned' | null {
  const isOwn = (a: string) => own.has(a) || own.has(a.toLowerCase())
  for (const t of tx.transfers) {
    if (t.token === null || !sameAddress(t.token, vault)) continue
    if (sameAddress(t.from, ZERO) && isOwn(t.to)) return 'minted'
    if (sameAddress(t.to, ZERO) && isOwn(t.from)) return 'burned'
  }
  return null
}

export function describeCurveLendingActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const chainId = parseEvmChainId(tx.chain)
  const chain = chainId === null ? undefined : CURVE_LENDING_CHAINS[chainId]
  const scrv = chain?.scrvUsd
  if (!chain || !scrv) return null
  const call = tx.call
  const subtitle = `Savings crvUSD · ${chain.name}`

  // The deposit's allowance: approve(scrvUSD, amount) on crvUSD.
  if (call?.to && call.selector?.toLowerCase() === APPROVE && sameAddress(call.to, chain.crvUsd) && call.data) {
    try {
      const { args } = decodeFunctionData({ abi: APPROVE_ABI, data: call.data as `0x${string}` })
      if (!sameAddress(args[0], scrv.vault)) return null
      const revoke = args[1] === 0n
      return activityBase(tx, revoke ? 'revoke' : 'approve', revoke ? 'Revoked crvUSD for Savings crvUSD' : 'Approved crvUSD for Savings crvUSD', { protocol: MODULE_NAME, subtitle, counterparty: scrv.vault })
    } catch {
      return null
    }
  }

  let action: Action | undefined
  if (call?.to && call.selector && sameAddress(call.to, scrv.vault)) action = SCRVUSD_ACTIONS[call.selector.toLowerCase()]
  if (!action) {
    const moved = sharesMoved(tx, ctx.own, scrv.vault)
    if (moved === 'minted') action = { kind: 'supply', verb: 'Deposited', principal: 'out' }
    else if (moved === 'burned') action = { kind: 'withdraw', verb: 'Withdrew', principal: 'in' }
  }
  if (!action) return null

  const net = netTransfers(tx, ctx.own)
  const { assetsIn, assetsOut } = splitNet(net, transferMeta(tx, chain.crvUsd, scrv.vault))
  const side = action.principal === 'out' ? assetsOut : assetsIn
  const principal = side.find((a) => a.token && sameAddress(a.token, chain.crvUsd)) ? 'crvUSD' : ''
  return activityBase(tx, action.kind, principal ? `${action.verb} ${principal}` : action.verb, {
    protocol: MODULE_NAME, subtitle, counterparty: call?.to ?? scrv.vault, assetsIn, assetsOut,
  })
}
