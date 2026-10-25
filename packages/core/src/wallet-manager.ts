import type { IWalletAccount } from './account.js'
import type { FeeRates } from './account.js'
import { isSeedSigner, requireCurve, type Signer, type SignerCurve } from './signer.js'
import { SignerError } from './errors.js'
import { copyBytes, getRandomSeedPhrase, isValidSeedPhrase, normalizeMnemonic, seedFromMnemonicSync, zeroize } from './mnemonic.js'

/** Seeds of every manager, outside the objects (see the class comment). */
const MANAGER_SEEDS = new WeakMap<object, Uint8Array>()
/** Managers whose `dispose()` ran: kept outside the object, like the seed. */
const DISPOSED = new WeakSet<object>()

/**
 * Base for chain packages. Holds either the 64-byte BIP-39 seed (local seed
 * signers derive from it) or an external Signer, derives accounts by index or
 * path, and zeroizes on dispose.
 *
 * A mnemonic passed as a string is stretched to the seed bytes right here and
 * the string is not kept: JS strings cannot be zeroized, `Uint8Array`s can.
 * A 64-byte seed passed as bytes is COPIED (the caller zeroizes its own).
 * Keep the mnemonic's own lifetime short on the calling side (read it, build
 * the manager, drop the reference) — or build from a `Signer` and never hand
 * the words to the SDK at all (see `@anywalletkit/keyring`).
 *
 * The seed is never an own property: it lives in a module WeakMap, so logging
 * or serializing a manager shows no secret.
 */
export abstract class WalletManager<TAccount extends IWalletAccount, TConfig extends object = Record<string, never>> {
  protected readonly _signer: Signer | undefined
  protected readonly _config: TConfig
  protected readonly _accounts = new Map<string, TAccount>()
  private readonly _pending = new Map<string, Promise<TAccount>>()

  constructor(seedOrSigner: string | Uint8Array | Signer, config: TConfig) {
    if (typeof seedOrSigner === 'string') {
      if (!isValidSeedPhrase(seedOrSigner)) throw new Error('Invalid seed phrase.')
      MANAGER_SEEDS.set(this, seedFromMnemonicSync(normalizeMnemonic(seedOrSigner)))
    } else if (seedOrSigner instanceof Uint8Array) {
      if (seedOrSigner.length !== 64) throw new Error(`A BIP-39 seed is 64 bytes; got ${seedOrSigner.length}.`)
      MANAGER_SEEDS.set(this, copyBytes(seedOrSigner))
    } else {
      this._signer = seedOrSigner
    }
    this._config = config
  }

  /** The 64-byte seed this manager derives from; throws for a Signer-built or disposed manager. */
  protected seedBytes(): Uint8Array {
    const seed = MANAGER_SEEDS.get(this)
    if (!seed) throw new SignerError(this._signer ? 'This manager was built from a Signer, not a seed phrase.' : 'This manager has been disposed.')
    return seed
  }

  /** Same as the core {@link isValidSeedPhrase}. */
  static isValidSeedPhrase(seed: string): boolean {
    return isValidSeedPhrase(seed)
  }

  /** Same as the core {@link getRandomSeedPhrase}. */
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
  /** Current network fee rates at three speeds. */
  abstract getFeeRates(): Promise<FeeRates>

  /**
   * The account cached under `key`, built by `create` at most once: concurrent calls share one
   * build. Throws once the manager is disposed; an account whose build finishes after `dispose()`
   * is disposed itself and the call throws, so no live signing account outlives the manager.
   */
  protected async cachedAccount(key: string, create: () => TAccount | Promise<TAccount>): Promise<TAccount> {
    if (DISPOSED.has(this)) throw new SignerError('This manager has been disposed.')
    const cached = this._accounts.get(key)
    if (cached) return cached
    const pending = this._pending.get(key)
    if (pending) return pending
    const build = (async () => {
      const account = await create()
      if (DISPOSED.has(this)) {
        account.dispose()
        throw new SignerError('This manager was disposed while the account was being created.')
      }
      this._accounts.set(key, account)
      return account
    })()
    this._pending.set(key, build)
    try {
      return await build
    } finally {
      this._pending.delete(key)
    }
  }

  /**
   * {@link cachedAccount} over an injected signer: the signer itself (`relativePath` undefined) or
   * its child along `relativePath`. A child that never becomes an account is disposed.
   */
  protected signerAccount(key: string, signer: Signer, relativePath: string | undefined, build: (leaf: Signer, publicKey: Uint8Array) => TAccount): Promise<TAccount> {
    return this.cachedAccount(key, async () => {
      let leaf: Signer = signer
      if (relativePath !== undefined) {
        if (!isSeedSigner(signer)) throw new SignerError('This signer cannot derive children.')
        leaf = await (signer.deriveLeaf ?? signer.derive).call(signer, relativePath)
      }
      try {
        return build(leaf, await leaf.getPublicKey())
      } catch (err) {
        if (leaf !== signer) leaf.dispose()
        throw err
      }
    })
  }

  /** Dispose every derived account and zeroize the seed; subclasses zeroize their own extras first, then call super. */
  dispose(): void {
    DISPOSED.add(this)
    for (const account of this._accounts.values()) account.dispose()
    this._accounts.clear()
    this._signer?.dispose()
    zeroize(MANAGER_SEEDS.get(this))
    MANAGER_SEEDS.delete(this)
  }
}
