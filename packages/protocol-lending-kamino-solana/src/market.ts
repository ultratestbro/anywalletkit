import type { BorrowOptions, IWalletAccount, IWalletAccountReadOnly, LendingQuote, LendingResult, RepayOptions, SupplyOptions, WithdrawOptions } from '@anywalletkit/core'
import { MAIN_MARKET, type ApiMarket, type ApiObligation, type ApiReserve } from './api.js'
import { fromDecimalString, lessBps, toAmount, toDecimalString, type AmountOption } from './amounts.js'
import { DEFAULT_FIRST_DEPOSIT_ALLOWANCE, KaminoBase, type KaminoBaseConfig } from './base.js'
import { KaminoError } from './errors.js'

export interface KaminoMarketConfig extends KaminoBaseConfig {
  /** The lending market (default: Kamino's Main Market). */
  market?: string
  /**
   * Pin the reserve a token maps to. Without it the reserve with the most
   * supplied value for that mint is used (the Main Market has several USDC
   * reserves: the big one and small isolated ones).
   */
  reserves?: Record<string, string>
  /** SOL a FIRST deposit may spend on the obligation, user metadata, lookup table and ATAs (default 0.045 SOL). */
  firstDepositAllowanceLamports?: bigint | number
}

export interface KaminoMarketWithdrawOptions extends Omit<WithdrawOptions, 'amount'> { amount: AmountOption }
export interface KaminoMarketRepayOptions extends Omit<RepayOptions, 'amount'> { amount: AmountOption }

export interface ReserveInfo extends ApiReserve {
  /** Fraction borrowed of what is supplied. */
  utilization: number
}

export interface MarketInfo extends ApiMarket { reserves: ReserveInfo[] }

export interface MarketPosition {
  /** The obligations (loans) the wallet has in this market; an empty list means no position. */
  obligations: ApiObligation[]
  /** Base units per mint, summed over obligations. */
  supplied: Record<string, bigint>
  borrowed: Record<string, bigint>
}

export interface MarketQuote extends LendingQuote { reserve: string; minReceived?: bigint }

/**
 * A Kamino Lend market as a `LendingProtocol`: `supply` deposits a reserve's
 * token as collateral on the wallet's obligation, `withdraw` takes it back,
 * `borrow` / `repay` take and return a reserve's liquidity against it.
 *
 * Tokens are named by mint. The first deposit creates the obligation (plus
 * user metadata and a per-user lookup table) and costs their rent, which the
 * guard allows once; every transaction is proven before signing.
 */
export class KaminoMarketProtocolSolana extends KaminoBase<KaminoMarketConfig> {
  readonly market: string
  private readonly firstDepositAllowance: bigint
  private _reserves: { at: number; p: Promise<ApiReserve[]> } | null = null

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: KaminoMarketConfig = {}) {
    super(account, config)
    this.market = config?.market ?? MAIN_MARKET
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(this.market)) throw new KaminoError("'market' must be the lending market's address.")
    this.firstDepositAllowance = config?.firstDepositAllowanceLamports === undefined ? DEFAULT_FIRST_DEPOSIT_ALLOWANCE : BigInt(config.firstDepositAllowanceLamports)
  }

  /** Reserves with rates, cached for a minute. */
  async getReserves(): Promise<ReserveInfo[]> {
    const now = Date.now()
    if (!this._reserves || now - this._reserves.at > 60_000) {
      const p = this.api.getReserves(this.market).catch((e) => { this._reserves = null; throw e })
      this._reserves = { at: now, p }
    }
    const rows = await this._reserves.p
    return rows.map((r) => ({ ...r, utilization: r.totalSupplyUsd > 0 ? r.totalBorrowUsd / r.totalSupplyUsd : 0 }))
  }

  /** The market's config entry plus its reserves. */
  async getMarket(): Promise<MarketInfo> {
    const [markets, reserves] = await Promise.all([this.api.listMarkets(), this.getReserves()])
    const m = markets.find((x) => x.lendingMarket === this.market)
    if (!m) throw new KaminoError(`Market ${this.market} is not in Kamino's market list.`)
    return { ...m, reserves }
  }

  /** The reserve a mint maps to: the pinned one, else the deepest by supplied value. */
  async resolveReserve(mint: string): Promise<ReserveInfo> {
    if (typeof mint !== 'string' || !mint) throw new KaminoError("'token' must be the token's mint address.")
    const reserves = await this.getReserves()
    const pinned = this._config.reserves?.[mint]
    if (pinned) {
      const r = reserves.find((x) => x.reserve === pinned)
      if (!r) throw new KaminoError(`Reserve ${pinned} is not in market ${this.market}.`)
      if (r.mint !== mint) throw new KaminoError(`Reserve ${pinned} holds ${r.symbol} (${r.mint}), not ${mint}.`)
      return r
    }
    const candidates = reserves.filter((x) => x.mint === mint).sort((a, b) => b.totalSupplyUsd - a.totalSupplyUsd)
    if (candidates.length === 0) throw new KaminoError(`Market ${this.market} has no reserve for ${mint}.`)
    return candidates[0]!
  }

  /** Obligations and per-mint totals. */
  async getPosition(): Promise<MarketPosition> {
    const me = await this.me()
    const obligations = await this.api.getUserObligations(this.market, me)
    const supplied: Record<string, bigint> = {}, borrowed: Record<string, bigint> = {}
    for (const o of obligations) {
      for (const d of o.deposits) if (d.mint) supplied[d.mint] = (supplied[d.mint] ?? 0n) + fromDecimalString(d.amount, await this.decimals(d.mint))
      for (const b of o.borrows) if (b.mint) borrowed[b.mint] = (borrowed[b.mint] ?? 0n) + fromDecimalString(b.amount, await this.decimals(b.mint))
    }
    return { obligations, supplied, borrowed }
  }

  private async lend(kind: 'deposit' | 'withdraw' | 'borrow' | 'repay', me: string, mint: string, amount: bigint): Promise<{ base64: string; reserve: ReserveInfo }> {
    const reserve = await this.resolveReserve(mint)
    const p = { wallet: me, market: this.market, reserve: reserve.reserve, amount: toDecimalString(amount, await this.decimals(mint)), memo: this.memo() }
    const base64 = kind === 'deposit' ? await this.api.buildLendDeposit(p) : kind === 'withdraw' ? await this.api.buildLendWithdraw(p) : kind === 'borrow' ? await this.api.buildLendBorrow(p) : await this.api.buildLendRepay(p)
    return { base64, reserve }
  }

  /** A wallet without an obligation here pays the rent of one on its first deposit. */
  private async firstDepositExtra(me: string): Promise<bigint> {
    const obligations = await this.api.getUserObligations(this.market, me).catch(() => [])
    return obligations.length === 0 ? this.firstDepositAllowance : 0n
  }

  /** Resolve 'max' against the position's supplied / borrowed total for the mint. */
  private async resolveMax(amount: AmountOption, mint: string, side: 'supplied' | 'borrowed'): Promise<bigint> {
    if (amount !== 'max') return toAmount(amount)
    const total = (await this.getPosition())[side][mint] ?? 0n
    if (total === 0n) throw new KaminoError(`Nothing ${side} in ${mint} on market ${this.market}.`)
    return total
  }

  override async quoteSupply(o: SupplyOptions): Promise<MarketQuote> {
    const me = await this.me()
    const amount = toAmount(o.amount)
    const [{ base64, reserve }, extra] = await Promise.all([this.lend('deposit', me, o.token, amount), this.firstDepositExtra(me)])
    const { fee } = await this.quoteBuilt(base64, this.spendExpectation(o.token, amount, extra))
    return { fee, reserve: reserve.reserve }
  }

  override async supply(o: SupplyOptions): Promise<LendingResult> {
    this.requireSigningAccount('supply(options)')
    const me = await this.me()
    const amount = toAmount(o.amount)
    const [{ base64 }, extra] = await Promise.all([this.lend('deposit', me, o.token, amount), this.firstDepositExtra(me)])
    return this.sendBuilt(base64, this.spendExpectation(o.token, amount, extra), 'supply')
  }

  override async quoteWithdraw(o: KaminoMarketWithdrawOptions): Promise<MarketQuote> {
    const me = await this.me()
    const amount = await this.resolveMax(o.amount, o.token, 'supplied')
    const { base64, reserve } = await this.lend('withdraw', me, o.token, amount)
    const expect = this.receiveExpectation(o.token, amount)
    const { fee } = await this.quoteBuilt(base64, expect)
    return { fee, reserve: reserve.reserve, minReceived: expect.tokenIn!.minAmount }
  }

  override async withdraw(o: KaminoMarketWithdrawOptions): Promise<LendingResult> {
    this.requireSigningAccount('withdraw(options)')
    const me = await this.me()
    const amount = await this.resolveMax(o.amount, o.token, 'supplied')
    const { base64 } = await this.lend('withdraw', me, o.token, amount)
    return this.sendBuilt(base64, this.receiveExpectation(o.token, amount), 'withdraw')
  }

  override async quoteBorrow(o: BorrowOptions): Promise<MarketQuote> {
    const me = await this.me()
    const amount = toAmount(o.amount)
    const { base64, reserve } = await this.lend('borrow', me, o.token, amount)
    const expect = this.receiveExpectation(o.token, amount)
    const { fee } = await this.quoteBuilt(base64, expect)
    return { fee, reserve: reserve.reserve, minReceived: expect.tokenIn!.minAmount }
  }

  override async borrow(o: BorrowOptions): Promise<LendingResult> {
    this.requireSigningAccount('borrow(options)')
    const me = await this.me()
    const amount = toAmount(o.amount)
    const { base64 } = await this.lend('borrow', me, o.token, amount)
    return this.sendBuilt(base64, this.receiveExpectation(o.token, amount), 'borrow')
  }

  override async quoteRepay(o: KaminoMarketRepayOptions): Promise<MarketQuote> {
    const me = await this.me()
    const amount = await this.resolveMax(o.amount, o.token, 'borrowed')
    const { base64, reserve } = await this.lend('repay', me, o.token, amount)
    // Interest accrues between the quote and the block: allow the slippage tolerance on top of the debt read.
    const { fee } = await this.quoteBuilt(base64, this.spendExpectation(o.token, amount + (amount - lessBps(amount, this.slippageBps))))
    return { fee, reserve: reserve.reserve }
  }

  override async repay(o: KaminoMarketRepayOptions): Promise<LendingResult> {
    this.requireSigningAccount('repay(options)')
    const me = await this.me()
    const amount = await this.resolveMax(o.amount, o.token, 'borrowed')
    const { base64 } = await this.lend('repay', me, o.token, amount)
    return this.sendBuilt(base64, this.spendExpectation(o.token, amount + (amount - lessBps(amount, this.slippageBps))), 'repay')
  }
}
