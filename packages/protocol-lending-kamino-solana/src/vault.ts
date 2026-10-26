import { NotImplementedError, type IWalletAccount, type IWalletAccountReadOnly, type LendingQuote, type LendingResult, type SupplyOptions, type WithdrawOptions } from '@anywalletkit/core'
import { WITHDRAW_ALL, type ApiVault, type ApiVaultMetrics } from './api.js'
import { divWadUp, fromDecimalString, lessBps, mulWad, toAmount, toDecimalString, toWad, type AmountOption } from './amounts.js'
import { KaminoBase, type Expectation, type KaminoBaseConfig } from './base.js'
import { KaminoError } from './errors.js'
import { vaultSharesMint } from './pda.js'
import { KVAULT_PROGRAM } from './programs.js'

export interface KaminoVaultConfig extends KaminoBaseConfig {
  /** The Earn vault (kVault) address. */
  vault: string
  /** Keep the shares in the wallet instead of staking them in the vault farm (default false — staked, as the Kamino app does). */
  skipFarm?: boolean
  /**
   * The mint the vault takes and pays out. The API's answer must name it; `supply` needs it here or
   * as its `token`, so a changed API answer cannot make the wallet deposit another asset.
   */
  asset?: string
}

export interface KaminoVaultSupplyOptions extends Omit<SupplyOptions, 'token'> { token?: string }
export interface KaminoVaultWithdrawOptions extends Omit<WithdrawOptions, 'amount' | 'token'> { token?: string; amount: AmountOption }

export interface VaultInfo {
  vault: string
  programId: string
  name: string
  asset: { mint: string; decimals: number; symbol: string }
  shares: { mint: string; decimals: number }
  /** Base units of the asset the vault manages (available + invested), and shares issued. */
  totalAssets: bigint
  sharesIssued: bigint
  /** Assets per 1e18 shares (both in token units), for display. */
  tokensPerShareWad: bigint
  /** USD per asset token and per share, as the API reports them. */
  tokenPriceUsd: number
  sharePriceUsd: number
  /** Percent, net of fees; `apy` is the live rate, the others trailing windows. */
  apy: number
  apy7d: number
  apy30d: number
  apyFarmRewards: number
  fees: { performanceBps: number; managementBps: number }
  minDeposit: bigint
  minWithdraw: bigint
  holders: number
  farm: string | null
  allocations: ApiVault['allocations']
}

export interface VaultPosition {
  /** Share base units: in the wallet, staked in the vault farm, and both. */
  unstakedShares: bigint
  stakedShares: bigint
  shares: bigint
  /** Asset base units the shares are worth now. */
  assets: bigint
}

export interface VaultSupplyQuote extends LendingQuote { expectedShares: bigint }
export interface VaultWithdrawQuote extends LendingQuote { shares: bigint; expectedAssets: bigint; minAssets: bigint }

/**
 * A Kamino Earn vault (kVault) as a `LendingProtocol`: `supply` deposits the
 * vault's asset for shares (staked in the vault farm unless `skipFarm`),
 * `withdraw` redeems shares for the asset; `borrow` / `repay` reject, a vault
 * does not lend to its depositors.
 *
 * The transaction comes from Kamino's API and is signed only after the
 * wallet's guard proves it calls only the Kamino / token programs and moves
 * exactly the declared balances (the deposit out, the asset in at the quoted
 * minimum, no other token account touched). Rates, TVL and positions are the
 * API's.
 */
export class KaminoVaultProtocolSolana extends KaminoBase<KaminoVaultConfig> {
  readonly vault: string
  private _vault: Promise<ApiVault> | null = null

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: KaminoVaultConfig) {
    super(account, config)
    if (typeof config?.vault !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.vault)) throw new KaminoError("'vault' must be the Earn vault's address.")
    this.vault = config.vault
  }

  /**
   * The vault's static state (cached per instance), checked against what the API cannot choose: it is
   * this vault, on the kVault program, its shares mint is the one the program derives for it, and it
   * takes the configured asset. Mint decimals come from the chain when the account can read them
   * (round 3, H7: a changed `sharesMint` turned the withdraw guard into a pass for any token).
   */
  protected state(): Promise<ApiVault> {
    if (!this._vault) this._vault = this.api.getVault(this.vault).then((v) => this.verified(v)).catch((e) => { this._vault = null; throw e })
    return this._vault
  }

  private async verified(v: ApiVault): Promise<ApiVault> {
    const refuse = (what: string) => { throw new KaminoError(`Kamino's answer for vault ${this.vault} does not hold up: ${what}.`) }
    if (v.address !== this.vault) refuse(`it describes ${v.address}`)
    if (v.programId !== KVAULT_PROGRAM) refuse(`program ${v.programId} is not the kVault program`)
    const shares = vaultSharesMint(this.vault, KVAULT_PROGRAM)
    if (v.sharesMint !== shares) refuse(`shares mint ${v.sharesMint} is not the vault's (${shares})`)
    if (v.tokenMint === v.sharesMint) refuse('the asset is the shares mint')
    const asset = this._config.asset
    if (asset !== undefined && v.tokenMint !== asset) refuse(`it takes ${v.tokenMint}, not the configured ${asset}`)
    if (typeof this.surface().getMintInfo === 'function') {
      const [td, sd] = await Promise.all([this.decimals(v.tokenMint), this.decimals(v.sharesMint)])
      if (td !== v.tokenMintDecimals || sd !== v.sharesMintDecimals) refuse(`mint decimals ${v.tokenMintDecimals} / ${v.sharesMintDecimals} are ${td} / ${sd} on chain`)
    }
    return v
  }

  private info(v: ApiVault, m: ApiVaultMetrics): VaultInfo {
    const d = v.tokenMintDecimals
    return {
      vault: v.address, programId: v.programId, name: v.name,
      asset: { mint: v.tokenMint, decimals: d, symbol: symbolOf(v) },
      shares: { mint: v.sharesMint, decimals: v.sharesMintDecimals },
      totalAssets: fromDecimalString(m.tokensAvailable, d) + fromDecimalString(m.tokensInvested, d),
      sharesIssued: fromDecimalString(m.sharesIssued, v.sharesMintDecimals),
      tokensPerShareWad: toWad(m.tokensPerShare),
      tokenPriceUsd: Number(m.tokenPrice), sharePriceUsd: Number(m.sharePrice),
      apy: m.apy, apy7d: m.apy7d, apy30d: m.apy30d, apyFarmRewards: m.apyFarmRewards,
      fees: { performanceBps: v.performanceFeeBps, managementBps: v.managementFeeBps },
      minDeposit: v.minDepositAmount, minWithdraw: v.minWithdrawAmount,
      holders: m.numberOfHolders, farm: v.vaultFarm, allocations: v.allocations,
    }
  }

  /** The vault as the API describes it: asset, shares, rate, fees, TVL. */
  async getVault(): Promise<VaultInfo> {
    const [v, m] = await Promise.all([this.state(), this.api.getVaultMetrics(this.vault)])
    return this.info(v, m)
  }

  /** Net APY in percent. */
  async getApy(): Promise<number> {
    return (await this.api.getVaultMetrics(this.vault)).apy
  }

  /** Shares (wallet + farm) and what they are worth now. */
  async getPosition(): Promise<VaultPosition> {
    const me = await this.me()
    const [v, m, p] = await Promise.all([this.state(), this.api.getVaultMetrics(this.vault), this.api.getVaultPosition(me, this.vault)])
    const sd = v.sharesMintDecimals
    const unstakedShares = fromDecimalString(p.unstakedShares, sd), stakedShares = fromDecimalString(p.stakedShares, sd)
    const shares = fromDecimalString(p.totalShares, sd) || unstakedShares + stakedShares
    return { unstakedShares, stakedShares, shares, assets: this.sharesToAssets(shares, v, toWad(m.tokensPerShare)) }
  }

  /** shares (share units) × tokensPerShare → asset units; decimals may differ between the two mints. */
  private sharesToAssets(shares: bigint, v: ApiVault, tokensPerShareWad: bigint): bigint {
    return rescale(mulWad(shares, tokensPerShareWad), v.sharesMintDecimals, v.tokenMintDecimals)
  }

  private assetsToShares(assets: bigint, v: ApiVault, tokensPerShareWad: bigint): bigint {
    return rescale(divWadUp(assets, tokensPerShareWad), v.tokenMintDecimals, v.sharesMintDecimals)
  }

  private async plan(o: KaminoVaultSupplyOptions, me: string): Promise<{ base64: string; v: ApiVault; amount: bigint; expectedShares: bigint }> {
    const amount = toAmount(o.amount)
    // What the wallet deposits is named by the caller, never only by the API.
    const token = o.token ?? this._config.asset
    if (token === undefined) throw new KaminoError(`Name the asset to deposit: pass 'token' or set 'asset' in the vault config.`)
    const [v, m] = await Promise.all([this.state(), this.api.getVaultMetrics(this.vault)])
    if (token !== v.tokenMint) throw new KaminoError(`Vault ${this.vault} takes ${symbolOf(v)} (${v.tokenMint}), not ${token}.`)
    if (amount < v.minDepositAmount) throw new KaminoError(`Deposit below the vault minimum: ${amount} < ${v.minDepositAmount} base units.`)
    const base64 = await this.api.buildVaultDeposit({ wallet: me, kvault: this.vault, amount: toDecimalString(amount, v.tokenMintDecimals), skipFarm: this._config.skipFarm, memo: this.memo() })
    return { base64, v, amount, expectedShares: this.assetsToShares(amount, v, toWad(m.tokensPerShare)) }
  }

  private supplyExpectation(v: ApiVault, amount: bigint, expectedShares: bigint) {
    const e = this.spendExpectation(v.tokenMint, amount)
    // Shares that stay in the wallet are proven in; staked shares land in the farm, so only the spend is bounded.
    return this._config.skipFarm ? { ...e, tokenIn: { mint: v.sharesMint, minAmount: lessBps(expectedShares, this.slippageBps) } } : e
  }

  override async quoteSupply(o: KaminoVaultSupplyOptions): Promise<VaultSupplyQuote> {
    const me = await this.me()
    const { base64, v, amount, expectedShares } = await this.plan(o, me)
    const { fee } = await this.quoteBuilt(base64, this.supplyExpectation(v, amount, expectedShares))
    return { fee, expectedShares }
  }

  override async supply(o: KaminoVaultSupplyOptions): Promise<LendingResult> {
    this.requireSigningAccount('supply(options)')
    const me = await this.me()
    const { base64, v, amount, expectedShares } = await this.plan(o, me)
    return this.sendBuilt(base64, this.supplyExpectation(v, amount, expectedShares), 'supply')
  }

  private async planWithdraw(o: KaminoVaultWithdrawOptions, me: string): Promise<{ base64: string; v: ApiVault; shares: bigint; expectedAssets: bigint }> {
    const [v, m, position] = await Promise.all([this.state(), this.api.getVaultMetrics(this.vault), this.getPosition()])
    if (o.token && o.token !== v.tokenMint) throw new KaminoError(`Vault ${this.vault} pays out ${symbolOf(v)} (${v.tokenMint}), not ${o.token}.`)
    if (position.shares === 0n) throw new KaminoError(`No position in vault ${this.vault} for ${me}.`)
    const tps = toWad(m.tokensPerShare)
    let shares: bigint, amountArg: string
    if (o.amount === 'max') { shares = position.shares; amountArg = WITHDRAW_ALL }
    else {
      const assets = toAmount(o.amount)
      shares = this.assetsToShares(assets, v, tps)
      if (shares > position.shares) throw new KaminoError(`Withdrawal exceeds the position: ${assets} asset units need ${shares} shares, the wallet holds ${position.shares}.`)
      amountArg = toDecimalString(shares, v.sharesMintDecimals)
    }
    const expectedAssets = this.sharesToAssets(shares, v, tps)
    if (expectedAssets < v.minWithdrawAmount) throw new KaminoError(`Withdrawal below the vault minimum: ${expectedAssets} < ${v.minWithdrawAmount} base units.`)
    const base64 = await this.api.buildVaultWithdraw({ wallet: me, kvault: this.vault, amount: amountArg, memo: this.memo() })
    return { base64, v, shares, expectedAssets }
  }

  /**
   * The asset comes in (within slippage), and the shares being redeemed may leave the wallet's
   * share account — exactly those, no more (audit 2026-10-25, #1.3). Shares staked in the farm are
   * unstaked into that account and burned in the same transaction, so the bound holds for both.
   */
  private withdrawExpectation(v: ApiVault, shares: bigint, expectedAssets: bigint): Expectation {
    return { ...this.receiveExpectation(v.tokenMint, expectedAssets), maxTokenOut: { mint: v.sharesMint, amount: shares } }
  }

  override async quoteWithdraw(o: KaminoVaultWithdrawOptions): Promise<VaultWithdrawQuote> {
    const me = await this.me()
    const { base64, v, shares, expectedAssets } = await this.planWithdraw(o, me)
    const expect = this.withdrawExpectation(v, shares, expectedAssets)
    const { fee } = await this.quoteBuilt(base64, expect)
    return { fee, shares, expectedAssets, minAssets: expect.tokenIn!.minAmount }
  }

  override async withdraw(o: KaminoVaultWithdrawOptions): Promise<LendingResult> {
    this.requireSigningAccount('withdraw(options)')
    const me = await this.me()
    const { base64, v, shares, expectedAssets } = await this.planWithdraw(o, me)
    return this.sendBuilt(base64, this.withdrawExpectation(v, shares, expectedAssets), 'withdraw')
  }

  override async borrow(): Promise<LendingResult> { throw new NotImplementedError('borrow(options) — an Earn vault does not lend to its depositors; use KaminoMarketProtocolSolana.') }
  override async quoteBorrow(): Promise<LendingQuote> { throw new NotImplementedError('quoteBorrow(options) — an Earn vault does not lend to its depositors; use KaminoMarketProtocolSolana.') }
  override async repay(): Promise<LendingResult> { throw new NotImplementedError('repay(options) — an Earn vault has no debt; use KaminoMarketProtocolSolana.') }
  override async quoteRepay(): Promise<LendingQuote> { throw new NotImplementedError('quoteRepay(options) — an Earn vault has no debt; use KaminoMarketProtocolSolana.') }
}

/** Re-express base units from one mint's decimals in another's. */
function rescale(amount: bigint, fromDecimals: number, toDecimals: number): bigint {
  if (fromDecimals === toDecimals) return amount
  return fromDecimals < toDecimals ? amount * 10n ** BigInt(toDecimals - fromDecimals) : amount / 10n ** BigInt(fromDecimals - toDecimals)
}

const SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  So11111111111111111111111111111111111111112: 'SOL',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
  '2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH': 'USDG',
})

function symbolOf(v: ApiVault): string {
  return SYMBOLS[v.tokenMint] ?? v.tokenMint.slice(0, 4) + '…'
}
