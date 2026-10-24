// Activity recognition: turns a chain-normalized transaction into "Supplied USDC ·
// Aave v3 · Base". Pure and offline — the only inputs are the transaction, the
// wallet's own addresses and the market presets this package ships.
//
// Rule: the called contract must be a known Aave v3 Pool or WrappedTokenGatewayV3
// (every preset market on the transaction's chain, plus the market this instance
// was configured with), and the 4-byte selector decides the kind. Amounts come
// from the receipt's transfers (net per token for the wallet); the principal
// asset is the `address asset` argument when calldata is present, otherwise the
// token that moved in the direction the action implies.
import {
  activityBase, netTransfers, sameAddress, splitNet,
  type ActivityAsset, type ActivityItem, type ActivityKind, type ChainTx, type DescribeActivityContext,
} from '@anywalletkit/core'
import { toFunctionSelector } from 'viem'
import { AAVE_MARKETS, type AaveMarket } from './markets.js'

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-lending-aave-evm'

interface Action {
  kind: ActivityKind
  verb: string
  /** Which side of the net transfers holds the principal asset. */
  principal: 'out' | 'in' | 'none'
  /** Gateway methods move the chain's native coin. */
  native?: boolean
}

const sel = (signature: string): string => toFunctionSelector(`function ${signature}`).toLowerCase()

/** IPool (aave-v3-origin). Every method takes `address asset` as its first argument. */
export const POOL_ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  [sel('supply(address,uint256,address,uint16)')]: { kind: 'supply', verb: 'Supplied', principal: 'out' },
  [sel('supplyWithPermit(address,uint256,address,uint16,uint256,uint8,bytes32,bytes32)')]: { kind: 'supply', verb: 'Supplied', principal: 'out' },
  [sel('deposit(address,uint256,address,uint16)')]: { kind: 'supply', verb: 'Supplied', principal: 'out' }, // v2-compatible alias still on v3 pools
  [sel('withdraw(address,uint256,address)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in' },
  [sel('borrow(address,uint256,uint256,uint16,address)')]: { kind: 'borrow', verb: 'Borrowed', principal: 'in' },
  [sel('repay(address,uint256,uint256,address)')]: { kind: 'repay', verb: 'Repaid', principal: 'out' },
  [sel('repayWithPermit(address,uint256,uint256,address,uint256,uint8,bytes32,bytes32)')]: { kind: 'repay', verb: 'Repaid', principal: 'out' },
  [sel('repayWithATokens(address,uint256,uint256)')]: { kind: 'repay', verb: 'Repaid', principal: 'out' },
  [sel('setUserUseReserveAsCollateral(address,bool)')]: { kind: 'contract', verb: 'Updated collateral for', principal: 'none' },
  [sel('setUserEMode(uint8)')]: { kind: 'contract', verb: 'Changed E-Mode', principal: 'none' },
})

/** WrappedTokenGatewayV3 (v3.2+ signatures, see abi.ts). */
export const GATEWAY_ACTIONS: Readonly<Record<string, Action>> = Object.freeze({
  [sel('depositETH(address,address,uint16)')]: { kind: 'supply', verb: 'Supplied', principal: 'out', native: true },
  [sel('withdrawETH(address,uint256,address)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in', native: true },
  [sel('borrowETH(address,uint256,uint16)')]: { kind: 'borrow', verb: 'Borrowed', principal: 'in', native: true },
  [sel('repayETH(address,uint256,address)')]: { kind: 'repay', verb: 'Repaid', principal: 'out', native: true },
  [sel('withdrawETHWithPermit(address,uint256,address,uint256,uint8,bytes32,bytes32)')]: { kind: 'withdraw', verb: 'Withdrew', principal: 'in', native: true },
})

/** Native coin ticker per chain with a known market (for gateway titles). */
const NATIVE_SYMBOL: Readonly<Record<number, string>> = Object.freeze({
  1: 'ETH', 10: 'ETH', 56: 'BNB', 100: 'xDAI', 137: 'POL', 146: 'S', 324: 'ETH', 1088: 'METIS', 1868: 'ETH', 5000: 'MNT',
  8453: 'ETH', 9745: 'XPL', 42161: 'ETH', 42220: 'CELO', 43114: 'AVAX', 57073: 'ETH', 59144: 'ETH', 534352: 'ETH',
})

/** A market as the recognizer needs it: Pool, optional gateway, display name. */
export interface ActivityMarket {
  pool: string
  wethGateway?: string
  /** Human chain label for the subtitle ("Base", "Ethereum Lido"). */
  chainName: string
}

export function parseEvmChainId(chain: string): number | null {
  const m = /^eip155:(\d+)$/.exec(chain)
  return m ? Number(m[1]) : null
}

/** "Aave V3 Base" → "Base", "Aave V3 Ink (whitelabel)" → "Ink". */
export const marketChainName = (m: AaveMarket): string => m.name.replace(/^Aave V3 /, '').replace(/ \(whitelabel\)$/, '')

export const toActivityMarket = (m: AaveMarket): ActivityMarket =>
  m.wethGateway ? { pool: m.pool, wethGateway: m.wethGateway, chainName: marketChainName(m) } : { pool: m.pool, chainName: marketChainName(m) }

/** Every preset market on a chain. */
export function presetMarkets(chainId: number): ActivityMarket[] {
  return Object.values(AAVE_MARKETS[chainId] ?? {}).map(toActivityMarket)
}

const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`

/** Symbol / decimals the history source attached to a token's transfers, if any. */
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

/**
 * Describe `tx` if it is a call to one of `markets`. Returns null for anything else
 * (another protocol, a plain transfer, a chain without a market).
 */
export function describeAaveActivity(tx: ChainTx, ctx: DescribeActivityContext, markets: readonly ActivityMarket[]): ActivityItem | null {
  const call = tx.call
  if (!call?.to || !call.selector) return null
  const chainId = parseEvmChainId(tx.chain)
  if (chainId === null) return null
  const selector = call.selector.toLowerCase()

  for (const m of markets) {
    const isPool = sameAddress(call.to, m.pool)
    const isGateway = m.wethGateway !== undefined && sameAddress(call.to, m.wethGateway)
    if (!isPool && !isGateway) continue

    const action = (isPool ? POOL_ACTIONS : GATEWAY_ACTIONS)[selector]
    const net = netTransfers(tx, ctx.own)
    // The top-level native value is not in `transfers` on every source; count it once.
    if (tx.nativeValue > 0n && !tx.transfers.some((t) => t.token === null && sameAddress(t.from, tx.from) && sameAddress(t.to, call.to) && t.amount === tx.nativeValue)) {
      net.set(null, (net.get(null) ?? 0n) - tx.nativeValue)
    }
    const { assetsIn, assetsOut } = splitNet(net, transferMeta(tx))
    const subtitle = `Aave v3 · ${m.chainName}`
    const common = { protocol: MODULE_NAME, subtitle, counterparty: call.to, assetsIn, assetsOut }

    if (!action) return activityBase(tx, 'contract', 'Aave v3 transaction', common)

    let label: string
    if (action.native) {
      label = NATIVE_SYMBOL[chainId] ?? 'ETH'
    } else {
      const decoded = call.data && call.data.length >= 74 ? `0x${call.data.slice(34, 74)}` : null
      const side = action.principal === 'out' ? assetsOut : action.principal === 'in' ? assetsIn : []
      const principal: ActivityAsset | undefined = (decoded ? [...assetsOut, ...assetsIn].find((a) => a.token && sameAddress(a.token, decoded)) : undefined) ?? side[0]
      label = principal?.symbol ?? (principal?.token ? short(principal.token) : decoded ? short(decoded) : '')
    }
    const title = label ? `${action.verb} ${label}` : action.verb
    return activityBase(tx, action.kind, title, common)
  }
  return null
}
