// An in-memory scrvUSD on Ethereum: the vault's real runtime code (the EIP-1167 clone) and the
// implementation's real VaultV3 3.0.4 code for the identity checks, a VaultV3 that converts at
// the live share price of 2026-11-05 (block 26 350 290), its profit-unlocking state, and crvUSD.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { getAddress, maxUint256, type Address, type Hex } from 'viem'
import { createMockAccount } from '@anywalletkit/conformance'
import { ERC20_ABI, VAULT_V3_ABI } from '../src/abi.js'
import { SCRVUSD } from '../src/chains.js'
import { FakeChain, revertString } from './fake-chain.js'

export const USER = getAddress('0x00000000000000000000000000000000000000B0')
export const OTHER = getAddress('0x00000000000000000000000000000000000000A1')
export const VAULT = getAddress(SCRVUSD.vault)
export const IMPL = getAddress(SCRVUSD.implementation)
export const CRVUSD = getAddress(SCRVUSD.asset)
export const ROLE_MANAGER = getAddress('0x40907540d8a6C65c637785e8f8B742ae6b0b9968')
export const E18 = 10n ** 18n

export const IMPL_CODE = readFileSync(fileURLToPath(new URL('./fixtures/vault-v3-3.0.4.runtime.hex', import.meta.url)), 'utf8').trim() as Hex

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(':')

export interface State {
  apiVersion: string
  asset: Address
  isShutdown: boolean
  totalAssets: bigint
  totalSupply: bigint
  totalDebt: bigint
  maxDeposit: bigint
  /** What the vault can pay out now (maxWithdraw / maxRedeem bound). */
  liquid: bigint
  profitUnlockingRate: bigint
  fullProfitUnlockDate: bigint
  balances: Map<string, bigint>
  allowances: Map<string, bigint>
  /** write fn → VaultV3 revert string */
  revertOn: Map<string, string>
}

export function makeScrvUsd(overrides: Partial<State> = {}): { chain: FakeChain; state: State } {
  const state: State = {
    apiVersion: '3.0.4',
    asset: CRVUSD,
    isShutdown: false,
    // Live on 2026-11-05: 14.96M crvUSD over 13.45M shares (price per share 1.1119).
    totalAssets: 14_957_723_797_672_854_293_931_291n,
    totalSupply: 13_452_475_871_734_876_233_205_548n,
    totalDebt: 0n,
    maxDeposit: maxUint256,
    liquid: 14_957_723_797_672_854_293_931_291n,
    profitUnlockingRate: 25_953_163_264_686_406_615_740_034_288n,
    fullProfitUnlockDate: 1_794_304_075n,
    balances: new Map(),
    allowances: new Map(),
    revertOn: new Map(),
    ...overrides,
  }
  const chain = new FakeChain()
  chain.chainId = 1
  chain.codes.set(VAULT.toLowerCase(), SCRVUSD.cloneCode)
  chain.codes.set(IMPL.toLowerCase(), IMPL_CODE)
  const fail = (fn: string) => { const r = state.revertOn.get(fn); if (r) revertString(r) }
  const toAssets = (s: bigint) => (s * state.totalAssets) / state.totalSupply
  const toShares = (a: bigint) => (a * state.totalSupply) / state.totalAssets
  const toSharesUp = (a: bigint) => (a * state.totalSupply + state.totalAssets - 1n) / state.totalAssets
  const bal = (who: unknown) => state.balances.get(key(VAULT, who as string)) ?? 0n

  chain.on(VAULT, VAULT_V3_ABI, (fn, args) => {
    switch (fn) {
      case 'apiVersion': return state.apiVersion
      case 'asset': return state.asset
      case 'name': return 'Savings crvUSD'
      case 'symbol': return 'scrvUSD'
      case 'decimals': return 18
      case 'isShutdown': return state.isShutdown
      case 'totalAssets': return state.totalAssets
      case 'totalSupply': return state.totalSupply
      case 'totalIdle': return state.totalAssets - state.totalDebt
      case 'totalDebt': return state.totalDebt
      case 'pricePerShare': return toAssets(E18)
      case 'profitMaxUnlockTime': return 604_800n
      case 'fullProfitUnlockDate': return state.fullProfitUnlockDate
      case 'profitUnlockingRate': return state.profitUnlockingRate
      case 'lastProfitUpdate': return state.fullProfitUnlockDate - 604_800n
      case 'role_manager': return ROLE_MANAGER
      case 'balanceOf': return bal(args[0])
      case 'convertToAssets': case 'previewRedeem': return toAssets(args[0] as bigint)
      case 'convertToShares': case 'previewDeposit': return toShares(args[0] as bigint)
      case 'previewWithdraw': return toSharesUp(args[0] as bigint)
      case 'maxDeposit': return state.isShutdown ? 0n : state.maxDeposit
      case 'maxWithdraw': { const a = toAssets(bal(args[0])); return a < state.liquid ? a : state.liquid }
      // VaultV3: min(convertToShares(maxWithdraw, down), balance) — one unit short of the balance even when fully liquid.
      case 'maxRedeem': { const s = bal(args[0]); const a = toAssets(s); const w = toShares(a < state.liquid ? a : state.liquid); return w < s ? w : s }
      case 'deposit': fail(fn); if (state.isShutdown) revertString('exceed deposit limit'); return toShares(args[0] as bigint)
      case 'withdraw': fail(fn); return toSharesUp(args[0] as bigint)
      case 'redeem': fail(fn); if ((args[0] as bigint) > bal(args[2])) revertString('insufficient shares to redeem'); return toAssets(args[0] as bigint)
      default: throw new Error(`vault: ${fn}`)
    }
  })
  chain.on(CRVUSD, ERC20_ABI, (fn, args) => {
    switch (fn) {
      case 'allowance': return state.allowances.get(key(CRVUSD, args[0] as string, args[1] as string)) ?? 0n
      case 'balanceOf': return state.balances.get(key(CRVUSD, args[0] as string)) ?? 0n
      case 'decimals': return 18
      case 'symbol': return 'crvUSD'
      case 'approve': return true
      default: throw new Error(fn)
    }
  })
  return { chain, state }
}

export const setAllowance = (s: State, owner: Address, v: bigint) => s.allowances.set(key(CRVUSD, owner, VAULT), v)
export const setShares = (s: State, owner: Address, v: bigint) => s.balances.set(key(VAULT, owner), v)

export const account = () => createMockAccount({ chain: 'eip155:1', address: USER })
