import {
  LendingProtocol, NetworkError,
  type ActivityItem, type BorrowOptions, type ChainTx, type DescribeActivityContext, type IWalletAccount, type IWalletAccountReadOnly,
  type LendingQuote, type LendingResult, type RepayOptions, type SupplyOptions, type WithdrawOptions, bigintToNumber,
} from '@anywalletkit/core'
import {
  createPublicClient, custom, decodeFunctionResult, encodeFunctionData, fallback, getAddress, hexToString, http, isAddress, maxUint256, zeroAddress,
  type Abi, type Address, type EIP1193Provider, type Hex, type PublicClient, type Transport,
} from 'viem'
import { ADDRESSES_PROVIDER_ABI, ERC20_ABI, GATEWAY_ABI, MULTICALL3, ORACLE_ABI, POOL_ABI, VARIABLE_DEBT_ABI, VARIABLE_RATE_MODE } from './abi.js'
import { describeAaveActivity, parseEvmChainId, presetMarkets, type ActivityMarket } from './activity.js'
import { AaveError, toAaveError } from './errors.js'
import { AAVE_MARKETS, type AaveMarket } from './markets.js'
import {
  healthFactorToNumber, parseReserveConfiguration, rayToAprPct, rayToApyPct, userFlags, type ReserveInfo,
} from './reserve.js'

export type EvmProvider = string | EIP1193Provider

export interface AaveProtocolConfig {
  /** Chain the market lives on (default: the account's `eip155:N`, else 1). */
  chainId?: number
  /** Preset key in AAVE_MARKETS for the chain: 'core' (default), 'lido', 'etherfi'. */
  market?: string
  /** A PoolAddressesProvider for a market not in the presets. The Pool is read from it. */
  addressesProvider?: string
  /** Expected Pool address; checked against what the addresses provider reports. Presets fill it. */
  pool?: string
  /** WrappedTokenGatewayV3 for native-coin legs. `null` disables native support; presets fill it. */
  wethGateway?: string | null
  /** RPC url(s) or EIP-1193 provider(s) to read the chain through. Defaults to the account's own. */
  provider?: EvmProvider | EvmProvider[]
  /** Aave referral code (inactive on every market today — 0). */
  referralCode?: number
  /** Use `supplyWithPermit` / `repayWithPermit` when the token and the account support EIP-2612 (default true). */
  usePermit?: boolean
  /** Permit validity in seconds (default 1200). */
  permitTtlSeconds?: number
  /** How long to wait for an approval to be mined before the main transaction (default 180 000 ms). */
  waitTimeoutMs?: number
  /** Multicall3 address, or `false` to read reserves one call at a time. */
  multicall?: string | false
  /** Cache lifetime for the reserve list (default 30 000 ms). */
  reserveTtlMs?: number
}

/** Amount in base units, or 'max' for the whole position / whole debt. */
export type AmountOption = bigint | number | 'max'

export interface AaveSupplyOptions extends SupplyOptions { token: string }
export interface AaveWithdrawOptions extends Omit<WithdrawOptions, 'amount'> { amount: AmountOption }
export interface AaveBorrowOptions extends BorrowOptions { token: string }
export interface AaveRepayOptions extends Omit<RepayOptions, 'amount'> {
  amount: AmountOption
  /** Burn aTokens of the same asset instead of pulling the underlying (`repayWithATokens`). */
  withATokens?: boolean
}

export interface Tx { to: Address; data: Hex; value: bigint; gasLimit?: bigint }

export interface MarketInfo {
  chainId: number
  name: string
  addressesProvider: Address
  pool: Address
  oracle: Address
  dataProvider: Address
  /** Price decimals of the oracle (1e8 → USD with 8 decimals on every Aave market today). */
  baseCurrencyUnit: bigint
  wethGateway: Address | null
  /** The wrapped native token the gateway supplies (WETH, WMATIC, WAVAX, …); null without a gateway. */
  wrappedNative: Address | null
}

export interface AccountData {
  /** In base currency units (see MarketInfo.baseCurrencyUnit). */
  totalCollateralBase: bigint
  totalDebtBase: bigint
  availableBorrowsBase: bigint
  /** Fractions: 0.8 = 80 %. */
  currentLiquidationThreshold: number
  ltv: number
  /** WAD; uint256.max without debt. */
  healthFactorWad: bigint
  /** 1.0 = liquidation line; Infinity without debt. */
  healthFactor: number
}

export interface Position {
  account: AccountData
  supplies: Array<{ token: Address; symbol: string; aToken: Address; amount: bigint; collateral: boolean; supplyApy: number }>
  borrows: Array<{ token: Address; symbol: string; variableDebtToken: Address; amount: bigint; borrowApy: number }>
}

export interface SupplyPlan { reserve: ReserveInfo; native: boolean; approvals: Tx[]; tx: Tx; permit: boolean }
export interface WithdrawPlan { reserve: ReserveInfo; native: boolean; approvals: Tx[]; tx: Tx; amount: bigint; all: boolean }
export interface BorrowPlan { reserve: ReserveInfo; native: boolean; approvals: Tx[]; tx: Tx }
export interface RepayPlan { reserve: ReserveInfo; native: boolean; approvals: Tx[]; tx: Tx; debt: bigint; all: boolean; permit: boolean; withATokens: boolean }

export type AaveLendingResult = LendingResult & { approveHashes: string[]; permit?: boolean }

/** Gas used for a fee quote when the real estimate cannot run yet (allowance still pending, permit unsigned). */
const FALLBACK_GAS = { approve: 60_000n, supply: 260_000n, withdraw: 330_000n, borrow: 400_000n, repay: 280_000n } as const

type PermitSigner = {
  getPermitInfo?: (token: string) => Promise<{ supported: boolean }>
  signPermit?: (o: { token: string; spender: string; value: bigint; deadline: bigint }) => Promise<{ v: number; r: Hex; s: Hex; deadline: bigint }>
}

function toAmount(amount: bigint | number | string): bigint {
  if (typeof amount !== 'bigint' && !(typeof amount === 'number' && Number.isSafeInteger(amount))) {
    throw new AaveError("'amount' must be a bigint or a safe integer (in base units), or 'max' where allowed.")
  }
  const value = BigInt(amount)
  if (value <= 0n) throw new AaveError("'amount' should be greater than zero.")
  return value
}

function toTransport(p: EvmProvider): Transport {
  return typeof p === 'string' ? http(p) : custom(p)
}

/**
 * Aave v3 for EVM wallet accounts: supply, withdraw, borrow (variable rate)
 * and repay on any Aave v3 market, plus the reads a wallet screen needs —
 * reserves with rates and caps, the account's health factor, the position.
 *
 * Nothing but the PoolAddressesProvider is trusted from configuration: the
 * Pool, oracle and data provider are read from it on-chain and the preset's
 * Pool address must match. Before money moves, the module checks the reserve
 * (active, not frozen or paused, borrowing enabled, caps) and proves the
 * call with `eth_call` from the account, translating Aave's revert codes and
 * custom errors into readable messages. ERC-20 legs approve the exact amount
 * (a one-transaction `supplyWithPermit` / `repayWithPermit` when the token and
 * the account support EIP-2612); native legs go through WrappedTokenGatewayV3.
 */
export class AaveProtocolEvm extends LendingProtocol<AaveProtocolConfig> {
  readonly chainId: number
  readonly preset: AaveMarket | null
  readonly addressesProvider: Address
  private readonly _expectedPool: Address | null
  private readonly _gateway: Address | null
  private readonly _client: PublicClient | undefined
  private readonly _referral: number
  private readonly _usePermit: boolean
  private readonly _permitTtl: number
  private readonly _waitTimeout: number
  private readonly _multicall: Address | null
  private readonly _reserveTtl: number
  private _market: Promise<MarketInfo> | null = null
  private _reserves: { at: number; list: ReserveInfo[] } | null = null

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: AaveProtocolConfig = {}) {
    super(account, config)
    const accountChain = /^eip155:(\d+)$/.exec(account?.chain ?? '')
    this.chainId = config.chainId ?? (accountChain ? Number(accountChain[1]) : 1)
    if (accountChain && Number(accountChain[1]) !== this.chainId) {
      throw new AaveError(`The account is on eip155:${accountChain[1]} but the market is configured for eip155:${this.chainId}.`)
    }
    const presets = AAVE_MARKETS[this.chainId]
    const key = config.market ?? 'core'
    this.preset = config.addressesProvider ? null : (presets?.[key] ?? null)
    if (!config.addressesProvider && !this.preset) {
      throw new AaveError(presets
        ? `Unknown Aave market '${key}' on chain ${this.chainId}; known: ${Object.keys(presets).join(', ')}.`
        : `No known Aave v3 market on chain ${this.chainId}; pass 'addressesProvider' (and 'pool') explicitly.`)
    }
    const provider = config.addressesProvider ?? this.preset!.addressesProvider
    if (!isAddress(provider)) throw new AaveError("'addressesProvider' must be an address.")
    this.addressesProvider = getAddress(provider)
    const pool = config.pool ?? this.preset?.pool
    if (pool !== undefined && !isAddress(pool)) throw new AaveError("'pool' must be an address.")
    this._expectedPool = pool ? getAddress(pool) : null
    const gateway = config.wethGateway === undefined ? this.preset?.wethGateway : config.wethGateway
    if (gateway && !isAddress(gateway)) throw new AaveError("'wethGateway' must be an address or null.")
    this._gateway = gateway ? getAddress(gateway) : null
    this._referral = config.referralCode ?? 0
    this._usePermit = config.usePermit ?? true
    this._permitTtl = config.permitTtlSeconds ?? 1200
    this._waitTimeout = config.waitTimeoutMs ?? 180_000
    this._multicall = config.multicall === false ? null : getAddress(config.multicall ?? MULTICALL3)
    this._reserveTtl = config.reserveTtlMs ?? 30_000

    const raw = config.provider ?? (account as unknown as { _config?: { provider?: EvmProvider | EvmProvider[] } })?._config?.provider
    if (raw !== undefined) {
      const list = Array.isArray(raw) ? raw : [raw]
      if (list.length > 0) {
        const transport = list.length === 1 ? toTransport(list[0]!) : fallback(list.map(toTransport))
        this._client = createPublicClient({ transport })
      }
    }
  }

  // ---- activity ----

  /**
   * Recognize this protocol's transactions offline: a call to a known Aave v3 Pool or
   * WrappedTokenGatewayV3 (every preset market on the transaction's chain, plus the
   * market this instance is configured with). See `activity.ts` for the rule.
   */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    const chainId = parseEvmChainId(tx.chain)
    if (chainId === null) return null
    const markets: ActivityMarket[] = presetMarkets(chainId)
    if (chainId === this.chainId && !this.preset && this._expectedPool) {
      const custom: ActivityMarket = { pool: this._expectedPool, chainName: `eip155:${chainId}` }
      if (this._gateway) custom.wethGateway = this._gateway
      markets.push(custom)
    }
    return describeAaveActivity(tx, ctx, markets)
  }

  // ---- plumbing ----

  private get client(): PublicClient {
    if (!this._client) throw new NetworkError('The protocol must be initialized with a provider (or an account configured with one).')
    return this._client
  }

  private async read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client.readContract({ address, abi: abi as Abi, functionName, args } as never) as Promise<T>
  }

  /** Multicall3 when available, one call each otherwise (zkSync, exotic providers). */
  private async readMany<T>(calls: Array<{ address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }>): Promise<T[]> {
    if (calls.length === 0) return []
    if (this._multicall) {
      try {
        const out = await this.client.multicall({
          contracts: calls.map((c) => ({ address: c.address, abi: c.abi as Abi, functionName: c.functionName, args: c.args ?? [] })),
          multicallAddress: this._multicall,
          allowFailure: false,
        } as never)
        return out as unknown as T[]
      } catch { /* no Multicall3 here, or the provider refuses — fall back */ }
    }
    return Promise.all(calls.map((c) => this.read<T>(c.address, c.abi, c.functionName, c.args ?? [])))
  }

  /**
   * ERC-20 symbols, tolerant per token: MKR answers `symbol()` with a bytes32,
   * which would fail a strict string decode — the raw 32-byte word is read as
   * ASCII instead; anything else unreadable becomes '?'.
   */
  private async symbolsOf(assets: Address[]): Promise<string[]> {
    const data = encodeFunctionData({ abi: ERC20_ABI, functionName: 'symbol' })
    const raw = await Promise.all(assets.map(async (asset) => {
      try { return (await this.client.call({ to: asset, data })).data ?? '0x' } catch { return '0x' as Hex }
    }))
    return raw.map((hex) => {
      if (hex.length === 66) return hexToString(hex, { size: 32 }).replace(/\0+$/, '') || '?'
      try { return decodeFunctionResult({ abi: ERC20_ABI, functionName: 'symbol', data: hex }) as string } catch { return '?' }
    })
  }

  private async me(): Promise<Address> {
    return getAddress(await this._account.getAddress())
  }

  private writable(method: string): IWalletAccount {
    return this.requireSigningAccount(`${method}(options)`)
  }

  private async send(tx: Tx): Promise<{ hash: string; fee: bigint }> {
    const account = this.requireSigningAccount('send')
    const { gasLimit: _g, ...clean } = tx
    const result = await account.sendTransaction(clean)
    if (!result?.hash) throw new AaveError('The account returned no transaction hash.')
    return { hash: result.hash, fee: BigInt(result.fee ?? 0) }
  }

  /** Poll the account's receipt until mined; a reverted receipt throws. */
  private async wait(hash: string): Promise<void> {
    const deadline = Date.now() + this._waitTimeout
    for (;;) {
      const receipt = await this._account.getTransactionReceipt(hash)
      if (receipt) {
        if (receipt.status !== 1) throw new AaveError(`Transaction ${hash} reverted.`)
        return
      }
      if (Date.now() > deadline) throw new NetworkError(`Transaction ${hash} was not mined within ${this._waitTimeout} ms.`)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  private async sendAndWait(tx: Tx): Promise<{ hash: string; fee: bigint }> {
    const sent = await this.send(tx)
    await this.wait(sent.hash)
    return sent
  }

  /** `eth_call` from the account; an Aave revert becomes a readable AaveError. */
  private async prove(tx: Tx, action: string): Promise<void> {
    try {
      await this.client.call({ account: await this.me(), to: tx.to, data: tx.data, value: tx.value })
    } catch (e) {
      toAaveError(e, action)
    }
  }

  private async quoteFee(txs: Tx[]): Promise<bigint> {
    let fee = 0n
    for (const tx of txs) {
      const { gasLimit, ...clean } = tx
      const quoted = await this._account.quoteSendTransaction(gasLimit !== undefined ? { ...clean, gasLimit } : clean)
      fee += BigInt(quoted.fee ?? 0)
    }
    return fee
  }

  private encode(abi: readonly unknown[], functionName: string, args: readonly unknown[]): Hex {
    return encodeFunctionData({ abi: abi as Abi, functionName, args } as never)
  }

  /** Exact-amount ERC-20 approvals, with the approve(0) reset Ethereum's USDT demands before a raise. */
  private async approvals(token: Address, spender: Address, amount: bigint): Promise<Tx[]> {
    const owner = await this.me()
    const allowance = await this.read<bigint>(token, ERC20_ABI, 'allowance', [owner, spender])
    if (allowance >= amount) return []
    const out: Tx[] = []
    if (allowance > 0n) out.push({ to: token, data: this.encode(ERC20_ABI, 'approve', [spender, 0n]), value: 0n, gasLimit: FALLBACK_GAS.approve })
    out.push({ to: token, data: this.encode(ERC20_ABI, 'approve', [spender, amount]), value: 0n, gasLimit: FALLBACK_GAS.approve })
    return out
  }

  /** A signed EIP-2612 permit for the Pool, when both the token and the account can. */
  private async permitFor(token: Address, amount: bigint, spender: Address): Promise<{ deadline: bigint; v: number; r: Hex; s: Hex } | null> {
    const acc = this._account as unknown as PermitSigner
    if (!this._usePermit || typeof acc.signPermit !== 'function' || typeof acc.getPermitInfo !== 'function') return null
    try {
      const info = await acc.getPermitInfo(token)
      if (!info.supported) return null
    } catch {
      return null
    }
    const deadline = BigInt(Math.floor(Date.now() / 1000) + this._permitTtl)
    const p = await acc.signPermit({ token, spender, value: amount, deadline })
    return { deadline: p.deadline, v: p.v, r: p.r, s: p.s }
  }

  private async canPermit(token: Address): Promise<boolean> {
    const acc = this._account as unknown as PermitSigner
    if (!this._usePermit || typeof acc.signPermit !== 'function' || typeof acc.getPermitInfo !== 'function') return false
    try { return (await acc.getPermitInfo(token)).supported } catch { return false }
  }

  // ---- market & reserves ----

  /** The market as the addresses provider reports it; the preset's Pool must agree. Cached per instance. */
  getMarket(): Promise<MarketInfo> {
    if (!this._market) {
      this._market = (async () => {
        const [pool, oracle, dataProvider] = await Promise.all([
          this.read<Address>(this.addressesProvider, ADDRESSES_PROVIDER_ABI, 'getPool'),
          this.read<Address>(this.addressesProvider, ADDRESSES_PROVIDER_ABI, 'getPriceOracle'),
          this.read<Address>(this.addressesProvider, ADDRESSES_PROVIDER_ABI, 'getPoolDataProvider'),
        ])
        if (pool === zeroAddress) throw new AaveError(`${this.addressesProvider} reports no Pool — not an Aave v3 PoolAddressesProvider on chain ${this.chainId}?`)
        if (this._expectedPool && getAddress(pool) !== this._expectedPool) {
          throw new AaveError(`Pool mismatch: the addresses provider reports ${pool}, configuration expects ${this._expectedPool}. Refusing to use either.`)
        }
        const [baseCurrencyUnit, wrappedNative] = await Promise.all([
          this.read<bigint>(oracle, ORACLE_ABI, 'BASE_CURRENCY_UNIT').catch(() => 10n ** 8n),
          this._gateway ? this.read<Address>(this._gateway, GATEWAY_ABI, 'getWETHAddress') : Promise.resolve(null),
        ])
        return {
          chainId: this.chainId,
          name: this.preset?.name ?? `Aave V3 (${this.addressesProvider})`,
          addressesProvider: this.addressesProvider,
          pool: getAddress(pool),
          oracle: getAddress(oracle),
          dataProvider: getAddress(dataProvider),
          baseCurrencyUnit,
          wethGateway: this._gateway,
          wrappedNative: wrappedNative ? getAddress(wrappedNative) : null,
        }
      })().catch((e) => { this._market = null; throw e })
    }
    return this._market
  }

  /** Every reserve of the market with configuration, rates and token addresses. Cached `reserveTtlMs`. */
  async getReserves({ refresh = false }: { refresh?: boolean } = {}): Promise<ReserveInfo[]> {
    if (this._reserves && !refresh && Date.now() - this._reserves.at < this._reserveTtl) return this._reserves.list
    const { pool } = await this.getMarket()
    const assets = await this.read<Address[]>(pool, POOL_ABI, 'getReservesList')
    type Raw = {
      configuration: { data: bigint }; liquidityIndex: bigint; currentLiquidityRate: bigint; variableBorrowIndex: bigint
      currentVariableBorrowRate: bigint; lastUpdateTimestamp: number | bigint; id: number; aTokenAddress: Address
      variableDebtTokenAddress: Address; accruedToTreasury: bigint; isolationModeTotalDebt: bigint
    }
    const data = await this.readMany<Raw>(assets.map((asset) => ({ address: pool, abi: POOL_ABI, functionName: 'getReserveData', args: [asset] })))
    const symbols = await this.symbolsOf(assets)
    const list = assets.map((asset, i) => {
      const r = data[i]!
      return {
        ...parseReserveConfiguration(r.configuration.data),
        asset: getAddress(asset),
        symbol: symbols[i] ?? '?',
        id: Number(r.id),
        aToken: getAddress(r.aTokenAddress),
        variableDebtToken: getAddress(r.variableDebtTokenAddress),
        liquidityRate: r.currentLiquidityRate,
        variableBorrowRate: r.currentVariableBorrowRate,
        liquidityIndex: r.liquidityIndex,
        variableBorrowIndex: r.variableBorrowIndex,
        lastUpdateTimestamp: bigintToNumber(BigInt(r.lastUpdateTimestamp)),
        accruedToTreasury: r.accruedToTreasury,
        isolationModeTotalDebt: r.isolationModeTotalDebt,
        supplyApr: rayToAprPct(r.currentLiquidityRate),
        supplyApy: rayToApyPct(r.currentLiquidityRate),
        borrowApr: rayToAprPct(r.currentVariableBorrowRate),
        borrowApy: rayToApyPct(r.currentVariableBorrowRate),
      } satisfies ReserveInfo
    })
    this._reserves = { at: Date.now(), list }
    return list
  }

  /** 'native' / zero address / 'ETH' → the gateway's wrapped native; else a checksummed ERC-20. */
  async resolveToken(token: string | undefined): Promise<{ native: boolean; asset: Address }> {
    if (token === undefined || token === null || token === 'native' || token === 'ETH' || token === zeroAddress) {
      const { wethGateway, wrappedNative } = await this.getMarket()
      if (!wethGateway || !wrappedNative) throw new AaveError('This market has no WrappedTokenGateway: supply the wrapped native token (WETH, …) as an ERC-20 instead.')
      return { native: true, asset: wrappedNative }
    }
    if (!isAddress(token)) throw new AaveError("'token' must be an ERC-20 address or 'native'.")
    return { native: false, asset: getAddress(token) }
  }

  /** The reserve for a token (or the wrapped native for 'native'). */
  async getReserve(token: string): Promise<ReserveInfo> {
    const { asset } = await this.resolveToken(token)
    const list = await this.getReserves()
    const r = list.find((x) => x.asset === asset)
    if (!r) throw new AaveError(`${asset} is not listed on this Aave market.`)
    return r
  }

  /** Oracle price in base currency units (8-decimal USD on every market today). */
  async getAssetPrice(token: string): Promise<bigint> {
    const { asset } = await this.resolveToken(token)
    const { oracle } = await this.getMarket()
    return this.read<bigint>(oracle, ORACLE_ABI, 'getAssetPrice', [asset])
  }

  /** Supply APY in percent for a token (what Aave's UI shows). */
  async getSupplyApy(token: string): Promise<number> {
    return (await this.getReserve(token)).supplyApy
  }

  /** Variable borrow APY in percent. */
  async getBorrowApy(token: string): Promise<number> {
    return (await this.getReserve(token)).borrowApy
  }

  // ---- account ----

  /** Pool.getUserAccountData for the account (or `user`), with the health factor as a number. */
  async getUserAccountData(user?: string): Promise<AccountData> {
    const { pool } = await this.getMarket()
    const who = user ? getAddress(user) : await this.me()
    const [totalCollateralBase, totalDebtBase, availableBorrowsBase, lt, ltv, hf] =
      await this.read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(pool, POOL_ABI, 'getUserAccountData', [who])
    return {
      totalCollateralBase, totalDebtBase, availableBorrowsBase,
      currentLiquidationThreshold: bigintToNumber(lt) / 10_000,
      ltv: bigintToNumber(ltv) / 10_000,
      healthFactorWad: hf,
      healthFactor: healthFactorToNumber(hf),
    }
  }

  /** Supplied and borrowed balances per reserve, with the collateral flag, plus the account totals. */
  async getPosition(): Promise<Position> {
    const [reserves, account, me, market] = await Promise.all([this.getReserves(), this.getUserAccountData(), this.me(), this.getMarket()])
    const config = await this.read<{ data: bigint }>(market.pool, POOL_ABI, 'getUserConfiguration', [me])
    const balances = await this.readMany<bigint>(reserves.flatMap((r) => [
      { address: r.aToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] },
      { address: r.variableDebtToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] },
    ]))
    const supplies: Position['supplies'] = []
    const borrows: Position['borrows'] = []
    reserves.forEach((r, i) => {
      const supplied = balances[2 * i] ?? 0n
      const borrowed = balances[2 * i + 1] ?? 0n
      const flags = userFlags(config.data, r.id)
      if (supplied > 0n) supplies.push({ token: r.asset, symbol: r.symbol, aToken: r.aToken, amount: supplied, collateral: flags.collateral, supplyApy: r.supplyApy })
      if (borrowed > 0n) borrows.push({ token: r.asset, symbol: r.symbol, variableDebtToken: r.variableDebtToken, amount: borrowed, borrowApy: r.borrowApy })
    })
    return { account, supplies, borrows }
  }

  // ---- supply ----

  private assertUsable(r: ReserveInfo, action: string): void {
    if (!r.active) throw new AaveError(`${r.symbol}: the reserve is not active.`, 'ReserveInactive')
    if (r.paused) throw new AaveError(`${r.symbol}: the reserve is paused — try again later.`, 'ReservePaused')
    if (r.frozen && action !== 'withdraw' && action !== 'repay') throw new AaveError(`${r.symbol}: the reserve is frozen (withdraw and repay only).`, 'ReserveFrozen')
  }

  /** @internal */
  async planSupply(o: AaveSupplyOptions, { sign }: { sign: boolean }): Promise<SupplyPlan> {
    const amount = toAmount(o.amount)
    const { native, asset } = await this.resolveToken(o.token)
    const reserve = await this.getReserve(asset)
    this.assertUsable(reserve, 'supply')
    const market = await this.getMarket()
    const onBehalfOf = o.onBehalfOf ? getAddress(o.onBehalfOf) : await this.me()
    if (reserve.supplyCap > 0n) {
      const total = await this.read<bigint>(reserve.aToken, ERC20_ABI, 'totalSupply')
      const cap = reserve.supplyCap * 10n ** BigInt(reserve.decimals)
      if (total + amount > cap) throw new AaveError(`${reserve.symbol}: supply cap reached (${cap - total < 0n ? 0n : cap - total} base units left).`, 'SupplyCapExceeded')
    }
    if (native) {
      const tx: Tx = { to: market.wethGateway!, data: this.encode(GATEWAY_ABI, 'depositETH', [market.pool, onBehalfOf, this._referral]), value: amount }
      return { reserve, native, approvals: [], tx, permit: false }
    }
    const approvals = await this.approvals(asset, market.pool, amount)
    if (approvals.length > 0) {
      if (sign) {
        const permit = await this.permitFor(asset, amount, market.pool)
        if (permit) {
          const data = this.encode(POOL_ABI, 'supplyWithPermit', [asset, amount, onBehalfOf, this._referral, permit.deadline, permit.v, permit.r, permit.s])
          return { reserve, native, approvals: [], tx: { to: market.pool, data, value: 0n }, permit: true }
        }
      } else if (await this.canPermit(asset)) {
        const data = this.encode(POOL_ABI, 'supply', [asset, amount, onBehalfOf, this._referral])
        return { reserve, native, approvals: [], tx: { to: market.pool, data, value: 0n, gasLimit: FALLBACK_GAS.supply }, permit: true }
      }
    }
    const tx: Tx = { to: market.pool, data: this.encode(POOL_ABI, 'supply', [asset, amount, onBehalfOf, this._referral]), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.supply
    return { reserve, native, approvals, tx, permit: false }
  }

  /**
   * Supplies `amount` of `token` ('native' goes through the gateway); aTokens
   * land on `onBehalfOf` (default: the account). ERC-20 legs approve the exact
   * amount first and wait for the receipt, or use one `supplyWithPermit` when
   * the token and the account support permits.
   */
  override async supply(o: AaveSupplyOptions): Promise<AaveLendingResult> {
    this.writable('supply')
    const plan = await this.planSupply(o, { sign: true })
    return this.execute(plan, 'supply')
  }

  override async quoteSupply(o: AaveSupplyOptions): Promise<LendingQuote & { approvals: number; permit: boolean; supplyApy: number }> {
    const plan = await this.planSupply(o, { sign: false })
    if (plan.approvals.length === 0 && !plan.permit) await this.prove(plan.tx, 'supply')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), approvals: plan.approvals.length, permit: plan.permit, supplyApy: plan.reserve.supplyApy }
  }

  private async execute(plan: { approvals: Tx[]; tx: Tx; permit?: boolean }, action: string): Promise<AaveLendingResult> {
    const approveHashes: string[] = []
    let fee = 0n
    for (const a of plan.approvals) {
      const sent = await this.sendAndWait(a)
      approveHashes.push(sent.hash)
      fee += sent.fee
    }
    await this.prove(plan.tx, action)
    const sent = await this.send(plan.tx)
    const out: AaveLendingResult = { hash: sent.hash, fee: fee + sent.fee, approveHashes }
    if (plan.permit) out.permit = true
    return out
  }

  // ---- withdraw ----

  /** @internal */
  async planWithdraw(o: AaveWithdrawOptions): Promise<WithdrawPlan> {
    const all = o.amount === 'max'
    const { native, asset } = await this.resolveToken(o.token)
    const reserve = await this.getReserve(asset)
    this.assertUsable(reserve, 'withdraw')
    const market = await this.getMarket()
    const me = await this.me()
    const to = o.to ? getAddress(o.to) : me
    const held = await this.read<bigint>(reserve.aToken, ERC20_ABI, 'balanceOf', [me])
    if (held === 0n) throw new AaveError(`${reserve.symbol}: nothing supplied to withdraw.`)
    const amount = all ? maxUint256 : toAmount(o.amount)
    if (!all && amount > held) throw new AaveError(`${reserve.symbol}: the amount exceeds the supplied balance (${held}).`, 'NotEnoughAvailableUserBalance')
    if (native) {
      // The gateway burns the account's aWETH: it needs an allowance on them.
      const approvals = await this.approvals(reserve.aToken, market.wethGateway!, all ? held : amount)
      const tx: Tx = { to: market.wethGateway!, data: this.encode(GATEWAY_ABI, 'withdrawETH', [market.pool, amount, to]), value: 0n }
      if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.withdraw
      return { reserve, native, approvals, tx, amount: all ? held : amount, all }
    }
    const tx: Tx = { to: market.pool, data: this.encode(POOL_ABI, 'withdraw', [asset, amount, to]), value: 0n }
    return { reserve, native, approvals: [], tx, amount: all ? held : amount, all }
  }

  /**
   * Withdraws `amount` (or 'max') of a supplied token to `to` (default: the
   * account). Refused by the protocol — and reported here before sending — when
   * it would push the health factor below 1.
   */
  override async withdraw(o: AaveWithdrawOptions): Promise<AaveLendingResult & { amount: bigint }> {
    this.writable('withdraw')
    const plan = await this.planWithdraw(o)
    return { ...(await this.execute(plan, 'withdraw')), amount: plan.amount }
  }

  override async quoteWithdraw(o: AaveWithdrawOptions): Promise<LendingQuote & { amount: bigint; approvals: number }> {
    const plan = await this.planWithdraw(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'withdraw')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), amount: plan.amount, approvals: plan.approvals.length }
  }

  // ---- borrow ----

  /** @internal */
  async planBorrow(o: AaveBorrowOptions): Promise<BorrowPlan> {
    const amount = toAmount(o.amount)
    const { native, asset } = await this.resolveToken(o.token)
    const reserve = await this.getReserve(asset)
    this.assertUsable(reserve, 'borrow')
    if (!reserve.borrowingEnabled) throw new AaveError(`${reserve.symbol}: borrowing is not enabled.`, 'BorrowingNotEnabled')
    const market = await this.getMarket()
    const me = await this.me()
    const onBehalfOf = o.onBehalfOf ? getAddress(o.onBehalfOf) : me
    if (native && onBehalfOf !== me) throw new AaveError("Native borrows go through the gateway, which cannot borrow on behalf of someone else — borrow the wrapped token instead.")
    if (onBehalfOf !== me) {
      const allowance = await this.read<bigint>(reserve.variableDebtToken, VARIABLE_DEBT_ABI, 'borrowAllowance', [onBehalfOf, me])
      if (allowance < amount) throw new AaveError(`${onBehalfOf} has delegated ${allowance} of ${reserve.symbol} credit to this account; ${amount} requested.`)
    }
    const [account, price] = await Promise.all([this.getUserAccountData(onBehalfOf), this.read<bigint>(market.oracle, ORACLE_ABI, 'getAssetPrice', [asset])])
    if (account.totalCollateralBase === 0n) throw new AaveError('No collateral supplied: supply an asset and enable it as collateral first.', 'CollateralBalanceIsZero')
    const amountBase = (amount * price) / 10n ** BigInt(reserve.decimals)
    if (amountBase > account.availableBorrowsBase) {
      throw new AaveError(`Borrowing power exceeded: ${amount} ${reserve.symbol} is ${amountBase} in base units, ${account.availableBorrowsBase} available.`, 'CollateralCannotCoverNewBorrow')
    }
    if (reserve.borrowCap > 0n) {
      const debt = await this.read<bigint>(reserve.variableDebtToken, VARIABLE_DEBT_ABI, 'totalSupply')
      const cap = reserve.borrowCap * 10n ** BigInt(reserve.decimals)
      if (debt + amount > cap) throw new AaveError(`${reserve.symbol}: borrow cap reached (${cap > debt ? cap - debt : 0n} base units left).`, 'BorrowCapExceeded')
    }
    if (native) {
      // The gateway borrows WETH in the account's name: it needs credit delegation on the debt token.
      const delegated = await this.read<bigint>(reserve.variableDebtToken, VARIABLE_DEBT_ABI, 'borrowAllowance', [me, market.wethGateway!])
      const approvals: Tx[] = delegated >= amount ? [] : [{ to: reserve.variableDebtToken, data: this.encode(VARIABLE_DEBT_ABI, 'approveDelegation', [market.wethGateway!, amount]), value: 0n, gasLimit: FALLBACK_GAS.approve }]
      const tx: Tx = { to: market.wethGateway!, data: this.encode(GATEWAY_ABI, 'borrowETH', [market.pool, amount, this._referral]), value: 0n }
      if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.borrow
      return { reserve, native, approvals, tx }
    }
    const tx: Tx = { to: market.pool, data: this.encode(POOL_ABI, 'borrow', [asset, amount, VARIABLE_RATE_MODE, this._referral, onBehalfOf]), value: 0n }
    return { reserve, native, approvals: [], tx }
  }

  /**
   * Borrows `amount` of `token` at the variable rate against the account's
   * collateral (or against `onBehalfOf`'s, who must have delegated credit).
   * Refused before sending when the amount exceeds the borrowing power.
   */
  override async borrow(o: AaveBorrowOptions): Promise<AaveLendingResult> {
    this.writable('borrow')
    const plan = await this.planBorrow(o)
    return this.execute(plan, 'borrow')
  }

  override async quoteBorrow(o: AaveBorrowOptions): Promise<LendingQuote & { borrowApy: number; approvals: number }> {
    const plan = await this.planBorrow(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'borrow')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), borrowApy: plan.reserve.borrowApy, approvals: plan.approvals.length }
  }

  // ---- repay ----

  /** @internal */
  async planRepay(o: AaveRepayOptions, { sign }: { sign: boolean }): Promise<RepayPlan> {
    const all = o.amount === 'max'
    const { native, asset } = await this.resolveToken(o.token)
    const reserve = await this.getReserve(asset)
    this.assertUsable(reserve, 'repay')
    const market = await this.getMarket()
    const me = await this.me()
    const onBehalfOf = o.onBehalfOf ? getAddress(o.onBehalfOf) : me
    const debt = await this.read<bigint>(reserve.variableDebtToken, VARIABLE_DEBT_ABI, 'balanceOf', [onBehalfOf])
    if (debt === 0n) throw new AaveError(`${reserve.symbol}: ${onBehalfOf === me ? 'the account has' : `${onBehalfOf} has`} no variable debt to repay.`, 'NoDebtOfSelectedType')
    // Aave refuses `max` on behalf of someone else: pass the exact debt instead.
    const amount = all ? (onBehalfOf === me ? maxUint256 : debt) : toAmount(o.amount)
    // Interest accrues between now and the mined block: pull a little more than
    // the current debt for a full repayment; Aave only takes what is owed.
    const buffered = debt + debt / 1000n + 1n
    const pulled = all ? buffered : amount > debt ? buffered : amount
    if (o.withATokens) {
      if (native) throw new AaveError('repayWithATokens works on the wrapped token, not through the gateway — pass the WETH address.')
      if (onBehalfOf !== me) throw new AaveError('repayWithATokens can only repay the account’s own debt.')
      const held = await this.read<bigint>(reserve.aToken, ERC20_ABI, 'balanceOf', [me])
      if (held < (all ? debt : amount)) throw new AaveError(`${reserve.symbol}: only ${held} aTokens held, ${all ? debt : amount} needed.`)
      const tx: Tx = { to: market.pool, data: this.encode(POOL_ABI, 'repayWithATokens', [asset, amount, VARIABLE_RATE_MODE]), value: 0n }
      return { reserve, native, approvals: [], tx, debt, all, permit: false, withATokens: true }
    }
    if (native) {
      const tx: Tx = { to: market.wethGateway!, data: this.encode(GATEWAY_ABI, 'repayETH', [market.pool, amount, onBehalfOf]), value: pulled }
      return { reserve, native, approvals: [], tx, debt, all, permit: false, withATokens: false }
    }
    const approvals = await this.approvals(asset, market.pool, pulled)
    if (approvals.length > 0) {
      if (sign) {
        const permit = await this.permitFor(asset, pulled, market.pool)
        if (permit) {
          const data = this.encode(POOL_ABI, 'repayWithPermit', [asset, amount, VARIABLE_RATE_MODE, onBehalfOf, permit.deadline, permit.v, permit.r, permit.s])
          return { reserve, native, approvals: [], tx: { to: market.pool, data, value: 0n }, debt, all, permit: true, withATokens: false }
        }
      } else if (await this.canPermit(asset)) {
        const data = this.encode(POOL_ABI, 'repay', [asset, amount, VARIABLE_RATE_MODE, onBehalfOf])
        return { reserve, native, approvals: [], tx: { to: market.pool, data, value: 0n, gasLimit: FALLBACK_GAS.repay }, debt, all, permit: true, withATokens: false }
      }
    }
    const tx: Tx = { to: market.pool, data: this.encode(POOL_ABI, 'repay', [asset, amount, VARIABLE_RATE_MODE, onBehalfOf]), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.repay
    return { reserve, native, approvals, tx, debt, all, permit: false, withATokens: false }
  }

  /**
   * Repays `amount` (or 'max') of variable debt in `token` for the account or
   * `onBehalfOf`. A full repayment approves (or sends, for native) the debt
   * plus 0.1 % so the interest of the next seconds is covered; the Pool takes
   * only what is owed and the gateway refunds the rest.
   */
  override async repay(o: AaveRepayOptions): Promise<AaveLendingResult & { debt: bigint }> {
    this.writable('repay')
    const plan = await this.planRepay(o, { sign: true })
    return { ...(await this.execute(plan, 'repay')), debt: plan.debt }
  }

  override async quoteRepay(o: AaveRepayOptions): Promise<LendingQuote & { debt: bigint; approvals: number; permit: boolean }> {
    const plan = await this.planRepay(o, { sign: false })
    if (plan.approvals.length === 0 && !plan.permit) await this.prove(plan.tx, 'repay')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), debt: plan.debt, approvals: plan.approvals.length, permit: plan.permit }
  }

  // ---- collateral switch ----

  /** Enable or disable a supplied asset as collateral (refused when it would break the health factor). */
  async setCollateral({ token, enabled }: { token: string; enabled: boolean }): Promise<LendingResult> {
    this.writable('setCollateral')
    const { asset } = await this.resolveToken(token)
    const reserve = await this.getReserve(asset)
    if (enabled && reserve.ltv === 0) throw new AaveError(`${reserve.symbol} has zero LTV and cannot be used as collateral.`)
    const { pool } = await this.getMarket()
    const tx: Tx = { to: pool, data: this.encode(POOL_ABI, 'setUserUseReserveAsCollateral', [asset, enabled]), value: 0n }
    await this.prove(tx, 'setCollateral')
    return this.send(tx)
  }
}

export default AaveProtocolEvm
