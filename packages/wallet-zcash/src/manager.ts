import { LocalSigner, SignerError, WalletManager, isSeedSigner, type FeeRates, type Signer } from '@anywalletkit/core'
import { WalletAccountZcash } from './account.js'
import { MARGINAL_FEE } from './fee.js'
import { WalletAccountReadOnlyZcash } from './read-only-account.js'
import type { ZcashConfig, ZcashNetwork } from './types.js'

/** SLIP-44 coin type: 133 for mainnet, 1 for testnet. */
export const coinType = (network: ZcashNetwork): 133 | 1 => (network === 'mainnet' ? 133 : 1)

/**
 * One seed → Zcash transparent accounts at m/44'/133'/0'/0/i (BIP-44, the path
 * Zashi, YWallet, Ledger and Trezor use for the transparent receiver) — t1… on
 * mainnet, tm… on testnet. Paths may be relative to the purpose/coin prefix
 * ("0'/0/i") or given in full.
 *
 * Built with a secp256k1 `Signer` instead of a seed, the manager wraps it:
 * a derivable `SeedSigner` yields `getAccount(i)` children below its path; a
 * leaf or external signer is `getAccount(0)`.
 */
export class WalletManagerZcash extends WalletManager<WalletAccountZcash, ZcashConfig> {
  constructor(seedOrSigner: string | Uint8Array | Signer, config: ZcashConfig = {}) {
    super(seedOrSigner, config)
  }

  /** `m/44'/133'` on mainnet (coin type 1 on testnet); account `i` is at `basePath/0'/0/i`. */
  get basePath(): string {
    return `m/44'/${coinType(this._config.network ?? 'mainnet')}'`
  }

  async getAccount(index = 0): Promise<WalletAccountZcash> {
    return this.getAccountByPath(`${this.basePath}/0'/0/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountZcash> {
    const full = path.startsWith('m/') ? path : `${this.basePath}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    const external = this.externalSigner()
    if (external) return this.fromSigner(external, full)
    const signer = LocalSigner.leafFromSeed(this.seedBytes(), 'secp256k1', full)
    const account = new WalletAccountZcash(signer, signer.publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
  }

  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountZcash> {
    this.requireSigner('secp256k1')
    let leaf: Signer = signer
    let key = 'external'
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { leaf = await (signer.deriveLeaf ?? signer.derive).call(signer, path.slice(signer.path.length + 1)); key = path }
      else throw new SignerError(`The injected signer sits at ${signer.path}; it cannot provide ${path}.`)
    } else if (path !== `${this.basePath}/0'/0/0` && path !== 'external') {
      throw new SignerError(`An external signer has one account; ${path} is not derivable from it.`)
    }
    const cached = this._accounts.get(key)
    if (cached) return cached
    const account = new WalletAccountZcash(leaf, await leaf.getPublicKey(), key, this._config)
    this._accounts.set(key, account)
    return account
  }

  /** A read-only account for any transparent address, with this manager's config. */
  getReadOnlyAccount(address: string): WalletAccountReadOnlyZcash {
    return new WalletAccountReadOnlyZcash(address, this._config)
  }

  /** ZIP-317 has no fee market: every tier is the 5000-zatoshi marginal fee per logical action. */
  async getFeeRates(): Promise<FeeRates> {
    return { slow: MARGINAL_FEE, normal: MARGINAL_FEE, fast: MARGINAL_FEE }
  }
}
