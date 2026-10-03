import { ReadOnlyAccountError, SignerError, zeroize, type IWalletAccount, type IWalletAccountReadOnly, type TransferResult } from '@forgewallet/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import {
  getAddress, hashMessage, hashTypedData, hexToBytes, keccak256, serializeTransaction,
  type Hex, type Signature, type TransactionSerializable,
} from 'viem'
import { publicKeyToAddress } from 'viem/accounts'
import { encodeApprove, USDT_MAINNET } from './erc20.js'
import { WalletAccountReadOnlyEvm, cleanTypes, inferPrimaryType, transferTransaction } from './read-only-account.js'
import type { ApproveOptions, EvmConfig, EvmTransaction, EvmTransferOptions, TypedDataInput } from './types.js'

const toHex = (u8: Uint8Array): Hex => `0x${Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('')}`

/** Uncompressed 65-byte public key → checksummed address. */
export function addressFromPublicKey(compressed: Uint8Array): `0x${string}` {
  const uncompressed = secp256k1.Point.fromHex(toHex(compressed).slice(2)).toBytes(false)
  return publicKeyToAddress(toHex(uncompressed))
}

function toBigInt(v: bigint | number | string | undefined): bigint | undefined {
  return v === undefined ? undefined : BigInt(v)
}

/**
 * The signing EVM account. The private key lives ONLY in `_privateKey`
 * (a Uint8Array, zeroized by `dispose()`); signatures are produced with noble
 * secp256k1 over viem-computed hashes, so no hex copy of the key is ever made.
 */
export class WalletAccountEvm extends WalletAccountReadOnlyEvm implements IWalletAccount {
  readonly needsNetwork = false
  readonly path: string
  readonly publicKey: Uint8Array
  private _privateKey: Uint8Array | undefined
  private _readOnly: WalletAccountReadOnlyEvm | undefined

  constructor(privateKey: Uint8Array, publicKey: Uint8Array, path: string, config: EvmConfig = {}) {
    super(addressFromPublicKey(publicKey), config)
    this._privateKey = privateKey
    this.publicKey = publicKey
    this.path = path
  }

  /** Account index when the path is the standard m/44'/60'/0'/0/i, else undefined. */
  get index(): number | undefined {
    const m = /^m\/44'\/60'\/0'\/0\/(\d+)$/.exec(this.path)
    return m ? Number(m[1]) : undefined
  }

  private key(): Uint8Array {
    if (!this._privateKey) throw new SignerError('This account has been disposed.')
    return this._privateKey
  }

  /** Raw secp256k1 signature over a 32-byte hash, as a viem Signature (v = 27 | 28). */
  private signHash(hash: Hex): Signature {
    const sig = secp256k1.sign(hexToBytes(hash), this.key(), { prehash: false, format: 'recovered' })
    const recovery = sig[0]!
    const r = toHex(sig.slice(1, 33))
    const s = toHex(sig.slice(33, 65))
    return { r, s, v: BigInt(27 + recovery), yParity: recovery }
  }

  private serializeSignature(sig: Signature): Hex {
    return `0x${sig.r.slice(2)}${sig.s.slice(2)}${Number(sig.v).toString(16)}`
  }

  /** EIP-191 personal_sign; returns 65-byte hex with v ∈ {27, 28} (ethers encoding). */
  async sign(message: string | Uint8Array): Promise<string> {
    const hash = hashMessage(typeof message === 'string' ? message : { raw: message })
    return this.serializeSignature(this.signHash(hash))
  }

  /** EIP-712. Accepts `{domain, types, message}`; `primaryType` is inferred when absent. */
  async signTypedData(typed: TypedDataInput): Promise<string> {
    const types = cleanTypes(typed.types)
    const hash = hashTypedData({
      domain: typed.domain, types, primaryType: typed.primaryType ?? inferPrimaryType(types), message: typed.message,
    } as never)
    return this.serializeSignature(this.signHash(hash))
  }

  /** ethers-shaped tx → viem serializable, filling gaps from the network when there is a client. */
  private async prepare(tx: EvmTransaction): Promise<TransactionSerializable> {
    const chainId = tx.chainId !== undefined ? Number(tx.chainId) : await this.getChainId()
    const nonce = tx.nonce ?? (await this.requireClient('fetch the nonce').getTransactionCount({ address: this.address, blockTag: 'pending' }))
    const to = tx.to !== undefined ? getAddress(tx.to) : undefined
    const value = toBigInt(tx.value) ?? 0n
    const data = (tx.data ?? '0x') as Hex
    const gas = toBigInt(tx.gasLimit) ?? (await this.requireClient('estimate gas').estimateGas({ account: this.address, ...(to ? { to } : {}), value, data }))

    const legacy = tx.type === 0 || tx.type === 1 || (tx.gasPrice !== undefined && tx.maxFeePerGas === undefined)
    const base = { chainId, nonce, ...(to ? { to } : {}), value, data, gas }
    if (legacy) {
      const gasPrice = toBigInt(tx.gasPrice) ?? (await this.requireClient('read fee data').getGasPrice())
      return tx.type === 1
        ? { ...base, type: 'eip2930', gasPrice, accessList: tx.accessList ?? [] }
        : { ...base, type: 'legacy', gasPrice }
    }
    let maxFeePerGas = toBigInt(tx.maxFeePerGas)
    let maxPriorityFeePerGas = toBigInt(tx.maxPriorityFeePerGas)
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      const fees = await this.requireClient('read fee data').estimateFeesPerGas()
      maxFeePerGas ??= fees.maxFeePerGas
      maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas
    }
    if (tx.type === 4) {
      return { ...base, type: 'eip7702', maxFeePerGas, maxPriorityFeePerGas, accessList: tx.accessList ?? [], authorizationList: (tx.authorizationList ?? []) as never }
    }
    return { ...base, type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas, accessList: tx.accessList ?? [] }
  }

  private async checkMaxFee(tx: EvmTransaction, limit: bigint | number | undefined, op: string): Promise<bigint | undefined> {
    if (!this._client) return undefined
    const { fee } = await this.quoteSendTransaction(tx)
    if (limit !== undefined && fee > BigInt(limit)) throw new Error(`Exceeded maximum fee cost for ${op} operation.`)
    return fee
  }

  /** Sign WITHOUT broadcasting. Fully-specified EIP-1559 / legacy txs sign offline. */
  async signTransaction(tx: EvmTransaction): Promise<string> {
    if (this._config.transactionMaxFee !== undefined) await this.checkMaxFee(tx, this._config.transactionMaxFee, 'transaction')
    const prepared = await this.prepare(tx)
    const hash = keccak256(serializeTransaction(prepared))
    return serializeTransaction(prepared, this.signHash(hash))
  }

  async sendTransaction(tx: EvmTransaction): Promise<TransferResult> {
    const client = this.requireClient('send transactions')
    const fee = (await this.checkMaxFee(tx, this._config.transactionMaxFee, 'transaction'))!
    const raw = await this.signTransaction(tx)
    const hash = await client.sendRawTransaction({ serializedTransaction: raw as Hex })
    return { hash, fee }
  }

  async transfer(options: EvmTransferOptions): Promise<TransferResult> {
    const client = this.requireClient('transfer tokens')
    const tx = transferTransaction(options)
    const fee = (await this.checkMaxFee(tx, this._config.transferMaxFee, 'transfer'))!
    const raw = await this.signTransaction(tx)
    const hash = await client.sendRawTransaction({ serializedTransaction: raw as Hex })
    return { hash, fee }
  }

  /** ERC-20 approve. Mainnet USDT non-zero → non-zero is refused or auto-reset (`autoResetAllowance`). */
  async approve(options: ApproveOptions): Promise<TransferResult> {
    const client = this.requireClient('approve funds')
    const token = getAddress(options.token)
    const spender = getAddress(options.spender)
    const amount = BigInt(options.amount)
    if (amount > 0n && (await this.getChainId()) === 1 && token.toLowerCase() === USDT_MAINNET) {
      const current = await this.getAllowance(token, spender)
      if (current > 0n) {
        if (!this._config.autoResetAllowance) {
          throw new Error('USDT requires the current allowance to be reset to 0 before setting a new non-zero value. Please send an "approve" transaction with an amount of 0 first.')
        }
        const reset = await this.sendTransaction({ to: token, value: 0n, data: encodeApprove(spender, 0n) })
        await client.waitForTransactionReceipt({ hash: reset.hash as Hex })
      }
    }
    return this.sendTransaction({ to: token, value: 0n, data: encodeApprove(spender, amount) })
  }

  toReadOnlyAccount(): IWalletAccountReadOnly {
    this._readOnly ??= new WalletAccountReadOnlyEvm(this.address, this._config)
    return this._readOnly
  }

  /** Zeroize the private key. Idempotent. */
  dispose(): void {
    zeroize(this._privateKey)
    this._privateKey = undefined
  }
}

export { ReadOnlyAccountError }
