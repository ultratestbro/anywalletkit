import { WalletManager, deriveSecp256k1, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountBtc } from './account.js'
import { WalletAccountReadOnlyBtc } from './read-only-account.js'
import type { BtcConfig } from './types.js'

/**
 * One seed → BIP-84 p2wpkh accounts at m/84'/0'/0'/0/i (mainnet) or m/84'/1'/0'/0/i
 * (testnet/regtest). Paths may be given relative to m/84'/coin'
 * ("0'/0/i"), or in full.
 */
export class WalletManagerBtc extends WalletManager<WalletAccountBtc, BtcConfig> {
  private _seedBytes: Uint8Array | undefined

  constructor(seedOrSigner: string | Signer, config: BtcConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  get basePath(): string {
    return `m/84'/${(this._config.network ?? 'bitcoin') === 'bitcoin' ? 0 : 1}'`
  }

  async getAccount(index = 0): Promise<WalletAccountBtc> {
    return this.getAccountByPath(`${this.basePath}/0'/0/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountBtc> {
    const full = path.startsWith('m/') ? path : `${this.basePath}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    if (!this._seedBytes) throw new Error('External signers for Bitcoin arrive in a later phase; construct WalletManagerBtc with a seed phrase.')
    const { privateKey, publicKey } = deriveSecp256k1(this._seedBytes, full)
    const account = new WalletAccountBtc(privateKey, publicKey, full, this._config)
    this._accounts.set(full, account)
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
    const big = (n: number) => BigInt(Math.max(Math.round(n), 1))
    return { slow: big(slow!), normal: big(normal!), fast: big(fast!) }
  }

  override dispose(): void {
    super.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
  }
}
