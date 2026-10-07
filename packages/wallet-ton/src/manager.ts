import { WalletManager, deriveEd25519, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { mnemonicToPrivateKey } from '@ton/crypto'
import { WalletAccountTon } from './account.js'
import { WalletAccountReadOnlyTon } from './read-only-account.js'
import type { TonConfig } from './types.js'

export const TON_BASE_PATH = "m/44'/607'"
/** Path label of the account a TON-native (Tonkeeper-style) mnemonic yields — there is exactly one. */
export const TON_MNEMONIC_PATH = 'ton-mnemonic'
const DEFAULT_TONAPI = 'https://tonapi.io/v2'

/**
 * One seed → TON accounts at m/44'/607'/i' (SLIP-10 ed25519) on Wallet V5R1 —
 * the derivation Trust Wallet and Ledger use for a BIP-39 phrase. Paths
 * may be relative to m/44'/607' ("0'") or full.
 *
 * Tonkeeper-style 24-word TON mnemonics (not BIP-39) are imported with
 * {@link WalletManagerTon.fromTonMnemonic}; they yield one account.
 */
export class WalletManagerTon extends WalletManager<WalletAccountTon, TonConfig> {
  private _seedBytes: Uint8Array | undefined
  private _tonKey: { privateKey: Uint8Array; publicKey: Uint8Array } | undefined

  constructor(seedOrSigner: string | Signer, config: TonConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  /**
   * Import a TON-native mnemonic (24 words, Tonkeeper / Tonhub / MyTonWallet
   * default): PBKDF2 per @ton/crypto, one ed25519 key, one V5R1 account at
   * path `ton-mnemonic` with the address those wallets show.
   */
  static async fromTonMnemonic(words: string[] | string, config: TonConfig = {}): Promise<WalletManagerTon> {
    const list = (Array.isArray(words) ? words : words.trim().split(/\s+/)).map((w) => w.toLowerCase())
    if (list.length !== 24) throw new Error('A TON mnemonic has 24 words.')
    const pair = await mnemonicToPrivateKey(list)
    const privateKey = new Uint8Array(pair.secretKey.subarray(0, 32)) // nacl secret key = seed || public key
    const publicKey = new Uint8Array(pair.publicKey)
    zeroize(new Uint8Array(pair.secretKey.buffer, pair.secretKey.byteOffset, pair.secretKey.byteLength))
    const manager = new WalletManagerTon(keySigner(privateKey, publicKey), config)
    manager._tonKey = { privateKey, publicKey }
    return manager
  }

  async getAccount(index = 0): Promise<WalletAccountTon> {
    if (this._tonKey) {
      if (index !== 0) throw new Error('A TON mnemonic yields a single account (index 0).')
      return this.getAccountByPath(TON_MNEMONIC_PATH)
    }
    return this.getAccountByPath(`${TON_BASE_PATH}/${index}'`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountTon> {
    if (this._tonKey) {
      if (path !== TON_MNEMONIC_PATH) throw new Error(`A TON mnemonic yields a single account at path '${TON_MNEMONIC_PATH}'.`)
      const cached = this._accounts.get(path)
      if (cached) return cached
      const account = new WalletAccountTon(this._tonKey.privateKey, this._tonKey.publicKey, path, this._config)
      this._accounts.set(path, account)
      return account
    }
    const full = path.startsWith('m/') ? path : `${TON_BASE_PATH}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    if (!this._seedBytes) throw new Error('External signers for TON arrive in a later phase; construct WalletManagerTon with a seed phrase.')
    const { privateKey, publicKey } = deriveEd25519(this._seedBytes, full)
    const account = new WalletAccountTon(privateKey, publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
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

  override dispose(): void {
    super.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
    if (this._tonKey) { zeroize(this._tonKey.privateKey); this._tonKey = undefined }
  }
}

/** Minimal ed25519 Signer over a raw key, so the base WalletManager can hold a mnemonic-less wallet. */
function keySigner(privateKey: Uint8Array, publicKey: Uint8Array): Signer {
  let key: Uint8Array | undefined = privateKey
  return {
    kind: 'external',
    curve: 'ed25519',
    async getPublicKey() { return publicKey },
    async sign(payload) {
      if (!key) throw new Error('Signer disposed.')
      return ed25519.sign(payload, key)
    },
    dispose() { zeroize(key); key = undefined },
  }
}
