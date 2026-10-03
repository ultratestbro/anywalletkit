import { WalletManager, deriveSecp256k1, seedFromMnemonicSync, zeroize, type FeeRates, type Signer } from '@forgewallet/core'
import { WalletAccountEvm } from './account.js'
import { WalletAccountReadOnlyEvm } from './read-only-account.js'
import type { EvmConfig } from './types.js'

export const EVM_BASE_PATH = "m/44'/60'/0'/0"

/**
 * One seed → EVM accounts at m/44'/60'/0'/0/i (BIP-44, identical to
 * MetaMask / ethers defaults). The 64-byte BIP-39 seed is held for the life of
 * the manager and zeroized on `dispose()`.
 */
export class WalletManagerEvm extends WalletManager<WalletAccountEvm, EvmConfig> {
  private _seedBytes: Uint8Array | undefined

  constructor(seedOrSigner: string | Signer, config: EvmConfig = {}) {
    super(seedOrSigner, config)
    if (this._seed !== undefined) this._seedBytes = seedFromMnemonicSync(this._seed)
  }

  async getAccount(index = 0): Promise<WalletAccountEvm> {
    return this.getAccountByPath(`${EVM_BASE_PATH}/${index}`)
  }

  async getAccountByPath(path: string): Promise<WalletAccountEvm> {
    const cached = this._accounts.get(path)
    if (cached) return cached
    if (!this._seedBytes) throw new Error('External signers for EVM arrive in a later phase; construct WalletManagerEvm with a seed phrase.')
    const { privateKey, publicKey } = deriveSecp256k1(this._seedBytes, path)
    const account = new WalletAccountEvm(privateKey, publicKey, path, this._config)
    this._accounts.set(path, account)
    return account
  }

  /** Watch-only account for any address, sharing this manager's provider config. */
  getReadOnlyAccount(address: string): WalletAccountReadOnlyEvm {
    return new WalletAccountReadOnlyEvm(address, this._config)
  }

  /** Fee multipliers: normal = feeRate × 1.0, fast = × 1.2. We add slow = × 0.8 for completeness. */
  async getFeeRates(): Promise<FeeRates> {
    const probe = new WalletAccountReadOnlyEvm('0x0000000000000000000000000000000000000000', this._config)
    const normal = await probe.getFeeRate()
    return { slow: (normal * 80n) / 100n, normal, fast: (normal * 120n) / 100n }
  }

  override dispose(): void {
    super.dispose()
    zeroize(this._seedBytes)
    this._seedBytes = undefined
  }
}
