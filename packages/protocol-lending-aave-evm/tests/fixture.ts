// A two-reserve Aave v3 market (USDT 6 decimals, WETH 18) with mutable state.
import { getAddress, maxUint256, type Address } from 'viem'
import { createMockAccount } from '@anywalletkit/conformance'
import { ADDRESSES_PROVIDER_ABI, ERC20_ABI, GATEWAY_ABI, ORACLE_ABI, POOL_ABI, VARIABLE_DEBT_ABI } from '../src/abi.js'
import { FakeChain, revertCustom, revertString } from './fake-chain.js'

export const USER = getAddress('0x000000000000000000000000000000000000dEaD')
export const OTHER = getAddress('0x00000000000000000000000000000000000000A1')
export const ADDRESSES_PROVIDER = getAddress('0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e')
export const POOL = getAddress('0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2')
export const ORACLE = getAddress('0x54586bE62E3c3580375aE3723C145253060Ca0C2')
export const DATA_PROVIDER = getAddress('0x0a16f2FCC0D44FaE41cc54e079281D84A363bECD')
export const GATEWAY = getAddress('0xd01607c3C5eCABa394D8be377a08590149325722')
export const WETH = getAddress('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2')
export const USDT = getAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7')
export const A_USDT = getAddress('0x23878914EFE38d27C4D67Ab83ed1b93A74D4086a')
export const V_USDT = getAddress('0x6df1C1E379bC5a00a7b4C6e67A203333772f45A8')
export const A_WETH = getAddress('0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8')
export const V_WETH = getAddress('0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE')

export const E6 = 10n ** 6n
export const E8 = 10n ** 8n
export const E18 = 10n ** 18n
export const RAY = 10n ** 27n

export interface ReserveCfg {
  ltv: number; liquidationThreshold: number; liquidationBonus: number; decimals: number
  active?: boolean; frozen?: boolean; borrowingEnabled?: boolean; paused?: boolean
  reserveFactor?: number; borrowCap?: bigint; supplyCap?: bigint
}

/** ReserveConfigurationMap bits as ReserveConfiguration.sol lays them out. */
export function buildConfiguration(c: ReserveCfg): bigint {
  let d = 0n
  d |= BigInt(c.ltv)
  d |= BigInt(c.liquidationThreshold) << 16n
  d |= BigInt(c.liquidationBonus) << 32n
  d |= BigInt(c.decimals) << 48n
  if (c.active ?? true) d |= 1n << 56n
  if (c.frozen) d |= 1n << 57n
  if (c.borrowingEnabled ?? true) d |= 1n << 58n
  if (c.paused) d |= 1n << 60n
  d |= BigInt(c.reserveFactor ?? 1000) << 64n
  d |= (c.borrowCap ?? 0n) << 80n
  d |= (c.supplyCap ?? 0n) << 116n
  return d
}

export interface MarketState {
  dialect: 'string' | 'custom'
  reserves: Record<Address, ReserveCfg & { aToken: Address; vToken: Address; id: number; liquidityRate: bigint; borrowRate: bigint; price: bigint }>
  allowances: Map<string, bigint>
  balances: Map<string, bigint>
  totalSupply: Map<Address, bigint>
  delegation: Map<string, bigint>
  userConfig: bigint
  account: { collateral: bigint; debt: bigint; available: bigint; lt: bigint; ltv: bigint; hf: bigint }
  /** Pool write functions that must revert, with Aave's reason. */
  revertOn: Map<string, string>
  poolAddress: Address
}

const key = (...parts: string[]) => parts.map((p) => p.toLowerCase()).join(':')

export function makeMarket(overrides: Partial<MarketState> = {}): { chain: FakeChain; state: MarketState } {
  const state: MarketState = {
    dialect: 'string',
    reserves: {
      [USDT]: { ltv: 7500, liquidationThreshold: 7800, liquidationBonus: 10450, decimals: 6, aToken: A_USDT, vToken: V_USDT, id: 0, liquidityRate: RAY * 4n / 100n, borrowRate: RAY * 6n / 100n, price: E8 },
      [WETH]: { ltv: 8050, liquidationThreshold: 8300, liquidationBonus: 10500, decimals: 18, aToken: A_WETH, vToken: V_WETH, id: 1, liquidityRate: RAY * 2n / 100n, borrowRate: RAY * 3n / 100n, price: 3000n * E8 },
    },
    allowances: new Map(),
    balances: new Map(),
    totalSupply: new Map([[A_USDT, 500_000n * E6], [V_USDT, 300_000n * E6], [A_WETH, 1000n * E18], [V_WETH, 400n * E18]]),
    delegation: new Map(),
    userConfig: 0n,
    account: { collateral: 0n, debt: 0n, available: 0n, lt: 7800n, ltv: 7500n, hf: maxUint256 },
    revertOn: new Map(),
    poolAddress: POOL,
    ...overrides,
  }
  const chain = new FakeChain()
  const revert = (reason: string) => (state.dialect === 'string' ? revertString(reason) : revertCustom(reason))
  const codeOf: Record<string, string> = { HealthFactorLowerThanLiquidationThreshold: '35', SupplyCapExceeded: '51', CollateralCannotCoverNewBorrow: '36', NotEnoughAvailableUserBalance: '32' }
  const fail = (fn: string) => {
    const name = state.revertOn.get(fn)
    if (name) revert(state.dialect === 'string' ? (codeOf[name] ?? name) : name)
  }

  chain.on(ADDRESSES_PROVIDER, ADDRESSES_PROVIDER_ABI, (fn) => {
    if (fn === 'getPool') return state.poolAddress
    if (fn === 'getPriceOracle') return ORACLE
    if (fn === 'getPoolDataProvider') return DATA_PROVIDER
    if (fn === 'getMarketId') return 'Aave V3 Ethereum Market'
    throw new Error(fn)
  })
  chain.on(ORACLE, ORACLE_ABI, (fn, args) => {
    if (fn === 'BASE_CURRENCY_UNIT') return E8
    if (fn === 'getAssetPrice') return state.reserves[getAddress(args[0] as Address)]!.price
    if (fn === 'getAssetsPrices') return (args[0] as Address[]).map((a) => state.reserves[getAddress(a)]!.price)
    throw new Error(fn)
  })
  chain.on(GATEWAY, GATEWAY_ABI, (fn) => {
    if (fn === 'getWETHAddress') return WETH
    fail(fn)
    return undefined
  })
  chain.on(POOL, POOL_ABI, (fn, args) => {
    switch (fn) {
      case 'getReservesList': return Object.keys(state.reserves)
      case 'getReserveData': {
        const r = state.reserves[getAddress(args[0] as Address)]
        if (!r) throw new Error('unknown reserve')
        return {
          configuration: { data: buildConfiguration(r) }, liquidityIndex: RAY, currentLiquidityRate: r.liquidityRate, variableBorrowIndex: RAY,
          currentVariableBorrowRate: r.borrowRate, currentStableBorrowRate: 0n, lastUpdateTimestamp: 1_760_000_000, id: r.id,
          aTokenAddress: r.aToken, stableDebtTokenAddress: '0x0000000000000000000000000000000000000000', variableDebtTokenAddress: r.vToken,
          interestRateStrategyAddress: '0x0000000000000000000000000000000000000001', accruedToTreasury: 0n, unbacked: 0n, isolationModeTotalDebt: 0n,
        }
      }
      case 'getUserAccountData': {
        const a = state.account
        return [a.collateral, a.debt, a.available, a.lt, a.ltv, a.hf]
      }
      case 'getUserConfiguration': return { data: state.userConfig }
      case 'getReserveNormalizedIncome': return RAY
      case 'ADDRESSES_PROVIDER': return ADDRESSES_PROVIDER
      default:
        fail(fn)
        if (fn === 'withdraw' || fn === 'repay' || fn === 'repayWithATokens' || fn === 'repayWithPermit') return 0n
        return undefined
    }
  })
  const erc20 = (token: Address) => (fn: string, args: readonly unknown[]) => {
    switch (fn) {
      case 'allowance': return state.allowances.get(key(token, args[0] as string, args[1] as string)) ?? 0n
      case 'balanceOf': return state.balances.get(key(token, args[0] as string)) ?? 0n
      case 'totalSupply': return state.totalSupply.get(token) ?? 0n
      case 'decimals': return token === USDT ? 6 : 18
      case 'symbol': return token === USDT ? 'USDT' : token === WETH ? 'WETH' : token === A_USDT ? 'aEthUSDT' : token === A_WETH ? 'aEthWETH' : '?'
      case 'approve': return true
      case 'approveDelegation': return undefined
      case 'borrowAllowance': return state.delegation.get(key(token, args[0] as string, args[1] as string)) ?? 0n
      default: throw new Error(fn)
    }
  }
  const merged = [...ERC20_ABI, ...VARIABLE_DEBT_ABI.filter((x) => x.type === 'function' && !ERC20_ABI.some((y) => y.type === 'function' && y.name === x.name))]
  for (const t of [USDT, WETH, A_USDT, A_WETH, V_USDT, V_WETH]) chain.on(t, merged, erc20(t))
  return { chain, state }
}

export const setAllowance = (s: MarketState, token: Address, owner: Address, spender: Address, v: bigint) => s.allowances.set(key(token, owner, spender), v)
export const setBalance = (s: MarketState, token: Address, owner: Address, v: bigint) => s.balances.set(key(token, owner), v)
export const setDelegation = (s: MarketState, vToken: Address, from: Address, to: Address, v: bigint) => s.delegation.set(key(vToken, from, to), v)

/** A signing mock account on eip155:1 (the conformance one, address USER). */
export const account = () => createMockAccount({ chain: 'eip155:1', address: USER })

/** The same plus wallet-evm's permit surface, so the permit road can be tested. */
export function permitAccount(supported = true) {
  const a = account() as ReturnType<typeof account> & {
    getPermitInfo: (t: string) => Promise<{ supported: boolean }>
    signPermit: (o: { token: string; spender: string; value: bigint; deadline: bigint }) => Promise<{ v: number; r: `0x${string}`; s: `0x${string}`; deadline: bigint }>
    permits: unknown[]
  }
  a.permits = []
  a.getPermitInfo = async () => ({ supported })
  a.signPermit = async (o) => { a.permits.push(o); return { v: 27, r: `0x${'11'.repeat(32)}`, s: `0x${'22'.repeat(32)}`, deadline: o.deadline } }
  return a
}
