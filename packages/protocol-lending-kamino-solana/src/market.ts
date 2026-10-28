import type { BorrowOptions, IWalletAccount, IWalletAccountReadOnly, LendingQuote, LendingResult, RepayOptions, SupplyOptions, WithdrawOptions } from '@anywalletkit/core'
import { MAIN_MARKET, type ApiMarket, type ApiObligation, type ApiReserve } from './api.js'
import { fromDecimalString, lessBps, toAmount, toDecimalString, type AmountOption } from './amounts.js'
import { DEFAULT_FIRST_DEPOSIT_ALLOWANCE, KaminoBase, WSOL_MINT, type KaminoBaseConfig } from './base.js'
import { debtNow, decodeObligation, decodeReserve, depositedLiquidity, withinTolerance, type ObligationChain, type ReserveChain } from './chain.js'
import { KaminoError } from './errors.js'
import { associatedTokenAddress, vanillaObligation } from './pda.js'
import { marketRules, type InstructionRule } from './policy.js'
import { KLEND_PROGRAM, TOKEN_PROGRAM } from './programs.js'

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

type LendKind = 'deposit' | 'withdraw' | 'borrow' | 'repay'

/** The reserve and the wallet's vanilla obligation as the chain has them, plus what the operation may carry. */
interface Prepared {
  reserve: ReserveInfo
  chain: { reserve: ReserveChain; obligation: ObligationChain | null; obligationAddress: string }
  amount: bigint
  rules: readonly InstructionRule[]
}

/**
 * A Kamino Lend market as a `LendingProtocol`: `supply` deposits a reserve's
 * token as collateral on the wallet's obligation, `withdraw` takes it back,
 * `borrow` / `repay` take and return a reserve's liquidity against it.
 *
 * Tokens are named by mint. The first deposit creates the obligation (plus
 * user metadata and a per-user lookup table) and costs their rent, which the
 * guard allows once; every transaction is proven before signing: only the
 * instructions the operation takes, on the wallet's vanilla obligation, the
 * resolved reserve and the wallet's own token account. The reserve is checked
 * on chain, and 'max' amounts and the first-deposit allowance come from the
 * obligation's on-chain state.
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

  /**
   * The reserve and the wallet's vanilla obligation from the chain (scan 2026-10-27 modules, F1/F6/F10):
   * the reserve must be this market's and lend the token, 'max' comes from the obligation, and the
   * instruction rules pin the operation to that obligation, reserve and the wallet's token account.
   */
  private async prepare(kind: LendKind, me: string, mint: string, amount: AmountOption): Promise<Prepared> {
    const reserve = await this.resolveReserve(mint)
    const obligationAddress = vanillaObligation(me, this.market, KLEND_PROGRAM)
    const [r, o] = await this.readChain([reserve.reserve, obligationAddress])
    const onChain = decodeReserve(reserve.reserve, r ?? null)
    if (onChain.lendingMarket !== this.market) throw new KaminoError(`Reserve ${reserve.reserve} belongs to market ${onChain.lendingMarket} on chain, not ${this.market}.`)
    if (onChain.mint !== mint) throw new KaminoError(`Reserve ${reserve.reserve} lends ${onChain.mint} on chain, not ${mint}.`)
    const obligation = o ? decodeObligation(obligationAddress, o) : null
    if (obligation && (obligation.owner !== me || obligation.lendingMarket !== this.market)) throw new KaminoError(`Obligation ${obligationAddress} is not ${me}'s on market ${this.market}.`)
    const chain = { reserve: onChain, obligation, obligationAddress }
    const value = amount === 'max' ? await this.resolveMax(kind === 'withdraw' ? 'supplied' : 'borrowed', me, mint, reserve.reserve, chain) : toAmount(amount)
    const rules = marketRules(kind, {
      me, market: this.market, obligation: obligationAddress, reserve: reserve.reserve, mint,
      ata: associatedTokenAddress(me, mint, onChain.tokenProgram), wsolAta: associatedTokenAddress(me, WSOL_MINT, TOKEN_PROGRAM),
    })
    return { reserve, chain, amount: value, rules }
  }

  private build(kind: LendKind, me: string, p: Prepared): Promise<string> {
    const params = { wallet: me, market: this.market, reserve: p.reserve.reserve, amount: toDecimalString(p.amount, p.chain.reserve.decimals), memo: this.memo() }
    return kind === 'deposit' ? this.api.buildLendDeposit(params) : kind === 'withdraw' ? this.api.buildLendWithdraw(params) : kind === 'borrow' ? this.api.buildLendBorrow(params) : this.api.buildLendRepay(params)
  }

  /** A wallet without its vanilla obligation here (on chain) pays the rent of one on its first deposit. */
  private firstDepositExtra(p: Prepared): bigint {
    return p.chain.obligation ? 0n : this.firstDepositAllowance
  }

  /**
   * 'max' from the chain: what the vanilla obligation holds in, or owes to, this reserve (debt with the
   * interest the reserve has accrued). When the API reports a figure for that obligation it must agree
   * within 1%: an inflated debt or a negative deposit is refused (scan 2026-10-27 modules, F6/F10).
   */
  private async resolveMax(side: 'supplied' | 'borrowed', me: string, mint: string, reserve: string, c: Prepared['chain']): Promise<bigint> {
    const o = c.obligation
    const amount = !o ? 0n : side === 'supplied' ? depositedLiquidity(o, c.reserve, reserve) : debtNow(o, c.reserve, reserve)
    if (amount <= 0n) throw new KaminoError(`Nothing ${side} in ${mint} on market ${this.market}.`)
    const reported = await this.reported(side, me, mint, c.obligationAddress, c.reserve.decimals)
    if (reported !== undefined) {
      // The API counts per mint; the obligation may hold the mint in more than one reserve.
      const legs = side === 'supplied' ? o!.deposits : o!.borrows
      const others = [...new Set(legs.map((l) => l.reserve).filter((r) => r !== reserve))]
      let perMint = amount
      if (others.length) {
        const accs = await this.readChain(others)
        others.forEach((r, i) => {
          const rc = decodeReserve(r, accs[i] ?? null)
          if (rc.mint === mint) perMint += side === 'supplied' ? depositedLiquidity(o!, rc, r) : debtNow(o!, rc, r)
        })
      }
      if (!withinTolerance(reported, perMint)) throw new KaminoError(`Kamino reports ${reported} base units ${side} in ${mint}; obligation ${c.obligationAddress} has ${perMint} on chain.`)
    }
    return amount
  }

  /** The API's figure for one leg of the wallet's vanilla obligation; undefined when it reports none. */
  private async reported(side: 'supplied' | 'borrowed', me: string, mint: string, obligation: string, decimals: number): Promise<bigint | undefined> {
    const row = (await this.api.getUserObligations(this.market, me)).find((x) => x.obligation === obligation)
    const legs = (side === 'supplied' ? row?.deposits : row?.borrows)?.filter((l) => l.mint === mint) ?? []
    if (!legs.length) return undefined
    return legs.reduce((sum, l) => sum + fromDecimalString(l.amount, decimals), 0n)
  }

  override async quoteSupply(o: SupplyOptions): Promise<MarketQuote> {
    const me = await this.me()
    const p = await this.prepare('deposit', me, o.token, o.amount)
    const base64 = await this.build('deposit', me, p)
    const { fee } = await this.quoteBuilt(base64, this.spendExpectation(o.token, p.amount, this.firstDepositExtra(p)), p.rules)
    return { fee, reserve: p.reserve.reserve }
  }

  override async supply(o: SupplyOptions): Promise<LendingResult> {
    this.requireSigningAccount('supply(options)')
    const me = await this.me()
    const p = await this.prepare('deposit', me, o.token, o.amount)
    const base64 = await this.build('deposit', me, p)
    return this.sendBuilt(base64, this.spendExpectation(o.token, p.amount, this.firstDepositExtra(p)), p.rules, 'supply')
  }

  override async quoteWithdraw(o: KaminoMarketWithdrawOptions): Promise<MarketQuote> {
    const me = await this.me()
    const p = await this.prepare('withdraw', me, o.token, o.amount)
    const base64 = await this.build('withdraw', me, p)
    const expect = this.receiveExpectation(o.token, p.amount)
    const { fee } = await this.quoteBuilt(base64, expect, p.rules)
    return { fee, reserve: p.reserve.reserve, minReceived: expect.tokenIn!.minAmount }
  }

  override async withdraw(o: KaminoMarketWithdrawOptions): Promise<LendingResult> {
    this.requireSigningAccount('withdraw(options)')
    const me = await this.me()
    const p = await this.prepare('withdraw', me, o.token, o.amount)
    const base64 = await this.build('withdraw', me, p)
    return this.sendBuilt(base64, this.receiveExpectation(o.token, p.amount), p.rules, 'withdraw')
  }

  /** A borrow pays out at most what was asked: a bigger one is debt the user did not choose. */
  private borrowExpectation(mint: string, amount: bigint) {
    return this.receiveExpectation(mint, amount, 0n, amount)
  }

  override async quoteBorrow(o: BorrowOptions): Promise<MarketQuote> {
    const me = await this.me()
    const p = await this.prepare('borrow', me, o.token, o.amount)
    const base64 = await this.build('borrow', me, p)
    const expect = this.borrowExpectation(o.token, p.amount)
    const { fee } = await this.quoteBuilt(base64, expect, p.rules)
    return { fee, reserve: p.reserve.reserve, minReceived: expect.tokenIn!.minAmount }
  }

  override async borrow(o: BorrowOptions): Promise<LendingResult> {
    this.requireSigningAccount('borrow(options)')
    const me = await this.me()
    const p = await this.prepare('borrow', me, o.token, o.amount)
    const base64 = await this.build('borrow', me, p)
    return this.sendBuilt(base64, this.borrowExpectation(o.token, p.amount), p.rules, 'borrow')
  }

  /** Interest accrues between the quote and the block: allow the slippage tolerance on top of the debt read. */
  private repayExpectation(mint: string, amount: bigint) {
    return this.spendExpectation(mint, amount + (amount - lessBps(amount, this.slippageBps)))
  }

  override async quoteRepay(o: KaminoMarketRepayOptions): Promise<MarketQuote> {
    const me = await this.me()
    const p = await this.prepare('repay', me, o.token, o.amount)
    const base64 = await this.build('repay', me, p)
    const { fee } = await this.quoteBuilt(base64, this.repayExpectation(o.token, p.amount), p.rules)
    return { fee, reserve: p.reserve.reserve }
  }

  override async repay(o: KaminoMarketRepayOptions): Promise<LendingResult> {
    this.requireSigningAccount('repay(options)')
    const me = await this.me()
    const p = await this.prepare('repay', me, o.token, o.amount)
    const base64 = await this.build('repay', me, p)
    return this.sendBuilt(base64, this.repayExpectation(o.token, p.amount), p.rules, 'repay')
  }
}
