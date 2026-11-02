import { LocalSigner, SignerError, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { bytesToBase58, ed25519Key, implicitAccountId, publicKeyToString } from './address.js'
import { decodeAnyTransaction, decodeTransaction, encodeSignedTransaction, encodeTransaction } from './borsh.js'
import { BroadcastUnknownError, MessageIsTransactionError, SimulationError, UnsafeTransactionError } from './errors.js'
import { nep413Hash, type Nep413Payload, type Nep413Signed } from './nep413.js'
import { WalletAccountReadOnlyNear, assertWellFormed, receiptOf } from './read-only-account.js'
import { fromBase64, isDefinitiveBroadcast, outcomeFailed, toBase64 } from './rpc.js'
import type { NearBuiltTransaction, NearConfig, NearFeeEstimate, NearSignedTransaction, NearTransaction, NearTransferOptions } from './types.js'

/** Does `bytes` carry `key` anywhere? A Solana transaction names each signer's 32-byte key. */
const carriesKey = (bytes: Uint8Array, key: Uint8Array): boolean => {
  outer: for (let i = 0; i + key.length <= bytes.length; i++) {
    for (let j = 0; j < key.length; j++) if (bytes[i + j] !== key[j]) continue outer
    return true
  }
  return false
}

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
  /**
   * The signer that holds the key, in a private field: not a property of the account, so no code
   * the account is handed to (a protocol module, a logger) can reach it and sign around the
   * account's checks (audit 2026-10-29 A1).
   */
  readonly #signer: Signer
  /** What holds the key: `seed`, `key` (one imported key) or `external`. */
  readonly signerKind: Signer['kind']
  private _disposed = false
  private _readOnly: WalletAccountReadOnlyNear | undefined
  /**
   * Highest nonce this account has broadcast (accepted, or maybe sent). The access key is read at
   * `final`, which lags the block that holds our last transaction, so a second send right after
   * the first would sign the same nonce and be refused. A filled-in nonce is never below it + 1;
   * NEAR only needs nonces to increase, so a gap left by a transaction that never landed is harmless.
   */
  private _nonceFloor: bigint | undefined
  /** Tail of this account's send queue: prepare → sign → broadcast runs one send at a time. */
  private _sendTail: Promise<unknown> = Promise.resolve()

  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: NearConfig = {}, accountId?: string) {
    super(accountId ?? implicitAccountId(publicKey), config, ed25519Key(publicKey))
    this.#signer = requireCurve(signer, 'ed25519')
    this.signerKind = this.#signer.kind
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
    return new WalletAccountNear(this.#signer, this.publicKey.data, this.path, this._config, accountId)
  }

  private key(): void {
    if (this._disposed) throw new SignerError('This account has been disposed.')
  }

  async #signBytes(bytes: Uint8Array, context: 'near-tx' | 'near-message' | 'near-nep413'): Promise<Uint8Array> {
    this.key()
    return this.#signer.sign(bytes, { scheme: 'ed25519', context })
  }

  /**
   * Raw ed25519 signature over the message bytes, as NEAR tooling prints it: "ed25519:<base58>".
   * A 32-byte message — string or bytes — is refused with {@link MessageIsTransactionError}: a NEAR
   * transaction is signed over its 32-byte sha256, so those bytes could be one. Bytes that carry
   * this account's public key are refused as well: one ed25519 key (an external signer) may also be
   * a Solana wallet, and a Solana transaction names its signer's key. Sites asking a wallet to sign
   * a message use {@link signNep413}.
   */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    if (bytes.length === 32 || carriesKey(bytes, this.publicKey.data)) throw new MessageIsTransactionError()
    return `ed25519:${bytesToBase58(await this.#signBytes(bytes, 'near-message'))}`
  }

  /** NEP-413 off-chain message (what NEAR Intents and dApps ask wallets to sign). */
  async signNep413(payload: Nep413Payload): Promise<Nep413Signed> {
    const sig = await this.#signBytes(nep413Hash(payload), 'near-nep413')
    return { signature: toBase64(sig), publicKey: publicKeyToString(this.publicKey), accountId: this.address }
  }

  /**
   * Sign a fully built transaction. It gets the same hard checks as `signTransaction` (this
   * account's signer and key, no dangerous action unless `allowDangerousActions`, gas limit) but
   * no node round-trip: no preflight and no fee check.
   */
  async signBuilt(tx: NearBuiltTransaction): Promise<NearSignedTransaction> {
    const own = this.#ownCopy(tx)
    this.assertSafe(own)
    return this.#signChecked(own)
  }

  /**
   * A plain copy of `tx`, decoded from its borsh bytes: the object the checks read is the one that
   * gets hashed and signed, whatever the caller does with its own object (a getter, or an array
   * changed while a node call is awaited).
   */
  #ownCopy(tx: NearBuiltTransaction): NearBuiltTransaction {
    let copy: NearBuiltTransaction
    try {
      copy = decodeTransaction(encodeTransaction(tx))
    } catch (e) {
      this.assertSafe(tx)
      throw new UnsafeTransactionError('non-canonical', `Not an encodable NEAR transaction: ${(e as Error).message}`)
    }
    return copy
  }

  /** Sign a transaction that has already been through `assertSafe`. */
  async #signChecked(tx: NearBuiltTransaction): Promise<NearSignedTransaction> {
    assertWellFormed(tx)
    const sig = await this.#signBytes(WalletAccountReadOnlyNear.hashOf(tx), 'near-tx')
    return { transaction: tx, signature: { keyType: 'ed25519', data: sig } }
  }

  /** Build → hard checks → preflight → fee cap. Shared by sign / send / transfer. */
  private async prepare(tx: NearTransaction | string, maxFee: bigint | number | undefined, op: string): Promise<{ built: NearBuiltTransaction; estimate: NearFeeEstimate }> {
    let built = await this.buildTransaction(tx)
    // A nonce the caller set (or a serialized transaction) is theirs; a filled-in one clears our last broadcast.
    if (typeof tx !== 'string' && tx.nonce === undefined && this._nonceFloor !== undefined && built.nonce <= this._nonceFloor) {
      built = { ...built, nonce: this._nonceFloor + 1n }
    }
    // From here on the checks, the preflight and the signature all read our own copy, not the caller's actions.
    built = this.#ownCopy(built)
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
    return toBase64(encodeSignedTransaction(await this.#signChecked(built)))
  }

  private async broadcast(signed: NearSignedTransaction): Promise<string> {
    const hash = WalletAccountReadOnlyNear.txHash(signed.transaction)
    const rpc = this.requireRpc('broadcast')
    const used = (): void => {
      const n = signed.transaction.nonce
      if (this._nonceFloor === undefined || n > this._nonceFloor) this._nonceFloor = n
    }
    let outcome: Awaited<ReturnType<typeof rpc.sendTx>>
    try {
      outcome = await rpc.sendTx(toBase64(encodeSignedTransaction(signed)))
    } catch (e) {
      // A known refusal (invalid nonce, invalid tx, unparsable request) is a clean failure; no answer,
      // a node timeout or an unnamed gateway error may still land.
      if (isDefinitiveBroadcast(e)) throw e
      used()
      throw new BroadcastUnknownError(hash, e)
    }
    used()
    const failure = outcomeFailed(outcome)
    if (failure) throw new Error(`Transaction ${hash} failed on chain: ${failure}`)
    return outcome.transaction?.hash ?? hash
  }

  /**
   * Sign and broadcast. Accepts a transaction, or base64 borsh of an unsigned /
   * already-signed transaction (a signed one is checked, not re-signed).
   */
  sendTransaction(tx: NearTransaction | string, options: WriteOptions = {}): Promise<NearTransferResult> {
    return this.#serial(() => this.#sendTransactionNow(tx, options))
  }

  async #sendTransactionNow(tx: NearTransaction | string, options: WriteOptions): Promise<NearTransferResult> {
    this.key()
    this.requireRpc('send transactions')
    const presigned = typeof tx === 'string' ? decodeSigned(tx) : undefined
    const { built, estimate } = await this.prepare(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    const signed = presigned ?? (await this.#signChecked(built))
    return { hash: await this.broadcast(signed), fee: estimate.fee, estimate }
  }

  /** Native NEAR (no `token`) or NEP-141 `ft_transfer` (with `storage_deposit` when the recipient needs it). */
  transfer(o: NearTransferOptions, writeOptions: WriteOptions = {}): Promise<NearTransferResult> {
    return this.#serial(() => this.#transferNow(o, writeOptions))
  }

  async #transferNow(o: NearTransferOptions, writeOptions: WriteOptions): Promise<NearTransferResult> {
    this.key()
    this.requireRpc('transfer tokens')
    const { built, estimate } = await this.prepare(await this.transferActions(o), feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
    return { hash: await this.broadcast(await this.#signChecked(built)), fee: estimate.fee, estimate }
  }

  /**
   * One send at a time per account: two sends started together would read the same access-key
   * nonce before either is broadcast. A failed send does not block the next.
   */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this._sendTail.then(run)
    this._sendTail = next.then(() => undefined, () => undefined)
    return next
  }

  /** The same account as a {@link WalletAccountReadOnlyNear}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyNear(this.address, this._config, this.publicKey)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this._disposed = true
    this.#signer.dispose()
  }
}

function decodeSigned(b64: string): NearSignedTransaction | undefined {
  const { transaction, signature } = decodeAnyTransaction(fromBase64(b64))
  return signature ? { transaction, signature } : undefined
}

export { receiptOf }
