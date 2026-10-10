// An in-memory Morpho on Base: the Blue singleton with one cbBTC/USDC market
// (the real Base market, so the id derivation has a golden value), an IRM and
// oracle, a MetaMorpho USDC vault acknowledged by the v1.0 factory, tokens.
import { getAddress, maxUint256, type Abi, type Address, type Hex } from 'viem'
import { createMockAccount } from '@forgewallet/conformance'
import { ERC20_ABI, ERC4626_ABI, FACTORY_V1_ABI, FACTORY_V2_ABI, IRM_ABI, MORPHO_ABI, ORACLE_ABI, VAULT_V1_ABI } from '../src/abi.js'
import { marketId, toAssetsDown, toSharesDown, toSharesUp, type MarketParams, type MarketState } from '../src/math.js'
import { FakeChain, revertString } from './fake-chain.js'

export const USER = getAddress('0x000000000000000000000000000000000000dEaD')
export const OTHER = getAddress('0x00000000000000000000000000000000000000A1')
export const MORPHO = getAddress('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb')
export const FACTORY_V1 = getAddress('0xA9c3D3a366466Fa809d1Ae982Fb2c46E5fC41101')
export const FACTORY_V2 = getAddress('0x4501125508079A99ebBebCE205DeC9593C2b5857')
export const USDC = getAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')
export const CBBTC = getAddress('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf')
export const ORACLE = getAddress('0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9')
export const IRM = getAddress('0x46415998764C29aB2a25CbeA6254146D50D22687')
export const VAULT = getAddress('0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61')
export const FAKE_VAULT = getAddress('0x00000000000000000000000000000000000000F0')

export const E6 = 10n ** 6n
export const E8 = 10n ** 8n
export const E18 = 10n ** 18n
export const WAD = E18

export const PARAMS: MarketParams = { loanToken: USDC, collateralToken: CBBTC, oracle: ORACLE, irm: IRM, lltv: 860000000000000000n }
/** The live Base cbBTC/USDC market id (Morpho API, 2026-10-10). */
export const MARKET_ID: Hex = '0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836'

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(':')
/** Per-second WAD rate for ~5 % APR. */
export const RATE = 1_585_489_599n

export interface State {
  market: MarketState
  positions: Map<string, { supplyShares: bigint; borrowShares: bigint; collateral: bigint }>
  /** 1 cbBTC = 100 000 USDC → price scaled 1e36 × 10^(6−8). */
  price: bigint
  allowances: Map<string, bigint>
  balances: Map<string, bigint>
  authorized: Map<string, boolean>
  vault: { totalAssets: bigint; totalSupply: bigint; maxDeposit: bigint; liquid: bigint; fee: bigint; isMetaMorpho: boolean }
  /** write fn → Morpho revert string */
  revertOn: Map<string, string>
}

export function makeMorpho(overrides: Partial<State> = {}): { chain: FakeChain; state: State } {
  const state: State = {
    market: { totalSupplyAssets: 1_000_000n * E6, totalSupplyShares: 1_000_000n * E6 * 10n ** 6n, totalBorrowAssets: 900_000n * E6, totalBorrowShares: 900_000n * E6 * 10n ** 6n, lastUpdate: BigInt(Math.floor(Date.now() / 1000)), fee: 0n },
    positions: new Map(),
    price: 100_000n * 10n ** 36n * E6 / E8,
    allowances: new Map(),
    balances: new Map(),
    authorized: new Map(),
    vault: { totalAssets: 500_000n * E6, totalSupply: 500_000n * E18, maxDeposit: maxUint256, liquid: 500_000n * E6, fee: 10n ** 17n, isMetaMorpho: true },
    revertOn: new Map(),
    ...overrides,
  }
  const chain = new FakeChain()
  chain.chainId = 8453
  const fail = (fn: string) => { const r = state.revertOn.get(fn); if (r) revertString(r) }
  const pos = (who: string) => state.positions.get(who.toLowerCase()) ?? { supplyShares: 0n, borrowShares: 0n, collateral: 0n }

  chain.on(MORPHO, MORPHO_ABI, (fn, args) => {
    switch (fn) {
      case 'market': {
        if ((args[0] as string).toLowerCase() !== MARKET_ID) return [0n, 0n, 0n, 0n, 0n, 0n]
        const m = state.market
        return [m.totalSupplyAssets, m.totalSupplyShares, m.totalBorrowAssets, m.totalBorrowShares, m.lastUpdate, m.fee]
      }
      case 'idToMarketParams':
        if ((args[0] as string).toLowerCase() !== MARKET_ID) return ['0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n]
        return [PARAMS.loanToken, PARAMS.collateralToken, PARAMS.oracle, PARAMS.irm, PARAMS.lltv]
      case 'position': { const p = pos(args[1] as string); return [p.supplyShares, p.borrowShares, p.collateral] }
      case 'isAuthorized': return state.authorized.get(key(args[0] as string, args[1] as string)) ?? false
      case 'supply': fail(fn); return [args[1], 0n]
      case 'withdraw': fail(fn); return [args[1], args[2]]
      case 'borrow': fail(fn); return [args[1], 0n]
      case 'repay': fail(fn); return [args[1], args[2]]
      case 'supplyCollateral': case 'withdrawCollateral': case 'setAuthorization': case 'accrueInterest': fail(fn); return undefined
      default: throw new Error(`morpho: ${fn}`)
    }
  })
  chain.on(IRM, IRM_ABI, (fn) => { if (fn === 'borrowRateView') return RATE; throw new Error(fn) })
  chain.on(ORACLE, ORACLE_ABI, (fn) => { if (fn === 'price') return state.price; throw new Error(fn) })
  chain.on(FACTORY_V1, FACTORY_V1_ABI, (fn, args) => {
    if (fn === 'isMetaMorpho') return state.vault.isMetaMorpho && (args[0] as string).toLowerCase() === VAULT.toLowerCase()
    if (fn === 'MORPHO') return MORPHO
    throw new Error(fn)
  })
  chain.on(FACTORY_V2, FACTORY_V2_ABI, (fn) => { if (fn === 'isVaultV2') return false; throw new Error(fn) })

  const vaultHandler = (fn: string, args: readonly unknown[]) => {
    const v = state.vault
    const toShares = (a: bigint) => (a * (v.totalSupply + 10n ** 12n)) / (v.totalAssets + 1n) // DECIMALS_OFFSET 12 virtual shares
    const toAssets = (s: bigint) => (s * (v.totalAssets + 1n)) / (v.totalSupply + 10n ** 12n)
    switch (fn) {
      case 'asset': return USDC
      case 'name': return 'Gauntlet USDC Prime'
      case 'symbol': return 'gtUSDCp'
      case 'decimals': return 18
      case 'totalAssets': return v.totalAssets
      case 'totalSupply': return v.totalSupply
      case 'balanceOf': return state.balances.get(key(VAULT, args[0] as string)) ?? 0n
      case 'convertToAssets': return toAssets(args[0] as bigint)
      case 'convertToShares': case 'previewDeposit': return toShares(args[0] as bigint)
      case 'previewRedeem': return toAssets(args[0] as bigint)
      case 'maxDeposit': return v.maxDeposit
      case 'maxWithdraw': { const a = toAssets(state.balances.get(key(VAULT, args[0] as string)) ?? 0n); return a < v.liquid ? a : v.liquid }
      case 'maxRedeem': { const s = state.balances.get(key(VAULT, args[0] as string)) ?? 0n; const a = toAssets(s); return a <= v.liquid ? s : toShares(v.liquid) }
      case 'MORPHO': return MORPHO
      case 'fee': return v.fee
      case 'timelock': return 604800n
      case 'curator': return OTHER
      case 'DECIMALS_OFFSET': return 12
      case 'deposit': fail(fn); return toShares(args[0] as bigint)
      case 'withdraw': fail(fn); return toShares(args[0] as bigint)
      case 'redeem': fail(fn); return toAssets(args[0] as bigint)
      case 'allowance': return state.allowances.get(key(VAULT, args[0] as string, args[1] as string)) ?? 0n
      case 'approve': return true
      default: throw new Error(`vault: ${fn}`)
    }
  }
  const nameOf = (x: unknown) => (x as { name?: string }).name
  const extra = (abi: readonly unknown[]) => abi.filter((x) => (x as { type: string }).type === 'function' && !ERC4626_ABI.some((y) => y.type === 'function' && y.name === nameOf(x)))
  const vaultAbi = [...ERC4626_ABI, ...extra(VAULT_V1_ABI), ...extra(ERC20_ABI)] as Abi
  chain.on(VAULT, vaultAbi, vaultHandler)
  chain.on(FAKE_VAULT, vaultAbi, vaultHandler)

  const erc20 = (token: Address, symbol: string, decimals: number) => (fn: string, args: readonly unknown[]) => {
    switch (fn) {
      case 'allowance': return state.allowances.get(key(token, args[0] as string, args[1] as string)) ?? 0n
      case 'balanceOf': return state.balances.get(key(token, args[0] as string)) ?? 0n
      case 'decimals': return decimals
      case 'symbol': return symbol
      case 'approve': return true
      default: throw new Error(fn)
    }
  }
  chain.on(USDC, ERC20_ABI, erc20(USDC, 'USDC', 6))
  chain.on(CBBTC, ERC20_ABI, erc20(CBBTC, 'cbBTC', 8))
  return { chain, state }
}

export const setAllowance = (s: State, token: Address, owner: Address, spender: Address, v: bigint) => s.allowances.set(key(token, owner, spender), v)
export const setBalance = (s: State, token: Address, owner: Address, v: bigint) => s.balances.set(key(token, owner), v)
export const setPosition = (s: State, who: Address, p: { supplyAssets?: bigint; borrowAssets?: bigint; collateral?: bigint }) => {
  const m = s.market
  s.positions.set(who.toLowerCase(), {
    supplyShares: p.supplyAssets ? toSharesDown(p.supplyAssets, m.totalSupplyAssets, m.totalSupplyShares) : 0n,
    borrowShares: p.borrowAssets ? toSharesUp(p.borrowAssets, m.totalBorrowAssets, m.totalBorrowShares) : 0n,
    collateral: p.collateral ?? 0n,
  })
}
export { toAssetsDown, marketId }

export const account = () => createMockAccount({ chain: 'eip155:8453', address: USER })
