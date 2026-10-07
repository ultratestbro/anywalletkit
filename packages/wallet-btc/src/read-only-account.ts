import { InsufficientFundsError, NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import type { BTC_NETWORK } from '@scure/btc-signer/utils.js'
import { INPUT_WEIGHT, decodeAddress, dustLimit, kindOfType, outputVBytes, spendInfo, type ScriptKind } from './address.js'
import { createClient } from './client.js'
import { MAX_UTXO_INPUTS, selectAll, selectCoins, type CoinSelection } from './coinselect.js'
import { DEFAULT_MAX_FEE_RATE } from './describe.js'
import { UnsupportedAddressTypeError } from './errors.js'
import { recoverMessagePublicKey } from './message.js'
import { networkParams } from './network.js'
import { CAIP2_GENESIS, type BtcAddressType, type BtcClient, type BtcConfig, type BtcMaxSpendableResult, type BtcNetwork, type BtcReceipt, type BtcSpend, type BtcTransferOptions } from './types.js'

export { MAX_UTXO_INPUTS }

export interface SpendPlan extends CoinSelection {
  /** Sats the recipient gets (the requested value — never reduced). */
  amount: bigint
  recipientScript: Uint8Array
  recipientKind: ScriptKind
}

const toBig = (v: bigint | number | string): bigint => (typeof v === 'bigint' ? v : BigInt(Math.round(Number(v))))
export const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/** Watch-only Bitcoin account: balances, quotes, receipts, BIP-137 verification. No key. */
export class WalletAccountReadOnlyBtc implements IWalletAccountReadOnly {
  readonly address: string
  readonly chain: string
  /** Output script of `address`. */
  readonly scriptPubKey: Uint8Array
  readonly scriptKind: ScriptKind
  /** p2wpkh / p2tr when the address is one we know how to spend from; undefined for other script types. */
  readonly addressType: BtcAddressType | undefined
  readonly dustLimit: bigint
  protected readonly _config: BtcConfig
  protected readonly _client: BtcClient | undefined
  protected readonly _network: BTC_NETWORK
  protected readonly _networkName: BtcNetwork

  constructor(address: string, config: BtcConfig = {}) {
    this._config = config
    this._networkName = config.network ?? 'bitcoin'
    this._network = networkParams(this._networkName)
    const decoded = decodeAddress(address, this._network)
    this.address = address
    this.scriptPubKey = decoded.script
    this.scriptKind = decoded.kind
    this.addressType = decoded.kind === 'wpkh' ? 'p2wpkh' : decoded.kind === 'tr' ? 'p2tr' : undefined
    this.dustLimit = dustLimit(decoded.kind)
    this.chain = CAIP2_GENESIS[this._networkName]
    this._client = createClient(config)
  }

  protected requireClient(what: string): BtcClient {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a client to ${what}.`)
    return this._client
  }

  get maxFeeRate(): number {
    return this._config.maxFeeRate ?? DEFAULT_MAX_FEE_RATE
  }

  async getAddress(): Promise<string> { return this.address }

  /** Confirmed minus pending outgoing (Bitcoin Core wallet semantics). */
  async getBalance(): Promise<bigint> {
    const { confirmed, unconfirmed, unconfirmedOutgoing } = await this.requireClient('read balances').getBalance(this.address)
    return unconfirmedOutgoing !== undefined ? confirmed - unconfirmedOutgoing : confirmed + unconfirmed
  }

  async getTokenBalance(_token: string): Promise<bigint> {
    throw new Error("The 'getTokenBalance' method is not supported on the bitcoin blockchain.")
  }

  /** Weight one of OUR inputs adds; throws for address types we cannot spend from. */
  protected inputWeight(): number {
    if (!this.addressType) throw new UnsupportedAddressTypeError(`Cannot build spends from a ${this.scriptKind} address; only p2wpkh and p2tr accounts spend.`)
    return INPUT_WEIGHT[this.addressType]
  }

  protected async resolveFeeRate(spend: { feeRate?: bigint | number; confirmationTarget?: number }): Promise<bigint> {
    if (spend.feeRate !== undefined) {
      const r = toBig(spend.feeRate)
      return r < 1n ? 1n : r
    }
    const est = await this.requireClient('estimate fees').estimateFee(spend.confirmationTarget ?? 1)
    return BigInt(Math.max(Math.ceil(est), 1))
  }

  /** Coin selection for a spend (see coinselect.ts). Validates the recipient and the dust floor first. */
  protected async planSpend(spend: BtcSpend): Promise<SpendPlan> {
    const amount = toBig(spend.value)
    const recipient = decodeAddress(spend.to, this._network)
    const floor = dustLimit(recipient.kind)
    if (amount < floor) throw new Error(`The amount must be at least the dust limit of the recipient's address type (${floor} sat).`)
    const inputWeight = this.inputWeight()
    const feeRate = await this.resolveFeeRate(spend)
    const utxos = await this.requireClient('plan a spend').listUnspent(this.address)
    if (utxos.length === 0) throw new InsufficientFundsError(amount, 0n, 'BTC')
    const own = kindOfType(this.addressType!)
    const selection = selectCoins({
      utxos,
      targets: [{ value: amount, vbytes: outputVBytes(recipient.kind, recipient.script) }],
      feeRate,
      inputWeight,
      changeVBytes: outputVBytes(own),
      changeDust: dustLimit(own),
      maxInputs: this._config.maxInputs ?? MAX_UTXO_INPUTS,
    })
    return { ...selection, amount, recipientScript: recipient.script, recipientKind: recipient.kind }
  }

  async quoteSendTransaction(tx: BtcSpend): Promise<{ fee: bigint }> {
    const { fee } = await this.planSpend(tx)
    return { fee }
  }

  async quoteTransfer(o: BtcTransferOptions): Promise<{ fee: bigint }> {
    if (o.token) throw new Error('Tokens are not supported on the bitcoin blockchain.')
    return this.quoteSendTransaction({ to: o.recipient, value: o.amount })
  }

  /** Everything spendable in ONE transaction to a single output of our own address type, no change. */
  async getMaxSpendable(opts: { feeRate?: bigint | number; confirmationTarget?: number; to?: string } = {}): Promise<BtcMaxSpendableResult> {
    const inputWeight = this.inputWeight()
    const feeRate = await this.resolveFeeRate(opts)
    const utxos = await this.requireClient('plan a spend').listUnspent(this.address)
    const outKind = opts.to ? decodeAddress(opts.to, this._network).kind : kindOfType(this.addressType!)
    const sweep = selectAll({ utxos, feeRate, inputWeight, outputVBytes: outputVBytes(outKind), maxInputs: this._config.maxInputs ?? MAX_UTXO_INPUTS })
    const amount = sweep.amount >= dustLimit(outKind) ? sweep.amount : 0n
    return { amount, fee: amount > 0n ? sweep.fee : 0n, changeValue: 0n, inputs: amount > 0n ? sweep.utxos.length : 0, feeRate }
  }

  /** Undefined until the transaction is mined. */
  async getTransactionReceipt(hash: string): Promise<BtcReceipt | undefined> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The 'getTransactionReceipt(hash)' method requires a valid transaction hash.")
    const client = this.requireClient('fetch transaction receipts')
    const info = client.getTransactionInfo ? await client.getTransactionInfo(hash) : undefined
    if (!info || !info.blockHeight || info.blockHeight <= 0) return undefined
    return {
      hash, status: 1, blockNumber: BigInt(info.blockHeight), confirmations: info.confirmations,
      ...(info.fees !== undefined ? { fee: BigInt(info.fees) } : {}), ...(info.hex !== undefined ? { hex: info.hex } : {}),
    }
  }

  /** BIP-137: recover the key and compare its p2wpkh address with ours. Taproot addresses have no BIP-137 form. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    if (this.addressType === 'p2tr') throw new UnsupportedAddressTypeError('BIP-137 message signatures do not exist for taproot addresses (BIP-322 is not implemented).')
    const rec = recoverMessagePublicKey(message, signature)
    if (!rec || rec.publicKey.length !== 33) return false
    try { return spendInfo(rec.publicKey, this._network, 'p2wpkh').address === this.address } catch { return false }
  }

  /** Chain tip for anti-fee-sniping; undefined when disabled or the transport cannot tell. */
  protected async lockTimeHeight(): Promise<number> {
    if (this._config.antiFeeSniping === false || !this._client?.getBlockHeight) return 0
    try { return await this._client.getBlockHeight() } catch { return 0 }
  }
}
