import { NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import {
  address, appendTransactionMessageInstructions, compileTransactionMessage, createNoopSigner, createTransactionMessage,
  getAddressEncoder, getBase64Decoder, getBase64Encoder, getCompiledTransactionMessageEncoder,
  isSignature, isTransactionMessageWithBlockhashLifetime, isTransactionMessageWithDurableNonceLifetime,
  pipe, setTransactionMessageFeePayer, setTransactionMessageLifetimeUsingBlockhash,
  type Address, type Instruction, type Transaction, type TransactionMessage,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstruction, getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from '@solana-program/token'
import { createRpc } from './rpc.js'
import { CAIP2_GENESIS, type SolanaConfig, type SolanaReceipt, type SolanaRpc, type SolanaTransaction, type SolanaTransferOptions } from './types.js'

const MAX_U64 = 0xffffffffffffffffn
const utf8 = (s: string) => new TextEncoder().encode(s)
const hexToBytes = (h: string) => Uint8Array.from(h.replace(/^0x/, '').match(/.{2}/g) ?? [], (b) => parseInt(b, 16))

export const isSignedTransaction = (tx: unknown): tx is Transaction =>
  typeof tx === 'object' && tx !== null && 'messageBytes' in tx && 'signatures' in tx
export const isNativeTransfer = (tx: unknown): tx is { to: string; value: bigint | number | string } =>
  typeof tx === 'object' && tx !== null && 'to' in tx && 'value' in tx
export const isTransactionMessage = (tx: unknown): tx is TransactionMessage =>
  typeof tx === 'object' && tx !== null && Array.isArray((tx as TransactionMessage).instructions)

export class WalletAccountReadOnlySolana implements IWalletAccountReadOnly {
  readonly address: Address
  readonly chain: string
  protected readonly _config: SolanaConfig
  protected readonly _rpc: SolanaRpc | undefined
  protected readonly _commitment

  constructor(addr: string, config: SolanaConfig = {}) {
    this.address = address(addr)
    this._config = config
    this._rpc = createRpc(config)
    this._commitment = config.commitment ?? 'confirmed'
    const net = config.network ?? 'mainnet'
    this.chain = CAIP2_GENESIS[net] ?? (net.startsWith('solana:') ? net : `solana:${net}`)
  }

  protected requireRpc(what: string): SolanaRpc {
    if (!this._rpc) throw new NetworkError(`The wallet must be connected to a provider to ${what}.`)
    return this._rpc
  }

  async getAddress(): Promise<string> { return this.address }

  async getBalance(): Promise<bigint> {
    const { value } = await this.requireRpc('retrieve balances').getBalance(this.address, { commitment: this._commitment }).send()
    return value
  }

  protected async ata(mint: Address, owner: Address): Promise<Address> {
    const [ata] = await findAssociatedTokenPda({ mint, owner, tokenProgram: TOKEN_PROGRAM_ADDRESS })
    return ata
  }

  async getTokenBalance(token: string): Promise<bigint> {
    const rpc = this.requireRpc('retrieve token balances')
    const ata = await this.ata(address(token), this.address)
    const info = await rpc.getAccountInfo(ata, { commitment: this._commitment, encoding: 'base64' }).send()
    if (!info.value) return 0n
    const bal = await rpc.getTokenAccountBalance(ata, { commitment: this._commitment }).send()
    return BigInt(bal.value.amount)
  }

  /** Batched over getMultipleAccounts (100 per call); amount read from the SPL account layout at offset 64. */
  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const rpc = this.requireRpc('retrieve token balances')
    const unique = [...new Set(tokens)]
    const atas = await Promise.all(unique.map((t) => this.ata(address(t), this.address)))
    const out: Record<string, bigint> = {}
    const b64 = getBase64Encoder()
    for (let i = 0; i < atas.length; i += 100) {
      const { value } = await rpc.getMultipleAccounts(atas.slice(i, i + 100), { commitment: this._commitment, encoding: 'base64' }).send()
      value.forEach((acc, j) => {
        const token = unique[i + j]!
        if (!acc) { out[token] = 0n; return }
        const bytes = b64.encode(acc.data[0])
        out[token] = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(64, true)
      })
    }
    return out
  }

  protected async latestBlockhash() {
    const { value } = await this.requireRpc('fetch a blockhash').getLatestBlockhash({ commitment: this._commitment }).send()
    return value
  }

  protected async buildNativeTransfer(to: string, value: bigint | number | string): Promise<TransactionMessage> {
    const bh = await this.latestBlockhash()
    const ix = getTransferSolInstruction({ source: createNoopSigner(this.address), destination: address(to), amount: BigInt(value) })
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(this.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions([ix], m),
    ) as TransactionMessage
  }

  protected async buildSplTransfer(token: string, recipient: string, amount: bigint | number | string): Promise<TransactionMessage> {
    const amt = BigInt(amount)
    if (amt > MAX_U64) throw new Error('Amount exceeds u64 maximum value')
    const rpc = this.requireRpc('transfer tokens')
    const mint = address(token)
    const to = address(recipient)
    const [fromAta, toAta] = await Promise.all([this.ata(mint, this.address), this.ata(mint, to)])
    const instructions: Instruction[] = []
    const toInfo = await rpc.getAccountInfo(toAta, { commitment: this._commitment, encoding: 'base64' }).send()
    if (!toInfo.value) instructions.push(getCreateAssociatedTokenIdempotentInstruction({ ata: toAta, mint, owner: to, payer: createNoopSigner(this.address) }))
    instructions.push(getTransferInstruction({ source: fromAta, destination: toAta, authority: createNoopSigner(this.address), amount: amt }))
    const bh = await this.latestBlockhash()
    return pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(this.address, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(bh, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ) as TransactionMessage
  }

  /** Normalise `{to, value}` or a kit message into a message with lifetime + this account as fee payer. */
  protected async prepareMessage(tx: SolanaTransaction): Promise<TransactionMessage> {
    let msg: TransactionMessage
    if (isNativeTransfer(tx)) msg = await this.buildNativeTransfer(tx.to, tx.value)
    else if (isTransactionMessage(tx)) msg = tx
    else throw new Error('Expected a {to, value} transfer or a transaction message.')
    if (!isTransactionMessageWithBlockhashLifetime(msg) && !isTransactionMessageWithDurableNonceLifetime(msg)) {
      msg = setTransactionMessageLifetimeUsingBlockhash(await this.latestBlockhash(), msg) as TransactionMessage
    }
    const payer = (msg as { feePayer?: Address | { address: Address } }).feePayer
    const payerAddress = typeof payer === 'string' ? payer : payer?.address
    if (payerAddress !== undefined && payerAddress !== this.address) {
      throw new Error(`Transaction fee payer (${payerAddress}) does not match wallet address (${this.address})`)
    }
    return setTransactionMessageFeePayer(this.address, msg as never) as TransactionMessage
  }

  protected async feeForMessage(msg: TransactionMessage): Promise<bigint> {
    const b64 = pipe(msg as never, compileTransactionMessage, getCompiledTransactionMessageEncoder().encode, getBase64Decoder().decode)
    return this.feeForBase64(b64)
  }

  protected async feeForBase64(messageBase64: string): Promise<bigint> {
    const { value } = await this.requireRpc('quote transactions').getFeeForMessage(messageBase64 as never, { commitment: this._commitment }).send()
    if (value === null || value === undefined) throw new Error('Failed to calculate transaction fee')
    return BigInt(value)
  }

  async quoteSendTransaction(tx: SolanaTransaction): Promise<{ fee: bigint }> {
    if (isSignedTransaction(tx)) return { fee: await this.feeForBase64(getBase64Decoder().decode(tx.messageBytes)) }
    return { fee: await this.feeForMessage(await this.prepareMessage(tx)) }
  }

  async quoteTransfer(o: SolanaTransferOptions): Promise<{ fee: bigint }> {
    const msg = o.token ? await this.buildSplTransfer(o.token, o.recipient, o.amount) : await this.buildNativeTransfer(o.recipient, o.amount)
    return { fee: await this.feeForMessage(msg) }
  }

  async getTransactionReceipt(hash: string): Promise<SolanaReceipt | undefined> {
    const rpc = this.requireRpc('fetch transaction receipts')
    if (!isSignature(hash)) throw new Error('Invalid signature.')
    const tx = await rpc.getTransaction(hash, { commitment: this._commitment, maxSupportedTransactionVersion: 0, encoding: 'json' }).send()
    if (!tx) return undefined
    return { hash, status: tx.meta?.err ? 0 : 1, blockNumber: BigInt(tx.slot), fee: BigInt(tx.meta?.fee ?? 0), blockTime: tx.blockTime === null || tx.blockTime === undefined ? null : Number(tx.blockTime), err: tx.meta?.err ?? null }
  }

  /** ed25519 over the UTF-8 message; `signature` hex. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    const pub = getAddressEncoder().encode(this.address) as Uint8Array
    try { return ed25519.verify(hexToBytes(signature), typeof message === 'string' ? utf8(message) : message, pub) } catch { return false }
  }
}
