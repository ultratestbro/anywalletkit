import { LocalSigner, SignerError, WalletManager, isSeedSigner, zeroize, type FeeRates, type Signer } from '@anywalletkit/core'
import { mnemonicToPrivateKey, mnemonicValidate } from '@ton/crypto'
import { WalletAccountTon } from './account.js'
import { WalletAccountReadOnlyTon } from './read-only-account.js'
import type { TonConfig } from './types.js'

/** Base derivation path for BIP-39 seeds; account `i` is at `m/44'/607'/i'`. */
export const TON_BASE_PATH = "m/44'/607'"
/** Path label of the account a TON-native (Tonkeeper-style) mnemonic yields — there is exactly one. */
export const TON_MNEMONIC_PATH = 'ton-mnemonic'
import { DEFAULT_TONAPI } from './emulation.js'

/**
 * One seed → TON accounts at m/44'/607'/i' (SLIP-10 ed25519) on Wallet V5R1 —
 * the derivation Trust Wallet and Ledger use for a BIP-39 phrase. Paths
 * may be relative to m/44'/607' ("0'") or full.
 *
 * Built with an ed25519 `Signer` instead of a seed, the manager wraps it:
 * - a derivable `SeedSigner` sitting at `m/44'/607'` yields `getAccount(i)` → `i'` children;
 * - a `SeedSigner` at a leaf, or any external signer, is `getAccount(0)` (path = the
 *   signer's path, or 'external'); other indexes/paths throw.
 *
 * Tonkeeper-style 24-word TON mnemonics (not BIP-39) are imported with
 * {@link WalletManagerTon.fromTonMnemonic}; they yield one account at `ton-mnemonic`.
 */
export class WalletManagerTon extends WalletManager<WalletAccountTon, TonConfig> {
  constructor(seedOrSigner: string | Uint8Array | Signer, config: TonConfig = {}) {
    super(seedOrSigner, config)
  }


  /**
   * Import a TON-native mnemonic (24 words, Tonkeeper / Tonhub / MyTonWallet
   * default): PBKDF2 per @ton/crypto, one ed25519 key, one V5R1 account at
   * path `ton-mnemonic` with the address those wallets show.
   */
  static async fromTonMnemonic(words: string[] | string, config: TonConfig = {}): Promise<WalletManagerTon> {
    const list = (Array.isArray(words) ? words : words.trim().split(/\s+/)).map((w) => w.toLowerCase())
    if (list.length !== 24) throw new Error('A TON mnemonic has 24 words.')
    // TON mnemonics carry their own check: a typo (or a BIP-39 phrase) would derive another, empty wallet.
    if (!(await mnemonicValidate(list))) throw new Error('Not a valid TON mnemonic: check the words (a typo would open a different, empty wallet).')
    const pair = await mnemonicToPrivateKey(list)
    const privateKey = new Uint8Array(pair.secretKey.subarray(0, 32)) // nacl secret key = seed || public key
    const publicKey = new Uint8Array(pair.publicKey)
    zeroize(new Uint8Array(pair.secretKey.buffer, pair.secretKey.byteOffset, pair.secretKey.byteLength))
    return new WalletManagerTon(LocalSigner.fromPrivateKey('ed25519', privateKey, publicKey, TON_MNEMONIC_PATH), config)
  }

  async getAccount(index = 0): Promise<WalletAccountTon> {
    const external = this.externalSigner()
    if (external && !(isSeedSigner(external) && external.path === TON_BASE_PATH)) {
      // A leaf signer (TON mnemonic, hardware, MPC…) is exactly one account.
      if (index !== 0) throw new SignerError(`This signer yields a single account (index 0); ${index} is not derivable from it.`)
      return this.fromSigner(external, this.singlePath(external))
    }
    return this.getAccountByPath(`${TON_BASE_PATH}/${index}'`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountTon> {
    const external = this.externalSigner()
    if (external) {
      const single = this.singlePath(external)
      const full = path === single || path.startsWith('m/') ? path : `${TON_BASE_PATH}/${path}`
      return this.fromSigner(external, full)
    }
    const full = path.startsWith('m/') ? path : `${TON_BASE_PATH}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    return this.cachedAccount(full, () => {
      const signer = LocalSigner.leafFromSeed(this.seedBytes(), 'ed25519', full)
      return new WalletAccountTon(signer, signer.publicKey, full, this._config)
    })
  }

  /** The one path a non-derivable signer answers to: its own, or 'external'. */
  private singlePath(signer: Signer): string {
    return isSeedSigner(signer) ? signer.path : 'external'
  }

  /** Resolve `path` against an injected signer: the signer itself, or a child when it can derive there. */
  private async fromSigner(signer: Signer, path: string): Promise<WalletAccountTon> {
    this.requireSigner('ed25519')
    let rel: string | undefined
    let key = this.singlePath(signer)
    if (isSeedSigner(signer)) {
      if (path === signer.path) key = path
      else if (path.startsWith(`${signer.path}/`)) { rel = path.slice(signer.path.length + 1); key = path }
      else throw new SignerError(`This signer yields a single account at path '${signer.path}'; it cannot provide ${path}.`)
    } else if (path !== `${TON_BASE_PATH}/0'` && path !== 'external') {
      throw new SignerError(`An external signer yields a single account; ${path} is not derivable from it.`)
    }
    return this.signerAccount(key, signer, rel, (leaf, publicKey) => new WalletAccountTon(leaf, publicKey, key, this._config))
  }

  /** Watch-only account for a public key (hex or bytes) — TON addresses derive from the key, not the other way round. */
  getReadOnlyAccount(publicKey: Uint8Array | string): WalletAccountReadOnlyTon {
    return new WalletAccountReadOnlyTon(publicKey, this._config)
  }

  /** Gas price from config param 21 via tonapi (normal = fast there; slow = ×0.8 here). */
  async getFeeRates(): Promise<FeeRates> {
    const doFetch = this._config.fetch ?? globalThis.fetch
    const res = await doFetch(`${this._config.tonApiUrl ?? DEFAULT_TONAPI}/blockchain/config/raw`, { signal: AbortSignal.timeout(this._config.timeoutMs ?? 15_000) })
    const json = (await res.json()) as { config: { config_param21: { gas_limits_prices: { gas_flat_pfx: { other: { gas_prices_ext: { gas_price: number } } } } } } }
    const normal = BigInt(Math.round(json.config.config_param21.gas_limits_prices.gas_flat_pfx.other.gas_prices_ext.gas_price / 65_536))
    return { slow: (normal * 80n) / 100n, normal, fast: normal }
  }

}
