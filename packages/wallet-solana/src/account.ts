import { LocalSigner, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult } from '@forgewallet/core'
import { compileTransaction, getAddressDecoder, getBase64EncodedWireTransaction, type SignatureBytes, type Transaction, type TransactionMessage } from '@solana/kit'
import { decodeWireTransaction } from './describe.js'
import { MessageIsTransactionError, isSolanaTransactionPayload } from './offchain.js'
import { WalletAccountReadOnlySolana, type SolanaPlan } from './read-only-account.js'
import type { SerializedCheck, SerializedTxGuard } from './serialized.js'
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
 * Signing Solana account. The account never touches a private key: every
 * signature is one `signer.sign(bytes, {scheme: 'ed25519', context})` call
 * over the compiled message bytes — a {@link LocalSigner} for seed wallets,
 * anything else (hardware, MPC, backend) through `externalSigner()`. No
 * WebCrypto anywhere, so it runs unchanged in Node and Hermes.
 *
 * Every broadcast goes through the same plan: hard checks (fee payer, burn
 * address, missing co-signers) → compute budget → simulation → fee guard →
 * sign → send. A failing step throws before the signer is asked for anything.
 */
export class WalletAccountSolana extends WalletAccountReadOnlySolana implements IWalletAccount {
  /** Blockhash and fee come from the network before signing. */
  readonly needsNetwork = true
  readonly path: string
  /** The signer's 32-byte ed25519 public key (needed synchronously for the address). */
  readonly publicKey: Uint8Array
  readonly signer: Signer
  private _readOnly: WalletAccountReadOnlySolana | undefined

  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: SolanaConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this.signer = requireCurve(signer, 'ed25519')
    this.publicKey = publicKey
    this.path = path
  }

  /** Back-compat: wrap a raw derived key in a {@link LocalSigner} (the account takes ownership; it cannot derive). */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: SolanaConfig = {}): WalletAccountSolana {
    return new WalletAccountSolana(LocalSigner.fromPrivateKey('ed25519', privateKey, publicKey, path), publicKey, path, config)
  }

  /** Account index for the standard m/44'/501'/i'/0' path. */
  get index(): number | undefined {
    const m = /^m\/44'\/501'\/(\d+)'\/0'$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  /**
   * Hex ed25519 signature over the raw message bytes (UTF-8 for a string; context `solana-offchain`).
   * Throws {@link MessageIsTransactionError} when the bytes are a Solana transaction this account
   * would sign for (see `isSolanaTransactionPayload`): that must go through `signTransaction`.
   */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    if (isSolanaTransactionPayload(bytes, this.publicKey)) throw new MessageIsTransactionError()
    return toHex(await this.signer.sign(bytes, { scheme: 'ed25519', context: 'solana-offchain' }))
  }

  /** Add this wallet's signature to a compiled transaction (other signatures are preserved). */
  async signCompiled(tx: Transaction): Promise<Transaction> {
    const sig = (await this.signer.sign(tx.messageBytes as unknown as Uint8Array, { scheme: 'ed25519', context: 'solana-message' })) as unknown as SignatureBytes
    return { ...tx, signatures: Object.freeze({ ...tx.signatures, [this.address]: sig }) } as Transaction
  }

  /** Compile and sign a message; returns the kit `Transaction` (for callers that want to inspect or co-sign). */
  async signTransactionMessage(msg: TransactionMessage): Promise<Transaction> {
    return this.signCompiled(compileTransaction(msg as never) as Transaction)
  }

  private maxFeeCheck(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  private async signPlan(plan: SolanaPlan): Promise<Transaction> {
    if (plan.transaction) {
      const mine = plan.transaction.signatures[this.address]
      const alreadySigned = mine !== null && mine !== undefined && (mine as Uint8Array).some((b) => b !== 0)
      return alreadySigned ? plan.transaction : this.signCompiled(plan.transaction)
    }
    return this.signCompiled(compileTransaction(plan.message as never) as Transaction)
  }

  /** Sign without broadcasting. Returns the base64 wire transaction. Simulation still runs (a reverting tx is refused). */
  async signTransaction(tx: SolanaTransaction): Promise<string> {
    const plan = await this.plan(tx)
    this.maxFeeCheck(plan.quote.fee, this._config.transactionMaxFee, 'transaction')
    return getBase64EncodedWireTransaction(await this.signPlan(plan))
  }

  private async broadcast(wire: string): Promise<string> {
    return this.requireRpc('send transactions').sendTransaction(wire as never, { encoding: 'base64', preflightCommitment: this._commitment }).send()
  }

  async sendTransaction(tx: SolanaTransaction): Promise<SolanaSendResult> {
    this.requireRpc('send transactions')
    const plan = await this.plan(tx)
    this.maxFeeCheck(plan.quote.fee, this._config.transactionMaxFee, 'transaction')
    const hash = await this.broadcast(getBase64EncodedWireTransaction(await this.signPlan(plan)))
    return { hash, fee: plan.quote.fee, quote: plan.quote }
  }

  /** SOL (no `token`), SPL or Token-2022 transfer; the recipient's ATA is created when missing. */
  async transfer(o: SolanaTransferOptions): Promise<SolanaSendResult> {
    this.requireRpc('transfer tokens')
    const plan = await this.planTransfer(o)
    this.maxFeeCheck(plan.quote.fee, this._config.transferMaxFee, 'transfer')
    const hash = await this.broadcast(getBase64EncodedWireTransaction(await this.signPlan(plan)))
    return { hash, fee: plan.quote.fee, quote: plan.quote }
  }

  /**
   * Sign and broadcast a provider-built transaction (base64 wire) after
   * {@link checkSerialized} proved it only does what `guard.expect` allows.
   * Signatures already present (other parties) are preserved.
   */
  async sendSerialized(base64: string, guard: SerializedTxGuard): Promise<SolanaSendResult & { check: SerializedCheck }> {
    this.requireRpc('send transactions')
    const check = await this.checkSerialized(base64, guard)
    this.maxFeeCheck(check.quote.fee, this._config.transactionMaxFee, 'transaction')
    const plan: SolanaPlan = { transaction: decodeWireTransaction(base64), quote: check.quote, simulation: check.simulation, description: check.description }
    const hash = await this.broadcast(getBase64EncodedWireTransaction(await this.signPlan(plan)))
    return { hash, fee: check.quote.fee, quote: check.quote, check }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlySolana(this.address, this._config)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this.signer.dispose()
  }
}
