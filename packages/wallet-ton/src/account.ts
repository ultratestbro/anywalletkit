import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Buffer } from 'buffer'
import { Cell, type MessageRelaxed } from '@ton/ton'
import { SEND_MODE, WalletAccountReadOnlyTon } from './read-only-account.js'
import type { TonConfig, TonSendable, TonTransferOptions } from './types.js'

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Signing TON account on WalletContractV5R1. The 32-byte ed25519 seed is the
 * only key material (zeroized by `dispose()`); @ton/ton's `signer` callback
 * lets noble sign the message hash, so no 64-byte nacl secret key is ever built.
 */
export class WalletAccountTon extends WalletAccountReadOnlyTon implements IWalletAccount {
  /** seqno and fees come from the network before signing. */
  readonly needsNetwork = true
  readonly path: string
  private _privateKey: Uint8Array | undefined
  private _readOnly: WalletAccountReadOnlyTon | undefined

  constructor(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: TonConfig = {}) {
    super(publicKey, config)
    this._privateKey = privateKey
    this.path = path
  }

  /** Account index for the standard m/44'/607'/i' path. */
  get index(): number | undefined {
    const m = /^m\/44'\/607'\/(\d+)'$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This account has been disposed.')
    return this._privateKey
  }

  /** Hex ed25519 signature over the raw message bytes. */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    return toHex(ed25519.sign(bytes, this.key()))
  }

  /** Build and sign the V5R1 external-message body for `messages`. */
  protected async signedTransfer(messages: MessageRelaxed[]): Promise<Cell> {
    const contract = this.requireContract('sign transactions')
    const key = this.key()
    const seqno = await contract.getSeqno()
    return contract.createTransfer({
      seqno, sendMode: SEND_MODE, messages,
      signer: async (cell: Cell) => Buffer.from(ed25519.sign(cell.hash(), key)),
    })
  }

  private checkMaxFee(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /** Sign without broadcasting. Returns the external-message body as base64 BoC. */
  async signTransaction(tx: TonSendable): Promise<string> {
    const transfer = tx instanceof Cell ? tx : await this.signedTransfer([this.transactionMessage(tx)])
    if (this._config.transactionMaxFee !== undefined) this.checkMaxFee(await this.transferFee(transfer), this._config.transactionMaxFee, 'transaction')
    return transfer.toBoc().toString('base64')
  }

  /** Sign and broadcast; `hash` is the body hash (hex) — resolve it with getTransactionReceipt. */
  async sendTransaction(tx: TonSendable): Promise<TransferResult> {
    const contract = this.requireContract('send transactions')
    const transfer = tx instanceof Cell ? tx : await this.signedTransfer([this.transactionMessage(tx)])
    const fee = await this.transferFee(transfer)
    this.checkMaxFee(fee, this._config.transactionMaxFee, 'transaction')
    await contract.send(transfer)
    return { hash: transfer.hash().toString('hex'), fee }
  }

  /** TON (no `token`) or jetton transfer. */
  async transfer(o: TonTransferOptions): Promise<TransferResult> {
    const contract = this.requireContract('transfer tokens')
    const message = o.token ? await this.jettonTransferMessage(o) : this.transactionMessage({ to: o.recipient, value: o.amount })
    const transfer = await this.signedTransfer([message])
    const fee = await this.transferFee(transfer)
    this.checkMaxFee(fee, this._config.transferMaxFee, 'transfer')
    await contract.send(transfer)
    return { hash: transfer.hash().toString('hex'), fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTon(this.publicKey, this._config)
    return this._readOnly
  }

  dispose(): void {
    zeroize(this._privateKey)
    this._privateKey = undefined
  }
}
