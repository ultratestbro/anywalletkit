import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { addressFromPublicKey, toHexAddress } from './address.js'
import { DEFAULT_FEE_LIMIT_SUN, WalletAccountReadOnlyTron, hashMessage, isPrebuilt } from './read-only-account.js'
import type { TronConfig, TronRawTransaction, TronTransaction, TronTransferOptions } from './types.js'

export interface TronTransferResult extends TransferResult { activationFee?: bigint }

/**
 * Signing Tron account. Key is a Uint8Array zeroized by `dispose()`. The full node
 * builds `raw_data`; we sign `txID` (= sha256(raw_data)) with secp256k1 and broadcast.
 */
export class WalletAccountTron extends WalletAccountReadOnlyTron implements IWalletAccount {
  /** ref block / expiration come from the node, so building needs the network. */
  readonly needsNetwork = true
  readonly path: string
  readonly publicKey: Uint8Array
  private _privateKey: Uint8Array | undefined
  private _readOnly: WalletAccountReadOnlyTron | undefined

  constructor(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: TronConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this._privateKey = privateKey
    this.publicKey = publicKey
    this.path = path
  }

  /** Account index for the standard m/44'/195'/0'/0/i path. */
  get index(): number | undefined {
    const m = /^m\/44'\/195'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This account has been disposed.')
    return this._privateKey
  }

  /** TIP-191 message signature: 0x + r||s||(27 + recovery) hex — tronweb v2 encoding. */
  async sign(message: string | Uint8Array): Promise<string> {
    const sig = secp256k1.sign(hashMessage(message), this.key(), { prehash: false, format: 'recovered' })
    return '0x' + bytesToHex(sig.slice(1)) + (27 + sig[0]!).toString(16).padStart(2, '0')
  }

  /** Attach `signature: [r||s||recovery]` (recovery as 00/01, tronweb encoding). */
  signRaw(tx: TronRawTransaction): TronRawTransaction {
    const sig = secp256k1.sign(hexToBytes(tx.txID), this.key(), { prehash: false, format: 'recovered', lowS: true })
    return { ...tx, signature: [bytesToHex(sig.slice(1)) + sig[0]!.toString(16).padStart(2, '0')] }
  }

  private assertOwner(tx: TronRawTransaction): void {
    const owner = tx.raw_data?.contract?.[0]?.parameter?.value?.owner_address as string | undefined
    if (owner && toHexAddress(owner) !== this.addressHex) throw new Error('The transaction owner does not match the wallet account address.')
  }

  private async maxFeeCheck(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation${op === 'transfer' ? 's' : ''}.`)
  }

  /** Build (via the node) and sign; returns the signed transaction JSON as a string (broadcast-ready). */
  async signTransaction(tx: TronTransaction): Promise<string> {
    this.key()
    this.requireClient('sign transactions')
    const built = await this.buildTransaction(tx)
    this.assertOwner(built)
    if (this._config.transactionMaxFee !== undefined) await this.maxFeeCheck((await this.quoteTransaction(built)).fee, this._config.transactionMaxFee, 'transaction')
    return JSON.stringify(this.signRaw(built))
  }

  private async broadcast(signed: TronRawTransaction): Promise<string> {
    const r = await this.post<{ result?: boolean; txid?: string; code?: string; message?: string }>('/wallet/broadcasttransaction', signed, 'broadcast')
    if (r.result !== true) throw new Error(`Broadcast failed: ${r.code ?? ''} ${r.message ?? ''}`.trim())
    return r.txid ?? signed.txID
  }

  async sendTransaction(tx: TronTransaction | string): Promise<TronTransferResult> {
    this.key()
    this.requireClient('send transactions')
    const parsed: TronTransaction = typeof tx === 'string' ? (JSON.parse(tx) as TronRawTransaction) : tx
    let signed: TronRawTransaction
    if (isPrebuilt(parsed) && parsed.signature?.length) signed = parsed
    else {
      const built = await this.buildTransaction(parsed)
      this.assertOwner(built)
      signed = this.signRaw(built)
    }
    const { fee, activationFee } = await this.quoteTransaction(signed)
    await this.maxFeeCheck(fee, this._config.transactionMaxFee, 'transaction')
    return { hash: await this.broadcast(signed), fee, activationFee }
  }

  /** TRX (no `token`) or TRC-20 `transfer(address,uint256)`. */
  async transfer(o: TronTransferOptions): Promise<TronTransferResult> {
    this.key()
    this.requireClient('transfer tokens')
    if (!o.token) {
      const built = await this.buildTransaction({ to: o.recipient, value: o.amount })
      const { fee, activationFee } = await this.quoteTransaction(built)
      await this.maxFeeCheck(fee, this._config.transferMaxFee, 'transfer')
      return { hash: await this.broadcast(this.signRaw(built)), fee, activationFee }
    }
    const { fee } = await this.quoteTransfer(o)
    await this.maxFeeCheck(fee, this._config.transferMaxFee, 'transfer')
    const built = await this.buildTransaction({
      contractAddress: o.token, functionSelector: 'transfer(address,uint256)',
      parameters: this.trc20TransferParams(o.recipient, o.amount),
      options: { feeLimit: Number(fee) || DEFAULT_FEE_LIMIT_SUN, callValue: 0 },
    })
    return { hash: await this.broadcast(this.signRaw(built)), fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTron(this.address, this._config)
    return this._readOnly
  }

  dispose(): void {
    zeroize(this._privateKey)
    this._privateKey = undefined
  }
}
