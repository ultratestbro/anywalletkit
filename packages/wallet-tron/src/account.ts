import { LocalSigner, SignerError, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { addressFromPublicKey, toHexAddress } from './address.js'
import { describeTransaction } from './describe.js'
import { BroadcastUnknownError, SimulationError, UnsafeTransactionError } from './errors.js'
import { assertNoError } from './client.js'
import { WalletAccountReadOnlyTron, hashMessage } from './read-only-account.js'
import { isDecodedContractType, verifyRawTransaction } from './raw.js'
import { isPrebuilt } from './shape.js'
import type { TronConfig, TronFeeEstimate, TronRawTransaction, TronSimulation, TronTransaction, TronTransferOptions } from './types.js'

export interface TronTransferResult extends TransferResult {
  /** Account creation fee included in `fee` (TRX transfer to a new account). */
  activationFee?: bigint
  estimate?: TronFeeEstimate
}

/**
 * Contract types the wallet has no field decoder for but signs anyway: they move nothing and change
 * no rights. A `VoteWitnessContract` re-assigns the account's votes (Stake 2.0 voting dApps).
 */
const UNDECODED_BUT_SAFE: ReadonlySet<string> = new Set(['VoteWitnessContract'])

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
  /** Derivation path, or `external` for an external signer. */
  readonly path: string
  /** Compressed secp256k1 key (33 bytes); needed synchronously for the address. */
  readonly publicKey: Uint8Array
  /** The signer that holds the key. */
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
  async #signDigest(digest: Uint8Array, context: 'tron-tx' | 'tron-message'): Promise<Uint8Array> {
    this.key()
    return this.signer.sign(digest, { scheme: 'ecdsa-recoverable', context })
  }

  /** TIP-191 message signature: 0x + r||s||(27 + recovery) hex (tronweb `signMessageV2` encoding). */
  async sign(message: string | Uint8Array): Promise<string> {
    const sig = await this.#signDigest(hashMessage(message), 'tron-message')
    return '0x' + bytesToHex(sig.subarray(0, 64)) + (27 + sig[64]!).toString(16).padStart(2, '0')
  }

  /**
   * Sign a prebuilt transaction (ours or a dApp's) and attach `signature: [r||s||recovery]`
   * (recovery as 00/01, tronweb encoding). The signature covers `sha256(raw_data_hex)`, so
   * that is what is checked and signed: `txID` must equal it, the JSON `raw_data` must agree
   * with the bytes field by field, and the hard checks ({@link assertSafe}) run on the bytes.
   * A transaction whose JSON says "1 TRX to me" while the bytes say otherwise is refused
   * (`raw-mismatch`), as is a `txID` that does not belong to the bytes (`txid-mismatch`).
   * `fee_limit` is held to the tighter of `transactionMaxFee` and `options.maxFee` (round 3, M8).
   * Signatures already on the transaction (a multisig co-signer's) are kept; ours is added once (L11).
   */
  async signRaw(tx: TronRawTransaction, options: WriteOptions = {}): Promise<TronRawTransaction> {
    this.key()
    const verified = verifyRawTransaction(tx)
    this.assertSafe({ ...tx, raw_data: verified.raw_data }, Date.now(), options.maxFee)
    const sig = await this.#signDigest(hexToBytes(verified.txID), 'tron-tx')
    const mine = bytesToHex(sig.subarray(0, 64)) + sig[64]!.toString(16).padStart(2, '0')
    const others = (tx.signature ?? []).filter((s) => s.toLowerCase() !== mine)
    return { ...tx, signature: [...others, mine] }
  }

  // ── Hard checks (before anything is signed) ─────────────────────────────────

  /**
   * Refuse to sign what cannot be right: a foreign owner, a missing or expired
   * (or >24h) expiration, no ref block, more than one contract, a TRX / TRC-20
   * transfer to the zero address (unless `allowBurn`), a `fee_limit` above
   * `transactionMaxFee` or the call's cap (`limit`), an `AccountPermissionUpdateContract` (unless
   * `allowPermissionChanges`), a contract type the wallet cannot decode (unless
   * `allowUndecodedContracts`; `VoteWitnessContract` only re-assigns votes and passes).
   */
  protected assertSafe(tx: TronRawTransaction, now = Date.now(), limit?: bigint | number): void {
    const contracts = tx.raw_data?.contract ?? []
    if (contracts.length !== 1) throw new UnsafeTransactionError('multi-contract', `Expected exactly one contract in the transaction, got ${contracts.length}.`)
    const owner = contracts[0]?.parameter?.value?.owner_address as string | undefined
    if (!owner || toHexAddress(owner) !== this.addressHex) throw new UnsafeTransactionError('owner-mismatch', 'The transaction owner does not match the wallet account address.')
    const type = String(contracts[0]!.type)
    if (type === 'AccountPermissionUpdateContract') {
      if (this._config.allowPermissionChanges !== true) throw new UnsafeTransactionError('permission-change', 'AccountPermissionUpdateContract changes which keys control this account: signing it can hand the account to someone else. Set allowPermissionChanges to sign one.')
    } else if (!isDecodedContractType(type) && !UNDECODED_BUT_SAFE.has(type) && this._config.allowUndecodedContracts !== true) {
      throw new UnsafeTransactionError('undecoded-contract', `The wallet cannot decode a ${type}, so it cannot tell what it does (some of these move TRX or tokens). Set allowUndecodedContracts to sign one.`)
    }
    if (!tx.raw_data.ref_block_bytes || !tx.raw_data.ref_block_hash) throw new UnsafeTransactionError('missing-ref-block', 'The transaction has no reference block (ref_block_bytes / ref_block_hash).')
    const exp = tx.raw_data.expiration
    if (exp === undefined || exp <= now) throw new UnsafeTransactionError('expired', 'The transaction has no expiration or has already expired.')
    if (exp > now + MAX_EXPIRATION_MS) throw new UnsafeTransactionError('expiration-too-far', 'The transaction expiration is more than 24 hours away.')
    const max = feeLimit(this._config.transactionMaxFee, limit === undefined ? {} : { maxFee: BigInt(limit) })
    if (max !== undefined && tx.raw_data.fee_limit !== undefined && BigInt(tx.raw_data.fee_limit) > max) {
      throw new UnsafeTransactionError('fee-limit', `fee_limit ${tx.raw_data.fee_limit} exceeds the fee cap of ${max}.`)
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
    // The fee_limit the SDK derives for its own call is capped by the caller's cap too (round 3, M8).
    const { built, sim: fromBuild } = await this.buildWithSimulation(tx, maxFee)
    // A caller-supplied transaction is checked against its bytes before anything else looks at it.
    this.assertSafe(isPrebuilt(tx) ? { ...built, raw_data: verifyRawTransaction(built).raw_data } : built, Date.now(), maxFee)
    let sim: TronSimulation | undefined = fromBuild
    if (this._config.simulate !== false) {
      sim ??= await this.simulateRaw(built)
      if (!sim.ok) throw new SimulationError(sim.reason ?? 'unknown', sim.energy)
    }
    const quote = await this.quoteTransaction(built, sim)
    this.maxFeeCheck(quote.fee, maxFee, op)
    // What the signed transaction may burn at worst: fee_limit of energy, plus the bandwidth, memo and
    // activation fees fee_limit does not cover. That is what the cap must hold (round 3, M8).
    if (maxFee !== undefined && built.raw_data.fee_limit !== undefined) {
      const other = quote.fee - quote.estimate.breakdown.energyBurn
      const worst = BigInt(built.raw_data.fee_limit) + other
      if (worst > BigInt(maxFee)) throw new UnsafeTransactionError('fee-limit', `fee_limit ${built.raw_data.fee_limit} plus ${other} sun of bandwidth, memo and activation fees can burn ${worst}, above the fee cap of ${maxFee}.`)
    }
    return { built, quote }
  }

  /** Build (via the node), check, simulate and sign; returns broadcast-ready transaction JSON. */
  async signTransaction(tx: TronTransaction, options: WriteOptions = {}): Promise<string> {
    this.key()
    this.requireClient('sign transactions')
    const { built } = await this.prepare(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return JSON.stringify(await this.signRaw(built))
  }

  private async broadcast(signed: TronRawTransaction): Promise<string> {
    const client = this.requireClient('broadcast')
    let r: { result?: boolean; txid?: string; code?: string; message?: string }
    try {
      r = (await client('/wallet/broadcasttransaction', signed)) as typeof r
    } catch (e) {
      // No node answered (timeouts, dropped connections on every provider): the bytes may be in the network.
      throw new BroadcastUnknownError(signed.txID, e)
    }
    // The network already holds these bytes: an earlier attempt (a lost answer, a failed-over node) delivered them.
    if (r?.code === 'DUP_TRANSACTION_ERROR') return signed.txID
    assertNoError(r, 'broadcast')
    if (r.result !== true) throw new Error(`Broadcast failed: ${r.code ?? ''} ${r.message ?? ''}`.trim())
    return r.txid ?? signed.txID
  }

  async sendTransaction(tx: TronTransaction | string, options: WriteOptions = {}): Promise<TronTransferResult> {
    this.key()
    this.requireClient('send transactions')
    const parsed: TronTransaction = typeof tx === 'string' ? (JSON.parse(tx) as TronRawTransaction) : tx
    const { built, quote } = await this.prepare(parsed, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    const signed = isPrebuilt(parsed) && parsed.signature?.length ? built : await this.signRaw(built)
    return { hash: await this.broadcast(signed), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  /** TRX (no `token`) or TRC-20 `transfer(address,uint256)`. */
  async transfer(o: TronTransferOptions, writeOptions: WriteOptions = {}): Promise<TronTransferResult> {
    this.key()
    this.requireClient('transfer tokens')
    const { built, quote } = await this.prepare(this.asTransaction(o), feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
    return { hash: await this.broadcast(await this.signRaw(built)), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  /** The same address as a {@link WalletAccountReadOnlyTron}. */
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
