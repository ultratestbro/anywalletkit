import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
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
 * Signing Tron account. Key is a Uint8Array zeroized by `dispose()`. The full node
 * builds `raw_data`; we check it, simulate it, sign `txID` (= sha256(raw_data)) with
 * secp256k1 and broadcast.
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

  /** TIP-191 message signature: 0x + r||s||(27 + recovery) hex (tronweb `signMessageV2` encoding). */
  async sign(message: string | Uint8Array): Promise<string> {
    const sig = secp256k1.sign(hashMessage(message), this.key(), { prehash: false, format: 'recovered' })
    return '0x' + bytesToHex(sig.slice(1)) + (27 + sig[0]!).toString(16).padStart(2, '0')
  }

  /** Attach `signature: [r||s||recovery]` (recovery as 00/01, tronweb encoding). No checks — see `signTransaction`. */
  signRaw(tx: TronRawTransaction): TronRawTransaction {
    const sig = secp256k1.sign(hexToBytes(tx.txID), this.key(), { prehash: false, format: 'recovered', lowS: true })
    return { ...tx, signature: [bytesToHex(sig.slice(1)) + sig[0]!.toString(16).padStart(2, '0')] }
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
    const { built, quote } = await this.prepare(parsed, this._config.transactionMaxFee, 'transaction')
    const signed = isPrebuilt(parsed) && parsed.signature?.length ? built : this.signRaw(built)
    return { hash: await this.broadcast(signed), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  /** TRX (no `token`) or TRC-20 `transfer(address,uint256)`. */
  async transfer(o: TronTransferOptions): Promise<TronTransferResult> {
    this.key()
    this.requireClient('transfer tokens')
    const { built, quote } = await this.prepare(this.asTransaction(o), this._config.transferMaxFee, 'transfer')
    return { hash: await this.broadcast(this.signRaw(built)), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
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
