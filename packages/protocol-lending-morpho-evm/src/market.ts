import type { BorrowOptions, IWalletAccount, IWalletAccountReadOnly, LendingQuote, LendingResult, RepayOptions, SupplyOptions, WithdrawOptions } from '@forgewallet/core'
import { getAddress, isAddress, isHex, zeroAddress, type Address, type Hex } from 'viem'
import { ERC20_ABI, IRM_ABI, MORPHO_ABI, ORACLE_ABI } from './abi.js'
import { FALLBACK_GAS, MorphoBase, toAmount, type AmountOption, type MorphoBaseConfig, type Tx } from './base.js'
import { MorphoError } from './errors.js'
import {
  accrue, collateralValue, marketId, maxBorrow, rateToApyPct, supplyApyPct, toAssetsDown, toAssetsUp, toSharesUp, WAD,
  type MarketParams, type MarketState,
} from './math.js'
import type { ApiMarket } from './api.js'

export interface MorphoMarketConfig extends MorphoBaseConfig {
  /** The market: its 32-byte id, or the full MarketParams. */
  market: Hex | { loanToken: string; collateralToken: string; oracle: string; irm: string; lltv: bigint | string | number }
}

export interface MorphoMarketSupplyOptions extends Omit<SupplyOptions, 'token'> { token?: string }
export interface MorphoMarketWithdrawOptions extends Omit<WithdrawOptions, 'amount' | 'token'> { token?: string; amount: AmountOption }
export interface MorphoMarketBorrowOptions extends Omit<BorrowOptions, 'token'> { token?: string; to?: string }
export interface MorphoMarketRepayOptions extends Omit<RepayOptions, 'amount' | 'token'> { token?: string; amount: AmountOption }

export interface MarketInfo {
  id: Hex
  params: MarketParams
  loan: { address: Address; symbol: string; decimals: number }
  collateral: { address: Address; symbol: string; decimals: number } | null
  /** Fraction (0.86 = 86 %). */
  lltv: number
  /** Oracle price of 1 collateral in loan units, 1e36 scale. */
  price: bigint
  /** State with interest accrued to now. */
  state: MarketState
  /** Loan tokens available to borrow / withdraw right now. */
  liquidity: bigint
  utilization: number
  /** Per-second WAD borrow rate from the IRM. */
  borrowRate: bigint
  borrowApy: number
  supplyApy: number
  /** Protocol fee on interest, fraction. */
  fee: number
}

export interface MarketPosition {
  supplyShares: bigint
  supplyAssets: bigint
  borrowShares: bigint
  /** Rounded up, as Morpho counts debt. */
  borrowAssets: bigint
  collateral: bigint
  /** Loan-token value of the collateral. */
  collateralValue: bigint
  /** The most the position may owe at the current price. */
  maxBorrow: bigint
  /** maxBorrow / borrowAssets; Infinity without debt. 1.0 = liquidatable. */
  healthFactor: number
  /** borrowAssets / collateralValue. */
  ltv: number
  /** Collateral price (loan per collateral, 1e36 scale) at which the position becomes liquidatable; null without debt. */
  liquidationPrice: bigint | null
}

/**
 * One Morpho Blue market as a `LendingProtocol`: `supply` / `withdraw` lend the
 * loan token to the market (shares appreciate with borrowers' interest), `borrow`
 * / `repay` take and return the loan token against the collateral the account
 * posts with `supplyCollateral` / `withdrawCollateral`.
 *
 * The market is resolved on-chain from its id or params (`idToMarketParams`,
 * `market().lastUpdate != 0`), state is read with interest accrued to now the
 * way `accrueInterest` would, and every write is checked against the market's
 * liquidity and the position's health (oracle price × LLTV) before `eth_call`
 * proves it. Morpho's revert strings are translated.
 */
export class MorphoMarketProtocolEvm extends MorphoBase<MorphoMarketConfig> {
  private readonly _id: Hex | null
  private readonly _params: MarketParams | null
  private _resolved: Promise<{ id: Hex; params: MarketParams; loan: MarketInfo['loan']; collateral: MarketInfo['collateral'] }> | null = null

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: MorphoMarketConfig) {
    super(account, config)
    const m = config?.market
    if (typeof m === 'string') {
      if (!isHex(m) || m.length !== 66) throw new MorphoError("'market' must be a 32-byte market id or MarketParams.")
      this._id = m.toLowerCase() as Hex
      this._params = null
    } else if (m && typeof m === 'object') {
      for (const k of ['loanToken', 'collateralToken', 'oracle', 'irm'] as const) {
        if (!isAddress(m[k])) throw new MorphoError(`'market.${k}' must be an address.`)
      }
      this._params = { loanToken: getAddress(m.loanToken), collateralToken: getAddress(m.collateralToken), oracle: getAddress(m.oracle), irm: getAddress(m.irm), lltv: BigInt(m.lltv) }
      this._id = marketId(this._params)
    } else {
      throw new MorphoError("'market' is required: a market id or MarketParams.")
    }
  }

  /** The market id. */
  get id(): Hex { return this._id! }

  private resolve() {
    if (!this._resolved) {
      this._resolved = (async () => {
        let params = this._params
        if (!params) {
          const [loanToken, collateralToken, oracle, irm, lltv] = await this.read<readonly [Address, Address, Address, Address, bigint]>(this.chain.morpho, MORPHO_ABI, 'idToMarketParams', [this._id!])
          if (loanToken === zeroAddress) throw new MorphoError(`Market ${this._id} is not created on Morpho (${this.chain.name}).`)
          params = { loanToken: getAddress(loanToken), collateralToken: getAddress(collateralToken), oracle: getAddress(oracle), irm: getAddress(irm), lltv }
        } else {
          const [, , , , lastUpdate] = await this.read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(this.chain.morpho, MORPHO_ABI, 'market', [this._id!])
          if (lastUpdate === 0n) throw new MorphoError(`No market with these params on Morpho (${this.chain.name}): id ${this._id}.`)
        }
        const loan = { address: params.loanToken, ...(await this.tokenMeta(params.loanToken)) }
        const collateral = params.collateralToken === zeroAddress ? null : { address: params.collateralToken, ...(await this.tokenMeta(params.collateralToken)) }
        return { id: this._id!, params, loan, collateral }
      })().catch((e) => { this._resolved = null; throw e })
    }
    return this._resolved
  }

  /** The market with interest accrued to now, oracle price and rates. */
  async getMarket(): Promise<MarketInfo> {
    const { id, params, loan, collateral } = await this.resolve()
    const raw = await this.read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(this.chain.morpho, MORPHO_ABI, 'market', [id])
    const m: MarketState = { totalSupplyAssets: raw[0], totalSupplyShares: raw[1], totalBorrowAssets: raw[2], totalBorrowShares: raw[3], lastUpdate: raw[4], fee: raw[5] }
    const [borrowRate, price] = await Promise.all([
      params.irm === zeroAddress ? Promise.resolve(0n) : this.read<bigint>(params.irm, IRM_ABI, 'borrowRateView', [params, m]).catch(() => 0n),
      params.oracle === zeroAddress ? Promise.resolve(0n) : this.read<bigint>(params.oracle, ORACLE_ABI, 'price').catch(() => 0n),
    ])
    const state = accrue(m, borrowRate, BigInt(Math.floor(Date.now() / 1000)))
    const borrowApy = rateToApyPct(borrowRate)
    const liquidity = state.totalSupplyAssets > state.totalBorrowAssets ? state.totalSupplyAssets - state.totalBorrowAssets : 0n
    return {
      id, params, loan, collateral, lltv: Number(params.lltv) / 1e18, price, state, liquidity,
      utilization: state.totalSupplyAssets === 0n ? 0 : Number(state.totalBorrowAssets) / Number(state.totalSupplyAssets),
      borrowRate, borrowApy, supplyApy: supplyApyPct(borrowApy, state), fee: Number(state.fee) / 1e18,
    }
  }

  /** The account's (or `user`'s) position with health computed at the current oracle price. */
  async getPosition(user?: string): Promise<MarketPosition> {
    const who = user ? getAddress(user) : await this.me()
    const [info, [supplyShares, borrowShares, collateral]] = await Promise.all([
      this.getMarket(), this.read<readonly [bigint, bigint, bigint]>(this.chain.morpho, MORPHO_ABI, 'position', [this.id, who]),
    ])
    const s = info.state
    const supplyAssets = toAssetsDown(supplyShares, s.totalSupplyAssets, s.totalSupplyShares)
    const borrowAssets = toAssetsUp(borrowShares, s.totalBorrowAssets, s.totalBorrowShares)
    const value = collateralValue(collateral, info.price)
    const max = maxBorrow(collateral, info.price, info.params.lltv)
    const liquidationPrice = borrowAssets === 0n || collateral === 0n ? null : (borrowAssets * WAD * 10n ** 36n) / (collateral * info.params.lltv)
    return {
      supplyShares, supplyAssets, borrowShares, borrowAssets, collateral, collateralValue: value, maxBorrow: max,
      healthFactor: borrowAssets === 0n ? Number.POSITIVE_INFINITY : Number(max) / Number(borrowAssets),
      ltv: value === 0n ? (borrowAssets === 0n ? 0 : Number.POSITIVE_INFINITY) : Number(borrowAssets) / Number(value),
      liquidationPrice,
    }
  }

  /** The market's API record (APY, listed, TVL) — decoration; null without API. */
  async getStats(): Promise<ApiMarket | null> {
    if (!this.api) return null
    try { return await this.api.marketById(this.id, this.chainId) } catch { return null }
  }

  private async assertLoanToken(token: string | undefined, info: MarketInfo): Promise<void> {
    if (token === undefined) return
    if (token === 'native') throw new MorphoError('Morpho markets take ERC-20 only (wrap the native coin first).')
    if (!isAddress(token) || getAddress(token) !== info.loan.address) throw new MorphoError(`This market lends ${info.loan.symbol} (${info.loan.address}), not ${token}.`)
  }

  // ---- lend the loan token ----

  /** @internal */
  async planSupply(o: MorphoMarketSupplyOptions): Promise<{ info: MarketInfo; approvals: Tx[]; tx: Tx }> {
    const amount = toAmount(o.amount)
    const info = await this.getMarket()
    await this.assertLoanToken(o.token, info)
    const onBehalf = o.onBehalfOf ? getAddress(o.onBehalfOf) : await this.me()
    const approvals = await this.approvals(info.loan.address, this.chain.morpho, amount)
    const tx: Tx = { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'supply', [info.params, amount, 0n, onBehalf, '0x']), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.market
    return { info, approvals, tx }
  }

  /** Lends `amount` of the loan token to the market; supply shares go to `onBehalfOf` (default: the account). */
  override async supply(o: MorphoMarketSupplyOptions): Promise<LendingResult & { approveHashes: string[] }> {
    this.writable('supply')
    return this.execute(await this.planSupply(o), 'supply')
  }

  override async quoteSupply(o: MorphoMarketSupplyOptions): Promise<LendingQuote & { supplyApy: number; approvals: number }> {
    const plan = await this.planSupply(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'supply')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), supplyApy: plan.info.supplyApy, approvals: plan.approvals.length }
  }

  /** @internal */
  async planWithdraw(o: MorphoMarketWithdrawOptions): Promise<{ info: MarketInfo; tx: Tx; assetsOut: bigint }> {
    const info = await this.getMarket()
    await this.assertLoanToken(o.token, info)
    const me = await this.me()
    const receiver = o.to ? getAddress(o.to) : me
    const pos = await this.getPosition()
    if (pos.supplyShares === 0n) throw new MorphoError('Nothing supplied to this market.')
    if (o.amount === 'max') {
      if (pos.supplyAssets > info.liquidity) throw new MorphoError(`Only ${info.liquidity} of ${pos.supplyAssets} ${info.loan.symbol} base units are available in the market right now (the rest is borrowed out).`, 'insufficient liquidity')
      return { info, tx: { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'withdraw', [info.params, 0n, pos.supplyShares, me, receiver]), value: 0n }, assetsOut: pos.supplyAssets }
    }
    const amount = toAmount(o.amount)
    if (amount > pos.supplyAssets) throw new MorphoError(`The amount exceeds the supplied balance (${pos.supplyAssets}).`)
    if (amount > info.liquidity) throw new MorphoError(`Only ${info.liquidity} ${info.loan.symbol} base units are available in the market right now.`, 'insufficient liquidity')
    return { info, tx: { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'withdraw', [info.params, amount, 0n, me, receiver]), value: 0n }, assetsOut: amount }
  }

  /** Withdraws supplied loan tokens (`amount` or 'max' → by shares) to `to` (default: the account). */
  override async withdraw(o: MorphoMarketWithdrawOptions): Promise<LendingResult & { assetsOut: bigint }> {
    this.writable('withdraw')
    const plan = await this.planWithdraw(o)
    await this.prove(plan.tx, 'withdraw')
    return { ...(await this.send(plan.tx)), assetsOut: plan.assetsOut }
  }

  override async quoteWithdraw(o: MorphoMarketWithdrawOptions): Promise<LendingQuote & { assetsOut: bigint }> {
    const plan = await this.planWithdraw(o)
    await this.prove(plan.tx, 'withdraw')
    return { fee: await this.quoteFee([plan.tx]), assetsOut: plan.assetsOut }
  }

  // ---- collateral ----

  /** @internal */
  async planSupplyCollateral(o: { amount: bigint | number; onBehalfOf?: string }): Promise<{ info: MarketInfo; approvals: Tx[]; tx: Tx }> {
    const amount = toAmount(o.amount)
    const info = await this.getMarket()
    if (!info.collateral) throw new MorphoError('This market has no collateral token (idle market).')
    const onBehalf = o.onBehalfOf ? getAddress(o.onBehalfOf) : await this.me()
    const approvals = await this.approvals(info.collateral.address, this.chain.morpho, amount)
    const tx: Tx = { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'supplyCollateral', [info.params, amount, onBehalf, '0x']), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.market
    return { info, approvals, tx }
  }

  /** Posts collateral for `onBehalfOf` (default: the account). Collateral earns nothing; it backs borrows. */
  async supplyCollateral(o: { amount: bigint | number; onBehalfOf?: string }): Promise<LendingResult & { approveHashes: string[] }> {
    this.writable('supplyCollateral')
    return this.execute(await this.planSupplyCollateral(o), 'supplyCollateral')
  }

  async quoteSupplyCollateral(o: { amount: bigint | number; onBehalfOf?: string }): Promise<LendingQuote & { approvals: number }> {
    const plan = await this.planSupplyCollateral(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'supplyCollateral')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), approvals: plan.approvals.length }
  }

  /** @internal */
  async planWithdrawCollateral(o: { amount: AmountOption; to?: string }): Promise<{ info: MarketInfo; tx: Tx; amount: bigint; healthAfter: number }> {
    const info = await this.getMarket()
    const me = await this.me()
    const receiver = o.to ? getAddress(o.to) : me
    const pos = await this.getPosition()
    if (pos.collateral === 0n) throw new MorphoError('No collateral posted on this market.')
    const amount = o.amount === 'max' ? pos.collateral : toAmount(o.amount)
    if (amount > pos.collateral) throw new MorphoError(`The amount exceeds the posted collateral (${pos.collateral}).`)
    const remaining = pos.collateral - amount
    const maxAfter = maxBorrow(remaining, info.price, info.params.lltv)
    const healthAfter = pos.borrowAssets === 0n ? Number.POSITIVE_INFINITY : Number(maxAfter) / Number(pos.borrowAssets)
    if (pos.borrowAssets > 0n && maxAfter < pos.borrowAssets) {
      throw new MorphoError(`Withdrawing ${amount} collateral would leave the position undercollateralized (health ${healthAfter.toFixed(3)} < 1): repay first.`, 'insufficient collateral')
    }
    return { info, tx: { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'withdrawCollateral', [info.params, amount, me, receiver]), value: 0n }, amount, healthAfter }
  }

  /** Takes collateral back (`amount` or 'max'); refused when the remaining collateral would not cover the debt. */
  async withdrawCollateral(o: { amount: AmountOption; to?: string }): Promise<LendingResult & { amount: bigint; healthAfter: number }> {
    this.writable('withdrawCollateral')
    const plan = await this.planWithdrawCollateral(o)
    await this.prove(plan.tx, 'withdrawCollateral')
    return { ...(await this.send(plan.tx)), amount: plan.amount, healthAfter: plan.healthAfter }
  }

  async quoteWithdrawCollateral(o: { amount: AmountOption; to?: string }): Promise<LendingQuote & { amount: bigint; healthAfter: number }> {
    const plan = await this.planWithdrawCollateral(o)
    await this.prove(plan.tx, 'withdrawCollateral')
    return { fee: await this.quoteFee([plan.tx]), amount: plan.amount, healthAfter: plan.healthAfter }
  }

  // ---- borrow / repay ----

  /** @internal */
  async planBorrow(o: MorphoMarketBorrowOptions): Promise<{ info: MarketInfo; tx: Tx; healthAfter: number }> {
    const amount = toAmount(o.amount)
    const info = await this.getMarket()
    await this.assertLoanToken(o.token, info)
    const me = await this.me()
    const onBehalf = o.onBehalfOf ? getAddress(o.onBehalfOf) : me
    const receiver = o.to ? getAddress(o.to) : me
    if (onBehalf !== me) {
      const ok = await this.read<boolean>(this.chain.morpho, MORPHO_ABI, 'isAuthorized', [onBehalf, me])
      if (!ok) throw new MorphoError(`${onBehalf} has not authorized this account on Morpho (setAuthorization).`, 'unauthorized')
    }
    const pos = await this.getPosition(onBehalf)
    if (pos.collateral === 0n) throw new MorphoError('No collateral posted: supplyCollateral first.', 'insufficient collateral')
    if (amount > info.liquidity) throw new MorphoError(`The market has only ${info.liquidity} ${info.loan.symbol} base units available to borrow right now.`, 'insufficient liquidity')
    const debtAfter = pos.borrowAssets + amount
    if (debtAfter > pos.maxBorrow) {
      throw new MorphoError(`Borrowing ${amount} would exceed the position's limit: max debt ${pos.maxBorrow} ${info.loan.symbol} base units at LLTV ${(info.lltv * 100).toFixed(1)}% (current debt ${pos.borrowAssets}).`, 'insufficient collateral')
    }
    const healthAfter = Number(pos.maxBorrow) / Number(debtAfter)
    return { info, tx: { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'borrow', [info.params, amount, 0n, onBehalf, receiver]), value: 0n }, healthAfter }
  }

  /** Borrows `amount` of the loan token against the account's collateral (or `onBehalfOf`'s, with authorization) to `to`. */
  override async borrow(o: MorphoMarketBorrowOptions): Promise<LendingResult & { healthAfter: number }> {
    this.writable('borrow')
    const plan = await this.planBorrow(o)
    await this.prove(plan.tx, 'borrow')
    return { ...(await this.send(plan.tx)), healthAfter: plan.healthAfter }
  }

  override async quoteBorrow(o: MorphoMarketBorrowOptions): Promise<LendingQuote & { borrowApy: number; healthAfter: number }> {
    const plan = await this.planBorrow(o)
    await this.prove(plan.tx, 'borrow')
    return { fee: await this.quoteFee([plan.tx]), borrowApy: plan.info.borrowApy, healthAfter: plan.healthAfter }
  }

  /** @internal */
  async planRepay(o: MorphoMarketRepayOptions): Promise<{ info: MarketInfo; approvals: Tx[]; tx: Tx; debt: bigint; all: boolean }> {
    const info = await this.getMarket()
    await this.assertLoanToken(o.token, info)
    const me = await this.me()
    const onBehalf = o.onBehalfOf ? getAddress(o.onBehalfOf) : me
    const pos = await this.getPosition(onBehalf)
    if (pos.borrowShares === 0n) throw new MorphoError(`${onBehalf === me ? 'The account has' : `${onBehalf} has`} no debt on this market.`)
    const all = o.amount === 'max'
    // A full repayment goes by shares (exact, no dust); interest keeps accruing
    // until the block mines, so the allowance covers the debt + 0.1 %.
    const pulled = all ? pos.borrowAssets + pos.borrowAssets / 1000n + 1n : toAmount(o.amount)
    if (!all && pulled > pos.borrowAssets) throw new MorphoError(`The amount exceeds the debt (${pos.borrowAssets}) — use 'max' to repay everything.`)
    const approvals = await this.approvals(info.loan.address, this.chain.morpho, pulled)
    const args = all ? [info.params, 0n, pos.borrowShares, onBehalf, '0x'] : [info.params, pulled, 0n, onBehalf, '0x']
    const tx: Tx = { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'repay', args), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.market
    return { info, approvals, tx, debt: pos.borrowAssets, all }
  }

  /** Repays `amount` of the loan token (or 'max' → all borrow shares) for the account or `onBehalfOf`. */
  override async repay(o: MorphoMarketRepayOptions): Promise<LendingResult & { approveHashes: string[]; debt: bigint }> {
    this.writable('repay')
    const plan = await this.planRepay(o)
    return { ...(await this.execute(plan, 'repay')), debt: plan.debt }
  }

  override async quoteRepay(o: MorphoMarketRepayOptions): Promise<LendingQuote & { debt: bigint; approvals: number }> {
    const plan = await this.planRepay(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'repay')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), debt: plan.debt, approvals: plan.approvals.length }
  }

  /** Lets (or stops letting) `manager` act on the account's positions on this chain's Morpho (all markets). */
  async setAuthorization({ manager, enabled }: { manager: string; enabled: boolean }): Promise<LendingResult> {
    this.writable('setAuthorization')
    const tx: Tx = { to: this.chain.morpho, data: this.encode(MORPHO_ABI, 'setAuthorization', [getAddress(manager), enabled]), value: 0n }
    await this.prove(tx, 'setAuthorization')
    return this.send(tx)
  }

  /** Shares the market would mint for `assets` supplied now (for previews). */
  async previewSupplyShares(assets: bigint): Promise<bigint> {
    const { state } = await this.getMarket()
    return toSharesUp(assets, state.totalSupplyAssets, state.totalSupplyShares)
  }
}

export { ERC20_ABI }
