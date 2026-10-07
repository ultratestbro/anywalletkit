import { InsufficientFundsError, LocalSigner, SignerError, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult } from '@forgewallet/core'
import { SigHash, Transaction, p2pkh } from '@scure/btc-signer'
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js'
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js'
import { hex } from '@scure/base'
import { addressFromPublicKey, spendInfo } from './address.js'
import { FINAL_SEQUENCE, RBF_SEQUENCE, assertSafe, describeTransaction, parseRawTransaction, type DescribeContext } from './describe.js'
import { UnsupportedAddressTypeError } from './errors.js'
import { signMessageWith } from './message.js'
import { networkParams } from './network.js'
import { WalletAccountReadOnlyBtc, type SpendPlan } from './read-only-account.js'
import type { BtcAddressType, BtcConfig, BtcNetwork, BtcSpend, BtcTransaction, BtcTransferOptions, BtcTxDescription } from './types.js'

export { addressFromPublicKey }

/** Address for a compressed public key; `network` may be a name or btc-signer params. */
export function addressFor(publicKey: Uint8Array, network: BtcNetwork | BTC_NETWORK = 'bitcoin', type: BtcAddressType = 'p2wpkh'): string {
  return addressFromPublicKey(publicKey, typeof network === 'string' ? networkParams(network) : network, type)
}

interface Built {
  tx: Transaction
  fee: bigint
  plan: SpendPlan
  desc: BtcTxDescription
}

/**
 * Signing Bitcoin account — BIP-84 p2wpkh or BIP-86 p2tr (key-path). The key never
 * enters this package: every signature is one `signer.sign(...)` call over a
 * btc-signer-computed sighash — a {@link LocalSigner} for seed wallets, anything
 * else (hardware, MPC, backend) through `externalSigner()`:
 *
 *   p2wpkh input  → `ecdsa`              over the BIP-143 sighash (SIGHASH_ALL), DER-encoded here
 *   p2tr input    → `schnorr` + `tweak`  over the BIP-341 sighash (DEFAULT), tweak = TapTweak(xonly)
 *   BIP-137 msg   → `ecdsa-recoverable`  over the magic hash
 *
 * Every spend is resolved to a full description ("what you sign") and run through
 * the hard safety checks (fee-rate ceiling, recipient/amount exactness, change
 * ownership) before signing AND before broadcast — also for caller-supplied raw hex.
 */
export class WalletAccountBtc extends WalletAccountReadOnlyBtc implements IWalletAccount {
  /** UTXOs, fee rate and tip height come from the network before signing. */
  readonly needsNetwork = true
  readonly path: string
  readonly publicKey: Uint8Array
  override readonly addressType: BtcAddressType
  readonly signer: Signer
  private _disposed = false
  private _readOnly: WalletAccountReadOnlyBtc | undefined

  /** `publicKey` is the signer's compressed secp256k1 key (33 bytes); it is needed synchronously for the address. */
  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: BtcConfig = {}) {
    const type = config.addressType ?? 'p2wpkh'
    super(addressFromPublicKey(publicKey, networkParams(config.network ?? 'bitcoin'), type), config)
    this.addressType = type
    this.signer = requireCurve(signer, 'secp256k1')
    // Fail at construction, not mid-spend: taproot key-path needs schnorr, p2wpkh needs plain ecdsa.
    const needed = type === 'p2tr' ? 'schnorr' : 'ecdsa'
    if (!this.signer.schemes.includes(needed)) throw new SignerError(`A ${type} account needs a signer with the '${needed}' scheme (has: ${this.signer.schemes.join(', ')}).`)
    this.publicKey = publicKey
    this.path = path
  }

  /** Back-compat: wrap a raw derived key in a {@link LocalSigner} (the account takes ownership; it cannot derive). */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: BtcConfig = {}): WalletAccountBtc {
    return new WalletAccountBtc(LocalSigner.fromPrivateKey('secp256k1', privateKey, publicKey, path), publicKey, path, config)
  }

  /** Account index for the standard m/{84|86}'/{0|1}'/0'/0/i path. */
  get index(): number | undefined {
    const m = /^m\/8[46]'\/[01]'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private live(): void {
    if (this._disposed) throw new SignerError('This account has been disposed.')
  }

  /** BIP-137 p2wpkh signature, base64 (Electrum / Bitcoin Core encoding). Not available for taproot accounts. */
  async sign(message: string | Uint8Array): Promise<string> {
    this.live()
    if (this.addressType === 'p2tr') throw new UnsupportedAddressTypeError('BIP-137 message signatures do not exist for taproot accounts (BIP-322 is not implemented).')
    return signMessageWith(message, this.signer, 'p2wpkh')
  }

  /** The x-only internal key and its BIP-86 tweak (no script tree) for taproot key-path spends. */
  private taprootKeys(): { xonly: Uint8Array; tweak: Uint8Array } {
    const xonly = this.publicKey.length === 33 ? this.publicKey.subarray(1) : this.publicKey
    return { xonly, tweak: schnorr.utils.taggedHash('TapTweak', xonly) }
  }

  /**
   * Sign every input through the signer and attach the witness-ready signature:
   * p2wpkh → `partialSig` (DER + SIGHASH_ALL), p2tr → `tapKeySig` (64 bytes, DEFAULT).
   * btc-signer only computes the sighash and assembles the witness; it never sees a key.
   */
  private async signInputs(tx: Transaction, values: bigint[]): Promise<void> {
    if (this.addressType === 'p2tr') {
      const { tweak } = this.taprootKeys()
      const scripts = Array.from({ length: tx.inputsLength }, () => this.scriptPubKey)
      for (let i = 0; i < tx.inputsLength; i++) {
        const sighash = tx.preimageWitnessV1(i, scripts, SigHash.DEFAULT, values)
        const sig = await this.signer.sign(sighash, { scheme: 'schnorr', context: 'btc-taproot-keypath', tweak })
        tx.updateInput(i, { tapKeySig: sig }, true)
      }
      return
    }
    const scriptCode = p2pkh(this.publicKey).script
    for (let i = 0; i < tx.inputsLength; i++) {
      const sighash = tx.preimageWitnessV0(i, scriptCode, SigHash.ALL, values[i]!)
      const rs = await this.signer.sign(sighash, { scheme: 'ecdsa', context: 'btc-sighash' })
      const der = secp256k1.Signature.fromBytes(rs, 'compact').toBytes('der')
      const sig = new Uint8Array(der.length + 1)
      sig.set(der, 0)
      sig[der.length] = SigHash.ALL
      tx.updateInput(i, { partialSig: [[this.publicKey, sig]] }, true)
    }
  }

  private ctx(intended?: { to: string; value: bigint }): DescribeContext {
    return { network: this._network, ownAddress: this.address, intended, maxFeeRate: this.maxFeeRate }
  }

  private async buildAndSign(plan: SpendPlan, to: string, recipientValue: bigint, change: bigint, lockTime: number, rbf: boolean): Promise<Transaction> {
    const spend = spendInfo(this.publicKey, this._network, this.addressType)
    const tx = new Transaction({ lockTime })
    const sequence = rbf ? RBF_SEQUENCE : FINAL_SEQUENCE
    for (const u of plan.utxos) {
      tx.addInput({ ...spend, txid: u.txid, index: u.vout, sequence, witnessUtxo: { script: this.scriptPubKey, amount: u.value } })
    }
    tx.addOutputAddress(to, recipientValue, this._network)
    if (change > 0n) tx.addOutputAddress(this.address, change, this._network)
    await this.signInputs(tx, plan.utxos.map((u) => u.value))
    tx.finalize()
    return tx
  }

  /**
   * Plan → sign → measure. The plan's fee assumes 72-byte DER signatures; if the
   * signed vsize somehow needs more, the difference comes out of change (never the
   * recipient) and the tx is re-signed once.
   */
  protected async buildSignedTransaction(spend: BtcSpend): Promise<Built> {
    this.live()
    const plan = await this.planSpend(spend)
    const lockTime = await this.lockTimeHeight()
    const rbf = spend.rbf ?? this._config.rbf ?? true
    let change = plan.change
    let fee = plan.fee
    let tx = await this.buildAndSign(plan, spend.to, plan.amount, change, lockTime, rbf)
    const required = BigInt(tx.vsize) * plan.feeRate
    if (required > fee) {
      const delta = required - fee
      if (change === 0n) {
        const have = plan.utxos.reduce((s, u) => s + u.value, 0n)
        throw new InsufficientFundsError(plan.amount + required, have, 'BTC')
      }
      change = change - delta
      if (change < this.dustLimit) { fee = plan.fee + plan.change; change = 0n } else fee = required
      tx = await this.buildAndSign(plan, spend.to, plan.amount, change, lockTime, rbf)
      if (BigInt(tx.vsize) * plan.feeRate > fee) throw new Error('Fee shortfall after output rebalance.')
    }
    const ctx = this.ctx({ to: spend.to, value: plan.amount })
    const desc = describeTransaction(tx, plan.utxos.map((u) => u.value), ctx)
    assertSafe(desc, ctx)
    return { tx, fee, plan, desc }
  }

  private checkMax(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /** Prevout values of a raw tx, fetched through the client (the wire format carries none). */
  private async inputValues(tx: Transaction): Promise<bigint[]> {
    const client = this.requireClient('inspect a raw transaction')
    const cache = new Map<string, Transaction>()
    const values: bigint[] = []
    for (let i = 0; i < tx.inputsLength; i++) {
      const inp = tx.getInput(i)
      if (!inp.txid || inp.index === undefined) throw new Error('Raw transaction input without a prevout.')
      const id = hex.encode(inp.txid)
      let prev = cache.get(id)
      if (!prev) { prev = parseRawTransaction(await client.getTransaction(id)); cache.set(id, prev) }
      const out = prev.getOutput(inp.index)
      if (out.amount === undefined) throw new Error(`Prevout ${id}:${inp.index} not found.`)
      values.push(out.amount)
    }
    return values
  }

  /** Describe a raw signed tx (needs the network for prevout values) and run the safety checks. */
  private async describeRaw(rawHex: string): Promise<{ tx: Transaction; desc: BtcTxDescription }> {
    const tx = parseRawTransaction(rawHex)
    const ctx = this.ctx()
    const desc = describeTransaction(tx, await this.inputValues(tx), ctx)
    assertSafe(desc, ctx)
    return { tx, desc }
  }

  /** "What you sign": the fully resolved spend (signed, NOT broadcast) or a caller's raw hex. */
  async describeTransaction(tx: BtcTransaction): Promise<BtcTxDescription> {
    if (typeof tx === 'string') return (await this.describeRaw(tx)).desc
    return (await this.buildSignedTransaction(tx)).desc
  }

  /** Sign without broadcasting. Returns the raw transaction hex. Raw hex input is returned unchanged. */
  async signTransaction(tx: BtcTransaction): Promise<string> {
    this.live()
    if (typeof tx === 'string') return tx
    const { tx: built, fee } = await this.buildSignedTransaction(tx)
    this.checkMax(fee, this._config.transactionMaxFee, 'transaction')
    return built.hex
  }

  override async quoteSendTransaction(tx: BtcTransaction): Promise<{ fee: bigint }> {
    if (typeof tx === 'string') return { fee: (await this.describeRaw(tx)).desc.fee }
    return super.quoteSendTransaction(tx)
  }

  async sendTransaction(tx: BtcTransaction): Promise<TransferResult> {
    this.live()
    const client = this.requireClient('send transactions')
    let rawHex: string, hash: string, fee: bigint
    if (typeof tx === 'string') {
      const { tx: parsed, desc } = await this.describeRaw(tx)
      rawHex = tx; hash = parsed.id; fee = desc.fee
    } else {
      const built = await this.buildSignedTransaction(tx)
      rawHex = built.tx.hex; hash = built.tx.id; fee = built.fee
    }
    this.checkMax(fee, this._config.transactionMaxFee, 'transaction')
    const txid = await client.broadcast(rawHex)
    return { hash: txid || hash, fee }
  }

  /** Native BTC only (`token` is rejected). Subject to `transferMaxFee`. */
  async transfer(o: BtcTransferOptions): Promise<TransferResult> {
    if (o.token) throw new Error('Tokens are not supported on the bitcoin blockchain.')
    this.live()
    const client = this.requireClient('transfer')
    const built = await this.buildSignedTransaction({ to: o.recipient, value: o.amount })
    this.checkMax(built.fee, this._config.transferMaxFee, 'transfer')
    const txid = await client.broadcast(built.tx.hex)
    return { hash: txid || built.tx.id, fee: built.fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyBtc(this.address, this._config)
    return this._readOnly
  }

  dispose(): void {
    this._disposed = true
    this.signer.dispose()
  }
}
