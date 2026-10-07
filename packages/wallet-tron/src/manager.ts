import { LocalSigner, SignerError, WalletManager, isSeedSigner, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountTron } from './account.js'
import { WalletAccountReadOnlyTron } from './read-only-account.js'
import type { TronConfig } from './types.js'

export const TRON_BASE_PATH = "m/44'/195'"
/** The account branch `getAccount(i)` indexes: m/44'/195'/0'/0/i (TronLink default). */
export const TRON_ACCOUNT_BRANCH = `${TRON_BASE_PATH}/0'/0`

/**
 * One seed → Tron accounts at m/44'/195'/0'/0/i (BIP-44; TronLink default).
 * Paths may be relative to m/44'/195' ("0'/0/3") or full.
 *
 * Built with a secp256k1 `Signer` instead of a seed, the manager wraps it:
 * - a derivable `SeedSigner` sitting at `m/44'/195'/0'/0` yields `getAccount(i)` children;
 * - a `SeedSigner` at a leaf, or any external signer, is `getAccount(0)` (path = the
 *   signer's path, or 'external'); other indexes/paths throw.
 */
export class WalletManagerTron extends WalletManager<WalletAccountTron, TronConfig> {
  private _seedBytes: Uint8Array | undefined

  constructor(seedOrSigner: string | Signer, config: TronConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  async getAccount(index = 0): Promise<WalletAccountTron> {
    return this.getAccountByPath(`${TRON_ACCOUNT_BRANCH}/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountTron> {
    const full = path.startsWith('m/') || path === 'external' ? path : `${TRON_BASE_PATH}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    const external = this.externalSigner()
    if (external) return this.fromSigner(external, full)
    const signer = LocalSigner.fromSeed(this._seedBytes!, 'secp256k1', full)
    const account = new WalletAccountTron(signer, signer.publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
  }

  /** Resolve `path` against an injected signer: the signer itself, or a child when it can derive there. */
  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountTron> {
    this.requireSigner('secp256k1')
    let leaf: Signer = signer
    let key = 'external'
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { leaf = await signer.derive(path.slice(signer.path.length + 1)); key = path }
      else throw new SignerError(`The injected signer sits at ${signer.path}; it cannot provide ${path}.`)
    } else if (path !== `${TRON_ACCOUNT_BRANCH}/0` && path !== 'external') {
      throw new SignerError(`An external signer has one account; ${path} is not derivable from it.`)
    }
    const cached = this._accounts.get(key)
    if (cached) return cached
    const account = new WalletAccountTron(leaf, await leaf.getPublicKey(), key, this._config)
    this._accounts.set(key, account)
    return account
  }

  getReadOnlyAccount(address: string): WalletAccountReadOnlyTron {
    return new WalletAccountReadOnlyTron(address, this._config)
  }

  /** getTransactionFee chain parameter; normal = ×1.1, fast = ×2.0; slow = ×1.0. */
  async getFeeRates(): Promise<FeeRates> {
    const probe = new WalletAccountReadOnlyTron('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', this._config) as unknown as { getChainParameter(k: string): Promise<bigint>; requireClient(w: string): unknown }
    probe.requireClient('get fee rates')
    const fee = await probe.getChainParameter('getTransactionFee')
    return { slow: fee, normal: (fee * 110n) / 100n, fast: (fee * 200n) / 100n }
  }

  override dispose(): void {
    super.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
  }
}
