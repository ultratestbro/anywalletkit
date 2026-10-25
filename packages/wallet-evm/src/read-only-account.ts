import { NetworkError, type IWalletAccountReadOnly } from '@anywalletkit/core'
import {
  BaseError, ContractFunctionRevertedError, decodeErrorResult, getAddress, hashTypedData, isHex,
  recoverMessageAddress, recoverAddress, stringToHex,
  type Hex, type PublicClient,
} from 'viem'
import { createClient } from './client.js'
import { ERC20_ABI } from './erc20.js'
import type { EvmConfig, EvmReceipt, EvmTransaction, EvmTransferOptions, SimulationResult, TypedDataInput } from './types.js'
import { encodeTransfer } from './erc20.js'

export const CAIP2_UNKNOWN = 'eip155:unknown'

/** Minimum priority fee the SDK bids when the network suggests less (wei, per chain id). */
export const MIN_PRIORITY_FEE_WEI: Readonly<Record<number, bigint>> = Object.freeze({
  1: 50_000_000n, // Ethereum mainnet: 0.05 gwei (≈$0.01 on 100k gas) — enough to be picked up
})

/** Fee fields a transaction is signed with: a legacy `gasPrice`, or the EIP-1559 cap and tip. */
export type FeeFields = { gasPrice: bigint } | { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }

/** Legacy fee fields: type 0 / 1, or a `gasPrice` without an EIP-1559 cap. */
export function usesLegacyFees(tx: EvmTransaction): boolean {
  return tx.type === 0 || tx.type === 1 || (tx.gasPrice !== undefined && tx.maxFeePerGas === undefined)
}

const toBigInt = (v: bigint | number | string | undefined): bigint | undefined => (v === undefined ? undefined : BigInt(v))

/** Pick the root type of an EIP-712 `types` map when `primaryType` is not given. */
export function inferPrimaryType(types: TypedDataInput['types']): string {
  const names = Object.keys(types).filter((t) => t !== 'EIP712Domain')
  const referenced = new Set(
    // Linear: cut at the first '[' (a backtracking /\[.*\]$/ is quadratic on dApp-supplied input).
    names.flatMap((n) => types[n]!.map((f) => { const i = f.type.indexOf('['); return i < 0 ? f.type : f.type.slice(0, i) })).filter((t) => names.includes(t)),
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

/**
 * An EVM address without a key: balances, allowances, fee quotes, simulation, receipts and
 * signature checks. Hand it to code that should only read or quote.
 */
export class WalletAccountReadOnlyEvm implements IWalletAccountReadOnly {
  /** Checksummed address. */
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

  /** The RPC client, or a `NetworkError` naming the action when the wallet is offline. */
  protected requireClient(what: string): PublicClient {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a provider to ${what}.`)
    return this._client
  }

  /** The checksummed address. */
  async getAddress(): Promise<string> {
    return this.address
  }

  /** Chain id from the config, or asked from the RPC once and cached. */
  async getChainId(): Promise<number> {
    if (this._chainId === undefined) this._chainId = await this.requireClient('detect the chain id').getChainId()
    return this._chainId
  }

  /** Native balance in wei. */
  async getBalance(): Promise<bigint> {
    return this.requireClient('read balances').getBalance({ address: this.address })
  }

  /** ERC-20 `balanceOf` in the token's base units. */
  async getTokenBalance(token: string): Promise<bigint> {
    return this.requireClient('read token balances').readContract({
      address: getAddress(token), abi: ERC20_ABI, functionName: 'balanceOf', args: [this.address],
    })
  }

  /** Several ERC-20 balances in parallel, keyed by the token addresses as given. */
  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {}
    await Promise.all(tokens.map(async (t) => { out[t] = await this.getTokenBalance(t) }))
    return out
  }

  /** ERC-20 `allowance(owner, spender)` in base units. */
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

  /** Calldata/value/to in the shape viem's `call` / `estimateGas` take. */
  protected callParams(tx: EvmTransaction) {
    return {
      account: this.address,
      ...(tx.to !== undefined ? { to: getAddress(tx.to) } : {}),
      ...(tx.value !== undefined ? { value: BigInt(tx.value) } : {}),
      ...(tx.data !== undefined ? { data: tx.data as Hex } : {}),
    }
  }

  /** Gas limit: the tx's own, else one estimate. */
  protected async gasFor(tx: EvmTransaction): Promise<bigint> {
    if (tx.gasLimit !== undefined) return BigInt(tx.gasLimit)
    return this.requireClient('estimate gas').estimateGas(this.callParams(tx))
  }

  /**
   * The fee fields a send signs: the transaction's own where it sets them, the network's for the
   * rest. One function for the quote and the signature, so a cap checked on the quote holds for
   * what is signed.
   */
  protected async feeFields(tx: EvmTransaction, chainId: number): Promise<FeeFields> {
    if (usesLegacyFees(tx)) return { gasPrice: toBigInt(tx.gasPrice) ?? (await this.requireClient('read fee data').getGasPrice()) }
    let maxFeePerGas = toBigInt(tx.maxFeePerGas)
    let maxPriorityFeePerGas = toBigInt(tx.maxPriorityFeePerGas)
    if (maxFeePerGas === undefined || maxPriorityFeePerGas === undefined) {
      const fees = await this.requireClient('read fee data').estimateFeesPerGas()
      // Public mainnet nodes answer eth_maxPriorityFeePerGas with 0 when
      // blocks are quiet. A zero-tip transaction is last in every builder's
      // queue and gets evicted from the mempool as soon as the base fee
      // drifts above its cap (2026-10-09: one waited 3 min, one vanished
      // after the node had returned its hash). Floor the tip per chain when
      // the caller did not fix it.
      const tipFloor = maxPriorityFeePerGas === undefined ? (MIN_PRIORITY_FEE_WEI[chainId] ?? 0n) : 0n
      maxPriorityFeePerGas ??= fees.maxPriorityFeePerGas < tipFloor ? tipFloor : fees.maxPriorityFeePerGas
      // The cap is the network's base-fee headroom plus the tip actually bid,
      // so a tip above the network's (floored, or the caller's own) lifts the
      // cap with it instead of producing a tip above the cap.
      const headroom = fees.maxFeePerGas > fees.maxPriorityFeePerGas ? fees.maxFeePerGas - fees.maxPriorityFeePerGas : 0n
      maxFeePerGas ??= headroom + maxPriorityFeePerGas
    }
    return { maxFeePerGas, maxPriorityFeePerGas }
  }

  /**
   * Upper-bound fee in wei: `gas × fee cap`, with the cap the transaction would be signed with —
   * its own `gasPrice` / `maxFeePerGas` when it sets one, else the network's (`gasPrice` on chains
   * without EIP-1559).
   */
  async quoteSendTransaction(tx: EvmTransaction): Promise<{ fee: bigint }> {
    const client = this.requireClient('quote send transaction operations')
    const cap = async (): Promise<bigint> => {
      const chainId = tx.chainId !== undefined ? Number(tx.chainId) : await this.getChainId()
      try {
        const f = await this.feeFields(tx, chainId)
        return 'gasPrice' in f ? f.gasPrice : f.maxFeePerGas
      } catch (e) {
        // No fee fields and no EIP-1559 on this chain: the quote falls back to gasPrice, as getFeeRate does.
        const setsFees = tx.gasPrice !== undefined || tx.maxFeePerGas !== undefined || tx.maxPriorityFeePerGas !== undefined
        if (!setsFees) return client.getGasPrice()
        throw e
      }
    }
    const [gas, rate] = await Promise.all([this.gasFor(tx), cap()])
    return { fee: gas * rate }
  }

  /**
   * Dry-run the transaction from this account (`eth_call` + gas estimate).
   * A revert comes back as `{ok: false, reason}` with the decoded `Error(string)`,
   * `Panic(uint256)` or custom-error selector; only transport failures throw.
   */
  async simulateTransaction(tx: EvmTransaction): Promise<SimulationResult> {
    const client = this.requireClient('simulate transactions')
    const params = this.callParams(tx)
    let returnData: Hex
    try {
      const res = await client.call(params)
      returnData = res.data ?? '0x'
    } catch (e) {
      const revert = decodeRevert(e)
      if (revert) return { ok: false, ...revert }
      throw e
    }
    try {
      const gas = tx.gasLimit !== undefined ? BigInt(tx.gasLimit) : await client.estimateGas(params)
      return { ok: true, gas, returnData }
    } catch (e) {
      const revert = decodeRevert(e)
      if (revert) return { ok: false, ...revert }
      throw e
    }
  }

  /** Network fee of a transfer, in wei. */
  async quoteTransfer(options: EvmTransferOptions): Promise<{ fee: bigint }> {
    return this.quoteSendTransaction(transferTransaction(options))
  }

  /** The receipt, or `undefined` while the transaction is not mined. */
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

  /** The transaction as the RPC returns it (viem shape). */
  async getTransactionByHash(hash: string) {
    return this.requireClient('fetch transactions').getTransaction({ hash: hash as Hex })
  }

  /** True when `signature` is this address's EIP-191 signature of `message`. */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    const recovered = await recoverMessageAddress({
      message: typeof message === 'string' ? message : { raw: message },
      signature: signature as Hex,
    })
    return recovered.toLowerCase() === this.address.toLowerCase()
  }

  /** True when `signature` is this address's EIP-712 signature of `typed`. */
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

const PANIC: Record<number, string> = {
  0x01: 'assertion failed', 0x11: 'arithmetic overflow/underflow', 0x12: 'division by zero', 0x21: 'invalid enum value',
  0x22: 'invalid storage byte array', 0x31: 'pop on empty array', 0x32: 'array index out of bounds', 0x41: 'out of memory', 0x51: 'uninitialized function pointer',
}

/** Walk a viem error for revert data and turn it into a human reason; undefined when it is not a revert. */
export function decodeRevert(e: unknown): { reason: string; data?: Hex } | undefined {
  if (!(e instanceof BaseError)) return undefined
  const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
  const data = reverted?.raw ?? extractRevertData(e)
  if (data && data !== '0x') {
    const selector = data.slice(0, 10)
    try {
      if (selector === '0x08c379a0') {
        const d = decodeErrorResult({ abi: [{ type: 'error', name: 'Error', inputs: [{ type: 'string', name: 'message' }] }], data })
        return { reason: String(d.args?.[0] ?? 'reverted'), data }
      }
      if (selector === '0x4e487b71') {
        const d = decodeErrorResult({ abi: [{ type: 'error', name: 'Panic', inputs: [{ type: 'uint256', name: 'code' }] }], data })
        const code = Number(d.args?.[0] ?? 0)
        return { reason: `panic 0x${code.toString(16)}: ${PANIC[code] ?? 'unknown'}`, data }
      }
    } catch { /* fall through to selector */ }
    return { reason: `reverted with custom error ${selector}`, data }
  }
  const text = e.shortMessage || e.message
  if (/revert|execution reverted|out of gas|insufficient funds|gas required exceeds/i.test(text)) return { reason: text }
  return undefined
}

function extractRevertData(e: BaseError): Hex | undefined {
  let cur: unknown = e
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    const bag = cur as { data?: unknown; cause?: unknown }
    if (typeof bag.data === 'string' && isHex(bag.data)) return bag.data as Hex
    if (bag.data && typeof bag.data === 'object' && typeof (bag.data as { data?: unknown }).data === 'string') return (bag.data as { data: Hex }).data
    cur = bag.cause
  }
  return undefined
}
