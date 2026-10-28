import { NotImplementedError, type IWalletAccount, type IWalletAccountReadOnly, type LendingQuote, type LendingResult, type SupplyOptions, type WithdrawOptions } from '@anywalletkit/core'
import type { ApiVault, ApiVaultMetrics } from './api.js'
import { divWadUp, fromDecimalString, lessBps, mulWad, toAmount, toDecimalString, toWad, type AmountOption } from './amounts.js'
import { KaminoBase, WSOL_MINT, type Expectation, type KaminoBaseConfig } from './base.js'
import { decodeFarmUser, decodeReserve, decodeVault, tokenAmount, vaultTokensPerShareWad, withinTolerance, type ReserveChain, type VaultChain } from './chain.js'
import { KaminoError } from './errors.js'
import { associatedTokenAddress, farmUserState, vaultSharesMint } from './pda.js'
import { vaultRules, type InstructionRule } from './policy.js'
import { KVAULT_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from './programs.js'

export interface KaminoVaultConfig extends KaminoBaseConfig {
  /** The Earn vault (kVault) address. */
  vault: string
  /**
   * Keep the shares in the wallet (default true). The guard then proves the shares arrive. With
   * `false` they are staked in the vault farm, as the Kamino app does: they never reach the wallet,
   * so the guard can only bound what leaves it; the instruction rules pin the stake to this vault's
   * farm (from the chain) and the wallet's own farm state.
   */
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

/** The vault and the wallet's place in it as the chain has them; the bounds of a write come from here. */
interface VaultOnChain {
  state: VaultChain
  /** Assets per share (token units, WAD) from the vault's state and its reserves. */
  tokensPerShareWad: bigint
  tokenAta: string
  sharesAtas: readonly string[]
  farm: { farm: string; userState: string } | null
  /** Shares in the wallet's shares account(s) and staked in the vault farm. */
  unstaked: bigint
  staked: bigint
}

/**
 * A Kamino Earn vault (kVault) as a `LendingProtocol`: `supply` deposits the
 * vault's asset for shares (kept in the wallet; staked in the vault farm with `skipFarm: false`),
 * `withdraw` redeems shares for the asset; `borrow` / `repay` reject, a vault
 * does not lend to its depositors.
 *
 * The transaction comes from Kamino's API and is signed only after the
 * wallet's guard proves it carries only the instructions the operation takes,
 * on this vault and the wallet's own accounts, and moves exactly the declared
 * balances (the deposit out, the asset in at the minimum, no other token
 * account touched). The bounds come from the chain: the share price from the
 * vault's state and its reserves, the position from the wallet's shares
 * account and farm stake; the API's price must agree with it. Reads
 * (`getVault`, `getPosition`, APY, TVL) are the API's.
 */
export class KaminoVaultProtocolSolana extends KaminoBase<KaminoVaultConfig> {
  readonly vault: string
  private _vault: Promise<ApiVault> | null = null

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: KaminoVaultConfig) {
    super(account, config)
    if (typeof config?.vault !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(config.vault)) throw new KaminoError("'vault' must be the Earn vault's address.")
    this.vault = config.vault
  }

  /** Shares stay in the wallet unless the app opts into the farm (round 3 review: only then can the guard prove them). */
  private get skipFarm(): boolean {
    return this._config.skipFarm !== false
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

  /**
   * What a write's bounds are computed from, read from the chain (scan 2026-10-27 modules, F2/F11/F12):
   * the vault's state and the reserves it invests in give the share price, the wallet's shares
   * account and farm state its position. The API must describe the same vault — mints, decimals —
   * and quote a `tokensPerShare` within 1% of the chain's; a lying rate is refused, never used.
   */
  private async onChain(me: string, v: ApiVault, m: ApiVaultMetrics): Promise<VaultOnChain> {
    const refuse = (what: string): never => { throw new KaminoError(`Kamino's answer for vault ${this.vault} does not match the chain: ${what}.`) }
    const state = decodeVault(this.vault, (await this.readChain([this.vault]))[0] ?? null)
    if (state.tokenMint !== v.tokenMint || state.sharesMint !== v.sharesMint) refuse(`mints ${v.tokenMint} / ${v.sharesMint} are ${state.tokenMint} / ${state.sharesMint} on chain`)
    if (state.tokenDecimals !== v.tokenMintDecimals || state.sharesDecimals !== v.sharesMintDecimals) refuse(`decimals ${v.tokenMintDecimals} / ${v.sharesMintDecimals} are ${state.tokenDecimals} / ${state.sharesDecimals} on chain`)
    const invested = state.allocations.filter((a) => a.ctokens > 0n).map((a) => a.reserve)
    const sharesAtas = [associatedTokenAddress(me, state.sharesMint, TOKEN_PROGRAM), associatedTokenAddress(me, state.sharesMint, TOKEN_2022_PROGRAM)]
    const userState = state.farm ? farmUserState(state.farm, me) : null
    const accs = await this.readChain([...invested, ...sharesAtas, ...(userState ? [userState] : [])])
    const reserves = new Map<string, ReserveChain>()
    invested.forEach((r, i) => {
      const reserve = decodeReserve(r, accs[i] ?? null)
      if (reserve.mint !== state.tokenMint) refuse(`its reserve ${r} lends ${reserve.mint}`)
      reserves.set(r, reserve)
    })
    const tokensPerShareWad = vaultTokensPerShareWad(state, reserves)
    const quoted = toWad(m.tokensPerShare)
    if (quoted <= 0n) refuse(`tokensPerShare ${m.tokensPerShare} is not positive`)
    if (!withinTolerance(quoted, tokensPerShareWad)) refuse(`tokensPerShare ${m.tokensPerShare} is ${toDecimalString(tokensPerShareWad, 18)} on chain`)
    const unstaked = sharesAtas.reduce((sum, a, i) => sum + tokenAmount(accs[invested.length + i] ?? null, state.sharesMint, me), 0n)
    const farmAcc = userState ? accs[invested.length + 2] ?? null : null
    const stake = userState && farmAcc ? decodeFarmUser(userState, farmAcc) : null
    const staked = stake && stake.owner === me && stake.farm === state.farm ? stake.staked : 0n
    return {
      state, tokensPerShareWad, sharesAtas, tokenAta: associatedTokenAddress(me, state.tokenMint, state.tokenProgram),
      farm: state.farm && userState ? { farm: state.farm, userState } : null, unstaked, staked,
    }
  }

  private rules(op: 'deposit' | 'withdraw', me: string, c: VaultOnChain): readonly InstructionRule[] {
    return vaultRules(op, {
      me, vault: this.vault, mint: c.state.tokenMint, sharesMint: c.state.sharesMint, tokenAta: c.tokenAta, sharesAtas: c.sharesAtas, farm: c.farm,
      wsolAta: associatedTokenAddress(me, WSOL_MINT, TOKEN_PROGRAM),
    }, { stake: !this.skipFarm })
  }

  private async plan(o: KaminoVaultSupplyOptions, me: string): Promise<{ base64: string; v: ApiVault; amount: bigint; expectedShares: bigint; rules: readonly InstructionRule[] }> {
    const amount = toAmount(o.amount)
    // What the wallet deposits is named by the caller, never only by the API.
    const token = o.token ?? this._config.asset
    if (token === undefined) throw new KaminoError(`Name the asset to deposit: pass 'token' or set 'asset' in the vault config.`)
    const [v, m] = await Promise.all([this.state(), this.api.getVaultMetrics(this.vault)])
    if (token !== v.tokenMint) throw new KaminoError(`Vault ${this.vault} takes ${symbolOf(v)} (${v.tokenMint}), not ${token}.`)
    const c = await this.onChain(me, v, m)
    if (amount < c.state.minDeposit) throw new KaminoError(`Deposit below the vault minimum: ${amount} < ${c.state.minDeposit} base units.`)
    const expectedShares = this.assetsToShares(amount, v, c.tokensPerShareWad)
    if (expectedShares <= 0n) throw new KaminoError(`A deposit of ${amount} base units buys no shares of vault ${this.vault}.`)
    const base64 = await this.api.buildVaultDeposit({ wallet: me, kvault: this.vault, amount: toDecimalString(amount, v.tokenMintDecimals), skipFarm: this.skipFarm, memo: this.memo() })
    return { base64, v, amount, expectedShares, rules: this.rules('deposit', me, c) }
  }

  private supplyExpectation(v: ApiVault, amount: bigint, expectedShares: bigint) {
    const e = this.spendExpectation(v.tokenMint, amount)
    // Shares that stay in the wallet are proven in; staked shares land in the farm, so only the spend is bounded.
    return this.skipFarm ? { ...e, tokenIn: { mint: v.sharesMint, minAmount: lessBps(expectedShares, this.slippageBps) } } : e
  }

  override async quoteSupply(o: KaminoVaultSupplyOptions): Promise<VaultSupplyQuote> {
    const me = await this.me()
    const { base64, v, amount, expectedShares, rules } = await this.plan(o, me)
    const { fee } = await this.quoteBuilt(base64, this.supplyExpectation(v, amount, expectedShares), rules)
    return { fee, expectedShares }
  }

  override async supply(o: KaminoVaultSupplyOptions): Promise<LendingResult> {
    this.requireSigningAccount('supply(options)')
    const me = await this.me()
    const { base64, v, amount, expectedShares, rules } = await this.plan(o, me)
    return this.sendBuilt(base64, this.supplyExpectation(v, amount, expectedShares), rules, 'supply')
  }

  private async planWithdraw(o: KaminoVaultWithdrawOptions, me: string): Promise<{ base64: string; v: ApiVault; shares: bigint; expectedAssets: bigint; rules: readonly InstructionRule[] }> {
    const [v, m] = await Promise.all([this.state(), this.api.getVaultMetrics(this.vault)])
    if (o.token && o.token !== v.tokenMint) throw new KaminoError(`Vault ${this.vault} pays out ${symbolOf(v)} (${v.tokenMint}), not ${o.token}.`)
    const c = await this.onChain(me, v, m)
    const held = c.unstaked + c.staked
    if (held === 0n) throw new KaminoError(`No position in vault ${this.vault} for ${me}.`)
    const tps = c.tokensPerShareWad
    let shares: bigint, amountArg: string
    // Every share, by count: what the chain holds is what the guard lets go (the API refuses u64::MAX as a decimal now).
    if (o.amount === 'max') { shares = held; amountArg = toDecimalString(held, v.sharesMintDecimals) }
    else {
      const assets = toAmount(o.amount)
      shares = this.assetsToShares(assets, v, tps)
      if (shares > held) throw new KaminoError(`Withdrawal exceeds the position: ${assets} asset units need ${shares} shares, the wallet holds ${held}.`)
      amountArg = toDecimalString(shares, v.sharesMintDecimals)
    }
    const expectedAssets = this.sharesToAssets(shares, v, tps)
    if (expectedAssets < c.state.minWithdraw) throw new KaminoError(`Withdrawal below the vault minimum: ${expectedAssets} < ${c.state.minWithdraw} base units.`)
    const base64 = await this.api.buildVaultWithdraw({ wallet: me, kvault: this.vault, amount: amountArg, memo: this.memo() })
    return { base64, v, shares, expectedAssets, rules: this.rules('withdraw', me, c) }
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
    const { base64, v, shares, expectedAssets, rules } = await this.planWithdraw(o, me)
    const expect = this.withdrawExpectation(v, shares, expectedAssets)
    const { fee } = await this.quoteBuilt(base64, expect, rules)
    return { fee, shares, expectedAssets, minAssets: expect.tokenIn!.minAmount }
  }

  override async withdraw(o: KaminoVaultWithdrawOptions): Promise<LendingResult> {
    this.requireSigningAccount('withdraw(options)')
    const me = await this.me()
    const { base64, v, shares, expectedAssets, rules } = await this.planWithdraw(o, me)
    return this.sendBuilt(base64, this.withdrawExpectation(v, shares, expectedAssets), rules, 'withdraw')
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
