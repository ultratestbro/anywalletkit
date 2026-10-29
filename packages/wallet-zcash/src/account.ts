import { InsufficientFundsError, LocalSigner, NetworkError, SignerError, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { DUST_LIMIT, addressFromPublicKey } from './address.js'
import { UnsafeTransactionError, assertSafe, describeTransaction, type DescribeContext } from './describe.js'
import { bytesToHex } from './encoding.js'
import { BroadcastUnknownError } from './errors.js'
import { isAlreadyKnown, isAnsweredRefusal } from './http.js'
import { signMessageWith } from './message.js'
import { WalletAccountReadOnlyZcash, type SpendPlan } from './read-only-account.js'
import { FINAL_SEQUENCE, branchIdForHeight, p2pkhScriptSig, parseTx, serializeTx, sighashAll, txid as txidOf, type TransparentTxV5 } from './tx.js'
import type { SpentOutput, ZcashClient, ZcashConfig, ZcashNetwork, ZcashSpend, ZcashTransaction, ZcashTransferOptions, ZcashTxDescription } from './types.js'

export { addressFromPublicKey }

/** t-address for a compressed public key. */
export function addressFor(publicKey: Uint8Array, network: ZcashNetwork = 'mainnet'): string {
  return addressFromPublicKey(publicKey, network)
}

/** ZIP-203 default: a transaction expires 40 blocks (~50 min) after it was built. */
export const DEFAULT_EXPIRY_DELTA = 40

export interface Built {
  tx: TransparentTxV5
  hex: string
  txid: string
  fee: bigint
  plan: SpendPlan
  desc: ZcashTxDescription
}

/**
 * Signing Zcash account — BIP-44 P2PKH at m/44'/133'/0'/0/i (t1…). The key never
 * enters this package: every input is one `signer.sign(...)` call over the
 * ZIP-244 signature digest computed here (`ecdsa`, DER-encoded + SIGHASH_ALL
 * into the scriptSig); messages are `ecdsa-recoverable` over the Zcash magic hash.
 *
 * Every spend is resolved to a full description ("what you sign") and run through
 * the hard safety checks (fee ceiling, recipient/amount exactness, change
 * ownership) before signing AND before broadcast — also for caller-supplied raw hex.
 */
export class WalletAccountZcash extends WalletAccountReadOnlyZcash implements IWalletAccount {
  /** UTXOs and the tip height come from the network before signing. */
  readonly needsNetwork = true
  /** Derivation path, or `external` for an external signer. */
  readonly path: string
  /** Compressed secp256k1 public key. */
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
  private _readOnly: WalletAccountReadOnlyZcash | undefined

  /** `publicKey` is the signer's compressed secp256k1 key (33 bytes); it is needed synchronously for the address. */
  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: ZcashConfig = {}) {
    super(addressFromPublicKey(publicKey, config.network ?? 'mainnet'), config)
    this.#signer = requireCurve(signer, 'secp256k1')
    this.signerKind = this.#signer.kind
    if (!this.#signer.schemes.includes('ecdsa')) throw new SignerError(`A Zcash account needs a signer with the 'ecdsa' scheme (has: ${this.#signer.schemes.join(', ')}).`)
    this.publicKey = publicKey
    this.path = path
  }

  /** Back-compat: wrap a raw derived key in a {@link LocalSigner} (the account takes ownership; it cannot derive). */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: ZcashConfig = {}): WalletAccountZcash {
    return new WalletAccountZcash(LocalSigner.fromPrivateKey('secp256k1', privateKey, publicKey, path), publicKey, path, config)
  }

  /** Account index for the standard m/44'/133'/0'/0/i path. */
  get index(): number | undefined {
    const m = /^m\/44'\/(133|1)'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[2]) : undefined
  }

  private live(): void {
    if (this._disposed) throw new SignerError('This account has been disposed.')
  }

  /** Zcash message signature (zcashd `signmessage` encoding), base64. */
  async sign(message: string | Uint8Array): Promise<string> {
    this.live()
    return signMessageWith(message, this.#signer)
  }

  private ctx(intended?: { to: string; value: bigint }): DescribeContext {
    return { network: this._network, ownAddress: this.address, intended, maxFee: this.maxFee }
  }

  /**
   * Lock time, expiry and branch id for a transaction that lands in the next block (round 3, L7):
   * expiry = tip + 1 + `expiryDelta`, the branch id in force at tip + 1 (mainnet table; off mainnet
   * `consensusBranchId` must be configured — testnet and regtest activate upgrades at other heights).
   * Without a tip nothing is signed when the expiry, anti-fee-sniping or the branch id need it: a
   * transaction signed with expiry 0 never expires.
   */
  private async chainParams(): Promise<{ lockTime: number; expiryHeight: number; consensusBranchId: number }> {
    const delta = this._config.expiryDelta ?? DEFAULT_EXPIRY_DELTA
    const configured = this._config.consensusBranchId
    if (configured === undefined && this._network !== 'mainnet') {
      throw new UnsafeTransactionError('unknown-branch-id', `On ${this._network} the consensus branch id depends on that network's upgrade heights; set consensusBranchId in the config.`)
    }
    const antiSnipe = this._config.antiFeeSniping !== false
    const needTip = delta > 0 || antiSnipe || configured === undefined
    const tip = needTip ? await this.tipHeight() : undefined
    if (needTip && tip === undefined) throw new NetworkError('The Zcash chain tip is unknown, so the expiry height and the branch id cannot be set; nothing was signed.')
    const next = tip === undefined ? undefined : tip + 1
    const consensusBranchId = configured ?? branchIdForHeight(next)
    const lockTime = tip !== undefined && antiSnipe ? tip : 0
    const expiryHeight = next !== undefined && delta > 0 ? next + delta : 0
    return { lockTime, expiryHeight, consensusBranchId }
  }

  /** Sign every input through the signer; the scriptSig is `<DER ‖ 0x01> <pubkey>`. */
  async #signInputs(tx: TransparentTxV5, spent: SpentOutput[]): Promise<void> {
    for (let i = 0; i < tx.inputs.length; i++) {
      const digest = sighashAll(tx, i, spent)
      const rs = await this.#signer.sign(digest, { scheme: 'ecdsa', context: 'zcash-sighash' })
      const der = secp256k1.Signature.fromBytes(rs, 'compact').toBytes('der')
      tx.inputs[i]!.scriptSig = p2pkhScriptSig(der, this.publicKey)
    }
  }

  async #signSpend(spend: ZcashSpend): Promise<Built> {
    this.live()
    const plan = await this.planSpend(spend)
    const params = await this.chainParams()
    const tx: TransparentTxV5 = {
      ...params,
      inputs: plan.utxos.map((u) => ({ txid: u.txid, vout: u.vout, scriptSig: new Uint8Array(0), sequence: FINAL_SEQUENCE })),
      outputs: [{ value: plan.amount, script: plan.recipient.script }, ...(plan.change > 0n ? [{ value: plan.change, script: this.scriptPubKey }] : [])],
    }
    const spent: SpentOutput[] = plan.utxos.map((u) => ({ value: u.value, script: this.scriptPubKey }))
    const have = plan.utxos.reduce((s, u) => s + u.value, 0n)
    if (have < plan.amount + plan.fee) throw new InsufficientFundsError(plan.amount + plan.fee, have, 'ZEC')
    await this.#signInputs(tx, spent)
    const ctx = this.ctx({ to: spend.to, value: plan.amount })
    const desc = describeTransaction(tx, spent, ctx)
    assertSafe(desc, ctx)
    const bytes = serializeTx(tx)
    return { tx, hex: bytesToHex(bytes), txid: txidOf(tx), fee: plan.fee, plan, desc }
  }

  private checkMax(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /** The outputs a raw transaction spends, fetched through the client (the wire format carries no values). */
  private async spentOutputs(tx: TransparentTxV5): Promise<SpentOutput[]> {
    const client = this.requireClient('inspect a raw transaction')
    const out: SpentOutput[] = []
    for (const i of tx.inputs) {
      const o = await client.getOutput(i.txid, i.vout)
      if (!o) throw new Error(`Prevout ${i.txid}:${i.vout} not found.`)
      out.push(o)
    }
    return out
  }

  /** Describe a raw signed tx (needs the network for prevouts) and run the safety checks. */
  private async describeRaw(rawHex: string): Promise<{ tx: TransparentTxV5; desc: ZcashTxDescription }> {
    const tx = parseTx(rawHex)
    const ctx = this.ctx()
    const desc = describeTransaction(tx, await this.spentOutputs(tx), ctx)
    assertSafe(desc, ctx)
    return { tx, desc }
  }

  /** "What you sign": the fully resolved spend (signed, NOT broadcast) or a caller's raw hex. */
  async describeTransaction(tx: ZcashTransaction): Promise<ZcashTxDescription> {
    if (typeof tx === 'string') return (await this.describeRaw(tx)).desc
    return (await this.#signSpend(tx)).desc
  }

  /** Sign without broadcasting. Returns the raw transaction hex. Raw hex input gets the checks `sendTransaction` runs (prevouts through the client) and is returned unchanged, never re-signed. */
  async signTransaction(tx: ZcashTransaction, options: WriteOptions = {}): Promise<string> {
    this.live()
    if (typeof tx === 'string') {
      const { desc } = await this.describeRaw(tx)
      this.checkMax(desc.fee, feeLimit(this._config.transactionMaxFee, options), 'transaction')
      return tx
    }
    const built = await this.#signSpend(tx)
    this.checkMax(built.fee, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return built.hex
  }

  override async quoteSendTransaction(tx: ZcashTransaction): Promise<{ fee: bigint }> {
    if (typeof tx === 'string') return { fee: (await this.describeRaw(tx)).desc.fee }
    return super.quoteSendTransaction(tx)
  }

  async sendTransaction(tx: ZcashTransaction, options: WriteOptions = {}): Promise<TransferResult> {
    this.live()
    const client = this.requireClient('send transactions')
    let rawHex: string, hash: string, fee: bigint
    if (typeof tx === 'string') {
      const { tx: parsed, desc } = await this.describeRaw(tx)
      rawHex = tx; hash = txidOf(parsed); fee = desc.fee
    } else {
      const built = await this.#signSpend(tx)
      rawHex = built.hex; hash = built.txid; fee = built.fee
    }
    this.checkMax(fee, feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return { hash: await this.broadcast(client, rawHex, hash), fee }
  }

  /** Native ZEC only (`token` is rejected). Subject to `transferMaxFee`. */
  async transfer(o: ZcashTransferOptions, writeOptions: WriteOptions = {}): Promise<TransferResult> {
    if (o.token) throw new Error('Tokens are not supported on the zcash blockchain.')
    this.live()
    const client = this.requireClient('transfer')
    const built = await this.#signSpend({ to: o.recipient, value: o.amount })
    this.checkMax(built.fee, feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
    return { hash: await this.broadcast(client, built.hex, built.txid), fee: built.fee }
  }

  /**
   * Send once through the client. Only a node's refusal means nothing went out; "already in the
   * mempool / block chain" means an earlier attempt delivered it; anything else may have landed and
   * is a {@link BroadcastUnknownError} with the txid computed before sending (round 3, M12).
   */
  private async broadcast(client: ZcashClient, rawHex: string, txid: string): Promise<string> {
    try {
      return (await client.broadcast(rawHex)) || txid
    } catch (e) {
      if (isAlreadyKnown(e)) return txid
      if (isAnsweredRefusal(e)) throw e
      throw new BroadcastUnknownError(txid, e)
    }
  }

  /** The same address as a {@link WalletAccountReadOnlyZcash}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyZcash(this.address, this._config)
    return this._readOnly
  }

  dispose(): void {
    this._disposed = true
    this.#signer.dispose()
  }
}

export { DUST_LIMIT, UnsafeTransactionError }
