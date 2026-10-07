import type { IWalletAccount } from './account.js'
import type { FeeRates } from './account.js'
import { requireCurve, type Signer, type SignerCurve } from './signer.js'
import { SignerError } from './errors.js'
import { getRandomSeedPhrase, isValidSeedPhrase, normalizeMnemonic } from './mnemonic.js'

/**
 * Base for chain packages. Holds either a mnemonic (local seed signer) or an
 * external Signer, derives accounts by index or path, and zeroizes on dispose.
 */
export abstract class WalletManager<TAccount extends IWalletAccount, TConfig extends object = Record<string, never>> {
  protected readonly _seed: string | undefined
  protected readonly _signer: Signer | undefined
  protected readonly _config: TConfig
  protected readonly _accounts = new Map<string, TAccount>()

  constructor(seedOrSigner: string | Signer, config: TConfig) {
    if (typeof seedOrSigner === 'string') {
      if (!isValidSeedPhrase(seedOrSigner)) throw new Error('Invalid seed phrase.')
      this._seed = normalizeMnemonic(seedOrSigner)
    } else {
      this._signer = seedOrSigner
    }
    this._config = config
  }

  static isValidSeedPhrase(seed: string): boolean {
    return isValidSeedPhrase(seed)
  }

  static getRandomSeedPhrase(words: 12 | 24 = 24): string {
    return getRandomSeedPhrase(words)
  }

  /** The Signer this manager was built with, if any (no mnemonic then). Chain managers decide how to turn it into accounts. */
  protected externalSigner(): Signer | undefined {
    return this._signer
  }

  /** The external signer, asserted to sign on `curve`; throws when the manager holds a mnemonic instead. */
  protected requireSigner(curve: SignerCurve): Signer {
    if (!this._signer) throw new SignerError('This manager was built from a seed phrase, not a Signer.')
    return requireCurve(this._signer, curve)
  }

  /** Account `index` on the chain's standard path. Cached per index. */
  abstract getAccount(index?: number): Promise<TAccount>
  /** Account at an explicit path. Cached per path. */
  abstract getAccountByPath(path: string): Promise<TAccount>
  abstract getFeeRates(): Promise<FeeRates>

  /** Dispose every derived account; subclasses zeroize their own extras first, then call super. */
  dispose(): void {
    for (const account of this._accounts.values()) account.dispose()
    this._accounts.clear()
    this._signer?.dispose()
  }
}
