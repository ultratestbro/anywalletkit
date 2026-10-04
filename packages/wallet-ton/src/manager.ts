import { WalletManager, deriveEd25519, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountTon } from './account.js'
import { WalletAccountReadOnlyTon } from './read-only-account.js'
import type { TonConfig } from './types.js'

export const TON_BASE_PATH = "m/44'/607'"
const DEFAULT_TONAPI = 'https://tonapi.io/v2'

/**
 * One seed → TON accounts at m/44'/607'/i' (SLIP-10 ed25519, WalletContractV5R1,
 * the standard TON derivation). Paths may be relative to m/44'/607' ("0'") or full.
 */
export class WalletManagerTon extends WalletManager<WalletAccountTon, TonConfig> {
  private _seedBytes: Uint8Array | undefined

  constructor(seedOrSigner: string | Signer, config: TonConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  async getAccount(index = 0): Promise<WalletAccountTon> {
    return this.getAccountByPath(`${TON_BASE_PATH}/${index}'`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountTon> {
    const full = path.startsWith('m/') ? path : `${TON_BASE_PATH}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    if (!this._seedBytes) throw new Error('External signers for TON arrive in a later phase; construct WalletManagerTon with a seed phrase.')
    const { privateKey, publicKey } = deriveEd25519(this._seedBytes, full)
    const account = new WalletAccountTon(privateKey, publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
  }

  /** Watch-only account for a public key (hex or bytes) — TON addresses derive from the key, not the other way round. */
  getReadOnlyAccount(publicKey: Uint8Array | string): WalletAccountReadOnlyTon {
    return new WalletAccountReadOnlyTon(publicKey, this._config)
  }

  /** Gas price from config param 21 via tonapi (normal = fast there; slow = ×0.8 here). */
  async getFeeRates(): Promise<FeeRates> {
    const res = await fetch(`${this._config.tonApiUrl ?? DEFAULT_TONAPI}/blockchain/config/raw`)
    const json = (await res.json()) as { config: { config_param21: { gas_limits_prices: { gas_flat_pfx: { other: { gas_prices_ext: { gas_price: number } } } } } } }
    const normal = BigInt(Math.round(json.config.config_param21.gas_limits_prices.gas_flat_pfx.other.gas_prices_ext.gas_price / 65_536))
    return { slow: (normal * 80n) / 100n, normal, fast: normal }
  }

  override dispose(): void {
    super.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
  }
}
