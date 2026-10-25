import { LocalSigner, SignerError, WalletManager, isSeedSigner, type FeeRates, type Signer } from '@anywalletkit/core'
import { WalletAccountSolana } from './account.js'
import { WalletAccountReadOnlySolana } from './read-only-account.js'
import type { SolanaConfig } from './types.js'

/** Base derivation path; account `i` is at `m/44'/501'/i'/0'` (Phantom, Solflare). */
export const SOLANA_BASE_PATH = "m/44'/501'"
const DEFAULT_BASE_FEE = 5_000n

/**
 * One seed → Solana accounts at m/44'/501'/i'/0' (SLIP-10 ed25519; Phantom and
 * Solflare default). Paths may be given relative to m/44'/501' ("0'/0'") or in full.
 *
 * Built with an ed25519 `Signer` instead of a seed, the manager wraps it:
 * - a derivable `SeedSigner` sitting at `m/44'/501'` yields `getAccount(i)` → `i'/0'` children
 *   (any path under the signer's path derives);
 * - a `SeedSigner` at a leaf, or any external signer, is `getAccount(0)` (path = the
 *   signer's path, or 'external'); other indexes/paths throw `SignerError`.
 */
export class WalletManagerSolana extends WalletManager<WalletAccountSolana, SolanaConfig> {
  constructor(seedOrSigner: string | Uint8Array | Signer, config: SolanaConfig = {}) {
    super(seedOrSigner, config)
  }


  async getAccount(index = 0): Promise<WalletAccountSolana> {
    return this.getAccountByPath(`${SOLANA_BASE_PATH}/${index}'/0'`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountSolana> {
    const full = path.startsWith('m/') ? path : `${SOLANA_BASE_PATH}/${path}`
    if (!full.split('/').slice(1).every((s) => s.endsWith("'"))) throw new Error('In Solana, every child path in a derivation path must be hardened.')
    const cached = this._accounts.get(full)
    if (cached) return cached
    const external = this.externalSigner()
    if (external) return this.fromSigner(external, full)
    return this.cachedAccount(full, () => {
      const signer = LocalSigner.leafFromSeed(this.seedBytes(), 'ed25519', full)
      return new WalletAccountSolana(signer, signer.publicKey, full, this._config)
    })
  }

  /** Resolve `path` against an injected signer: the signer itself, or a child when it can derive there. */
  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountSolana> {
    this.requireSigner('ed25519')
    let rel: string | undefined
    let key = 'external'
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { rel = path.slice(signer.path.length + 1); key = path }
      else throw new SignerError(`The injected signer sits at ${signer.path}; it cannot provide ${path}.`)
    } else if (path !== `${SOLANA_BASE_PATH}/0'/0'` && path !== 'external') {
      throw new SignerError(`An external signer has one account; ${path} is not derivable from it.`)
    }
    return this.signerAccount(key, signer, rel, (leaf, publicKey) => new WalletAccountSolana(leaf, publicKey, key, this._config))
  }

  /** A read-only account for any address, with this manager's config. */
  getReadOnlyAccount(address: string): WalletAccountReadOnlySolana {
    return new WalletAccountReadOnlySolana(address, this._config)
  }

  /** Max recent prioritization fee (micro-lamports/CU); slow = ×0.8, fast = ×1.2. */
  async getFeeRates(): Promise<FeeRates> {
    const probe = new WalletAccountReadOnlySolana('11111111111111111111111111111111', this._config)
    const rpc = (probe as unknown as { requireRpc(w: string): { getRecentPrioritizationFees(): { send(): Promise<Array<{ prioritizationFee: bigint | number }>> } } }).requireRpc('get fee rates')
    const fees = (await rpc.getRecentPrioritizationFees().send()).map((f) => BigInt(f.prioritizationFee)).filter((f) => f > 0n)
    const normal = fees.length ? fees.reduce((a, b) => (b > a ? b : a), 0n) : DEFAULT_BASE_FEE
    return { slow: (normal * 80n) / 100n, normal, fast: (normal * 120n) / 100n }
  }

}
