import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import * as ecc from '@bitcoinerlab/secp256k1'
import { Psbt, Transaction, networks, payments } from 'bitcoinjs-lib'
import { signMessage } from './message.js'
import { WalletAccountReadOnlyBtc, type SpendPlan } from './read-only-account.js'
import type { BtcConfig, BtcSpend, BtcTransaction, BtcTransferOptions } from './types.js'

export function addressFromPublicKey(publicKey: Uint8Array, network: keyof typeof networks = 'bitcoin'): string {
  const { address } = payments.p2wpkh({ pubkey: publicKey, network: networks[network] })
  if (!address) throw new Error('Could not derive a p2wpkh address')
  return address
}

const toBig = (v: bigint | number | string): bigint => (typeof v === 'bigint' ? v : BigInt(Math.round(Number(v))))

/**
 * Signing Bitcoin account (BIP-84 p2wpkh). The private key is a Uint8Array
 * zeroized by `dispose()`; PSBT inputs are signed through a tiny Signer shim
 * over @bitcoinerlab/secp256k1, so no copy of the key is ever made.
 */
export class WalletAccountBtc extends WalletAccountReadOnlyBtc implements IWalletAccount {
  /** UTXOs and the fee rate come from the network before signing. */
  readonly needsNetwork = true
  readonly path: string
  readonly publicKey: Uint8Array
  private _privateKey: Uint8Array | undefined
  private _readOnly: WalletAccountReadOnlyBtc | undefined

  constructor(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: BtcConfig = {}) {
    super(addressFromPublicKey(publicKey, config.network ?? 'bitcoin'), config)
    this._privateKey = privateKey
    this.publicKey = publicKey
    this.path = path
  }

  /** Account index for the standard m/84'/{0|1}'/0'/0/i path. */
  get index(): number | undefined {
    const m = /^m\/84'\/[01]'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This account has been disposed.')
    return this._privateKey
  }

  /** BIP-137 p2wpkh signature, base64. */
  async sign(message: string | Uint8Array): Promise<string> {
    return signMessage(message, this.key(), 'p2wpkh')
  }

  private signer() {
    const priv = this.key()
    return { publicKey: this.publicKey, sign: (hash: Uint8Array, lowR?: boolean) => ecc.sign(hash, priv, lowR ? undefined : undefined) }
  }

  private buildAndSign(plan: SpendPlan, to: string, recipientValue: bigint, change: bigint): Transaction {
    const psbt = new Psbt({ network: this._network })
    for (const u of plan.utxos) psbt.addInput({ hash: u.txid, index: u.vout, witnessUtxo: { script: u.scriptPubKey, value: u.value } })
    psbt.addOutput({ address: to, value: recipientValue })
    if (change > 0n) psbt.addOutput({ address: this.address, value: change })
    const signer = this.signer()
    plan.utxos.forEach((_, i) => psbt.signInput(i, signer))
    psbt.finalizeAllInputs()
    return psbt.extractTransaction()
  }

  /** Build + sign, then rebalance once if the real vsize needs more fee than coinselect estimated. */
  protected async buildSignedTransaction(spend: BtcSpend): Promise<{ tx: Transaction; fee: bigint; plan: SpendPlan }> {
    const plan = await this.planSpend(spend)
    let recipient = toBig(spend.value)
    let change = plan.changeValue
    let fee = plan.fee
    let tx = this.buildAndSign(plan, spend.to, recipient, change)
    let required = BigInt(tx.virtualSize()) * plan.feeRate
    if (required <= fee) return { tx, fee, plan }
    const delta = required - fee
    fee = required
    if (change > 0n) {
      change = change - delta
      if (change <= this.dustLimit) { fee += change; change = 0n }
    } else {
      recipient -= delta
      if (recipient <= this.dustLimit) throw new Error(`The amount after fees must be bigger than the dust limit (= ${this.dustLimit}).`)
    }
    tx = this.buildAndSign(plan, spend.to, recipient, change)
    required = BigInt(tx.virtualSize()) * plan.feeRate
    if (required > fee) throw new Error('Fee shortfall after output rebalance.')
    return { tx, fee, plan }
  }

  private checkMax(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /** Sign without broadcasting. Returns the raw transaction hex. */
  async signTransaction(tx: BtcTransaction): Promise<string> {
    this.key()
    if (typeof tx === 'string') return tx
    const { tx: built, fee } = await this.buildSignedTransaction(tx)
    this.checkMax(fee, this._config.transactionMaxFee, 'transaction')
    return built.toHex()
  }

  /** Fee of an already-signed tx: Σ inputs (fetched) − Σ outputs. */
  private async signedTxFee(tx: Transaction): Promise<bigint> {
    const client = this.requireClient('quote transactions')
    let inputs = 0n
    for (const i of tx.ins) {
      const prevId = Array.from(Uint8Array.from(i.hash).reverse(), (b) => b.toString(16).padStart(2, '0')).join('')
      const prev = Transaction.fromHex(await client.getTransaction(prevId))
      inputs += BigInt(prev.outs[i.index]!.value)
    }
    return inputs - tx.outs.reduce((s, o) => s + BigInt(o.value), 0n)
  }

  override async quoteSendTransaction(tx: BtcTransaction): Promise<{ fee: bigint }> {
    if (typeof tx === 'string') return { fee: await this.signedTxFee(Transaction.fromHex(tx)) }
    return super.quoteSendTransaction(tx)
  }

  async sendTransaction(tx: BtcTransaction): Promise<TransferResult> {
    this.key()
    const client = this.requireClient('send transactions')
    let hex: string, hash: string, fee: bigint
    if (typeof tx === 'string') {
      const t = Transaction.fromHex(tx)
      hex = tx; hash = t.getId(); fee = await this.signedTxFee(t)
    } else {
      const built = await this.buildSignedTransaction(tx)
      hex = built.tx.toHex(); hash = built.tx.getId(); fee = built.fee
    }
    this.checkMax(fee, this._config.transactionMaxFee, 'transaction')
    const txid = await client.broadcast(hex)
    return { hash: txid || hash, fee }
  }

  /** Native BTC only (`token` is rejected). Subject to `transferMaxFee`. */
  async transfer(o: BtcTransferOptions): Promise<TransferResult> {
    if (o.token) throw new Error('Tokens are not supported on the bitcoin blockchain.')
    this.key()
    const client = this.requireClient('transfer')
    const built = await this.buildSignedTransaction({ to: o.recipient, value: o.amount })
    this.checkMax(built.fee, this._config.transferMaxFee, 'transfer')
    const txid = await client.broadcast(built.tx.toHex())
    return { hash: txid || built.tx.getId(), fee: built.fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyBtc(this.address, this._config)
    return this._readOnly
  }

  dispose(): void {
    zeroize(this._privateKey)
    this._privateKey = undefined
  }
}
