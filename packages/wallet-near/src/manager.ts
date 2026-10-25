import { LocalSigner, NetworkError, SignerError, WalletManager, isSeedSigner, type FeeRates, type Signer } from '@anywalletkit/core'
import { WalletAccountNear } from './account.js'
import { WalletAccountReadOnlyNear } from './read-only-account.js'
import { NearRpc, createClient } from './rpc.js'
import type { NearConfig, NearPublicKey } from './types.js'

/** Base derivation path; account `i` is at `m/44'/397'/i'`. */
export const NEAR_BASE_PATH = "m/44'/397'"

/**
 * One seed → NEAR accounts at m/44'/397'/i' (SLIP-10 ed25519 — the NEAR Wallet /
 * near-seed-phrase path; index 0 is what every NEAR wallet derives). Paths may be
 * given relative to m/44'/397' ("0'") or in full; every segment must be hardened.
 *
 * Built with an ed25519 `Signer` instead of a seed, the manager wraps it:
 * - a derivable `SeedSigner` sitting at `m/44'/397'` yields `getAccount(i)` → `i'` children;
 * - a `SeedSigner` at a leaf, or any external signer, is `getAccount(0)` (path = the
 *   signer's path, or 'external'); other indexes/paths throw `SignerError`.
 *
 * `getNamedAccount("alice.near", i)` binds account i's key to a named account.
 */
export class WalletManagerNear extends WalletManager<WalletAccountNear, NearConfig> {
  constructor(seedOrSigner: string | Uint8Array | Signer, config: NearConfig = {}) {
    super(seedOrSigner, config)
  }


  async getAccount(index = 0): Promise<WalletAccountNear> {
    return this.getAccountByPath(`${NEAR_BASE_PATH}/${index}'`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountNear> {
    const full = path.startsWith('m/') || path === 'external' ? path : `${NEAR_BASE_PATH}/${path}`
    if (full !== 'external' && !full.split('/').slice(1).every((s) => s.endsWith("'"))) throw new Error('In NEAR, every child path in a derivation path must be hardened.')
    const cached = this._accounts.get(full)
    if (cached) return cached
    const external = this.externalSigner()
    if (external) return this.fromSigner(external, full)
    return this.cachedAccount(full, () => {
      const signer = LocalSigner.leafFromSeed(this.seedBytes(), 'ed25519', full)
      return new WalletAccountNear(signer, signer.publicKey, full, this._config)
    })
  }

  /** The key of account `index`, bound to a named account that lists it as a full-access key. */
  async getNamedAccount(accountId: string, index = 0): Promise<WalletAccountNear> {
    return (await this.getAccount(index)).withAccountId(accountId)
  }

  /** Resolve `path` against an injected signer: the signer itself, or a child when it can derive there. */
  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountNear> {
    this.requireSigner('ed25519')
    let rel: string | undefined
    let key = 'external'
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { rel = path.slice(signer.path.length + 1); key = path }
      else throw new SignerError(`The injected signer sits at ${signer.path}; it cannot provide ${path}.`)
    } else if (path !== `${NEAR_BASE_PATH}/0'` && path !== 'external') {
      throw new SignerError(`An external signer has one account; ${path} is not derivable from it.`)
    }
    return this.signerAccount(key, signer, rel, (leaf, publicKey) => new WalletAccountNear(leaf, publicKey, key, this._config))
  }

  /** A read-only account for any account id, with this manager's config. */
  getReadOnlyAccount(accountId: string, publicKey?: Uint8Array | NearPublicKey): WalletAccountReadOnlyNear {
    return new WalletAccountReadOnlyNear(accountId, this._config, publicKey)
  }

  /** NEAR has one protocol gas price (`gas_price` RPC, yoctoNEAR per gas); it can rise ~1%/block, so fast = ×1.1. */
  async getFeeRates(): Promise<FeeRates> {
    const client = createClient(this._config)
    if (!client) throw new NetworkError('The wallet must be connected to a provider to read fee rates.')
    const price = await new NearRpc(client).gasPrice()
    return { slow: price, normal: price, fast: (price * 11n) / 10n }
  }

}
