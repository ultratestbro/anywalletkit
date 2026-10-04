import { NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Buffer } from 'buffer'
import { Address, Cell, SendMode, TonClient, WalletContractV5R1, beginCell, fromNano, internal, toNano, type MessageRelaxed, type OpenedContract } from '@ton/ton'
import { createTonClient } from './client.js'
import { CAIP2, type TonConfig, type TonReceipt, type TonSendable, type TonTransaction, type TonTransferOptions } from './types.js'

const DUMMY_MESSAGE_VALUE = toNano('0.05')
const JETTON_TRANSFER_OP = 0x0f8a7ea5
const DEFAULT_INDEXER = 'https://toncenter.com/api/v3'
const SECRET_KEY_NULL = Buffer.alloc(64)
export const SEND_MODE = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS

const utf8 = (s: string | Uint8Array) => (typeof s === 'string' ? new TextEncoder().encode(s) : s)
const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))

export class WalletAccountReadOnlyTon implements IWalletAccountReadOnly {
  readonly chain: string
  readonly publicKey: Uint8Array
  protected readonly _config: TonConfig
  protected readonly _wallet: WalletContractV5R1
  protected readonly _client: TonClient | undefined
  protected readonly _contract: OpenedContract<WalletContractV5R1> | undefined
  readonly address: string

  constructor(publicKey: Uint8Array | string, config: TonConfig = {}) {
    this.publicKey = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey
    this._config = config
    this._wallet = WalletContractV5R1.create({ workchain: 0, publicKey: Buffer.from(this.publicKey) })
    this.address = this._wallet.address.toString({ bounceable: false })
    this.chain = CAIP2[config.network ?? 'mainnet']
    this._client = createTonClient(config)
    this._contract = this._client?.open(this._wallet)
  }

  protected requireContract(what: string): OpenedContract<WalletContractV5R1> {
    if (!this._contract) throw new NetworkError(`The wallet must be connected to a provider (ton center) to ${what}.`)
    return this._contract
  }
  protected requireClient(what: string): TonClient {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a provider (ton center) to ${what}.`)
    return this._client
  }

  async getAddress(): Promise<string> { return this.address }

  async getBalance(): Promise<bigint> {
    return this.requireContract('get balances').getBalance()
  }

  /** Resolve this wallet's jetton wallet for a jetton master. */
  async getJettonWalletAddress(token: string): Promise<Address> {
    const client = this.requireClient('resolve jetton wallets')
    const { stack } = await client.runMethod(Address.parse(token), 'get_wallet_address', [
      { type: 'slice', cell: beginCell().storeAddress(this._wallet.address).endCell() },
    ])
    return stack.readAddress()
  }

  async getTokenBalance(token: string): Promise<bigint> {
    const client = this.requireClient('get token balances')
    try {
      const jw = await this.getJettonWalletAddress(token)
      const { stack } = await client.runMethod(jw, 'get_wallet_data', [])
      return stack.readBigNumber()
    } catch (e) {
      if (e instanceof Error && e.message.includes('exit_code: -13')) return 0n // jetton wallet not deployed = never received
      throw e
    }
  }

  protected transactionMessage(tx: TonTransaction): MessageRelaxed {
    const { isBounceable } = Address.parseFriendly(tx.to)
    return internal({ to: tx.to, value: fromNano(BigInt(tx.value)), bounce: tx.bounceable ?? isBounceable, body: tx.body ?? '' })
  }

  protected async jettonTransferMessage(o: TonTransferOptions): Promise<MessageRelaxed> {
    const recipient = Address.parse(o.recipient)
    const jw = await this.getJettonWalletAddress(o.token!)
    const body = beginCell()
      .storeUint(JETTON_TRANSFER_OP, 32)
      .storeUint(randomQueryId(), 64)
      .storeCoins(BigInt(o.amount))
      .storeAddress(recipient)
      .storeAddress(this._wallet.address) // response destination (excess TON back to us)
      .storeBit(false) // no custom payload
      .storeCoins(1n) // forward 1 nanoton so the recipient wallet gets a notification
      .storeMaybeRef(null)
      .endCell()
    return internal({ to: jw, value: DUMMY_MESSAGE_VALUE, bounce: true, body })
  }

  /** Unsigned-shape transfer for fee estimation (zero secret key). */
  protected async unsignedTransfer(message: MessageRelaxed): Promise<Cell> {
    const contract = this.requireContract('build transfers')
    const seqno = await contract.getSeqno()
    return contract.createTransfer({ secretKey: SECRET_KEY_NULL, sendMode: SEND_MODE, messages: [message], seqno })
  }

  /** in_fwd + storage + gas + fwd, from toncenter's estimateFee. */
  protected async transferFee(transfer: Cell): Promise<bigint> {
    const client = this.requireClient('quote transfers')
    const addr = this._wallet.address
    const { code, data } = await client.getContractState(addr)
    const { source_fees } = await client.estimateExternalMessageFee(addr, {
      body: transfer, initCode: code ? null : this._wallet.init.code, initData: data ? null : this._wallet.init.data, ignoreSignature: true,
    })
    const { in_fwd_fee, storage_fee, gas_fee, fwd_fee } = source_fees
    return BigInt(in_fwd_fee + storage_fee + gas_fee + fwd_fee)
  }

  async quoteSendTransaction(tx: TonSendable): Promise<{ fee: bigint }> {
    const transfer = tx instanceof Cell ? tx : await this.unsignedTransfer(this.transactionMessage(tx))
    return { fee: await this.transferFee(transfer) }
  }

  async quoteTransfer(o: TonTransferOptions): Promise<{ fee: bigint }> {
    const message = o.token ? await this.jettonTransferMessage(o) : this.transactionMessage({ to: o.recipient, value: o.amount })
    return { fee: await this.transferFee(await this.unsignedTransfer(message)) }
  }

  /**
   * Receipt for a body hash returned by sendTransaction: toncenter v3 maps the
   * message body hash to the account transaction, which is then fetched.
   */
  async getTransactionReceipt(hash: string): Promise<TonReceipt | undefined> {
    const client = this.requireClient('fetch transaction receipts')
    const base = this._config.indexerUrl ?? DEFAULT_INDEXER
    const res = await fetch(`${base}/transactionsByMessage?${new URLSearchParams({ body_hash: hash, limit: '1' })}`)
    if (!res.ok) throw new NetworkError(`toncenter v3 ${res.status}`, { provider: base })
    const { transactions } = (await res.json()) as { transactions?: Array<{ account: string; hash: string; lt: string }> }
    const found = transactions?.[0]
    if (!found) return undefined
    const account = Address.parse(found.account)
    let tx
    try { [tx] = await client.getTransactions(account, { limit: 1, hash: found.hash }) }
    catch { [tx] = await client.getTransactions(account, { limit: 1, lt: found.lt, hash: found.hash, archival: true }) }
    if (!tx) return undefined
    const d = tx.description as { type: string; aborted?: boolean }
    return { hash, status: d.type === 'generic' && !d.aborted ? 1 : 0, blockNumber: tx.lt, transactionHash: tx.hash().toString('base64'), totalFees: tx.totalFees.coins, raw: tx }
  }

  /** ed25519 over the raw message bytes; `signature` hex. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    try { return ed25519.verify(hexToBytes(signature), utf8(message), this.publicKey) } catch { return false }
  }
}

function randomQueryId(): bigint {
  const r = new Uint32Array(2)
  globalThis.crypto.getRandomValues(r)
  return (BigInt(r[0]!) << 32n) | BigInt(r[1]!)
}
