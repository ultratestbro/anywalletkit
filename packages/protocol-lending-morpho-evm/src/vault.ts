import { NotImplementedError, bigintToNumber, type IWalletAccount, type IWalletAccountReadOnly, type LendingQuote, type LendingResult, type SupplyOptions, type WithdrawOptions } from '@forgewallet/core'
import { getAddress, isAddress, type Address } from 'viem'
import { ERC4626_ABI, FACTORY_V1_ABI, FACTORY_V2_ABI, VAULT_V1_ABI, VAULT_V2_ABI } from './abi.js'
import { FALLBACK_GAS, MorphoBase, toAmount, type AmountOption, type MorphoBaseConfig, type Tx } from './base.js'
import { MorphoError } from './errors.js'
import type { ApiVault } from './api.js'

export interface MorphoVaultConfig extends MorphoBaseConfig {
  /** The vault (MetaMorpho / Vault V1, or Vault V2). */
  vault: string
  /** Accept a vault no known Morpho factory acknowledges (default false). */
  allowUnverifiedVault?: boolean
}

export interface MorphoVaultSupplyOptions extends Omit<SupplyOptions, 'token'> { token?: string }
export interface MorphoVaultWithdrawOptions extends Omit<WithdrawOptions, 'amount' | 'token'> { token?: string; amount: AmountOption }

export interface VaultInfo {
  vault: Address
  version: 'v1' | 'v2' | 'unverified'
  factory: Address | null
  name: string
  symbol: string
  /** Share decimals (asset decimals + offset on V1). */
  decimals: number
  asset: { address: Address; symbol: string; decimals: number }
  totalAssets: bigint
  totalSupply: bigint
  /** Assets per 1e18 shares, for display. */
  sharePriceWad: bigint
  /** Fractions: V1 = performance fee; V2 = performance + management. */
  fees: { performance: number; management: number }
  /** V1 timelock in seconds; null on V2. */
  timelockSeconds: number | null
  curator: Address | null
}

export interface VaultPosition {
  shares: bigint
  /** Assets the shares are worth now. */
  assets: bigint
  /** Assets the vault can pay out to this account right now (liquidity-bound). */
  withdrawable: bigint
}

/**
 * A Morpho vault — MetaMorpho (Vault V1) or Vault V2 — as a `LendingProtocol`:
 * `supply` deposits the vault's asset for shares, `withdraw` redeems them;
 * `borrow` / `repay` reject, a vault does not lend to its depositors.
 *
 * The vault is identified on-chain: one of the chain's Morpho vault factories
 * must acknowledge it (`isMetaMorpho` / `isVaultV2`), its `asset()` must be the
 * token supplied, and deposits / withdrawals are checked against `maxDeposit`
 * / `maxWithdraw` (caps, liquidity, V2 gates) before anything is sent, then
 * proven with `eth_call`. APY and TVL come from the Morpho API as decoration.
 */
export class MorphoVaultProtocolEvm extends MorphoBase<MorphoVaultConfig> {
  readonly vault: Address
  private _info: Promise<VaultInfo> | null = null

  protected override get activityVault(): string { return this.vault }

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: MorphoVaultConfig) {
    super(account, config)
    if (!config?.vault || !isAddress(config.vault)) throw new MorphoError("'vault' must be the vault's address.")
    this.vault = getAddress(config.vault)
  }

  /** The vault as the chain describes it (cached per instance). Refuses an unverified vault unless allowed. */
  getVault(): Promise<VaultInfo> {
    if (!this._info) {
      this._info = (async () => {
        const v = this.vault
        const [asset, name, symbol, decimals, totalAssets, totalSupply] = await Promise.all([
          this.read<Address>(v, ERC4626_ABI, 'asset'), this.read<string>(v, ERC4626_ABI, 'name').catch(() => '?'),
          this.read<string>(v, ERC4626_ABI, 'symbol').catch(() => '?'), this.read<number>(v, ERC4626_ABI, 'decimals'),
          this.read<bigint>(v, ERC4626_ABI, 'totalAssets'), this.read<bigint>(v, ERC4626_ABI, 'totalSupply'),
        ])
        let version: VaultInfo['version'] = 'unverified'
        let factory: Address | null = null
        for (const f of this.chain.vaultV1Factories) {
          if (await this.read<boolean>(f, FACTORY_V1_ABI, 'isMetaMorpho', [v]).catch(() => false)) { version = 'v1'; factory = f; break }
        }
        if (version === 'unverified') {
          for (const f of this.chain.vaultV2Factories) {
            if (await this.read<boolean>(f, FACTORY_V2_ABI, 'isVaultV2', [v]).catch(() => false)) { version = 'v2'; factory = f; break }
          }
        }
        if (version === 'unverified' && !this._config.allowUnverifiedVault) {
          throw new MorphoError(`${v} is not acknowledged by any Morpho vault factory on ${this.chain.name} — refusing. Pass allowUnverifiedVault to override.`)
        }
        if (version === 'v1') {
          // A failed read must not look like a vault pointing at address zero: let the network error surface.
          const morpho = await this.read<Address>(v, VAULT_V1_ABI, 'MORPHO')
          if (getAddress(morpho) !== getAddress(this.chain.morpho)) throw new MorphoError(`Vault ${v} points at Morpho ${morpho}, expected ${this.chain.morpho}.`)
        }
        const meta = await this.tokenMeta(getAddress(asset))
        const fees = { performance: 0, management: 0 }
        let timelockSeconds: number | null = null
        let curator: Address | null = null
        if (version === 'v1') {
          const [fee, timelock, cur] = await Promise.all([
            this.read<bigint>(v, VAULT_V1_ABI, 'fee').catch(() => 0n), this.read<bigint>(v, VAULT_V1_ABI, 'timelock').catch(() => 0n), this.read<Address>(v, VAULT_V1_ABI, 'curator').catch(() => null),
          ])
          fees.performance = bigintToNumber(fee) / 1e18
          timelockSeconds = Number(timelock)
          curator = cur
        } else if (version === 'v2') {
          const [pf, mf, cur] = await Promise.all([
            this.read<bigint>(v, VAULT_V2_ABI, 'performanceFee').catch(() => 0n), this.read<bigint>(v, VAULT_V2_ABI, 'managementFee').catch(() => 0n), this.read<Address>(v, VAULT_V2_ABI, 'curator').catch(() => null),
          ])
          fees.performance = bigintToNumber(pf) / 1e18
          fees.management = bigintToNumber(mf) / 1e18
          curator = cur
        }
        const sharePriceWad = await this.read<bigint>(v, ERC4626_ABI, 'convertToAssets', [10n ** 18n]).catch(() => 0n)
        return { vault: v, version, factory, name, symbol, decimals: Number(decimals), asset: { address: getAddress(asset), ...meta }, totalAssets, totalSupply, sharePriceWad, fees, timelockSeconds, curator }
      })().catch((e) => { this._info = null; throw e })
    }
    return this._info
  }

  /** Shares, their current value, and what is withdrawable right now. */
  async getPosition(): Promise<VaultPosition> {
    const me = await this.me()
    const [shares, withdrawable] = await Promise.all([
      this.read<bigint>(this.vault, ERC4626_ABI, 'balanceOf', [me]),
      this.read<bigint>(this.vault, ERC4626_ABI, 'maxWithdraw', [me]).catch(() => 0n),
    ])
    const assets = shares > 0n ? await this.read<bigint>(this.vault, ERC4626_ABI, 'convertToAssets', [shares]) : 0n
    return { shares, assets, withdrawable }
  }

  /** The vault's API record (name, APY, TVL, listed) — null without API or when the API does not know the vault. */
  async getStats(): Promise<ApiVault | null> {
    if (!this.api) return null
    try { return await this.api.vault(this.vault, this.chainId) } catch { return null }
  }

  /** Net APY in percent from the Morpho API (after fees, incl. rewards). */
  async getApy(): Promise<number> {
    const s = await this.getStats()
    const apy = s?.netApy ?? s?.apy
    if (apy == null) throw new MorphoError('APY needs the Morpho API (config.api) and a vault it knows.')
    return apy
  }

  private async assertAsset(token: string | undefined): Promise<VaultInfo> {
    const info = await this.getVault()
    if (token !== undefined && token !== 'native' && (!isAddress(token) || getAddress(token) !== info.asset.address)) {
      throw new MorphoError(`This vault takes ${info.asset.symbol} (${info.asset.address}), not ${token}.`)
    }
    if (token === 'native') throw new MorphoError(`Morpho vaults take ERC-20 only: wrap first and supply ${info.asset.symbol}.`)
    return info
  }

  /** @internal */
  async planSupply(o: MorphoVaultSupplyOptions): Promise<{ info: VaultInfo; approvals: Tx[]; tx: Tx; sharesOut: bigint }> {
    const amount = toAmount(o.amount)
    const info = await this.assertAsset(o.token)
    const receiver = o.onBehalfOf ? getAddress(o.onBehalfOf) : await this.me()
    const max = await this.read<bigint>(this.vault, ERC4626_ABI, 'maxDeposit', [receiver])
    if (max < amount) {
      throw new MorphoError(max === 0n
        ? `${info.name}: deposits are closed right now (caps reached or the receiver is gated).`
        : `${info.name}: at most ${max} ${info.asset.symbol} base units can be deposited right now.`, 'ExceededMaxDeposit')
    }
    if (info.version === 'v2') {
      const ok = await this.read<boolean>(this.vault, VAULT_V2_ABI, 'canReceiveShares', [receiver]).catch(() => true)
      if (!ok) throw new MorphoError(`${info.name}: ${receiver} is not allowed to receive this vault's shares (gated vault).`, 'CannotReceiveShares')
    }
    const [approvals, sharesOut] = await Promise.all([
      this.approvals(info.asset.address, this.vault, amount),
      this.read<bigint>(this.vault, ERC4626_ABI, 'previewDeposit', [amount]).catch(() => 0n),
    ])
    const tx: Tx = { to: this.vault, data: this.encode(ERC4626_ABI, 'deposit', [amount, receiver]), value: 0n }
    if (approvals.length > 0) tx.gasLimit = FALLBACK_GAS.vault
    return { info, approvals, tx, sharesOut }
  }

  /** Deposits the vault's asset (`token` may be omitted) for shares minted to `onBehalfOf` (default: the account). */
  override async supply(o: MorphoVaultSupplyOptions): Promise<LendingResult & { approveHashes: string[]; sharesOut: bigint }> {
    this.writable('supply')
    const plan = await this.planSupply(o)
    return { ...(await this.execute(plan, 'deposit')), sharesOut: plan.sharesOut }
  }

  override async quoteSupply(o: MorphoVaultSupplyOptions): Promise<LendingQuote & { sharesOut: bigint; approvals: number }> {
    const plan = await this.planSupply(o)
    if (plan.approvals.length === 0) await this.prove(plan.tx, 'deposit')
    return { fee: await this.quoteFee([...plan.approvals, plan.tx]), sharesOut: plan.sharesOut, approvals: plan.approvals.length }
  }

  /** @internal */
  async planWithdraw(o: MorphoVaultWithdrawOptions): Promise<{ info: VaultInfo; tx: Tx; assetsOut: bigint; all: boolean }> {
    const info = await this.assertAsset(o.token)
    const me = await this.me()
    const to = o.to ? getAddress(o.to) : me
    const pos = await this.getPosition()
    if (pos.shares === 0n) throw new MorphoError(`${info.name}: nothing deposited to withdraw.`)
    if (info.version === 'v2') {
      const [sendShares, recvAssets] = await Promise.all([
        this.read<boolean>(this.vault, VAULT_V2_ABI, 'canSendShares', [me]).catch(() => true),
        this.read<boolean>(this.vault, VAULT_V2_ABI, 'canReceiveAssets', [to]).catch(() => true),
      ])
      if (!sendShares || !recvAssets) throw new MorphoError(`${info.name}: this gated vault refuses the withdrawal for ${!sendShares ? me : to}.`)
    }
    if (o.amount === 'max') {
      const maxRedeem = await this.read<bigint>(this.vault, ERC4626_ABI, 'maxRedeem', [me]).catch(() => pos.shares)
      if (maxRedeem < pos.shares) {
        throw new MorphoError(`${info.name}: only ${pos.withdrawable} of ${pos.assets} ${info.asset.symbol} base units are withdrawable right now (vault liquidity) — withdraw that amount, or wait.`, 'ExceededMaxRedeem')
      }
      return { info, tx: { to: this.vault, data: this.encode(ERC4626_ABI, 'redeem', [pos.shares, to, me]), value: 0n }, assetsOut: pos.assets, all: true }
    }
    const amount = toAmount(o.amount)
    if (amount > pos.assets) throw new MorphoError(`${info.name}: the amount exceeds the position (${pos.assets} base units).`)
    if (amount > pos.withdrawable) throw new MorphoError(`${info.name}: only ${pos.withdrawable} base units are withdrawable right now (vault liquidity).`, 'ExceededMaxWithdraw')
    return { info, tx: { to: this.vault, data: this.encode(ERC4626_ABI, 'withdraw', [amount, to, me]), value: 0n }, assetsOut: amount, all: false }
  }

  /** Withdraws `amount` of the asset (or 'max' → redeem every share) to `to` (default: the account). */
  override async withdraw(o: MorphoVaultWithdrawOptions): Promise<LendingResult & { assetsOut: bigint }> {
    this.writable('withdraw')
    const plan = await this.planWithdraw(o)
    await this.prove(plan.tx, plan.all ? 'redeem' : 'withdraw')
    const sent = await this.send(plan.tx)
    return { ...sent, assetsOut: plan.assetsOut }
  }

  override async quoteWithdraw(o: MorphoVaultWithdrawOptions): Promise<LendingQuote & { assetsOut: bigint }> {
    const plan = await this.planWithdraw(o)
    await this.prove(plan.tx, plan.all ? 'redeem' : 'withdraw')
    return { fee: await this.quoteFee([plan.tx]), assetsOut: plan.assetsOut }
  }

  override async borrow(): Promise<never> { throw new NotImplementedError('borrow(options): a Morpho vault does not lend to depositors — use MorphoMarketProtocolEvm.') }
  override async quoteBorrow(): Promise<never> { throw new NotImplementedError('quoteBorrow(options): a Morpho vault does not lend to depositors.') }
  override async repay(): Promise<never> { throw new NotImplementedError('repay(options): a Morpho vault has no debt to repay.') }
  override async quoteRepay(): Promise<never> { throw new NotImplementedError('quoteRepay(options): a Morpho vault has no debt to repay.') }
}
