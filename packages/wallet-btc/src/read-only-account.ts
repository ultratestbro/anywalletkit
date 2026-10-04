import { InsufficientFundsError, NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import { coinselect } from '@bitcoinerlab/coinselect'
import { DescriptorsFactory } from '@bitcoinerlab/descriptors'
import * as ecc from '@bitcoinerlab/secp256k1'
import { address as btcAddress, initEccLib, networks, payments, type Network } from 'bitcoinjs-lib'
import { createClient } from './blockbook.js'
import { recoverMessagePublicKey } from './message.js'
import { CAIP2_GENESIS, type BtcClient, type BtcConfig, type BtcNetwork, type BtcReceipt, type BtcSpend, type BtcTransferOptions, type Utxo } from './types.js'

initEccLib(ecc)
const { Output } = DescriptorsFactory(ecc)

/** Same constants so coin selection produces the same inputs, change and fee. */
export const MIN_TX_FEE_SATS = 141n
export const MAX_UTXO_INPUTS = 200
export const DUST_LIMIT_P2WPKH = 294n

export interface SpendPlan {
  utxos: Array<Utxo & { scriptPubKey: Uint8Array }>
  /** Fee the plan pays (sats). */
  fee: bigint
  /** Change back to the account, 0n when folded into the fee. */
  changeValue: bigint
  feeRate: bigint
}

const toBig = (v: bigint | number | string): bigint => (typeof v === 'bigint' ? v : BigInt(Math.round(Number(v))))
export const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

export class WalletAccountReadOnlyBtc implements IWalletAccountReadOnly {
  readonly address: string
  readonly chain: string
  protected readonly _config: BtcConfig
  protected readonly _client: BtcClient | undefined
  protected readonly _network: Network
  protected readonly _networkName: BtcNetwork
  readonly dustLimit = DUST_LIMIT_P2WPKH

  constructor(address: string, config: BtcConfig = {}) {
    this._config = config
    this._networkName = config.network ?? 'bitcoin'
    this._network = networks[this._networkName]
    btcAddress.toOutputScript(address, this._network) // validates
    this.address = address
    this.chain = CAIP2_GENESIS[this._networkName]
    this._client = createClient(config)
  }

  protected requireClient(what: string): BtcClient {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a client to ${what}.`)
    return this._client
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

  protected async resolveFeeRate(spend: BtcSpend): Promise<bigint> {
    if (spend.feeRate !== undefined) return toBig(spend.feeRate) < 1n ? 1n : toBig(spend.feeRate)
    const est = await this.requireClient('estimate fees').estimateFee(spend.confirmationTarget ?? 1)
    return toBig(Math.max(est, 1))
  }

  /** Coin selection with the exact parameters (@bitcoinerlab/coinselect, addr() descriptors, remainder = self). */
  protected async planSpend(spend: BtcSpend): Promise<SpendPlan> {
    const amount = toBig(spend.value)
    const feeRate = await this.resolveFeeRate(spend)
    if (amount <= this.dustLimit) throw new Error(`The amount must be bigger than the dust limit (= ${this.dustLimit}).`)
    btcAddress.toOutputScript(spend.to, this._network) // validate recipient early
    const client = this.requireClient('plan a spend')
    const scriptPubKey = btcAddress.toOutputScript(this.address, this._network)
    const self = new Output({ descriptor: `addr(${this.address})`, network: this._network })
    const target = new Output({ descriptor: `addr(${spend.to})`, network: this._network })
    const unspent = await client.listUnspent(this.address)
    const total = unspent.reduce((s, u) => s + u.value, 0n)
    if (unspent.length === 0) throw new InsufficientFundsError(amount, 0n, 'BTC')
    const result = coinselect({
      utxos: unspent.map((u) => ({ output: self, value: u.value, ref: u })),
      remainder: self,
      targets: [{ output: target, value: amount }],
      feeRate: Number(feeRate),
    })
    if (!result) throw new InsufficientFundsError(amount, total, 'BTC')
    if (result.utxos.length > MAX_UTXO_INPUTS) throw new Error('Exceeded maximum allowed inputs for transaction.')
    const fee = result.fee > MIN_TX_FEE_SATS ? result.fee : MIN_TX_FEE_SATS
    const utxos = (result.utxos as unknown as Array<{ ref: Utxo }>).map(({ ref }) => ({ ...ref, scriptPubKey }))
    const selected = utxos.reduce((s, u) => s + u.value, 0n)
    const changeValue = selected - fee - amount
    if (changeValue < 0n) throw new InsufficientFundsError(amount + fee, selected, 'BTC')
    if (changeValue <= this.dustLimit) return { utxos, fee: fee + changeValue, changeValue: 0n, feeRate }
    return { utxos, fee, changeValue, feeRate }
  }

  async quoteSendTransaction(tx: BtcSpend): Promise<{ fee: bigint }> {
    const { fee } = await this.planSpend(tx)
    return { fee }
  }

  async quoteTransfer(o: BtcTransferOptions): Promise<{ fee: bigint }> {
    if (o.token) throw new Error('Tokens are not supported on the bitcoin blockchain.')
    return this.quoteSendTransaction({ to: o.recipient, value: o.amount })
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

  /** BIP-137: recover the key and compare its p2wpkh address with ours. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    const rec = recoverMessagePublicKey(message, signature)
    if (!rec) return false
    try { return payments.p2wpkh({ pubkey: rec.publicKey, network: this._network }).address === this.address } catch { return false }
  }
}
