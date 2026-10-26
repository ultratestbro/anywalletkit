import { LocalSigner, SignerError, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { bytesToBase58, ed25519Key, implicitAccountId, publicKeyToString } from './address.js'
import { decodeAnyTransaction, encodeSignedTransaction } from './borsh.js'
import { BroadcastUnknownError, MessageIsTransactionError, SimulationError } from './errors.js'
import { nep413Hash, type Nep413Payload, type Nep413Signed } from './nep413.js'
import { WalletAccountReadOnlyNear, receiptOf } from './read-only-account.js'
import { fromBase64, isDefinitive, outcomeFailed, toBase64 } from './rpc.js'
import type { NearBuiltTransaction, NearConfig, NearFeeEstimate, NearSignedTransaction, NearTransaction, NearTransferOptions } from './types.js'

export interface NearTransferResult extends TransferResult {
  estimate?: NearFeeEstimate
}

/**
 * Signing NEAR account. The key lives in an ed25519 {@link Signer} (a local key
 * zeroized by `dispose()`, or an external hardware / MPC / backend signer). The
 * account builds the transaction (nonce + block hash from the node), checks it,
 * runs the preflight, has the signer sign sha256(borsh(tx)) (context `near-tx`)
 * and broadcasts it with `send_tx`.
 *
 * By default the account id is the implicit one (hex of the public key). Pass
 * `accountId` for a named account whose full-access key this is.
 */
export class WalletAccountNear extends WalletAccountReadOnlyNear implements IWalletAccount {
  /** nonce / block hash come from the node, so building needs the network. */
  readonly needsNetwork = true
  /** Derivation path, or `external` for an external signer. */
  readonly path: string
  /** The signer that holds the key. */
  readonly signer: Signer
  private _disposed = false
  private _readOnly: WalletAccountReadOnlyNear | undefined

  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: NearConfig = {}, accountId?: string) {
    super(accountId ?? implicitAccountId(publicKey), config, ed25519Key(publicKey))
    this.signer = requireCurve(signer, 'ed25519')
    this.path = path
  }

  /** Wrap a raw derived key (takes ownership; zeroized on dispose). */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: NearConfig = {}, accountId?: string): WalletAccountNear {
    return new WalletAccountNear(LocalSigner.fromPrivateKey('ed25519', privateKey, publicKey, path), publicKey, path, config, accountId)
  }

  /** Account index for the standard m/44'/397'/i' path. */
  get index(): number | undefined {
    const m = /^m\/44'\/397'\/(\d+)'$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  /** The same key bound to a named account (`alice.near`) that lists it as a full-access key. */
  withAccountId(accountId: string): WalletAccountNear {
    return new WalletAccountNear(this.signer, this.publicKey.data, this.path, this._config, accountId)
  }

  private key(): void {
    if (this._disposed) throw new SignerError('This account has been disposed.')
  }

  private async signBytes(bytes: Uint8Array, context: 'near-tx' | 'near-message' | 'near-nep413'): Promise<Uint8Array> {
    this.key()
    return this.signer.sign(bytes, { scheme: 'ed25519', context })
  }

  /**
   * Raw ed25519 signature over the message bytes, as NEAR tooling prints it: "ed25519:<base58>".
   * A 32-byte message — string or bytes — is refused with {@link MessageIsTransactionError}: a NEAR
   * transaction is signed over its 32-byte sha256, so those bytes could be one. Sites asking a
   * wallet to sign a message use {@link signNep413}.
   */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    if (bytes.length === 32) throw new MessageIsTransactionError()
    return `ed25519:${bytesToBase58(await this.signBytes(bytes, 'near-message'))}`
  }

  /** NEP-413 off-chain message (what NEAR Intents and dApps ask wallets to sign). */
  async signNep413(payload: Nep413Payload): Promise<Nep413Signed> {
    const sig = await this.signBytes(nep413Hash(payload), 'near-nep413')
    return { signature: toBase64(sig), publicKey: publicKeyToString(this.publicKey), accountId: this.address }
  }

  /** Sign a fully built transaction. No checks — see `signTransaction`. */
  async signBuilt(tx: NearBuiltTransaction): Promise<NearSignedTransaction> {
    const sig = await this.signBytes(WalletAccountReadOnlyNear.hashOf(tx), 'near-tx')
    return { transaction: tx, signature: { keyType: 'ed25519', data: sig } }
  }

  /** Build → hard checks → preflight → fee cap. Shared by sign / send / transfer. */
  private async prepare(tx: NearTransaction | string, maxFee: bigint | number | undefined, op: string): Promise<{ built: NearBuiltTransaction; estimate: NearFeeEstimate }> {
    const built = await this.buildTransaction(tx)
    this.assertSafe(built)
    const estimate = await this.estimate(built)
    this.assertSafe(built, estimate.fee)
    if (maxFee !== undefined && estimate.fee > BigInt(maxFee)) throw new Error(`Exceeded maximum fee cost for ${op} operation${op === 'transfer' ? 's' : ''}.`)
    if (this._config.simulate !== false) {
      const sim = await this.simulateTransaction(built, estimate)
      if (!sim.ok) throw new SimulationError(sim.reason ?? 'unknown')
    }
    return { built, estimate }
  }

  /** Build, check, preflight and sign; returns the signed transaction as base64 borsh (what `send_tx` takes). */
  async signTransaction(tx: NearTransaction | string, options: WriteOptions = {}): Promise<string> {
    this.key()
    this.requireRpc('sign transactions')
    const { built } = await this.prepare(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return toBase64(encodeSignedTransaction(await this.signBuilt(built)))
  }

  private async broadcast(signed: NearSignedTransaction): Promise<string> {
    const hash = WalletAccountReadOnlyNear.txHash(signed.transaction)
    const rpc = this.requireRpc('broadcast')
    let outcome: Awaited<ReturnType<typeof rpc.sendTx>>
    try {
      outcome = await rpc.sendTx(toBase64(encodeSignedTransaction(signed)))
    } catch (e) {
      // A definitive refusal (invalid nonce, invalid tx…) is a clean failure; no answer or a node timeout may still land.
      if (isDefinitive(e)) throw e
      throw new BroadcastUnknownError(hash, e)
    }
    const failure = outcomeFailed(outcome)
    if (failure) throw new Error(`Transaction ${hash} failed on chain: ${failure}`)
    return outcome.transaction?.hash ?? hash
  }

  /**
   * Sign and broadcast. Accepts a transaction, or base64 borsh of an unsigned /
   * already-signed transaction (a signed one is checked, not re-signed).
   */
  async sendTransaction(tx: NearTransaction | string, options: WriteOptions = {}): Promise<NearTransferResult> {
    this.key()
    this.requireRpc('send transactions')
    const presigned = typeof tx === 'string' ? decodeSigned(tx) : undefined
    const { built, estimate } = await this.prepare(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    const signed = presigned ?? (await this.signBuilt(built))
    return { hash: await this.broadcast(signed), fee: estimate.fee, estimate }
  }

  /** Native NEAR (no `token`) or NEP-141 `ft_transfer` (with `storage_deposit` when the recipient needs it). */
  async transfer(o: NearTransferOptions, writeOptions: WriteOptions = {}): Promise<NearTransferResult> {
    this.key()
    this.requireRpc('transfer tokens')
    const { built, estimate } = await this.prepare(await this.transferActions(o), feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
    return { hash: await this.broadcast(await this.signBuilt(built)), fee: estimate.fee, estimate }
  }

  /** The same account as a {@link WalletAccountReadOnlyNear}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyNear(this.address, this._config, this.publicKey)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this._disposed = true
    this.signer.dispose()
  }
}

function decodeSigned(b64: string): NearSignedTransaction | undefined {
  const { transaction, signature } = decodeAnyTransaction(fromBase64(b64))
  return signature ? { transaction, signature } : undefined
}

export { receiptOf }
