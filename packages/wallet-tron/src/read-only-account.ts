import { NetworkError, type IWalletAccountReadOnly } from '@forgewallet/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { encodeParameters, decodeUint, selector } from './abi.js'
import { addressFromPublicKey, toBase58Address, toHexAddress } from './address.js'
import { assertNoError, createClient } from './client.js'
import {
  CAIP2_GENESIS, type TronConfig, type TronContractCall, type TronFetch, type TronNativeTransfer,
  type TronQuote, type TronRawTransaction, type TronReceipt, type TronTransaction, type TronTransferOptions,
} from './types.js'

const BANDWIDTH_PRICE = 1_000n
const ACCOUNT_ACTIVATION_FEE_SUN = 1_000_000n
const ACCOUNT_ACTIVATION_BANDWIDTH_COST = 100_000n
export const DEFAULT_FEE_LIMIT_SUN = 15_000_000
const SIGNATURE_LENGTH_IN_BYTES = 65
const TRANSACTION_RESULT_OVERHEAD_IN_BYTES = 64
const PROTOBUF_OVERHEAD_IN_BYTES = 15

export const isPrebuilt = (tx: unknown): tx is TronRawTransaction => typeof tx === 'object' && tx !== null && typeof (tx as TronRawTransaction).txID === 'string'
export const isContractCall = (tx: unknown): tx is TronContractCall => typeof tx === 'object' && tx !== null && typeof (tx as TronContractCall).functionSelector === 'string'

interface Resources { freeNetLimit?: number; freeNetUsed?: number; NetLimit?: number; NetUsed?: number; EnergyLimit?: number; EnergyUsed?: number }
interface ChainParam { key: string; value?: number }

/** keccak256("\x19TRON Signed Message:\n" + byteLength + message) — TIP-191, what tronweb v2 signs. */
export function hashMessage(message: string | Uint8Array): Uint8Array {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
  const prefix = new TextEncoder().encode(`\x19TRON Signed Message:\n${bytes.length}`)
  const all = new Uint8Array(prefix.length + bytes.length)
  all.set(prefix, 0)
  all.set(bytes, prefix.length)
  return keccak_256(all)
}

export class WalletAccountReadOnlyTron implements IWalletAccountReadOnly {
  /** base58 T… */
  readonly address: string
  readonly addressHex: string
  readonly chain: string
  protected readonly _config: TronConfig
  protected readonly _client: TronFetch | undefined

  constructor(address: string, config: TronConfig = {}) {
    this.address = toBase58Address(address)
    this.addressHex = toHexAddress(address)
    this._config = config
    this._client = createClient(config)
    const net = config.network ?? 'mainnet'
    this.chain = CAIP2_GENESIS[net] ?? (net.startsWith('tron:') ? net : `tron:${net}`)
  }

  protected requireClient(what: string): TronFetch {
    if (!this._client) throw new NetworkError(`The wallet must be connected to a provider to ${what}.`)
    return this._client
  }

  protected async post<T>(path: string, body: unknown, what: string): Promise<T> {
    const res = await this.requireClient(what)(path, body)
    assertNoError(res, what)
    return res as T
  }

  async getAddress(): Promise<string> { return this.address }

  async getBalance(): Promise<bigint> {
    const acc = await this.post<{ balance?: number }>('/wallet/getaccount', { address: this.addressHex, visible: false }, 'retrieve balances')
    return BigInt(acc.balance ?? 0)
  }

  /** Read-only contract call. Returns constant_result hex strings. */
  protected async constantCall(contract: string, functionSelector: string, parameters: Array<{ type: string; value: unknown }>, what: string, extra: Record<string, unknown> = {}) {
    return this.post<{ constant_result?: string[]; energy_used?: number; transaction?: TronRawTransaction; result?: { result?: boolean; code?: string; message?: string } }>(
      '/wallet/triggerconstantcontract',
      { owner_address: this.addressHex, contract_address: toHexAddress(contract), function_selector: functionSelector, parameter: encodeParameters(parameters), visible: false, ...extra },
      what,
    )
  }

  async getTokenBalance(token: string): Promise<bigint> {
    const r = await this.constantCall(token, 'balanceOf(address)', [{ type: 'address', value: this.address }], 'retrieve token balances')
    return decodeUint(r.constant_result?.[0] ?? '0')
  }

  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {}
    await Promise.all(tokens.map(async (t) => { out[t] = await this.getTokenBalance(t) }))
    return out
  }

  async getAllowance(token: string, spender: string): Promise<bigint> {
    const r = await this.constantCall(token, 'allowance(address,address)', [{ type: 'address', value: this.address }, { type: 'address', value: spender }], 'read allowances')
    return decodeUint(r.constant_result?.[0] ?? '0')
  }

  protected async buildTransaction(tx: TronTransaction): Promise<TronRawTransaction> {
    if (isPrebuilt(tx)) return tx
    if (isContractCall(tx)) {
      const { contractAddress, functionSelector, parameters = [], options = {} } = tx
      const r = await this.post<{ transaction?: TronRawTransaction; result?: { result?: boolean } }>('/wallet/triggersmartcontract', {
        owner_address: this.addressHex, contract_address: toHexAddress(contractAddress), function_selector: functionSelector,
        parameter: encodeParameters(parameters), fee_limit: options.feeLimit ?? DEFAULT_FEE_LIMIT_SUN, call_value: options.callValue ?? 0, visible: false,
      }, 'build a contract call')
      if (!r.transaction) throw new Error('triggersmartcontract returned no transaction')
      return r.transaction
    }
    const { to, value } = tx as TronNativeTransfer
    return this.post<TronRawTransaction>('/wallet/createtransaction', { owner_address: this.addressHex, to_address: toHexAddress(to), amount: Number(BigInt(value)), visible: false }, 'build a transfer')
  }

  protected async getResources(): Promise<Resources> {
    return this.post<Resources>('/wallet/getaccountresource', { address: this.addressHex, visible: false }, 'read account resources')
  }

  protected async getChainParameter(key: string): Promise<bigint> {
    const r = await this.post<{ chainParameter?: ChainParam[] }>('/wallet/getchainparameters', {}, 'read chain parameters')
    const p = r.chainParameter?.find((c) => c.key === key)
    if (!p) throw new Error(`Chain parameter ${key} not found`)
    return BigInt(p.value ?? 0)
  }

  protected netEnergyCost(energyUsed: number | undefined, energyPrice: bigint, res: Resources): bigint {
    const available = BigInt(res.EnergyLimit ?? 0) - BigInt(res.EnergyUsed ?? 0)
    const needed = BigInt(energyUsed ?? 0) - available
    return needed > 0n ? needed * energyPrice : 0n
  }

  protected async bandwidthCost(tx: TronRawTransaction, isActivation: boolean, cached?: Resources): Promise<bigint> {
    const size = BigInt(Math.ceil(tx.raw_data_hex.length / 2) + SIGNATURE_LENGTH_IN_BYTES + TRANSACTION_RESULT_OVERHEAD_IN_BYTES + PROTOBUF_OVERHEAD_IN_BYTES)
    const res = cached ?? (await this.getResources())
    const freeLeft = BigInt(res.freeNetLimit ?? 0) - BigInt(res.freeNetUsed ?? 0)
    const frozenLeft = BigInt(res.NetLimit ?? 0) - BigInt(res.NetUsed ?? 0)
    if (frozenLeft >= size) return 0n
    if (isActivation) return ACCOUNT_ACTIVATION_BANDWIDTH_COST
    if (freeLeft >= size) return 0n
    return size * BANDWIDTH_PRICE
  }

  protected async isActivatingTransfer(type: string | undefined, value: Record<string, unknown>): Promise<boolean> {
    if (type !== 'TransferContract' && type !== 'TransferAssetContract') return false
    const to = value.to_address as string | undefined
    if (!to) return false
    const acc = await this.post<Record<string, unknown>>('/wallet/getaccount', { address: toHexAddress(to), visible: false }, 'check the recipient account')
    return Object.keys(acc).length === 0
  }

  protected async quoteTransaction(tx: TronRawTransaction): Promise<TronQuote> {
    const contract = tx.raw_data?.contract?.[0]
    const type = contract?.type
    const value = contract?.parameter?.value ?? {}
    const isActivation = await this.isActivatingTransfer(type, value)
    const activationFee = isActivation ? ACCOUNT_ACTIVATION_FEE_SUN : 0n
    let energyCost = 0n
    if (type === 'TriggerSmartContract') {
      const r = await this.post<{ energy_used?: number }>('/wallet/triggerconstantcontract', {
        owner_address: value.owner_address, contract_address: value.contract_address, data: value.data, call_value: value.call_value ?? 0, visible: false,
      }, 'estimate energy')
      const [price, res] = await Promise.all([this.getChainParameter('getEnergyFee'), this.getResources()])
      energyCost = this.netEnergyCost(r.energy_used, price, res)
    }
    const bandwidth = await this.bandwidthCost(tx, isActivation)
    return { fee: bandwidth + energyCost + activationFee, activationFee }
  }

  async quoteSendTransaction(tx: TronTransaction): Promise<TronQuote> {
    this.requireClient('quote transactions')
    return this.quoteTransaction(await this.buildTransaction(tx))
  }

  protected trc20TransferParams(recipient: string, amount: bigint | number | string) {
    return [{ type: 'address', value: recipient }, { type: 'uint256', value: BigInt(amount) }]
  }

  async quoteTransfer(o: TronTransferOptions): Promise<{ fee: bigint }> {
    this.requireClient('quote transfer operations')
    if (!o.token) return { fee: (await this.quoteSendTransaction({ to: o.recipient, value: o.amount })).fee }
    let sim
    try {
      sim = await this.constantCall(o.token, 'transfer(address,uint256)', this.trc20TransferParams(o.recipient, o.amount), 'simulate the transfer')
    } catch (e) {
      if (e instanceof Error && /REVERT/.test(e.message)) {
        const balance = await this.getTokenBalance(o.token)
        if (balance < BigInt(o.amount)) throw new Error('Insufficient token balance for the transfer.')
      }
      throw e
    }
    const [price, res] = await Promise.all([this.getChainParameter('getEnergyFee'), this.getResources()])
    const energy = this.netEnergyCost(sim.energy_used, price, res)
    const bandwidth = sim.transaction ? await this.bandwidthCost(sim.transaction, false, res) : 0n
    return { fee: energy + bandwidth }
  }

  async getTransactionReceipt(hash: string): Promise<TronReceipt | undefined> {
    const info = await this.post<Record<string, unknown>>('/wallet/gettransactioninfobyid', { value: hash }, 'fetch transaction receipts')
    if (!info || Object.keys(info).length === 0) return undefined
    const receipt = info.receipt as { result?: string } | undefined
    const failed = info.result === 'FAILED' || (receipt?.result !== undefined && receipt.result !== 'SUCCESS')
    return { hash, status: failed ? 0 : 1, blockNumber: BigInt((info.blockNumber as number) ?? 0), fee: BigInt((info.fee as number) ?? 0), raw: info }
  }

  /** Verify a TIP-191 signature produced by `sign` (0x + r||s||v, v = 27|28 or 0|1). */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    try {
      const sig = hexToBytes(signature.replace(/^0x/, ''))
      if (sig.length !== 65) return false
      let v = sig[64]!
      if (v >= 27) v -= 27
      const recovered = new Uint8Array(65)
      recovered[0] = v
      recovered.set(sig.slice(0, 64), 1)
      const pub = secp256k1.recoverPublicKey(recovered, hashMessage(message), { prehash: false })
      return addressFromPublicKey(pub) === this.address
    } catch { return false }
  }
}

export { selector }
