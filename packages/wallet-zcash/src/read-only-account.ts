import { InsufficientFundsError, NetworkError, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { DUST_LIMIT, addressFromPublicKey, decodeAddress, outputSize, type DecodedAddress } from './address.js'
import { createClient } from './client.js'
import { DEFAULT_MAX_FEE } from './describe.js'
import { MAX_UTXO_INPUTS, selectAll, selectCoins, type CoinSelection } from './fee.js'
import { recoverMessagePublicKey } from './message.js'
import { CAIP2, type ZcashClient, type ZcashConfig, type ZcashMaxSpendableResult, type ZcashNetwork, type ZcashReceipt, type ZcashSpend, type ZcashTransferOptions } from './types.js'

/** A coin selection for one spend, with the decoded recipient. */
export interface SpendPlan extends CoinSelection {
  /** Zatoshis the recipient gets (the requested value — never reduced). */
  amount: bigint
  recipient: DecodedAddress
}

const toBig = (v: bigint | number | string): bigint => (typeof v === 'bigint' ? v : BigInt(typeof v === 'string' ? v.trim() : Math.round(v)))

/** Watch-only Zcash account: balances, quotes, receipts, message verification. No key. */
export class WalletAccountReadOnlyZcash implements IWalletAccountReadOnly {
  /** The transparent address. */
  readonly address: string
  readonly chain: string
  /** The address's scriptPubKey. */
  readonly scriptPubKey: Uint8Array
  /** Script type of the address. */
  readonly scriptKind: DecodedAddress['kind']
  protected readonly _config: ZcashConfig
  protected readonly _client: ZcashClient | undefined
  protected readonly _network: ZcashNetwork

  constructor(address: string, config: ZcashConfig = {}) {
    this._config = config
    this._network = config.network ?? 'mainnet'
    const decoded = decodeAddress(address, this._network)
    this.address = address.trim()
    this.scriptPubKey = decoded.script
    this.scriptKind = decoded.kind
    this.chain = CAIP2[this._network]
    this._client = createClient(config)
  }

  protected requireClient(what: string): ZcashClient {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a client to ${what}.`)
    return this._client
  }

  /** Fee ceiling in zatoshis: `ZcashConfig.maxFee` or the default. */
  get maxFee(): bigint {
    return this._config.maxFee !== undefined ? toBig(this._config.maxFee) : DEFAULT_MAX_FEE
  }

  /** The transparent address. */
  async getAddress(): Promise<string> { return this.address }

  /** Confirmed plus incoming mempool value (the transports do not expose pending spends of our own outputs). */
  async getBalance(): Promise<bigint> {
    const { confirmed, unconfirmed } = await this.requireClient('read balances').getBalance(this.address)
    return confirmed + unconfirmed
  }

  /** Always throws: Zcash has no tokens. */
  async getTokenBalance(_token: string): Promise<bigint> {
    throw new Error("The 'getTokenBalance' method is not supported on the zcash blockchain.")
  }

  /** Coin selection for a spend (ZIP-317 fee). Validates the recipient and the dust floor first. */
  protected async planSpend(spend: ZcashSpend): Promise<SpendPlan> {
    if (this.scriptKind !== 'p2pkh') throw new Error(`Cannot build spends from a ${this.scriptKind} address; only P2PKH (t1…) accounts spend.`)
    const amount = toBig(spend.value)
    const recipient = decodeAddress(spend.to, this._network)
    if (amount < DUST_LIMIT) throw new Error(`The amount must be at least the dust limit (${DUST_LIMIT} zatoshis).`)
    const utxos = await this.requireClient('plan a spend').listUnspent(this.address)
    if (utxos.length === 0) throw new InsufficientFundsError(amount, 0n, 'ZEC')
    const selection = selectCoins({
      utxos,
      target: amount,
      recipientOutputSize: outputSize(recipient.script),
      changeOutputSize: outputSize(this.scriptPubKey),
      maxInputs: this._config.maxInputs ?? MAX_UTXO_INPUTS,
      ...(spend.fee !== undefined ? { fee: toBig(spend.fee) } : {}),
    })
    return { ...selection, amount, recipient }
  }

  /** ZIP-317 fee of a spend in zatoshis. */
  async quoteSendTransaction(tx: ZcashSpend): Promise<{ fee: bigint }> {
    const { fee } = await this.planSpend(tx)
    return { fee }
  }

  /** ZIP-317 fee of a transfer in zatoshis. */
  async quoteTransfer(o: ZcashTransferOptions): Promise<{ fee: bigint }> {
    if (o.token) throw new Error('Tokens are not supported on the zcash blockchain.')
    return this.quoteSendTransaction({ to: o.recipient, value: o.amount })
  }

  /** Everything spendable in ONE transaction to a single output, no change. */
  async getMaxSpendable(opts: { to?: string; fee?: bigint | number } = {}): Promise<ZcashMaxSpendableResult> {
    const utxos = await this.requireClient('plan a spend').listUnspent(this.address)
    const outScript = opts.to ? decodeAddress(opts.to, this._network).script : this.scriptPubKey
    const sweep = selectAll({ utxos, outputSize: outputSize(outScript), maxInputs: this._config.maxInputs ?? MAX_UTXO_INPUTS, ...(opts.fee !== undefined ? { fee: toBig(opts.fee) } : {}) })
    const amount = sweep.amount >= DUST_LIMIT ? sweep.amount : 0n
    return { amount, fee: amount > 0n ? sweep.fee : 0n, changeValue: 0n, inputs: amount > 0n ? sweep.utxos.length : 0 }
  }

  /** Undefined until the transaction is mined. */
  async getTransactionReceipt(hash: string): Promise<ZcashReceipt | undefined> {
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) throw new Error("The 'getTransactionReceipt(hash)' method requires a valid transaction hash.")
    const info = await this.requireClient('fetch transaction receipts').getTransactionInfo(hash)
    if (!info || info.blockHeight <= 0) return undefined
    return { hash, status: 1, blockNumber: BigInt(info.blockHeight), confirmations: info.confirmations, ...(info.fee !== undefined ? { fee: info.fee } : {}) }
  }

  /** Recover the key from a Zcash message signature and compare its P2PKH address with ours. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    const pub = recoverMessagePublicKey(message, signature)
    if (!pub) return false
    try { return addressFromPublicKey(pub, this._network) === this.address } catch { return false }
  }

  /** Chain tip for lock time / expiry; undefined when the transport cannot tell. */
  protected async tipHeight(): Promise<number | undefined> {
    if (!this._client) return undefined
    try { return await this._client.getBlockHeight() } catch { return undefined }
  }
}
