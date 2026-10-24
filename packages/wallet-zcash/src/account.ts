import { InsufficientFundsError, LocalSigner, SignerError, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult } from '@anywalletkit/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { DUST_LIMIT, addressFromPublicKey } from './address.js'
import { UnsafeTransactionError, assertSafe, describeTransaction, type DescribeContext } from './describe.js'
import { bytesToHex } from './encoding.js'
import { signMessageWith } from './message.js'
import { WalletAccountReadOnlyZcash, type SpendPlan } from './read-only-account.js'
import { FINAL_SEQUENCE, branchIdForHeight, p2pkhScriptSig, parseTx, serializeTx, sighashAll, txid as txidOf, type TransparentTxV5 } from './tx.js'
import type { SpentOutput, ZcashConfig, ZcashNetwork, ZcashSpend, ZcashTransaction, ZcashTransferOptions, ZcashTxDescription } from './types.js'

export { addressFromPublicKey }

/** t-address for a compressed public key. */
export function addressFor(publicKey: Uint8Array, network: ZcashNetwork = 'mainnet'): string {
  return addressFromPublicKey(publicKey, network)
}

/** ZIP-203 default: a transaction expires 40 blocks (~50 min) after it was built. */
export const DEFAULT_EXPIRY_DELTA = 40

interface Built {
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
  readonly path: string
  readonly publicKey: Uint8Array
  readonly signer: Signer
  private _disposed = false
  private _readOnly: WalletAccountReadOnlyZcash | undefined

  /** `publicKey` is the signer's compressed secp256k1 key (33 bytes); it is needed synchronously for the address. */
  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: ZcashConfig = {}) {
    super(addressFromPublicKey(publicKey, config.network ?? 'mainnet'), config)
    this.signer = requireCurve(signer, 'secp256k1')
    if (!this.signer.schemes.includes('ecdsa')) throw new SignerError(`A Zcash account needs a signer with the 'ecdsa' scheme (has: ${this.signer.schemes.join(', ')}).`)
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
    return signMessageWith(message, this.signer)
  }

  private ctx(intended?: { to: string; value: bigint }): DescribeContext {
    return { network: this._network, ownAddress: this.address, intended, maxFee: this.maxFee }
  }

  /** Lock time + expiry + branch id from the tip (or the config override). */
  private async chainParams(): Promise<{ lockTime: number; expiryHeight: number; consensusBranchId: number }> {
    const tip = await this.tipHeight()
    const delta = this._config.expiryDelta ?? DEFAULT_EXPIRY_DELTA
    const consensusBranchId = this._config.consensusBranchId ?? branchIdForHeight(tip)
    const lockTime = tip !== undefined && this._config.antiFeeSniping !== false ? tip : 0
    const expiryHeight = tip !== undefined && delta > 0 ? tip + delta : 0
    return { lockTime, expiryHeight, consensusBranchId }
  }

  /** Sign every input through the signer; the scriptSig is `<DER ‖ 0x01> <pubkey>`. */
  private async signInputs(tx: TransparentTxV5, spent: SpentOutput[]): Promise<void> {
    for (let i = 0; i < tx.inputs.length; i++) {
      const digest = sighashAll(tx, i, spent)
      const rs = await this.signer.sign(digest, { scheme: 'ecdsa', context: 'zcash-sighash' })
      const der = secp256k1.Signature.fromBytes(rs, 'compact').toBytes('der')
      tx.inputs[i]!.scriptSig = p2pkhScriptSig(der, this.publicKey)
    }
  }

  protected async buildSignedTransaction(spend: ZcashSpend): Promise<Built> {
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
    await this.signInputs(tx, spent)
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
    return (await this.buildSignedTransaction(tx)).desc
  }

  /** Sign without broadcasting. Returns the raw transaction hex. Raw hex input is returned unchanged. */
  async signTransaction(tx: ZcashTransaction): Promise<string> {
    this.live()
    if (typeof tx === 'string') return tx
    const built = await this.buildSignedTransaction(tx)
    this.checkMax(built.fee, this._config.transactionMaxFee, 'transaction')
    return built.hex
  }

  override async quoteSendTransaction(tx: ZcashTransaction): Promise<{ fee: bigint }> {
    if (typeof tx === 'string') return { fee: (await this.describeRaw(tx)).desc.fee }
    return super.quoteSendTransaction(tx)
  }

  async sendTransaction(tx: ZcashTransaction): Promise<TransferResult> {
    this.live()
    const client = this.requireClient('send transactions')
    let rawHex: string, hash: string, fee: bigint
    if (typeof tx === 'string') {
      const { tx: parsed, desc } = await this.describeRaw(tx)
      rawHex = tx; hash = txidOf(parsed); fee = desc.fee
    } else {
      const built = await this.buildSignedTransaction(tx)
      rawHex = built.hex; hash = built.txid; fee = built.fee
    }
    this.checkMax(fee, this._config.transactionMaxFee, 'transaction')
    const id = await client.broadcast(rawHex)
    return { hash: id || hash, fee }
  }

  /** Native ZEC only (`token` is rejected). Subject to `transferMaxFee`. */
  async transfer(o: ZcashTransferOptions): Promise<TransferResult> {
    if (o.token) throw new Error('Tokens are not supported on the zcash blockchain.')
    this.live()
    const client = this.requireClient('transfer')
    const built = await this.buildSignedTransaction({ to: o.recipient, value: o.amount })
    this.checkMax(built.fee, this._config.transferMaxFee, 'transfer')
    const id = await client.broadcast(built.hex)
    return { hash: id || built.txid, fee: built.fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyZcash(this.address, this._config)
    return this._readOnly
  }

  dispose(): void {
    this._disposed = true
    this.signer.dispose()
  }
}

export { DUST_LIMIT, UnsafeTransactionError }
