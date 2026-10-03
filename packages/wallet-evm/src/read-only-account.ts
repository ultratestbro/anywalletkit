import { NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import {
  getAddress, hashTypedData, isHex, recoverMessageAddress, recoverAddress, stringToHex,
  type Hex, type PublicClient,
} from 'viem'
import { createClient } from './client.js'
import { ERC20_ABI } from './erc20.js'
import type { EvmConfig, EvmReceipt, EvmTransaction, EvmTransferOptions, TypedDataInput } from './types.js'
import { encodeTransfer } from './erc20.js'

export const CAIP2_UNKNOWN = 'eip155:unknown'

/** Pick the root type of an EIP-712 `types` map when `primaryType` is not given. */
export function inferPrimaryType(types: TypedDataInput['types']): string {
  const names = Object.keys(types).filter((t) => t !== 'EIP712Domain')
  const referenced = new Set(
    names.flatMap((n) => types[n]!.map((f) => f.type.replace(/\[.*\]$/, ''))).filter((t) => names.includes(t)),
  )
  const roots = names.filter((n) => !referenced.has(n))
  if (roots.length !== 1) throw new Error(`Ambiguous EIP-712 primary type: ${roots.join(', ') || 'none'}. Pass primaryType.`)
  return roots[0]!
}

/** Strip `EIP712Domain` (ethers rejects it; viem tolerates it — normalise). */
export function cleanTypes(types: TypedDataInput['types']): TypedDataInput['types'] {
  return Object.fromEntries(Object.entries(types).filter(([k]) => k !== 'EIP712Domain'))
}

/** Build the transfer tx: native value, or ERC-20 `transfer` calldata. */
export function transferTransaction(o: EvmTransferOptions): EvmTransaction {
  const amount = BigInt(o.amount)
  if (!o.token) return { to: getAddress(o.recipient), value: amount }
  return { to: getAddress(o.token), value: 0n, data: encodeTransfer(getAddress(o.recipient), amount) }
}

export class WalletAccountReadOnlyEvm implements IWalletAccountReadOnly {
  readonly address: `0x${string}`
  protected readonly _config: EvmConfig
  protected readonly _client: PublicClient | undefined
  private _chainId: number | undefined

  constructor(address: string, config: EvmConfig = {}) {
    this.address = getAddress(address)
    this._config = config
    this._client = createClient(config)
    this._chainId = config.chainId
  }

  /** CAIP-2 id; "eip155:unknown" until the chain id is known (offline wallet without `chainId`). */
  get chain(): string {
    return this._chainId !== undefined ? `eip155:${this._chainId}` : CAIP2_UNKNOWN
  }

  protected requireClient(what: string): PublicClient {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a provider to ${what}.`)
    return this._client
  }

  async getAddress(): Promise<string> {
    return this.address
  }

  async getChainId(): Promise<number> {
    if (this._chainId === undefined) this._chainId = await this.requireClient('detect the chain id').getChainId()
    return this._chainId
  }

  async getBalance(): Promise<bigint> {
    return this.requireClient('read balances').getBalance({ address: this.address })
  }

  async getTokenBalance(token: string): Promise<bigint> {
    return this.requireClient('read token balances').readContract({
      address: getAddress(token), abi: ERC20_ABI, functionName: 'balanceOf', args: [this.address],
    })
  }

  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {}
    await Promise.all(tokens.map(async (t) => { out[t] = await this.getTokenBalance(t) }))
    return out
  }

  async getAllowance(token: string, spender: string): Promise<bigint> {
    return this.requireClient('read allowances').readContract({
      address: getAddress(token), abi: ERC20_ABI, functionName: 'allowance', args: [this.address, getAddress(spender)],
    })
  }

  /** Current fee rate: maxFeePerGas, falling back to gasPrice. */
  async getFeeRate(): Promise<bigint> {
    const client = this.requireClient('read fee data')
    try {
      const fees = await client.estimateFeesPerGas()
      if (fees.maxFeePerGas) return fees.maxFeePerGas
    } catch { /* legacy chain */ }
    return client.getGasPrice()
  }

  /** `gas × feeRate`. */
  async quoteSendTransaction(tx: EvmTransaction): Promise<{ fee: bigint }> {
    const client = this.requireClient('quote send transaction operations')
    const [gas, feeRate] = await Promise.all([
      tx.gasLimit !== undefined
        ? Promise.resolve(BigInt(tx.gasLimit))
        : client.estimateGas({
            account: this.address,
            ...(tx.to !== undefined ? { to: getAddress(tx.to) } : {}),
            ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
            ...(tx.data !== undefined ? { data: tx.data as Hex } : {}),
          }),
      this.getFeeRate(),
    ])
    return { fee: gas * feeRate }
  }

  async quoteTransfer(options: EvmTransferOptions): Promise<{ fee: bigint }> {
    return this.quoteSendTransaction(transferTransaction(options))
  }

  async getTransactionReceipt(hash: string): Promise<EvmReceipt | undefined> {
    const client = this.requireClient('fetch transaction receipts')
    try {
      const r = await client.getTransactionReceipt({ hash: hash as Hex })
      return {
        hash: r.transactionHash, status: r.status === 'success' ? 1 : 0, blockNumber: r.blockNumber,
        gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice, from: r.from, to: r.to, contractAddress: r.contractAddress ?? null, logs: r.logs,
      }
    } catch (e) {
      if (e instanceof Error && /not (be )?found/i.test(e.message)) return undefined
      throw e
    }
  }

  async getTransactionByHash(hash: string) {
    return this.requireClient('fetch transactions').getTransaction({ hash: hash as Hex })
  }

  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    const recovered = await recoverMessageAddress({
      message: typeof message === 'string' ? message : { raw: message },
      signature: signature as Hex,
    })
    return recovered.toLowerCase() === this.address.toLowerCase()
  }

  async verifyTypedData(typed: TypedDataInput, signature: string): Promise<boolean> {
    const types = cleanTypes(typed.types)
    const hash = hashTypedData({ domain: typed.domain, types, primaryType: typed.primaryType ?? inferPrimaryType(types), message: typed.message } as never)
    const recovered = await recoverAddress({ hash, signature: signature as Hex })
    return recovered.toLowerCase() === this.address.toLowerCase()
  }
}

/** Helper for callers that pass bytes where a string is expected. */
export function toHexMessage(message: string | Uint8Array): Hex {
  if (typeof message !== 'string') return `0x${Array.from(message, (b) => b.toString(16).padStart(2, '0')).join('')}`
  return isHex(message) ? message : stringToHex(message)
}
