import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { compileTransaction, getAddressDecoder, getBase64EncodedWireTransaction, type SignatureBytes, type Transaction, type TransactionMessage } from '@solana/kit'
import { WalletAccountReadOnlySolana, isSignedTransaction } from './read-only-account.js'
import type { SolanaConfig, SolanaTransaction, SolanaTransferOptions } from './types.js'

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

export function addressFromPublicKey(publicKey: Uint8Array): string {
  return getAddressDecoder().decode(publicKey)
}

/**
 * Signing Solana account. Signatures come from noble ed25519 over the compiled
 * message bytes — no WebCrypto, so it runs unchanged in Node, browsers and Hermes.
 * The key is a Uint8Array zeroized by `dispose()`.
 */
export class WalletAccountSolana extends WalletAccountReadOnlySolana implements IWalletAccount {
  /** Blockhash and fee come from the network before signing. */
  readonly needsNetwork = true
  readonly path: string
  readonly publicKey: Uint8Array
  private _privateKey: Uint8Array | undefined
  private _readOnly: WalletAccountReadOnlySolana | undefined

  constructor(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: SolanaConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this._privateKey = privateKey
    this.publicKey = publicKey
    this.path = path
  }

  /** Account index for the standard m/44'/501'/i'/0' path. */
  get index(): number | undefined {
    const m = /^m\/44'\/501'\/(\d+)'\/0'$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This account has been disposed.')
    return this._privateKey
  }

  /** Hex ed25519 signature over the UTF-8 message. */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    return toHex(ed25519.sign(bytes, this.key()))
  }

  /** Compile and sign a message; returns the kit `Transaction` (for callers that want to inspect or co-sign). */
  async signTransactionMessage(msg: TransactionMessage): Promise<Transaction> {
    const compiled = compileTransaction(msg as never) as Transaction
    const sig = ed25519.sign(compiled.messageBytes as unknown as Uint8Array, this.key()) as unknown as SignatureBytes
    return { ...compiled, signatures: Object.freeze({ ...compiled.signatures, [this.address]: sig }) } as Transaction
  }

  private async maxFeeCheck(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /** Sign without broadcasting. Returns the base64 wire transaction. */
  async signTransaction(tx: SolanaTransaction): Promise<string> {
    this.key()
    if (isSignedTransaction(tx)) return getBase64EncodedWireTransaction(tx)
    const msg = await this.prepareMessage(tx)
    if (this._config.transactionMaxFee !== undefined) await this.maxFeeCheck(await this.feeForMessage(msg), this._config.transactionMaxFee, 'transaction')
    return getBase64EncodedWireTransaction(await this.signTransactionMessage(msg))
  }

  private async broadcast(wire: string): Promise<string> {
    return this.requireRpc('send transactions').sendTransaction(wire as never, { encoding: 'base64', preflightCommitment: this._commitment }).send()
  }

  async sendTransaction(tx: SolanaTransaction): Promise<TransferResult> {
    this.key()
    this.requireRpc('send transactions')
    if (isSignedTransaction(tx)) {
      const { fee } = await this.quoteSendTransaction(tx)
      await this.maxFeeCheck(fee, this._config.transactionMaxFee, 'transaction')
      return { hash: await this.broadcast(getBase64EncodedWireTransaction(tx)), fee }
    }
    const msg = await this.prepareMessage(tx)
    const fee = await this.feeForMessage(msg)
    await this.maxFeeCheck(fee, this._config.transactionMaxFee, 'transaction')
    const hash = await this.broadcast(getBase64EncodedWireTransaction(await this.signTransactionMessage(msg)))
    return { hash, fee }
  }

  /** SOL (no `token`) or SPL transfer; the recipient's ATA is created when missing. */
  async transfer(o: SolanaTransferOptions): Promise<TransferResult> {
    this.key()
    this.requireRpc('transfer tokens')
    const msg = o.token ? await this.buildSplTransfer(o.token, o.recipient, o.amount) : await this.buildNativeTransfer(o.recipient, o.amount)
    const fee = await this.feeForMessage(msg)
    await this.maxFeeCheck(fee, this._config.transferMaxFee, 'transfer')
    const hash = await this.broadcast(getBase64EncodedWireTransaction(await this.signTransactionMessage(msg)))
    return { hash, fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlySolana(this.address, this._config)
    return this._readOnly
  }

  dispose(): void {
    zeroize(this._privateKey)
    this._privateKey = undefined
  }
}
