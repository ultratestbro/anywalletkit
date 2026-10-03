import { WalletManager, deriveEd25519, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountSolana } from './account.js'
import { WalletAccountReadOnlySolana } from './read-only-account.js'
import type { SolanaConfig } from './types.js'

export const SOLANA_BASE_PATH = "m/44'/501'"
const DEFAULT_BASE_FEE = 5_000n

/**
 * One seed → Solana accounts at m/44'/501'/i'/0' (SLIP-10 ed25519; Phantom,
 * Solflare default). Paths may be given relative to m/44'/501' ("0'/0'")
 * or in full.
 */
export class WalletManagerSolana extends WalletManager<WalletAccountSolana, SolanaConfig> {
  private _seedBytes: Uint8Array | undefined

  constructor(seedOrSigner: string | Signer, config: SolanaConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  async getAccount(index = 0): Promise<WalletAccountSolana> {
    return this.getAccountByPath(`${SOLANA_BASE_PATH}/${index}'/0'`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountSolana> {
    const full = path.startsWith('m/') ? path : `${SOLANA_BASE_PATH}/${path}`
    if (!full.split('/').slice(1).every((s) => s.endsWith("'"))) throw new Error('In Solana, every child path in a derivation path must be hardened.')
    const cached = this._accounts.get(full)
    if (cached) return cached
    if (!this._seedBytes) throw new Error('External signers for Solana arrive in a later phase; construct WalletManagerSolana with a seed phrase.')
    const { privateKey, publicKey } = deriveEd25519(this._seedBytes, full)
    const account = new WalletAccountSolana(privateKey, publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
  }

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

  override dispose(): void {
    super.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
  }
}
