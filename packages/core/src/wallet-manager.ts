import type { IWalletAccount } from './account.js'
import type { FeeRates } from './account.js'
import { requireCurve, type Signer, type SignerCurve } from './signer.js'
import { SignerError } from './errors.js'
import { getRandomSeedPhrase, isValidSeedPhrase, normalizeMnemonic, seedFromMnemonicSync, zeroize } from './mnemonic.js'

/**
 * Base for chain packages. Holds either the 64-byte BIP-39 seed (local seed
 * signers derive from it) or an external Signer, derives accounts by index or
 * path, and zeroizes on dispose.
 *
 * A mnemonic passed as a string is stretched to the seed bytes right here and
 * the string is not kept: JS strings cannot be zeroized, `Uint8Array`s can.
 * Keep the mnemonic's own lifetime short on the calling side (read it, build
 * the manager, drop the reference) — or build from a `Signer` and never hand
 * the words to the SDK at all (see `@forgewallet/keyring`).
 */
export abstract class WalletManager<TAccount extends IWalletAccount, TConfig extends object = Record<string, never>> {
  private _seedBytes: Uint8Array | undefined
  protected readonly _signer: Signer | undefined
  protected readonly _config: TConfig
  protected readonly _accounts = new Map<string, TAccount>()

  constructor(seedOrSigner: string | Signer, config: TConfig) {
    if (typeof seedOrSigner === 'string') {
      if (!isValidSeedPhrase(seedOrSigner)) throw new Error('Invalid seed phrase.')
      this._seedBytes = seedFromMnemonicSync(normalizeMnemonic(seedOrSigner))
    } else {
      this._signer = seedOrSigner
    }
    this._config = config
  }

  /** The 64-byte seed this manager derives from; throws for a Signer-built or disposed manager. */
  protected seedBytes(): Uint8Array {
    if (!this._seedBytes) throw new SignerError(this._signer ? 'This manager was built from a Signer, not a seed phrase.' : 'This manager has been disposed.')
    return this._seedBytes
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

  /** Dispose every derived account and zeroize the seed; subclasses zeroize their own extras first, then call super. */
  dispose(): void {
    for (const account of this._accounts.values()) account.dispose()
    this._accounts.clear()
    this._signer?.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
  }
}
