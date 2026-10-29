import { LocalSigner, SignerError, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { addressFromPublicKey, toHexAddress } from './address.js'
import { describeTransaction } from './describe.js'
import { BroadcastUnknownError, SimulationError, UnsafeTransactionError } from './errors.js'
import { assertNoError } from './client.js'
import { WalletAccountReadOnlyTron, hashMessage } from './read-only-account.js'
import { isDecodedContractType, verifyRawTransaction } from './raw.js'
import { isPrebuilt } from './shape.js'
import { MAX_MEMO_BYTES } from './memo.js'
import { CAIP2_GENESIS, type TronConfig, type TronFeeEstimate, type TronRawTransaction, type TronSimulation, type TronTransaction, type TronTransferOptions } from './types.js'

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
/** Contract types that burn energy, which only `fee_limit` bounds. */
const ENERGY_CONTRACTS: ReadonlySet<string> = new Set(['TriggerSmartContract', 'CreateSmartContract'])
/** Tron mainnet's CAIP-2 id. */
const MAINNET = CAIP2_GENESIS.mainnet!
/** A reference block up to this many blocks ahead of the node's head is waited for, not refused. */
const REF_BLOCK_AHEAD = 64
const BLOCK_MS = 3_000

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
  /**
   * The signer that holds the key, in a private field: not a property of the account, so no code
   * the account is handed to (a protocol module, a logger) can reach it and sign around the
   * account's checks (audit 2026-10-29 A1).
   */
  readonly #signer: Signer
  /** What holds the key: `seed`, `key` (one imported key) or `external`. */
  readonly signerKind: Signer['kind']
  private _disposed = false
  private _readOnly: WalletAccountReadOnlyTron | undefined

  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: TronConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this.#signer = requireCurve(signer, 'secp256k1')
    this.signerKind = this.#signer.kind
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
    return this.#signer.sign(digest, { scheme: 'ecdsa-recoverable', context })
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
    const checked = { ...tx, raw_data: verified.raw_data }
    this.assertSafe(checked, Date.now(), options.maxFee)
    // The checks prepare() runs for what this wallet builds, here for a dApp's prebuilt bytes (scan 2026-10-27 F22, F25).
    await this.assertRefBlock(checked)
    const cap = feeLimit(this._config.transactionMaxFee, options)
    if (cap !== undefined) await this.assertWorstFee(checked, cap)
    return this.#signVerified(tx)
  }

  /** Sign bytes every check has already passed (prepare(), or signRaw above). */
  async #signVerified(tx: TronRawTransaction): Promise<TronRawTransaction> {
    const verified = verifyRawTransaction(tx)
    const sig = await this.#signDigest(hexToBytes(verified.txID), 'tron-tx')
    const mine = bytesToHex(sig.subarray(0, 64)) + sig[64]!.toString(16).padStart(2, '0')
    const others = (tx.signature ?? []).filter((s) => s.toLowerCase() !== mine)
    return { ...tx, signature: [...others, mine] }
  }

  /**
   * A Tron transaction is bound to its network only by its reference block (TaPoS), and the key is
   * the same on every network. With a provider, the block at `ref_block_bytes` (the latest one with
   * those low 16 bits) must have the `ref_block_hash` the transaction names; offline, only a mainnet
   * account signs, unless `allowOfflineTestnetSigning` (scan 2026-10-27 F22, F27).
   */
  protected async assertRefBlock(tx: TronRawTransaction): Promise<void> {
    const refBytes = String(tx.raw_data.ref_block_bytes ?? '')
    const refHash = String(tx.raw_data.ref_block_hash ?? '').toLowerCase()
    if (!/^[0-9a-fA-F]{4}$/.test(refBytes) || !/^[0-9a-f]{16}$/.test(refHash)) throw new UnsafeTransactionError('missing-ref-block', 'The reference block must be 2 bytes of ref_block_bytes and 8 bytes of ref_block_hash.')
    if (!this._client) {
      if (this.chain === MAINNET || this._config.allowOfflineTestnetSigning === true) return
      throw new UnsafeTransactionError('offline-network', `Without a provider this ${this.chain} account cannot check that the reference block is on its network, and a mainnet reference block would make the signature valid on mainnet. Connect a provider, or set allowOfflineTestnetSigning.`)
    }
    const low = parseInt(refBytes, 16)
    for (let attempt = 0; ; attempt++) {
      const now = await this.post<{ block_header?: { raw_data?: { number?: number } } }>('/wallet/getnowblock', {}, 'check the reference block')
      const head = now.block_header?.raw_data?.number
      if (typeof head !== 'number' || !Number.isSafeInteger(head) || head < 0) throw new UnsafeTransactionError('ref-block-mismatch', 'The node did not report its head block, so the reference block cannot be checked.')
      const behind = (((head - low) % 65536) + 65536) % 65536
      // A reference block a few blocks ahead of this node (another node built the transaction): wait for it.
      if (behind > 65536 - REF_BLOCK_AHEAD && attempt < 2) { await new Promise((r) => setTimeout(r, BLOCK_MS)); continue }
      const num = head - behind
      const block = await this.post<{ blockID?: string }>('/wallet/getblockbynum', { num }, 'check the reference block')
      const id = typeof block.blockID === 'string' ? block.blockID.toLowerCase() : ''
      if (id.length !== 64 || id.slice(16, 32) !== refHash) {
        throw new UnsafeTransactionError('ref-block-mismatch', `The reference block ${refBytes}/${refHash} is not block ${num} of ${this.chain}: the transaction belongs to another network, where this signature would be valid too.`)
      }
      return
    }
  }

  /**
   * What prebuilt bytes may burn at worst, held to `cap`: fee_limit of energy, plus the bandwidth,
   * memo and activation fees fee_limit does not cover — the bound prepare() applies (round 3, M8). A
   * contract call without fee_limit, or no provider to price the rest, is refused (scan 2026-10-27 F25).
   */
  protected async assertWorstFee(tx: TronRawTransaction, cap: bigint): Promise<void> {
    const type = String(tx.raw_data.contract?.[0]?.type)
    if (ENERGY_CONTRACTS.has(type) && tx.raw_data.fee_limit === undefined) throw new UnsafeTransactionError('fee-limit', `A ${type} without fee_limit cannot be held to the fee cap of ${cap}.`)
    if (!this._client) throw new UnsafeTransactionError('fee-limit', `Without a provider the fees of this transaction cannot be priced against the fee cap of ${cap}; nothing was signed.`)
    // Energy is bounded by fee_limit itself: no simulation needed for the bound.
    const estimate = await this.estimateRaw(tx, { ok: true, energy: 0 })
    const other = estimate.trxBurn - estimate.breakdown.energyBurn
    const worst = BigInt(tx.raw_data.fee_limit ?? 0) + other
    if (worst > cap) throw new UnsafeTransactionError('fee-limit', `fee_limit ${tx.raw_data.fee_limit ?? 0} plus ${other} sun of bandwidth, memo and activation fees can burn ${worst}, above the fee cap of ${cap}.`)
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
    // Memos are paid per transaction and bandwidth per byte: a dApp's oversized data is refused (scan 2026-10-27 F25).
    if (tx.raw_data.data !== undefined && String(tx.raw_data.data).replace(/^0x/, '').length / 2 > MAX_MEMO_BYTES) throw new UnsafeTransactionError('memo', `raw_data.data is longer than ${MAX_MEMO_BYTES} bytes.`)
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
    const checked = isPrebuilt(tx) ? { ...built, raw_data: verifyRawTransaction(built).raw_data } : built
    this.assertSafe(checked, Date.now(), maxFee)
    // The node's build and a caller's prebuilt bytes alike: the reference block is on this network (scan 2026-10-27 F22, F27).
    await this.assertRefBlock(checked)
    if (maxFee !== undefined && ENERGY_CONTRACTS.has(String(checked.raw_data.contract?.[0]?.type)) && checked.raw_data.fee_limit === undefined) {
      throw new UnsafeTransactionError('fee-limit', `A contract call without fee_limit cannot be held to the fee cap of ${maxFee}.`)
    }
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
    return JSON.stringify(await this.#signVerified(built))
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
    const signed = isPrebuilt(parsed) && parsed.signature?.length ? built : await this.#signVerified(built)
    return { hash: await this.broadcast(signed), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  /** TRX (no `token`) or TRC-20 `transfer(address,uint256)`. */
  async transfer(o: TronTransferOptions, writeOptions: WriteOptions = {}): Promise<TronTransferResult> {
    this.key()
    this.requireClient('transfer tokens')
    const { built, quote } = await this.prepare(this.asTransaction(o), feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
    return { hash: await this.broadcast(await this.#signVerified(built)), fee: quote.fee, activationFee: quote.activationFee, estimate: quote.estimate }
  }

  /** The same address as a {@link WalletAccountReadOnlyTron}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTron(this.address, this._config)
    return this._readOnly
  }

  /** Dispose the signer (zeroizes a local key). Idempotent. */
  dispose(): void {
    this._disposed = true
    this.#signer.dispose()
  }
}
