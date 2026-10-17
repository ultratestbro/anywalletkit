// Activity recognition for Morpho: Blue (the singleton) and the ERC-4626 vaults
// (MetaMorpho / Vault V1 and Vault V2). Pure and offline.
//
// Rules:
//  - Blue: the called contract is the Morpho singleton of the transaction's chain
//    (preset, or the one this instance was configured with) and the selector is a
//    Blue method — supply / withdraw / borrow / repay / supplyCollateral /
//    withdrawCollateral / setAuthorization.
//  - Vaults: the module cannot list every vault offline (they are created by
//    factories; the on-chain `isMetaMorpho` / `isVaultV2` proof needs a node), so a
//    vault transaction is recognized when the selector is an ERC-4626 entry point
//    (deposit / mint / withdraw / redeem) AND the called contract itself is the
//    share token that the receipt shows minted to (deposit / mint) or burned from
//    (withdraw / redeem) one of the wallet's addresses, AND the chain has a Morpho
//    deployment. A vault this instance was configured with is accepted by address
//    alone. Caveat (documented in the README): any ERC-4626 vault on a Morpho
//    chain satisfies the first rule; the kit asks modules in registry order, so a
//    module that knows the specific vault should come first.
import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainTx, type DescribeActivityContext,
} from '@forgewallet/core'
import { toFunctionSelector } from 'viem'
import { MORPHO_CHAINS } from './chains.js'

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@forgewallet/protocol-lending-morpho-evm'

const ZERO = '0x0000000000000000000000000000000000000000'
const sel = (signature: string): string => toFunctionSelector(`function ${signature}`).toLowerCase()
const MARKET_PARAMS = '(address,address,address,address,uint256)'

interface Action { kind: ActivityKind; verb: string; principal: 'out' | 'in' | 'none' }

/** Morpho Blue (IMorpho). */
export const BLUE_ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  [sel(`supply(${MARKET_PARAMS},uint256,uint256,address,bytes)`)]: { kind: 'supply', verb: 'Supplied', principal: 'out' },
  [sel(`withdraw(${MARKET_PARAMS},uint256,uint256,address,address)`)]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel(`borrow(${MARKET_PARAMS},uint256,uint256,address,address)`)]: { kind: 'borrow', verb: 'Borrowed', principal: 'in' },
  [sel(`repay(${MARKET_PARAMS},uint256,uint256,address,bytes)`)]: { kind: 'repay', verb: 'Repaid', principal: 'out' },
  [sel(`supplyCollateral(${MARKET_PARAMS},uint256,address,bytes)`)]: { kind: 'supply', verb: 'Supplied collateral', principal: 'out' },
  [sel(`withdrawCollateral(${MARKET_PARAMS},uint256,address,address)`)]: { kind: 'withdraw', verb: 'Withdrew collateral', principal: 'in' },
  [sel('setAuthorization(address,bool)')]: { kind: 'contract', verb: 'Updated Morpho authorization', principal: 'none' },
})

/** ERC-4626 entry points shared by MetaMorpho / Vault V1 and Vault V2. */
export const VAULT_ACTIONS: Readonly<Record<string, Action & { shares: 'minted' | 'burned' }>> = Object.freeze({
  [sel('deposit(uint256,address)')]: { kind: 'supply', verb: 'Deposited', principal: 'out', shares: 'minted' },
  [sel('mint(uint256,address)')]: { kind: 'supply', verb: 'Deposited', principal: 'out', shares: 'minted' },
  [sel('withdraw(uint256,address,address)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in', shares: 'burned' },
  [sel('redeem(uint256,address,address)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in', shares: 'burned' },
})

export function parseEvmChainId(chain: string): number | null {
  const m = /^eip155:(\d+)$/.exec(chain)
  return m ? Number(m[1]) : null
}

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

function transferMeta(tx: ChainTx): (token: string | null) => Partial<ActivityAsset> | undefined {
  return (token) => {
    const t = tx.transfers.find((x) => (x.token === token || (x.token && token && sameAddress(x.token, token))) && (x.symbol !== undefined || x.decimals !== undefined))
    if (!t) return undefined
    const meta: Partial<ActivityAsset> = {}
    if (t.symbol !== undefined) meta.symbol = t.symbol
    if (t.decimals !== undefined) meta.decimals = t.decimals
    return meta
  }
}

/** Shares of `vault` minted to / burned from one of `own` in this receipt. */
function sharesMoved(tx: ChainTx, own: Set<string>, vault: string, how: 'minted' | 'burned'): boolean {
  const isOwn = (a: string) => own.has(a) || own.has(a.toLowerCase())
  return tx.transfers.some((t) => t.token !== null && sameAddress(t.token, vault) && (how === 'minted' ? isOwn(t.to) && sameAddress(t.from, ZERO) : isOwn(t.from) && sameAddress(t.to, ZERO)))
}

export interface MorphoActivityContext {
  /** Morpho (Blue) singleton for the transaction's chain, when known. */
  morpho?: string
  /** A vault this instance is configured with: accepted by address. */
  vault?: string
  /** Human chain label for the subtitle. */
  chainName: string
}

export function describeMorphoActivity(tx: ChainTx, ctx: DescribeActivityContext, m: MorphoActivityContext): ActivityItem | null {
  const call = tx.call
  if (!call?.to || !call.selector) return null
  const selector = call.selector.toLowerCase()
  const finish = (action: Action, venue: string, principalToken?: string | null): ActivityItem => {
    const net = netTransfers(tx, ctx.own)
    const { assetsIn, assetsOut } = splitNet(net, transferMeta(tx))
    const side = action.principal === 'out' ? assetsOut : action.principal === 'in' ? assetsIn : []
    // The principal is the loan / underlying asset, never the share token the vault mints or burns.
    const candidates = side.filter((a) => !(a.token && sameAddress(a.token, call.to)))
    const principal: ActivityAsset | undefined = (principalToken ? candidates.find((a) => a.token && sameAddress(a.token, principalToken)) : undefined) ?? candidates[0]
    const label = principal?.symbol ?? (principal?.token ? short(principal.token) : '')
    return activityBase(tx, action.kind, label ? `${action.verb} ${label}` : action.verb, {
      protocol: MODULE_NAME, subtitle: `${venue} · ${m.chainName}`, counterparty: call.to, assetsIn, assetsOut,
    })
  }

  // Blue: by address. `loanToken` is the first word of MarketParams when calldata is present.
  if (m.morpho && sameAddress(call.to, m.morpho)) {
    const action = BLUE_ACTIONS[selector]
    if (!action) return activityBase(tx, 'contract', 'Morpho transaction', { protocol: MODULE_NAME, subtitle: `Morpho · ${m.chainName}`, counterparty: call.to })
    const loanToken = call.data && call.data.length >= 74 ? `0x${call.data.slice(34, 74)}` : null
    return finish(action, 'Morpho', loanToken)
  }

  // Vaults: ERC-4626 selector + the called contract's shares moved for us (or the configured vault).
  const action = VAULT_ACTIONS[selector]
  if (!action) return null
  if (m.vault && sameAddress(call.to, m.vault)) return finish(action, 'Morpho Vault')
  if (sharesMoved(tx, ctx.own, call.to, action.shares)) return finish(action, 'Morpho Vault')
  return null
}

/** Preset context for a chain id (undefined when Morpho is not deployed there). */
export function presetContext(chainId: number): MorphoActivityContext | undefined {
  const c = MORPHO_CHAINS[chainId]
  return c ? { morpho: c.morpho, chainName: c.name } : undefined
}
