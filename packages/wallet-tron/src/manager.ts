import { WalletManager, deriveSecp256k1, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountTron } from './account.js'
import { WalletAccountReadOnlyTron } from './read-only-account.js'
import type { TronConfig } from './types.js'

export const TRON_BASE_PATH = "m/44'/195'"

/**
 * One seed → Tron accounts at m/44'/195'/0'/0/i (BIP-44; TronLink default).
 * Paths may be relative to m/44'/195' ("0'/0/3") or full.
 */
export class WalletManagerTron extends WalletManager<WalletAccountTron, TronConfig> {
  private _seedBytes: Uint8Array | undefined

  constructor(seedOrSigner: string | Signer, config: TronConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  async getAccount(index = 0): Promise<WalletAccountTron> {
    return this.getAccountByPath(`${TRON_BASE_PATH}/0'/0/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountTron> {
    const full = path.startsWith('m/') ? path : `${TRON_BASE_PATH}/${path}`
    const cached = this._accounts.get(full)
    if (cached) return cached
    if (!this._seedBytes) throw new Error('External signers for Tron arrive in a later phase; construct WalletManagerTron with a seed phrase.')
    const { privateKey, publicKey } = deriveSecp256k1(this._seedBytes, full)
    const account = new WalletAccountTron(privateKey, publicKey, full, this._config)
    this._accounts.set(full, account)
    return account
  }

  getReadOnlyAccount(address: string): WalletAccountReadOnlyTron {
    return new WalletAccountReadOnlyTron(address, this._config)
  }

  /** Fee from the getTransactionFee chain parameter; normal = ×1.1, fast = ×2.0; slow = ×1.0. */
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
