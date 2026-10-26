import { LocalSigner, feeLimit, requireCurve, type IWalletAccount, type IWalletAccountReadOnly, type Signer, type TransferResult, type WriteOptions } from '@anywalletkit/core'
import { Buffer } from 'buffer'
import { Cell } from '@ton/core'
import { MessageIsTransactionError, SimulationError, UnsafeTransactionError } from './errors.js'
import { tonProofDigest, tonSignDataDigest, type TonProof, type TonProofRequest, type TonSignDataRequest, type TonSignedData } from './tonconnect.js'
import { WalletAccountReadOnlyTon } from './read-only-account.js'
import { v5r1ExternalMessage, v5r1PackSigned, v5r1PackUnsigned, type V5R1Message } from './wallet-v5r1.js'
import type { TonConfig, TonSendable, TonTransferOptions } from './types.js'

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

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
  /** The signer that holds the key. */
  readonly signer: Signer
  private _readOnly: WalletAccountReadOnlyTon | undefined

  /** `publicKey` is the signer's 32-byte ed25519 key; the V5R1 address derives from it synchronously. */
  constructor(signer: Signer, publicKey: Uint8Array, path: string, config: TonConfig = {}) {
    super(publicKey, config)
    this.signer = requireCurve(signer, 'ed25519')
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
   * signature over the 32-byte hash of its signing cell, so those bytes could be one. TON Connect
   * goes through {@link signTonProof} and {@link signTonConnectData}.
   */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    if (bytes.length === 32) throw new MessageIsTransactionError()
    return toHex(await this.signer.sign(bytes, { scheme: 'ed25519', context: 'ton-message' }))
  }

  /**
   * TON Connect `ton_proof` for this wallet's address: the `proof` object of the connect reply. The
   * digest is built here (0xffff ‖ "ton-connect" ‖ …), so no request can turn it into a transfer.
   * `domain` is the host the wallet saw the request come from.
   */
  async signTonProof(request: TonProofRequest): Promise<TonProof> {
    const digest = tonProofDigest(this._address, request)
    const signature = await this.signer.sign(digest, { scheme: 'ed25519', context: 'ton-proof' })
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
    const signature = await this.signer.sign(digest, { scheme: 'ed25519', context: 'ton-sign-data' })
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
  private async prepare(messages: V5R1Message[], limit: bigint | number | undefined, op: string): Promise<{ body: Cell; fee: bigint }> {
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
    const { signing } = await this.signingCell(messages)
    const fee = await this.preflight(v5r1PackUnsigned(signing), limit, op, want)
    const signature = await this.signer.sign(new Uint8Array(signing.hash()), { scheme: 'ed25519', context: 'ton-external' })
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
      await this.preflight(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction')
      return tx.toBoc().toString('base64')
    }
    const { body } = await this.prepare(this.toMessages(tx), feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return body.toBoc().toString('base64')
  }

  private async broadcast(body: Cell): Promise<string> {
    const rpc = this.requireRpc('send transactions')
    const init = await this.initIfNeeded()
    await rpc.sendBoc(v5r1ExternalMessage(this._address, body, init))
    return body.hash().toString('hex')
  }

  /** Sign and broadcast; `hash` is the body hash (hex) — resolve it with getTransactionReceipt. */
  async sendTransaction(tx: TonSendable, options: WriteOptions = {}): Promise<TransferResult> {
    this.requireRpc('send transactions')
    const { body, fee } = tx instanceof Cell
      ? { body: tx, fee: await this.preflight(tx, feeLimit(this._config.transactionMaxFee, options), 'transaction') }
      : await this.prepare(this.toMessages(tx), feeLimit(this._config.transactionMaxFee, options), 'transaction')
    return { hash: await this.broadcast(body), fee }
  }

  /** TON (no `token`) or jetton transfer. */
  async transfer(o: TonTransferOptions, writeOptions: WriteOptions = {}): Promise<TransferResult> {
    this.requireRpc('transfer tokens')
    const message = o.token ? await this.jettonTransferMessage(o) : this.transactionMessage({ to: o.recipient, value: o.amount, ...(o.memo !== undefined ? { body: o.memo } : {}) })
    const { body, fee } = await this.prepare([message], feeLimit(this._config.transferMaxFee, writeOptions), 'transfer')
    return { hash: await this.broadcast(body), fee }
  }

  /** The same wallet as a {@link WalletAccountReadOnlyTon}. */
  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTon(this.publicKey, this._config)
    return this._readOnly
  }

  /** Disposes the signer: a local key is zeroized, an external one is released. */
  dispose(): void {
    this.signer.dispose()
  }
}
