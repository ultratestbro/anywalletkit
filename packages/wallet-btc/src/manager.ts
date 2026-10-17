import { LocalSigner, SignerError, WalletManager, isSeedSigner, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountBtc } from './account.js'
import { coinType, purposeFor } from './network.js'
import { WalletAccountReadOnlyBtc } from './read-only-account.js'
import type { BtcConfig } from './types.js'

/**
 * One seed → Bitcoin accounts.
 *   p2wpkh (default): BIP-84, m/84'/0'/0'/0/i on mainnet, m/84'/1'/0'/0/i on test networks — bc1q… / tb1q…
 *   p2tr:             BIP-86, m/86'/0'/0'/0/i (key-path taproot) — bc1p… / tb1p…
 * Paths may be relative to the purpose/coin prefix ("0'/0/i") or given in full.
 *
 * Built with a secp256k1 `Signer` instead of a seed, the manager wraps it:
 * - a derivable `SeedSigner` sitting at the account branch (`m/84'/0'/0'/0` or
 *   `m/86'/0'/0'/0`, per `addressType`/`network`) yields `getAccount(i)` children;
 * - a `SeedSigner` at a leaf, or any external signer, is `getAccount(0)` (path = the
 *   signer's path, or 'external') with the configured address type; other
 *   indexes/paths throw.
 */
export class WalletManagerBtc extends WalletManager<WalletAccountBtc, BtcConfig> {
  constructor(seedOrSigner: string | Signer, config: BtcConfig = {}) {
    super(seedOrSigner, config)
  }


  get basePath(): string {
    return `m/${purposeFor(this._config.addressType ?? 'p2wpkh')}'/${coinType(this._config.network ?? 'bitcoin')}'`
  }

  async getAccount(index = 0): Promise<WalletAccountBtc> {
    return this.getAccountByPath(`${this.basePath}/0'/0/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountBtc> {
    const full = path.startsWith('m/') ? path : `${this.basePath}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    const external = this.externalSigner()
    if (external) return this.fromSigner(external, full)
    const signer = LocalSigner.fromSeed(this.seedBytes(), 'secp256k1', full)
    const account = new WalletAccountBtc(signer, signer.publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
  }

  /** Resolve `path` against an injected signer: the signer itself, or a child when it can derive there. */
  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountBtc> {
    this.requireSigner('secp256k1')
    let leaf: Signer = signer
    let key = 'external'
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { leaf = await signer.derive(path.slice(signer.path.length + 1)); key = path }
      else throw new SignerError(`The injected signer sits at ${signer.path}; it cannot provide ${path}.`)
    } else if (path !== `${this.basePath}/0'/0/0` && path !== 'external') {
      throw new SignerError(`An external signer has one account; ${path} is not derivable from it.`)
    }
    const cached = this._accounts.get(key)
    if (cached) return cached
    const account = new WalletAccountBtc(leaf, await leaf.getPublicKey(), key, this._config)
    this._accounts.set(key, account)
    return account
  }

  getReadOnlyAccount(address: string): WalletAccountReadOnlyBtc {
    return new WalletAccountReadOnlyBtc(address, this._config)
  }

  /** sat/vB from the client's estimator: fast = 1 block, normal = 3, slow = 6. */
  async getFeeRates(): Promise<FeeRates> {
    const probe = new WalletAccountReadOnlyBtc(
      (this._config.network ?? 'bitcoin') === 'bitcoin' ? 'bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu' : 'tb1q6rz28mcfaxtmd6v789l9rrlrusdprr9pqcpvkl',
      this._config,
    )
    const client = (probe as unknown as { requireClient(w: string): { estimateFee(b: number): Promise<number> } }).requireClient('get fee rates')
    const [fast, normal, slow] = await Promise.all([1, 3, 6].map((b) => client.estimateFee(b)))
    const big = (n: number) => BigInt(Math.max(Math.ceil(n), 1))
    return { slow: big(slow!), normal: big(normal!), fast: big(fast!) }
  }

}
