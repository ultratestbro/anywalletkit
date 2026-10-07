import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { compileTransaction, getAddressDecoder, getBase64EncodedWireTransaction, type SignatureBytes, type Transaction, type TransactionMessage } from '@solana/kit'
import { WalletAccountReadOnlySolana, type SolanaPlan } from './read-only-account.js'
import type { SolanaConfig, SolanaFeeQuote, SolanaTransaction, SolanaTransferOptions } from './types.js'

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

export function addressFromPublicKey(publicKey: Uint8Array): string {
  return getAddressDecoder().decode(publicKey)
}

/** `TransferResult` plus the full fee breakdown. */
export interface SolanaSendResult extends TransferResult {
  quote: SolanaFeeQuote
}

/**
 * Signing Solana account. Signatures come from noble ed25519 over the compiled
 * message bytes — no WebCrypto, so it runs unchanged in Node and Hermes. The
 * key is a Uint8Array zeroized by `dispose()`.
 *
 * Every broadcast goes through the same plan: hard checks (fee payer, burn
 * address, missing co-signers) → compute budget → simulation → fee guard →
 * sign → send. A failing step throws before the key is used.
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

  /** Add this wallet's signature to a compiled transaction (other signatures are preserved). */
  signCompiled(tx: Transaction): Transaction {
    const sig = ed25519.sign(tx.messageBytes as unknown as Uint8Array, this.key()) as unknown as SignatureBytes
    return { ...tx, signatures: Object.freeze({ ...tx.signatures, [this.address]: sig }) } as Transaction
  }

  /** Compile and sign a message; returns the kit `Transaction` (for callers that want to inspect or co-sign). */
  async signTransactionMessage(msg: TransactionMessage): Promise<Transaction> {
    return this.signCompiled(compileTransaction(msg as never) as Transaction)
  }

  private maxFeeCheck(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  private signPlan(plan: SolanaPlan): Transaction {
    if (plan.transaction) {
      const mine = plan.transaction.signatures[this.address]
      const alreadySigned = mine !== null && mine !== undefined && (mine as Uint8Array).some((b) => b !== 0)
      return alreadySigned ? plan.transaction : this.signCompiled(plan.transaction)
    }
    return this.signCompiled(compileTransaction(plan.message as never) as Transaction)
  }

  /** Sign without broadcasting. Returns the base64 wire transaction. Simulation still runs (a reverting tx is refused). */
  async signTransaction(tx: SolanaTransaction): Promise<string> {
    this.key()
    const plan = await this.plan(tx)
    this.maxFeeCheck(plan.quote.fee, this._config.transactionMaxFee, 'transaction')
    return getBase64EncodedWireTransaction(this.signPlan(plan))
  }

  private async broadcast(wire: string): Promise<string> {
    return this.requireRpc('send transactions').sendTransaction(wire as never, { encoding: 'base64', preflightCommitment: this._commitment }).send()
  }

  async sendTransaction(tx: SolanaTransaction): Promise<SolanaSendResult> {
    this.key()
    this.requireRpc('send transactions')
    const plan = await this.plan(tx)
    this.maxFeeCheck(plan.quote.fee, this._config.transactionMaxFee, 'transaction')
    const hash = await this.broadcast(getBase64EncodedWireTransaction(this.signPlan(plan)))
    return { hash, fee: plan.quote.fee, quote: plan.quote }
  }

  /** SOL (no `token`), SPL or Token-2022 transfer; the recipient's ATA is created when missing. */
  async transfer(o: SolanaTransferOptions): Promise<SolanaSendResult> {
    this.key()
    this.requireRpc('transfer tokens')
    const plan = await this.planTransfer(o)
    this.maxFeeCheck(plan.quote.fee, this._config.transferMaxFee, 'transfer')
    const hash = await this.broadcast(getBase64EncodedWireTransaction(this.signPlan(plan)))
    return { hash, fee: plan.quote.fee, quote: plan.quote }
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
