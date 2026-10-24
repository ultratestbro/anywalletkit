import { NetworkError, type IWalletAccountReadOnly } from '@anywalletkit/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Address, Cell, beginCell, internal, loadStateInit, type StateInit } from '@ton/core'
import { commentCell, describeTransaction, type TonDescription } from './describe.js'
import { UnsafeTransactionError } from './errors.js'
import { TonCenter, createTonRpc } from './toncenter.js'
import { runEmulation } from './emulation.js'
import {
  DEFAULT_SEND_MODE, MAINNET_GLOBAL_ID, TESTNET_GLOBAL_ID, v5r1Address, v5r1ExternalMessage, v5r1PackUnsigned, v5r1SigningMessage, v5r1StateInit, v5r1WalletId,
  type V5R1Message,
} from './wallet-v5r1.js'
import { CAIP2, type TonConfig, type TonFees, type TonReceipt, type TonSendable, type TonSimulation, type TonTransaction, type TonTransferOptions } from './types.js'

const JETTON_TRANSFER_OP = 0x0f8a7ea5
const DEFAULT_JETTON_ATTACHED = 50_000_000n // 0.05 TON
const DEFAULT_INDEXER = 'https://toncenter.com/api/v3'
const DEFAULT_VALID_SECONDS = 60
const MAX_VALID_SECONDS = 600
/** PAY_GAS_SEPARATELY | IGNORE_ERRORS, the mode every action in an external carries. */
export const SEND_MODE = DEFAULT_SEND_MODE

const utf8 = (s: string | Uint8Array) => (typeof s === 'string' ? new TextEncoder().encode(s) : s)
const hexToBytes = (h: string) => Uint8Array.from(h.match(/.{2}/g) ?? [], (b) => parseInt(b, 16))
const big = (v: bigint | number | string) => BigInt(v)

/**
 * A TON V5R1 wallet without a key: balance, jetton balances, seqno, fee estimates, emulation,
 * receipts and signature checks.
 */
export class WalletAccountReadOnlyTon implements IWalletAccountReadOnly {
  readonly chain: string
  /** Ed25519 public key the wallet is derived from. */
  readonly publicKey: Uint8Array
  /** User-friendly address. */
  readonly address: string
  protected readonly _config: TonConfig
  protected readonly _walletId: bigint
  protected readonly _init: StateInit
  protected readonly _address: Address
  protected readonly _rpc: TonCenter | undefined

  constructor(publicKey: Uint8Array | string, config: TonConfig = {}) {
    this.publicKey = typeof publicKey === 'string' ? hexToBytes(publicKey) : publicKey
    this._config = config
    // The network_global_id inside wallet_id is the only thing that binds a signed external to one
    // network: a testnet wallet must carry -3, or every external it signs is also valid on mainnet
    // (same state init, address and wallet_id). It follows config.network; a contradicting override is refused.
    const networkGlobalId = config.network === 'testnet' ? TESTNET_GLOBAL_ID : MAINNET_GLOBAL_ID
    if (config.walletId?.networkGlobalId !== undefined && config.walletId.networkGlobalId !== networkGlobalId) {
      throw new UnsafeTransactionError('network-mismatch', `walletId.networkGlobalId ${config.walletId.networkGlobalId} contradicts network '${config.network ?? 'mainnet'}' (expected ${networkGlobalId}): externals signed this way would be valid on the other network.`)
    }
    this._walletId = v5r1WalletId({ networkGlobalId, ...(config.walletId?.subwalletNumber !== undefined ? { subwalletNumber: config.walletId.subwalletNumber } : {}) })
    this._init = v5r1StateInit(this.publicKey, this._walletId)
    this._address = v5r1Address(this.publicKey, { walletId: this._walletId })
    this.address = this._address.toString({ bounceable: false, testOnly: config.network === 'testnet' })
    this.chain = CAIP2[config.network ?? 'mainnet']
    const rpc = createTonRpc(config)
    this._rpc = rpc ? new TonCenter(rpc) : undefined
  }

  protected requireRpc(what: string): TonCenter {
    if (!this._rpc) throw new NetworkError(`The wallet must be connected to a provider (toncenter) to ${what}.`)
    return this._rpc
  }

  /** The user-friendly address. */
  async getAddress(): Promise<string> { return this.address }

  /** Native balance in nanotons. */
  async getBalance(): Promise<bigint> {
    return (await this.requireRpc('get balances').getAddressInformation(this._address)).balance
  }

  /** Current seqno — 0 until the wallet contract is deployed. Always fetched fresh. */
  async getSeqno(): Promise<number> {
    const rpc = this.requireRpc('read the seqno')
    const state = await rpc.getAddressInformation(this._address)
    if (state.state !== 'active') return 0
    return (await rpc.runGetMethodOk(this._address, 'seqno')).stack.readNumber()
  }

  /** Resolve this wallet's jetton wallet for a jetton master. */
  async getJettonWalletAddress(token: string): Promise<Address> {
    const rpc = this.requireRpc('resolve jetton wallets')
    const r = await rpc.runGetMethodOk(Address.parse(token), 'get_wallet_address', [
      { type: 'slice', cell: beginCell().storeAddress(this._address).endCell() },
    ])
    return r.stack.readAddress()
  }

  /**
   * Read a jetton wallet and prove it is ours for `token`: `get_wallet_data`
   * must name this wallet as owner and `token` as master. The master's own
   * `get_wallet_address` answer is not trusted on its own — a fake master could
   * point at our real wallet of another jetton (e.g. USDT).
   */
  protected async jettonWalletData(token: string, jw: Address): Promise<bigint> {
    const stack = (await this.requireRpc('read jetton wallets').runGetMethodOk(jw, 'get_wallet_data')).stack
    const balance = stack.readBigNumber()
    const owner = stack.readAddress()
    const master = stack.readAddress()
    if (!owner.equals(this._address) || !master.equals(Address.parse(token))) {
      throw new UnsafeTransactionError('jetton-wallet', `The jetton wallet ${jw.toString()} does not belong to this wallet for ${token}.`)
    }
    return balance
  }

  /**
   * Jetton balance in base units, read from this wallet's jetton wallet; 0 when it does not exist.
   */
  async getTokenBalance(token: string): Promise<bigint> {
    const rpc = this.requireRpc('get token balances')
    const jw = await this.getJettonWalletAddress(token)
    if ((await rpc.getAddressInformation(jw)).state !== 'active') return 0n // never received this jetton
    return this.jettonWalletData(token, jw)
  }

  // ── Message building ──────────────────────────────────────────────────────

  protected stateInitOf(src: TonTransaction['stateInit']): StateInit | undefined {
    if (src === undefined) return undefined
    if (typeof src === 'string') return loadStateInit(Cell.fromBase64(src).beginParse())
    if (src instanceof Cell) return loadStateInit(src.beginParse())
    return src
  }

  protected transactionMessage(tx: TonTransaction): V5R1Message {
    const value = big(tx.value)
    if (value <= 0n) throw new UnsafeTransactionError('zero-value', 'TON message value must be positive.')
    let address: Address
    let bounceable = true
    let testOnly: boolean | undefined
    if (Address.isFriendly(tx.to)) {
      const f = Address.parseFriendly(tx.to)
      address = f.address; bounceable = f.isBounceable; testOnly = f.isTestOnly
    } else {
      address = Address.parse(tx.to)
    }
    if (address.workChain !== 0 && address.workChain !== -1) throw new UnsafeTransactionError('exotic-workchain', `Refusing to send to workchain ${address.workChain}.`)
    const testnet = this._config.network === 'testnet'
    if (testOnly !== undefined && testOnly !== testnet) {
      throw new UnsafeTransactionError('network-mismatch', testOnly ? 'Test-only address on a mainnet wallet.' : 'Mainnet address on a testnet wallet.')
    }
    const body = tx.body instanceof Cell ? tx.body : typeof tx.body === 'string' ? (tx.body === '' ? undefined : commentCell(tx.body)) : tx.bodyBoc ? Cell.fromBase64(tx.bodyBoc) : undefined
    const init = this.stateInitOf(tx.stateInit)
    const message = internal({ to: address, value, bounce: tx.bounceable ?? bounceable, ...(body ? { body } : {}), ...(init ? { init } : {}) })
    return { message, ...(tx.sendMode !== undefined ? { mode: tx.sendMode } : {}) }
  }

  protected async jettonTransferMessage(o: TonTransferOptions): Promise<V5R1Message> {
    const amount = big(o.amount)
    if (amount <= 0n) throw new UnsafeTransactionError('zero-value', 'Jetton amount must be positive.')
    const recipient = Address.parse(o.recipient)
    const jw = await this.getJettonWalletAddress(o.token!)
    await this.jettonWalletData(o.token!, jw)
    const forwardTonAmount = o.forwardTonAmount !== undefined ? big(o.forwardTonAmount) : 1n
    if (o.memo !== undefined && o.forwardPayload !== undefined) throw new UnsafeTransactionError('memo-and-payload', 'Pass either memo or forwardPayload, not both: a jetton transfer carries one forward payload.')
    const payload = o.forwardPayload ?? o.memo
    const forwardPayload = payload === undefined ? null : typeof payload === 'string' ? commentCell(payload) : payload
    const body = beginCell()
      .storeUint(JETTON_TRANSFER_OP, 32)
      .storeUint(o.queryId !== undefined ? BigInt(o.queryId) : randomQueryId(), 64)
      .storeCoins(amount)
      .storeAddress(recipient)
      .storeAddress(o.responseDestination ? Address.parse(o.responseDestination) : this._address)
      .storeMaybeRef(o.customPayload ?? null)
      .storeCoins(forwardTonAmount)
      .storeMaybeRef(forwardPayload) // either-ref form: payloads always travel in a ref
      .endCell()
    const attached = o.attachedValue !== undefined
      ? big(o.attachedValue)
      : (this._config.jettonAttachedValue !== undefined ? big(this._config.jettonAttachedValue) : DEFAULT_JETTON_ATTACHED) + forwardTonAmount
    return { message: internal({ to: jw, value: attached, bounce: true, body }) }
  }

  protected toMessages(tx: TonTransaction | TonTransaction[]): V5R1Message[] {
    const list = Array.isArray(tx) ? tx : [tx]
    if (list.length === 0) throw new UnsafeTransactionError('empty', 'Nothing to send.')
    return list.map((t) => this.transactionMessage(t))
  }

  protected validUntil(): number {
    const seconds = this._config.validUntilSeconds ?? DEFAULT_VALID_SECONDS
    if (!Number.isInteger(seconds) || seconds <= 0 || seconds > MAX_VALID_SECONDS) {
      throw new UnsafeTransactionError('valid-until', `validUntilSeconds must be an integer between 1 and ${MAX_VALID_SECONDS}.`)
    }
    return Math.floor(Date.now() / 1000) + seconds
  }

  /** The cell to sign for `messages` at the CURRENT seqno (fetched fresh every time). */
  protected async signingCell(messages: V5R1Message[]): Promise<{ signing: Cell; seqno: number; validUntil: number }> {
    const seqno = await this.getSeqno()
    const validUntil = this.validUntil()
    return { signing: v5r1SigningMessage({ walletId: this._walletId, validUntil, seqno, messages }), seqno, validUntil }
  }

  // ── Fees / preflight ──────────────────────────────────────────────────────

  /** StateInit to attach to an external when the wallet is not deployed yet. */
  protected async initIfNeeded(): Promise<StateInit | undefined> {
    const state = await this.requireRpc('read the account state').getAddressInformation(this._address)
    return state.state === 'active' ? undefined : this._init
  }

  /** in_fwd + storage + gas + fwd from toncenter's estimateFee (signature ignored). */
  async estimateFees(body: Cell): Promise<TonFees> {
    const rpc = this.requireRpc('quote transfers')
    const init = await this.initIfNeeded()
    return rpc.estimateFee(this._address, { body, ...(init ? { init } : {}), ignoreSignature: true })
  }

  /**
   * Preflight an external body: fees via estimateFee and, unless
   * `config.emulate === false`, a trace emulation (tonapi by default, see
   * {@link TonConfig.emulate}) whose compute/action phases — and the first-hop
   * internal messages — decide `ok`. Never throws for a failing emulation,
   * only for transport problems or a malformed emulator response.
   */
  async simulateBody(body: Cell): Promise<TonSimulation> {
    const fees = await this.estimateFees(body)
    const init = await this.initIfNeeded()
    const outcome = await runEmulation(this._config, v5r1ExternalMessage(this._address, body, init))
    if (!outcome) return { ok: true, fees, emulated: false, source: 'estimate-only', warnings: [] }
    const common = {
      fees, emulated: true as const, source: outcome.source, warnings: outcome.warnings,
      ...(outcome.exitCode !== undefined ? { exitCode: outcome.exitCode } : {}),
      ...(outcome.risk ? { risk: outcome.risk } : {}),
    }
    if (outcome.ok) return { ok: true, ...common, ...(outcome.actionSuccess !== undefined ? { actionSuccess: outcome.actionSuccess } : {}) }
    return { ok: false, ...common, reason: outcome.reason ?? 'emulation failed', ...(outcome.aborted !== undefined ? { aborted: outcome.aborted } : {}) }
  }

  /** Preflight a {@link TonSendable} (unsigned body, current seqno). */
  async simulateTransaction(tx: TonSendable): Promise<TonSimulation> {
    const body = tx instanceof Cell ? tx : v5r1PackUnsigned((await this.signingCell(this.toMessages(tx))).signing)
    return this.simulateBody(body)
  }

  /** Estimated fee of a transaction, in nanotons. */
  async quoteSendTransaction(tx: TonSendable): Promise<{ fee: bigint }> {
    const body = tx instanceof Cell ? tx : v5r1PackUnsigned((await this.signingCell(this.toMessages(tx))).signing)
    return { fee: (await this.estimateFees(body)).total }
  }

  /** Estimated fee of a transfer, in nanotons. */
  async quoteTransfer(o: TonTransferOptions): Promise<{ fee: bigint }> {
    const message = o.token ? await this.jettonTransferMessage(o) : this.transactionMessage({ to: o.recipient, value: o.amount, ...(o.memo !== undefined ? { body: o.memo } : {}) })
    const { signing } = await this.signingCell([message])
    return { fee: (await this.estimateFees(v5r1PackUnsigned(signing))).total }
  }

  /** Offline description of what `tx` does — see {@link describeTransaction}. */
  describe(tx: TonSendable): TonDescription {
    return describeTransaction(tx, { network: this._config.network ?? 'mainnet' })
  }

  /**
   * Receipt for a body hash returned by sendTransaction: toncenter v3 maps the
   * message body hash to the account transaction, which is then fetched.
   */
  async getTransactionReceipt(hash: string): Promise<TonReceipt | undefined> {
    const rpc = this.requireRpc('fetch transaction receipts')
    const base = this._config.indexerUrl ?? DEFAULT_INDEXER
    const doFetch = this._config.fetch ?? globalThis.fetch
    const res = await doFetch(`${base}/transactionsByMessage?${new URLSearchParams({ body_hash: hash, limit: '1' })}`, { signal: AbortSignal.timeout(this._config.timeoutMs ?? 15_000) })
    if (!res.ok) throw new NetworkError(`toncenter v3 ${res.status}`, { provider: base })
    const { transactions } = (await res.json()) as { transactions?: Array<{ account: string; hash: string; lt: string }> }
    const found = transactions?.[0]
    if (!found) return undefined
    const account = Address.parse(found.account)
    let tx
    try { [tx] = await rpc.getTransactions(account, { limit: 1, hash: found.hash }) }
    catch { [tx] = await rpc.getTransactions(account, { limit: 1, lt: found.lt, hash: found.hash, archival: true }) }
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
