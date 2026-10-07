import { SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { ed25519 } from '@noble/curves/ed25519.js'
import { Cell } from '@ton/core'
import { SimulationError } from './errors.js'
import { WalletAccountReadOnlyTon } from './read-only-account.js'
import { v5r1ExternalMessage, v5r1PackSigned, v5r1PackUnsigned, type V5R1Message } from './wallet-v5r1.js'
import type { TonConfig, TonSendable, TonTransferOptions } from './types.js'

const toHex = (u8: Uint8Array) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * Signing TON account on Wallet V5R1. The 32-byte ed25519 seed is the only
 * key material (zeroized by `dispose()`); noble signs the body hash, so no
 * 64-byte nacl secret key is ever built.
 *
 * Every send runs: hard checks → fresh seqno → preflight on the zero-signed
 * body (estimateFee, emulation when configured, fee cap) → sign → broadcast.
 */
export class WalletAccountTon extends WalletAccountReadOnlyTon implements IWalletAccount {
  /** seqno and fees come from the network before signing. */
  readonly needsNetwork = true
  readonly path: string
  private _privateKey: Uint8Array | undefined
  private _readOnly: WalletAccountReadOnlyTon | undefined

  constructor(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: TonConfig = {}) {
    super(publicKey, config)
    this._privateKey = privateKey
    this.path = path
  }

  /** Account index for the standard m/44'/607'/i' path. */
  get index(): number | undefined {
    const m = /^m\/44'\/607'\/(\d+)'$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This account has been disposed.')
    return this._privateKey
  }

  /** Hex ed25519 signature over the raw message bytes. */
  async sign(message: string | Uint8Array): Promise<string> {
    const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
    return toHex(ed25519.sign(bytes, this.key()))
  }

  private checkMaxFee(fee: bigint, limit: bigint | number | undefined, op: string) {
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
  }

  /**
   * Checks → seqno → preflight → signed body. The preflight runs on the
   * zero-signed body (ignore_chksig), so nothing is signed before it passes.
   */
  private async prepare(messages: V5R1Message[], limit: bigint | number | undefined, op: string): Promise<{ body: Cell; fee: bigint }> {
    const key = this.key()
    const { signing } = await this.signingCell(messages)
    const fee = await this.preflight(v5r1PackUnsigned(signing), limit, op)
    return { body: v5r1PackSigned(signing, ed25519.sign(signing.hash(), key)), fee }
  }

  private async preflight(body: Cell, limit: bigint | number | undefined, op: string): Promise<bigint> {
    if (this._config.simulate === false) {
      if (limit === undefined) return 0n
      const fee = (await this.estimateFees(body)).total
      this.checkMaxFee(fee, limit, op)
      return fee
    }
    const sim = await this.simulateBody(body)
    if (!sim.ok) throw new SimulationError(sim.reason, { ...(sim.exitCode !== undefined ? { exitCode: sim.exitCode } : {}), ...(sim.aborted !== undefined ? { aborted: sim.aborted } : {}) })
    this.checkMaxFee(sim.fees.total, limit, op)
    return sim.fees.total
  }

  /** Sign without broadcasting. Returns the external-message BODY as base64 BoC (pass it back to sendTransaction as a Cell). */
  async signTransaction(tx: TonSendable): Promise<string> {
    if (tx instanceof Cell) {
      await this.preflight(tx, this._config.transactionMaxFee, 'transaction')
      return tx.toBoc().toString('base64')
    }
    const { body } = await this.prepare(this.toMessages(tx), this._config.transactionMaxFee, 'transaction')
    return body.toBoc().toString('base64')
  }

  private async broadcast(body: Cell): Promise<string> {
    const rpc = this.requireRpc('send transactions')
    const init = await this.initIfNeeded()
    await rpc.sendBoc(v5r1ExternalMessage(this._address, body, init))
    return body.hash().toString('hex')
  }

  /** Sign and broadcast; `hash` is the body hash (hex) — resolve it with getTransactionReceipt. */
  async sendTransaction(tx: TonSendable): Promise<TransferResult> {
    this.requireRpc('send transactions')
    const { body, fee } = tx instanceof Cell
      ? { body: tx, fee: await this.preflight(tx, this._config.transactionMaxFee, 'transaction') }
      : await this.prepare(this.toMessages(tx), this._config.transactionMaxFee, 'transaction')
    return { hash: await this.broadcast(body), fee }
  }

  /** TON (no `token`) or jetton transfer. */
  async transfer(o: TonTransferOptions): Promise<TransferResult> {
    this.requireRpc('transfer tokens')
    const message = o.token ? await this.jettonTransferMessage(o) : this.transactionMessage({ to: o.recipient, value: o.amount })
    const { body, fee } = await this.prepare([message], this._config.transferMaxFee, 'transfer')
    return { hash: await this.broadcast(body), fee }
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyTon(this.publicKey, this._config)
    return this._readOnly
  }

  dispose(): void {
    zeroize(this._privateKey)
    this._privateKey = undefined
  }
}
