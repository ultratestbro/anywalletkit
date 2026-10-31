import { LocalSigner, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { Buffer } from 'buffer'
import { Cell } from '@ton/core'
import { BroadcastUnknownError, MessageIsTransactionError, SimulationError, UnsafeTransactionError } from './errors.js'
import { isAnsweredRefusal } from './toncenter.js'
import { tonProofDigest, tonSignDataDigest, type TonProof, type TonProofRequest, type TonSignDataRequest, type TonSignedData } from './tonconnect.js'
import { WalletAccountReadOnlyTon } from './read-only-account.js'
import { parseV5R1Body, v5r1ExternalMessage, v5r1PackSigned, v5r1PackUnsigned, type V5R1Message } from './wallet-v5r1.js'
import { drainModes, sendModeOf } from './describe.js'
import type { TonConfig, TonSendable, TonTransferOptions } from './types.js'

/** How long a send waits, by default, for the previous transfer to move the seqno. */
export const PENDING_SEQNO_TIMEOUT_MS = 60_000
/** Pause between seqno reads while that wait runs. */
export const PENDING_SEQNO_POLL_MS = 1_500

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/** Does `bytes` carry `key` anywhere? A Solana transaction names each signer's 32-byte key. */
const carriesKey = (bytes: Uint8Array, key: Uint8Array): boolean => {
  outer: for (let i = 0; i + key.length <= bytes.length; i++) {
    for (let j = 0; j < key.length; j++) if (bytes[i + j] !== key[j]) continue outer
    return true
  }
  return false
}

/**
 * Signing TON account on Wallet V5R1. It never holds a key: the V5R1 body is
 * signed by `signer.sign(signingCell.hash(), {scheme: 'ed25519', context:
 * 'ton-external'})` — a {@link LocalSigner} for seed wallets, anything else
 * (hardware, MPC, backend) through `externalSigner()`.
 *
 * Every send runs: hard checks → fresh seqno → preflight on the zero-signed
 * body (estimateFee, emulation when configured, fee cap) → sign → broadcast.
 * The preflight body carries a zero signature, so the signer is only asked
 * once the transaction has passed.
 */
export class WalletAccountTon extends WalletAccountReadOnlyTon implements IWalletAccount {
  /** seqno and fees come from the network before signing. */
  readonly needsNetwork = true
  /** Derivation path, `ton-mnemonic`, or `external`. */
  readonly path: string
  /**
   * The signer that holds the key, in a private field: not a property of the account, so no code
   * the account is handed to (a protocol module, a logger) can reach it and sign around the
   * account's checks (audit 2026-10-29 A1).
   */
  readonly #signer: Signer
  /** What holds the key: `seed`, `key` (one imported key) or `external`. */
  readonly signerKind: Signer['kind']
  private _readOnly: WalletAccountReadOnlyTon | undefined
  /**
   * The last external this account broadcast (accepted, or maybe sent) and when it expires. Until
   * the wallet's seqno moves past it, a new message signed at the chain seqno would carry the same
   * seqno and silently never execute, so the next send waits for it first.
   */
  private _inFlight: { seqno: number; validUntil: number } | undefined
  /** Tail of this account's send queue: seqno → sign → broadcast runs one send at a time. */
  private _sendTail: Promise<unknown> = Promise.resolve()

  /** `publicKey` is the signer's 32-byte ed25519 key; the V5R1 address derives from it synchronously. */
  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: TonConfig = {}) {
    super(publicKey, config)
    this.#signer = requireCurve(signer, 'ed25519')
    this.signerKind = this.#signer.kind
    this.path = path
  }

  /** Back-compat: wrap a raw derived key in a {@link LocalSigner} (the account takes ownership; it cannot derive). */
  static fromPrivateKey(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: TonConfig = {}): WalletAccountTon {
    return new WalletAccountTon(LocalSigner.fromPrivateKey('ed25519', privateKey, publicKey, path), publicKey, path, config)
  }

  /** Account index for the standard m/44'/607'/i' path. */
  get index(): number | undefined {
    const m = /^m\/44'\/607'\/(\d+)'$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  /**
   * Hex ed25519 signature over the raw message bytes. A 32-byte message — string or bytes — is
   * refused with {@link MessageIsTransactionError}: the wallet contract checks a transfer's
   * signature over the 32-byte hash of its signing cell, so those bytes could be one. Bytes that
   * carry this account's public key are refused as well: one ed25519 key (an external signer) may
   * also be a Solana wallet, and a Solana transaction names its signer's key. TON Connect goes
   * through {@link signTonProof} and {@link signTonConnectData}.
   */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    if (bytes.length === 32 || carriesKey(bytes, this.publicKey)) throw new MessageIsTransactionError()
    return toHex(await this.#signer.sign(bytes, { scheme: 'ed25519', context: 'ton-message' }))
  }

  /**
   * TON Connect `ton_proof` for this wallet's address: the `proof` object of the connect reply. The
   * digest is built here (0xffff ‖ "ton-connect" ‖ …), so no request can turn it into a transfer.
   * `domain` is the host the wallet saw the request come from.
   */
  async signTonProof(request: TonProofRequest): Promise<TonProof> {
    const digest = tonProofDigest(this._address, request)
    const signature = await this.#signer.sign(digest, { scheme: 'ed25519', context: 'ton-proof' })
    return {
      timestamp: request.timestamp,
      domain: { lengthBytes: new TextEncoder().encode(request.domain).length, value: request.domain },
      payload: request.payload,
      signature: Buffer.from(signature).toString('base64'),
    }
  }

  /** TON Connect `signData` (text / binary) for this wallet's address: the reply the dApp gets. */
  async signTonConnectData(request: TonSignDataRequest): Promise<TonSignedData> {
    const digest = tonSignDataDigest(this._address, request)
    const signature = await this.#signer.sign(digest, { scheme: 'ed25519', context: 'ton-sign-data' })
    return {
      signature: Buffer.from(signature).toString('base64'),
      address: this._address.toRawString(),
      timestamp: request.timestamp,
      domain: request.domain,
      payload: request.payload.type === 'text' ? { type: 'text', text: request.payload.text } : { type: 'binary', bytes: request.payload.bytes },
    }
  }

  private checkMaxFee(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /**
   * Checks → seqno → preflight → signed body. The preflight runs on the
   * zero-signed body (ignore_chksig), so nothing is signed before it passes.
   */
  /**
   * Refuse send modes that drain the wallet — 128 (the whole remaining balance) and 32 (the account
   * destroyed once empty) — unless `allowDrainingTransactions`. Checked locally, before any seqno or
   * emulation, so it holds with `simulate: false` too (round 3, M11); the emulation check stays.
   */
  private assertNoDrain(modes: number[]): void {
    if (this._config.allowDrainingTransactions === true) return
    const found = modes.flatMap(drainModes)
    if (found.length) throw new UnsafeTransactionError('drain', `Refusing a message with send mode ${found.includes('carries-all-balance') ? '128 (it carries the whole remaining balance)' : '32 (it destroys the wallet account once empty)'}; set allowDrainingTransactions to override.`)
  }

  /** The send modes of a prebuilt V5R1 body; an unreadable body is left to the emulation and the node. */
  private bodyModes(body: Cell): number[] {
    return parseV5R1Body(body)?.messages.map((m) => m.mode) ?? []
  }

  /**
   * The seqno to sign the next send at: the chain's, once it has moved past this account's last
   * broadcast. While that external can still land (before its valid_until) the seqno is polled, up
   * to `pendingSeqnoTimeoutMs`; an expired one that never landed is forgotten.
   */
  async #nextSendSeqno(): Promise<number> {
    const timeout = this._config.pendingSeqnoTimeoutMs ?? PENDING_SEQNO_TIMEOUT_MS
    const deadline = Date.now() + timeout
    for (;;) {
      const chain = await this.getSeqno()
      const prev = this._inFlight
      if (!prev || chain > prev.seqno || Date.now() / 1000 > prev.validUntil) {
        this._inFlight = undefined
        return chain
      }
      if (Date.now() >= deadline) throw new Error(`The previous transfer is still pending (seqno ${prev.seqno} has not moved): wait for it to land, then send again.`)
      await new Promise((resolve) => setTimeout(resolve, Math.min(PENDING_SEQNO_POLL_MS, Math.max(0, deadline - Date.now()))))
    }
  }

  async #signMessages(messages: V5R1Message[], limit: bigint | number | undefined, op: string, forSend = false): Promise<{ body: Cell; fee: bigint }> {
    this.assertNoDrain(messages.map((m) => sendModeOf(m.mode)))
    // The wallet sends with IGNORE_ERRORS: a message whose value exceeds the
    // balance is silently dropped by the action phase — the external still
    // "succeeds", the seqno moves, the fee is paid and nothing leaves
    // (2026-10-09: a 2 GRAM deposit on a 0.46 GRAM balance). Refuse up front,
    // and again after emulation if the risk shows less TON leaving than asked.
    const want = messages.reduce((sum, m) => sum + (m.message.info.type === 'internal' ? m.message.info.value.coins : 0n), 0n)
    if (want > 0n) {
      const balance = await this.getBalance()
      if (balance < want) throw new UnsafeTransactionError('insufficient-balance', `Insufficient TON balance: the messages carry ${want} nanotons, the wallet holds ${balance} (fees come on top).`)
    }
    const { signing } = await this.signingCell(messages, forSend ? await this.#nextSendSeqno() : undefined)
    const fee = await this.preflight(v5r1PackUnsigned(signing), limit, op, want)
    const signature = await this.#signer.sign(new Uint8Array(signing.hash()), { scheme: 'ed25519', context: 'ton-external' })
    return { body: v5r1PackSigned(signing, signature), fee }
  }

  private async preflight(body: Cell, limit: bigint | number | undefined, op: string, expectedTonOut?: bigint): Promise<bigint> {
    if (this._config.simulate === false) {
      if (limit === undefined) return 0n
      const fee = (await this.estimateFees(body)).total
      this.checkMaxFee(fee, limit, op)
      return fee
    }
    const sim = await this.simulateBody(body)
    if (!sim.ok) throw new SimulationError(sim.reason, { ...(sim.exitCode !== undefined ? { exitCode: sim.exitCode } : {}), ...(sim.aborted !== undefined ? { aborted: sim.aborted } : {}) })
    if (sim.risk?.transferAllRemainingBalance && this._config.allowDrainingTransactions !== true) {
      throw new UnsafeTransactionError('drain', 'Refusing a message that carries the whole remaining balance (send mode 128); set allowDrainingTransactions to override.')
    }
    if (expectedTonOut !== undefined && sim.risk && sim.risk.ton < expectedTonOut) {
      throw new SimulationError(`The emulation shows only ${sim.risk.ton} nanotons leaving the wallet for messages carrying ${expectedTonOut}: a message would be dropped (insufficient balance for value + fees).`)
    }
    this.checkMaxFee(sim.fees.total, limit, op)
    return sim.fees.total
  }

  /** Sign without broadcasting. Returns the external-message BODY as base64 BoC (pass it back to sendTransaction as a Cell). */
  async signTransaction(tx: TonSendable, options: WriteOptions = {}): Promise<string> {
    if (tx instanceof Cell) {
      this.assertNoDrain(this.bodyModes(tx))
      await this.preflight(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
      return tx.toBoc().toString('base64')
    }
    const { body } = await this.#signMessages(this.toMessages(tx), feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return body.toBoc().toString('base64')
  }

  private async broadcast(body: Cell): Promise<string> {
    const rpc = this.requireRpc('send transactions')
    const init = await this.initIfNeeded()
    const hash = body.hash().toString('hex')
    const parsed = parseV5R1Body(body)
    const sent = (): void => {
      if (parsed) this._inFlight = { seqno: parsed.seqno, validUntil: parsed.validUntil }
    }
    try {
      await rpc.sendBoc(v5r1ExternalMessage(this._address, body, init))
    } catch (e) {
      // Only a node's explicit refusal means nothing went out (round 3, M12).
      if (isAnsweredRefusal(e)) throw e
      sent()
      throw new BroadcastUnknownError(hash, e)
    }
    sent()
    return hash
  }

  /**
   * One send at a time per account: two sends started together would read the same seqno before
   * either is broadcast. A failed send does not block the next.
   */
  #serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this._sendTail.then(run)
    this._sendTail = next.then(() => undefined, () => undefined)
    return next
  }

  /** Sign and broadcast; `hash` is the body hash (hex) — resolve it with getTransactionReceipt. */
  sendTransaction(tx: TonSendable, options: WriteOptions = {}): Promise<TransferResult> {
    return this.#serial(() => this.#sendTransactionNow(tx, options))
  }

  async #sendTransactionNow(tx: TonSendable, options: WriteOptions): Promise<TransferResult> {
    this.requireRpc('send transactions')
    if (tx instanceof Cell) this.assertNoDrain(this.bodyModes(tx))
    const { body, fee } = tx instanceof Cell
      ? { body: tx, fee: await this.preflight(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction') }
      : await this.#signMessages(this.toMessages(tx), feeLimit(this._config.transactionMaxFee, options), 'transaction', true)
    return { hash: await this.broadcast(body), fee }
  }

  /** TON (no `token`) or jetton transfer. */
  transfer(o: TonTransferOptions, writeOptions: WriteOptions = {}): Promise<TransferResult> {
    return this.#serial(() => this.#transferNow(o, writeOptions))
  }

  async #transferNow(o: TonTransferOptions, writeOptions: WriteOptions): Promise<TransferResult> {
    this.requireRpc('transfer tokens')
    const message = o.token ? await this.jettonTransferMessage(o) : this.transactionMessage({ to: o.recipient, value: o.amount, ...(o.memo !== undefined ? { body: o.memo } : {}) })
    const { body, fee } = await this.#signMessages([message], feeLimit(this._config.transferMaxFee, writeOptions), 'transfer', true)
    return { hash: await this.broadcast(body), fee }
  }

  /** The same wallet as a {@link WalletAccountReadOnlyTon}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTon(this.publicKey, this._config)
    return this._readOnly
  }

  /** Disposes the signer: a local key is zeroized, an external one is released. */
  dispose(): void {
    this.#signer.dispose()
  }
}
