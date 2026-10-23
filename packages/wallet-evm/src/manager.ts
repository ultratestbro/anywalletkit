import { LocalSigner, SignerError, WalletManager, isSeedSigner, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountEvm } from './account.js'
import { WalletAccountReadOnlyEvm } from './read-only-account.js'
import type { EvmConfig } from './types.js'

export const EVM_BASE_PATH = "m/44'/60'/0'/0"

/**
 * One seed → EVM accounts at m/44'/60'/0'/0/i (BIP-44; MetaMask / ethers
 * default). The 64-byte BIP-39 seed is held for the life of the manager and
 * zeroized on `dispose()`.
 *
 * Built with a secp256k1 `Signer` instead of a seed, the manager wraps it:
 * - a derivable `SeedSigner` sitting at `m/44'/60'/0'/0` yields `getAccount(i)` children;
 * - a `SeedSigner` at a leaf, or any external signer, is `getAccount(0)` (path = the
 *   signer's path, or 'external'); other indexes/paths throw.
 */
export class WalletManagerEvm extends WalletManager<WalletAccountEvm, EvmConfig> {
  constructor(seedOrSigner: string | Uint8Array | Signer, config: EvmConfig = {}) {
    super(seedOrSigner, config)
  }


  async getAccount(index = 0): Promise<WalletAccountEvm> {
    return this.getAccountByPath(`${EVM_BASE_PATH}/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountEvm> {
    const cached = this._accounts.get(path)
    if (cached) return cached
    const external = this.externalSigner()
    if (external) return this.fromSigner(external, path)
    const signer = LocalSigner.leafFromSeed(this.seedBytes(), 'secp256k1', path)
    const account = new WalletAccountEvm(signer, signer.publicKey, path, this._config)
    this._accounts.set(path, account)
    return account
  }

  /** Resolve `path` against an injected signer: the signer itself, or a child when it can derive there. */
  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountEvm> {
    this.requireSigner('secp256k1')
    let leaf: Signer = signer
    let key = 'external'
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { leaf = await (signer.deriveLeaf ?? signer.derive).call(signer, path.slice(signer.path.length + 1)); key = path }
      else throw new SignerError(`The injected signer sits at ${signer.path}; it cannot provide ${path}.`)
    } else if (path !== `${EVM_BASE_PATH}/0` && path !== 'external') {
      throw new SignerError(`An external signer has one account; ${path} is not derivable from it.`)
    }
    const cached = this._accounts.get(key)
    if (cached) return cached
    const account = new WalletAccountEvm(leaf, await leaf.getPublicKey(), key, this._config)
    this._accounts.set(key, account)
    return account
  }

  /** Watch-only account for any address, sharing this manager's provider config. */
  getReadOnlyAccount(address: string): WalletAccountReadOnlyEvm {
    return new WalletAccountReadOnlyEvm(address, this._config)
  }

  /** normal = feeRate × 1.0, fast = × 1.2, slow = × 0.8. */
  async getFeeRates(): Promise<FeeRates> {
    const probe = new WalletAccountReadOnlyEvm('0x0000000000000000000000000000000000000000', this._config)
    const normal = await probe.getFeeRate()
    return { slow: (normal * 80n) / 100n, normal, fast: (normal * 120n) / 100n }
  }

}
