import { NotImplementedError, type IWalletAccount, type IWalletAccountReadOnly, type LendingQuote, type LendingResult, type SupplyOptions, type WithdrawOptions } from '@anywalletkit/core'
import { getAddress, isAddress, keccak256, type Address } from 'viem'
import { VAULT_V3_ABI } from './abi.js'
import { CurveLendingBase, FALLBACK_GAS, toAmount, type AmountOption, type CurveLendingBaseConfig, type Tx } from './base.js'
import type { ScrvUsdDeployment } from './chains.js'
import { CurveLendingError, ScrvUsdVerificationError, VaultShutdownError } from './errors.js'
import { aprWadToApyPct, clampApy, scrvUsdAprWad } from './math.js'
import type { ScrvUsdApiStats } from './api.js'

export interface ScrvUsdConfig extends CurveLendingBaseConfig {
  /**
   * Deposit while the vault lends to strategies (`totalDebt > 0`). scrvUSD keeps every crvUSD
   * idle today, which is what makes withdrawals instant; Yearn V3 lets its role manager add
   * strategies, and that changes the risk. Default false: such a deposit is refused with code
   * `'StrategiesInUse'`. Withdrawals are never gated by it.
   */
  allowStrategies?: boolean
}

export interface ScrvUsdSupplyOptions extends Omit<SupplyOptions, 'token'> { token?: string }
export interface ScrvUsdWithdrawOptions extends Omit<WithdrawOptions, 'amount' | 'token'> { token?: string; amount: AmountOption }

export interface ScrvUsdInfo {
  vault: Address
  implementation: Address
  apiVersion: string
  name: string
  symbol: string
  /** Share decimals (VaultV3: the asset's, 18). */
  decimals: number
  asset: { address: Address; symbol: string; decimals: number }
  totalAssets: bigint
  totalSupply: bigint
  /** crvUSD held by the vault itself (instantly withdrawable). */
  totalIdle: bigint
  /** crvUSD lent to strategies (0 for scrvUSD today). */
  totalDebt: bigint
  /** Assets per 1e18 shares. */
  pricePerShare: bigint
  isShutdown: boolean
  /** Seconds a report's profit takes to unlock (604 800 = 7 days). */
  profitMaxUnlockTime: bigint
  /** Unix seconds when the current profit has fully unlocked. */
  fullProfitUnlockDate: bigint
  /** Shares burned per second × 1e12 while profit unlocks. */
  profitUnlockingRate: bigint
  roleManager: Address
  /** Block the state was read at, and its timestamp. */
  block: bigint
  timestamp: bigint
}

export interface ScrvUsdPosition {
  shares: bigint
  /** crvUSD the shares are worth now (`convertToAssets`). */
  assets: bigint
  /** crvUSD withdrawable now with zero loss (`maxWithdraw(owner, 0)`). */
  withdrawable: bigint
  /** Shares redeemable now with zero loss: every share when the vault can pay them all, else `maxRedeem(owner, 0)`. */
  redeemableShares: bigint
}

export interface ScrvUsdApy {
  /** Percent: the API's figure bounded by the on-chain projection, or the on-chain one. */
  apy: number
  source: 'api' | 'api-clamped' | 'chain'
  /** Percent, from `profitUnlockingRate` at `block`. */
  chainApy: number
  apiApy: number | null
  /** On-chain APR, WAD-scaled. */
  aprWad: bigint
  block: bigint
  /** Unix seconds: the projection holds until the profit has unlocked (then 0 until the next report). */
  unlockingUntil: bigint
}

const MAX_LOSS = 0n

/**
 * Savings crvUSD (scrvUSD) on Ethereum as a `LendingProtocol`: `supply` deposits crvUSD for
 * scrvUSD shares, `withdraw` redeems them with max_loss = 0; `borrow` / `repay` reject.
 *
 * Before anything is read for a write, the vault is identified on-chain (once per instance):
 * the read RPC is on Ethereum, the vault's runtime code is exactly the EIP-1167 clone of the
 * pinned VaultV3 implementation, the implementation's code hash is the pinned one, and the vault
 * answers `apiVersion()` "3.0.4" and `asset()` crvUSD. Any mismatch is a
 * `ScrvUsdVerificationError`; a failed read propagates. Every deposit then reads `isShutdown`,
 * `totalDebt` and `maxDeposit` fresh, every withdrawal `maxWithdraw` / `maxRedeem`, and the main
 * transaction is proven with `eth_call` before it is sent. The Curve API only decorates the APY.
 */
export class ScrvUsdProtocolEvm extends CurveLendingBase<ScrvUsdConfig> {
  readonly deployment: ScrvUsdDeployment
  readonly vault: Address
  private _verified: Promise<void> | null = null

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: ScrvUsdConfig = {}) {
    super(account, config)
    const d = this.chain.scrvUsd
    if (!d) throw new CurveLendingError(`scrvUSD is a vault on Ethereum only; on ${this.chain.name} it is a bridged token (swap crvUSD for it instead).`)
    this.deployment = d
    this.vault = getAddress(d.vault)
  }

  /** The on-chain identity checks (cached once they pass; a failure is retried on the next call). */
  verify(): Promise<void> {
    if (!this._verified) {
      this._verified = (async () => {
        const d = this.deployment
        const fail = (check: ScrvUsdVerificationError['check'], expected: string, observed: string): never => {
          throw new ScrvUsdVerificationError({ vault: this.vault, check, expected, observed })
        }
        // Chain and code first: on another chain, or with no vault at the address, the views below
        // return no data, and that must surface as the typed check, not as a decode error.
        const [chainId, clone, impl] = await Promise.all([
          this.client.getChainId(),
          this.client.getCode({ address: this.vault }),
          this.client.getCode({ address: d.implementation }),
        ])
        if (chainId !== d.chainId) fail('chain', `eip155:${d.chainId}`, `eip155:${chainId}`)
        if ((clone ?? '0x').toLowerCase() !== d.cloneCode.toLowerCase()) fail('clone', `EIP-1167 clone of ${d.implementation}`, clone && clone !== '0x' ? `${(clone.length - 2) / 2} bytes of other code` : 'no code')
        const implHash = impl && impl !== '0x' ? keccak256(impl) : '0x'
        if (implHash.toLowerCase() !== d.implementationCodeHash.toLowerCase()) fail('implementation', d.implementationCodeHash, implHash)
        const [apiVersion, asset] = await Promise.all([
          this.read<string>(this.vault, VAULT_V3_ABI, 'apiVersion'),
          this.read<Address>(this.vault, VAULT_V3_ABI, 'asset'),
        ])
        if (apiVersion !== d.apiVersion) fail('apiVersion', d.apiVersion, apiVersion)
        if (getAddress(asset) !== getAddress(d.asset)) fail('asset', d.asset, asset)
      })().catch((e) => { this._verified = null; throw e })
    }
    return this._verified
  }

  /** The vault, verified, with its state read now at one block. */
  async getVault(): Promise<ScrvUsdInfo> {
    await this.verify()
    const v = this.vault
    const block = await this.client.getBlock({ blockTag: 'latest' })
    const at = { blockNumber: block.number! }
    const r = <T>(fn: string): Promise<T> => this.client.readContract({ address: v, abi: VAULT_V3_ABI, functionName: fn, ...at } as never) as Promise<T>
    const [name, symbol, decimals, totalAssets, totalSupply, totalIdle, totalDebt, pricePerShare, isShutdown, profitMaxUnlockTime, fullProfitUnlockDate, profitUnlockingRate, roleManager] = await Promise.all([
      r<string>('name'), r<string>('symbol'), r<number>('decimals'), r<bigint>('totalAssets'), r<bigint>('totalSupply'), r<bigint>('totalIdle'), r<bigint>('totalDebt'),
      r<bigint>('pricePerShare'), r<boolean>('isShutdown'), r<bigint>('profitMaxUnlockTime'), r<bigint>('fullProfitUnlockDate'), r<bigint>('profitUnlockingRate'), r<Address>('role_manager'),
    ])
    return {
      vault: v, implementation: getAddress(this.deployment.implementation), apiVersion: this.deployment.apiVersion, name, symbol, decimals: Number(decimals),
      asset: { address: getAddress(this.deployment.asset), symbol: 'crvUSD', decimals: Number(decimals) },
      totalAssets, totalSupply, totalIdle, totalDebt, pricePerShare, isShutdown, profitMaxUnlockTime, fullProfitUnlockDate, profitUnlockingRate,
      roleManager: getAddress(roleManager), block: block.number!, timestamp: block.timestamp,
    }
  }

  /** Shares of `user` (default: the account), their value, and what can leave now with zero loss. */
  async getPosition(user?: string): Promise<ScrvUsdPosition> {
    await this.verify()
    const who = user ? getAddress(user) : await this.me()
    const shares = await this.read<bigint>(this.vault, VAULT_V3_ABI, 'balanceOf', [who])
    if (shares === 0n) return { shares, assets: 0n, withdrawable: 0n, redeemableShares: 0n }
    const [assets, withdrawable, redeemableShares] = await Promise.all([
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'convertToAssets', [shares]),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'maxWithdraw', [who, MAX_LOSS]),
      this.redeemable(who, shares),
    ])
    return { shares, assets, withdrawable, redeemableShares }
  }

  /**
   * Shares `owner` can redeem now with zero loss. VaultV3's `maxRedeem` is
   * convertToShares(maxWithdraw) rounded down, so even a fully liquid vault answers one share
   * unit short of the balance (seen on Ethereum 2026-11-05): when the vault can pay every
   * share's assets, the whole balance is redeemable; otherwise `maxRedeem` stands.
   */
  private async redeemable(owner: Address, shares: bigint): Promise<bigint> {
    const [assets, withdrawable, maxRedeem] = await Promise.all([
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'previewRedeem', [shares]),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'maxWithdraw', [owner, MAX_LOSS]),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'maxRedeem', [owner, MAX_LOSS]),
    ])
    if (withdrawable >= assets) return shares
    return maxRedeem < shares ? maxRedeem : shares
  }

  /** Curve API savings statistics — null without API or when it fails. */
  async getStats(): Promise<ScrvUsdApiStats | null> {
    if (!this.api) return null
    try { return await this.api.savingsStatistics() } catch { return null }
  }

  /**
   * The APY, with where it came from: the API's projection when it lies within the tolerance band
   * around the on-chain one (`APY_TOLERANCE`), clamped to the band's edge otherwise, the on-chain
   * projection alone without the API. The on-chain figure is read at one block.
   */
  async getApyDetails(): Promise<ScrvUsdApy> {
    const [info, stats] = await Promise.all([this.getVault(), this.getStats()])
    const aprWad = scrvUsdAprWad({ profitUnlockingRate: info.profitUnlockingRate, fullProfitUnlockDate: info.fullProfitUnlockDate, totalSupply: info.totalSupply, now: info.timestamp })
    const chainApy = aprWadToApyPct(aprWad)
    const apiApy = stats?.projApy ?? null
    const { apy, source } = clampApy(apiApy, chainApy)
    return { apy, source, chainApy, apiApy, aprWad, block: info.block, unlockingUntil: info.fullProfitUnlockDate }
  }

  /** Projected APY in percent (variable: it follows the weekly reports). */
  async getApy(): Promise<number> {
    return (await this.getApyDetails()).apy
  }

  private assertToken(token: string | undefined): void {
    if (token === 'native') throw new CurveLendingError('scrvUSD takes crvUSD only: swap to crvUSD first.')
    if (token !== undefined && (!isAddress(token) || getAddress(token) !== getAddress(this.deployment.asset))) {
      throw new CurveLendingError(`scrvUSD takes crvUSD (${this.deployment.asset}), not ${token}.`)
    }
  }

  /** @internal */
  async planSupply(o: ScrvUsdSupplyOptions): Promise<{ approvals: Tx[]; tx: Tx; sharesOut: bigint }> {
    const amount = toAmount(o.amount)
    this.assertToken(o.token)
    await this.verify()
    const receiver = o.onBehalfOf ? getAddress(o.onBehalfOf) : await this.me()
    const [isShutdown, totalDebt, maxDeposit] = await Promise.all([
      this.read<boolean>(this.vault, VAULT_V3_ABI, 'isShutdown'),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'totalDebt'),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'maxDeposit', [receiver]),
    ])
    if (isShutdown) throw new VaultShutdownError('Savings crvUSD')
    if (totalDebt > 0n && this._config.allowStrategies !== true) {
      throw new CurveLendingError(`Savings crvUSD now lends ${totalDebt} crvUSD base units to strategies (totalDebt > 0): its idle-only design changed — refusing the deposit. Pass allowStrategies to proceed.`, 'StrategiesInUse')
    }
    if (maxDeposit < amount) {
      throw new CurveLendingError(maxDeposit === 0n
        ? 'Savings crvUSD: deposits are closed right now (deposit limit reached).'
        : `Savings crvUSD: at most ${maxDeposit} crvUSD base units can be deposited right now.`, 'ExceededMaxDeposit')
    }
    const [approvals, sharesOut] = await Promise.all([
      this.approvals(getAddress(this.deployment.asset), this.vault, amount),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'previewDeposit', [amount]),
    ])
    const tx: Tx = { to: this.vault, data: this.encode(VAULT_V3_ABI, 'deposit', [amount, receiver]), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.vault
    return { approvals, tx, sharesOut }
  }

  /** Deposits crvUSD (`token` may be omitted) for scrvUSD minted to `onBehalfOf` (default: the account). */
  override async supply(o: ScrvUsdSupplyOptions): Promise<LendingResult & { approveHashes: string[]; sharesOut: bigint }> {
    this.writable('supply')
    const plan = await this.planSupply(o)
    return { ...(await this.execute(plan, 'deposit')), sharesOut: plan.sharesOut }
  }

  override async quoteSupply(o: ScrvUsdSupplyOptions): Promise<LendingQuote & { sharesOut: bigint; approvals: number }> {
    const plan = await this.planSupply(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'deposit')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), sharesOut: plan.sharesOut, approvals: plan.approvals.length }
  }

  /**
   * @internal 'max' redeems every share redeemable now (all of them while the vault can pay them,
   * else `maxRedeem(owner, 0)`; `complete` says whether that was the whole position); an amount
   * withdraws exactly that much crvUSD and is refused above `maxWithdraw(owner, 0)`.
   */
  async planWithdraw(o: ScrvUsdWithdrawOptions): Promise<{ tx: Tx; assetsOut: bigint; sharesIn: bigint; complete: boolean; method: 'redeem' | 'withdraw' }> {
    this.assertToken(o.token)
    await this.verify()
    const me = await this.me()
    const to = o.to ? getAddress(o.to) : me
    const shares = await this.read<bigint>(this.vault, VAULT_V3_ABI, 'balanceOf', [me])
    if (shares === 0n) throw new CurveLendingError('Savings crvUSD: nothing deposited to withdraw.')
    if (o.amount === 'max') {
      const redeem = await this.redeemable(me, shares)
      if (redeem === 0n) throw new CurveLendingError('Savings crvUSD: no shares can be redeemed right now (vault liquidity).', 'ExceededMaxRedeem')
      const assetsOut = await this.read<bigint>(this.vault, VAULT_V3_ABI, 'previewRedeem', [redeem])
      return { tx: { to: this.vault, data: this.encode(VAULT_V3_ABI, 'redeem', [redeem, to, me, MAX_LOSS]), value: 0n }, assetsOut, sharesIn: redeem, complete: redeem === shares, method: 'redeem' }
    }
    const amount = toAmount(o.amount)
    const [assets, withdrawable] = await Promise.all([
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'convertToAssets', [shares]),
      this.read<bigint>(this.vault, VAULT_V3_ABI, 'maxWithdraw', [me, MAX_LOSS]),
    ])
    if (amount > assets) throw new CurveLendingError(`Savings crvUSD: the amount exceeds the position (${assets} base units).`)
    if (amount > withdrawable) throw new CurveLendingError(`Savings crvUSD: only ${withdrawable} crvUSD base units are withdrawable right now (vault liquidity).`, 'ExceededMaxWithdraw')
    const sharesIn = await this.read<bigint>(this.vault, VAULT_V3_ABI, 'previewWithdraw', [amount])
    return { tx: { to: this.vault, data: this.encode(VAULT_V3_ABI, 'withdraw', [amount, to, me, MAX_LOSS]), value: 0n }, assetsOut: amount, sharesIn, complete: sharesIn === shares, method: 'withdraw' }
  }

  /** Withdraws `amount` of crvUSD (or 'max' → redeem every share) to `to` (default: the account), with zero allowed loss. */
  override async withdraw(o: ScrvUsdWithdrawOptions): Promise<LendingResult & { assetsOut: bigint; sharesIn: bigint; complete: boolean }> {
    this.writable('withdraw')
    const plan = await this.planWithdraw(o)
    await this.prove(plan.tx, plan.method)
    const sent = await this.send(plan.tx)
    return { ...sent, assetsOut: plan.assetsOut, sharesIn: plan.sharesIn, complete: plan.complete }
  }

  override async quoteWithdraw(o: ScrvUsdWithdrawOptions): Promise<LendingQuote & { assetsOut: bigint; sharesIn: bigint; complete: boolean }> {
    const plan = await this.planWithdraw(o)
    await this.prove(plan.tx, plan.method)
    return { fee: await this.quoteFee([plan.tx]), assetsOut: plan.assetsOut, sharesIn: plan.sharesIn, complete: plan.complete }
  }

  override async borrow(): Promise<never> { throw new NotImplementedError('borrow(options): Savings crvUSD does not lend to depositors.') }
  override async quoteBorrow(): Promise<never> { throw new NotImplementedError('quoteBorrow(options): Savings crvUSD does not lend to depositors.') }
  override async repay(): Promise<never> { throw new NotImplementedError('repay(options): Savings crvUSD has no debt to repay.') }
  override async quoteRepay(): Promise<never> { throw new NotImplementedError('quoteRepay(options): Savings crvUSD has no debt to repay.') }
}
