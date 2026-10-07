import { LocalSigner, SignerError, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult } from '@forgewallet/core'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { addressFromPublicKey, toHexAddress } from './address.js'
import { describeTransaction } from './describe.js'
import { SimulationError, UnsafeTransactionError } from './errors.js'
import { WalletAccountReadOnlyTron, hashMessage } from './read-only-account.js'
import { isPrebuilt } from './shape.js'
import type { TronConfig, TronFeeEstimate, TronRawTransaction, TronSimulation, TronTransaction, TronTransferOptions } from './types.js'

export interface TronTransferResult extends TransferResult {
  /** Account creation fee included in `fee` (TRX transfer to a new account). */
  activationFee?: bigint
  estimate?: TronFeeEstimate
}

/** Longest expiration the node accepts for a transaction (`Constant.MAXIMUM_TIME_UNTIL_EXPIRATION`). */
export const MAX_EXPIRATION_MS = 24 * 60 * 60 * 1000

/**
 * Signing Tron account. The key lives in a secp256k1 {@link Signer} (a local key
 * zeroized by `dispose()`, or an external hardware / MPC / backend signer). The
 * full node builds `raw_data`; we check it, simulate it, have the signer sign
 * `txID` (= sha256(raw_data)) as recoverable ECDSA (context `tron-tx`) and broadcast.
 */
export class WalletAccountTron extends WalletAccountReadOnlyTron implements IWalletAccount {
  /** ref block / expiration come from the node, so building needs the network. */
  readonly needsNetwork = true
  readonly path: string
  /** Compressed secp256k1 key (33 bytes); needed synchronously for the address. */
  readonly publicKey: Uint8Array
  readonly signer: Signer
  private _disposed = false
  private _readOnly: WalletAccountReadOnlyTron | undefined

  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: TronConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this.signer = requireCurve(signer, 'secp256k1')
    this.publicKey = publicKey
    this.path = path
  }

  /** Wrap a raw derived key (takes ownership; zeroized on dispose). Kept for callers that derive themselves. */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: TronConfig = {}): WalletAccountTron {
    return new WalletAccountTron(LocalSigner.fromPrivateKey('secp256k1', privateKey, publicKey, path), publicKey, path, config)
  }

  /** Account index for the standard m/44'/195'/0'/0/i path. */
  get index(): number | undefined {
    const m = /^m\/44'\/195'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): void {
    if (this._disposed) throw new SignerError('This account has been disposed.')
  }

  /** Recoverable secp256k1 signature over a 32-byte digest from the signer: r‖s‖recovery (recovery 0/1). */
  private async signDigest(digest: Uint8Array, context: 'tron-tx' | 'tron-message'): Promise<Uint8Array> {
    this.key()
    return this.signer.sign(digest, { scheme: 'ecdsa-recoverable', context })
  }

  /** TIP-191 message signature: 0x + r||s||(27 + recovery) hex (tronweb `signMessageV2` encoding). */
  async sign(message: string | Uint8Array): Promise<string> {
    const sig = await this.signDigest(hashMessage(message), 'tron-message')
    return '0x' + bytesToHex(sig.subarray(0, 64)) + (27 + sig[64]!).toString(16).padStart(2, '0')
  }

  /** Attach `signature: [r||s||recovery]` (recovery as 00/01, tronweb encoding). No checks — see `signTransaction`. */
  async signRaw(tx: TronRawTransaction): Promise<TronRawTransaction> {
    const sig = await this.signDigest(hexToBytes(tx.txID), 'tron-tx')
    return { ...tx, signature: [bytesToHex(sig.subarray(0, 64)) + sig[64]!.toString(16).padStart(2, '0')] }
  }

  // ── Hard checks (before anything is signed) ─────────────────────────────────

  /**
   * Refuse to sign what cannot be right: a foreign owner, a missing or expired
   * (or >24h) expiration, no ref block, more than one contract, a TRX / TRC-20
   * transfer to the zero address (unless `allowBurn`), a `fee_limit` above
   * `transactionMaxFee`.
   */
  protected assertSafe(tx: TronRawTransaction, now = Date.now()): void {
    const contracts = tx.raw_data?.contract ?? []
    if (contracts.length !== 1) throw new UnsafeTransactionError('multi-contract', `Expected exactly one contract in the transaction, got ${contracts.length}.`)
    const owner = contracts[0]?.parameter?.value?.owner_address as string | undefined
    if (!owner || toHexAddress(owner) !== this.addressHex) throw new UnsafeTransactionError('owner-mismatch', 'The transaction owner does not match the wallet account address.')
    if (!tx.raw_data.ref_block_bytes || !tx.raw_data.ref_block_hash) throw new UnsafeTransactionError('missing-ref-block', 'The transaction has no reference block (ref_block_bytes / ref_block_hash).')
    const exp = tx.raw_data.expiration
    if (exp === undefined || exp <= now) throw new UnsafeTransactionError('expired', 'The transaction has no expiration or has already expired.')
    if (exp > now + MAX_EXPIRATION_MS) throw new UnsafeTransactionError('expiration-too-far', 'The transaction expiration is more than 24 hours away.')
    const max = this._config.transactionMaxFee
    if (max !== undefined && tx.raw_data.fee_limit !== undefined && BigInt(tx.raw_data.fee_limit) > BigInt(max)) {
      throw new UnsafeTransactionError('fee-limit', `fee_limit ${tx.raw_data.fee_limit} exceeds transactionMaxFee ${max}.`)
    }
    if (!this._config.allowBurn) {
      const d = describeTransaction(tx, { now })
      if (d.warnings.some((w) => w.code === 'zero-address')) throw new UnsafeTransactionError('zero-address', 'Refusing to send to the zero address (set allowBurn to override).')
    }
  }

  private maxFeeCheck(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation${op === 'transfer' ? 's' : ''}.`)
  }

  /** Build → hard checks → simulate → estimate → fee cap. Shared by sign / send / transfer. */
  private async prepare(tx: TronTransaction, maxFee: bigint | number | undefined, op: string) {
    const { built, sim: fromBuild } = await this.buildWithSimulation(tx)
    this.assertSafe(built)
    let sim: TronSimulation | undefined = fromBuild
    if (this._config.simulate !== false) {
      sim ??= await this.simulateRaw(built)
      if (!sim.ok) throw new SimulationError(sim.reason ?? 'unknown', sim.energy)
    }
    const quote = await this.quoteTransaction(built, sim)
    this.maxFeeCheck(quote.fee, maxFee, op)
    return { built, quote }
  }

  /** Build (via the node), check, simulate and sign; returns broadcast-ready transaction JSON. */
  async signTransaction(tx: TronTransaction): Promise<string> {
    this.key()
    this.requireClient('sign transactions')
    const { built } = await this.prepare(tx, this._config.transactionMaxFee, 'transaction')
    return JSON.stringify(await this.signRaw(built))
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
    const { built, quote } = await this.prepare(parsed, this._config.transactionMaxFee, 'transaction')
    const signed = isPrebuilt(parsed) && parsed.signature?.length ? built : await this.signRaw(built)
    return { hash: await this.broadcast(signed), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  /** TRX (no `token`) or TRC-20 `transfer(address,uint256)`. */
  async transfer(o: TronTransferOptions): Promise<TronTransferResult> {
    this.key()
    this.requireClient('transfer tokens')
    const { built, quote } = await this.prepare(this.asTransaction(o), this._config.transferMaxFee, 'transfer')
    return { hash: await this.broadcast(await this.signRaw(built)), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTron(this.address, this._config)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this._disposed = true
    this.signer.dispose()
  }
}
