import { NetworkError, feeLimit as feeLimit_, type IWalletAccountReadOnly, bigintToNumber } from '@anywalletkit/core'
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import { decodeRevertReason, encodeParameters, decodeUint, hexToText, selector } from './abi.js'
import { addressFromPublicKey, toBase58Address, toHexAddress } from './address.js'
import { assertNoError, createClient } from './client.js'
import { describeTransaction, type DescribeContext } from './describe.js'
import { assertNodeBuild } from './build-check.js'
import { attachMemo, memoBytes } from './memo.js'
import { sunFromJson, sunToJson } from './json.js'
import { decodeRawData } from './raw.js'
import { isContractCall, isPrebuilt } from './shape.js'
import {
  CAIP2_GENESIS, type TronConfig, type TronContractCall, type TronFeeEstimate, type TronFetch, type TronNativeTransfer,
  type TronQuote, type TronRawTransaction, type TronReceipt, type TronSimulation, type TronTransaction, type TronTransferOptions,
  type TronTxDescription,
} from './types.js'

export { isPrebuilt, isContractCall }

/**
 * Fee limit for contract calls when no estimate is available (the simulation itself
 * failed and the caller gave none) — `buildTransaction` otherwise derives it from energy.
 */
export const DEFAULT_FEE_LIMIT_SUN = 15_000_000
/** Head-room over the simulated energy cost when deriving `fee_limit` (×1.2). */
export const FEE_LIMIT_MARGIN = 1.2

// ── Bandwidth formula (java-tron BandwidthProcessor.consume) ─────────────────
// points = serializedSize(Transaction{raw_data, signature[]}) + MAX_RESULT_SIZE_IN_TX (64)
// The protobuf envelope around raw_data is: field-1 tag (1) + length varint (1–3) + raw bytes,
// then per signature: field-2 tag (1) + length (1) + 65 bytes. A TRX transfer (~134 raw bytes)
// comes out at 268 points and a TRC-20 transfer (~211 raw bytes) at ~345 — what explorers show.
const SIGNATURE_BYTES = 65
const RESULT_RESERVE_BYTES = 64
const varintLen = (n: number) => (n < 128 ? 1 : n < 16_384 ? 2 : 3)
/**
 * Bandwidth points a transaction consumes: its serialized size with signatures plus the 64-byte
 * result reserve.
 */
export function bandwidthPoints(rawDataHex: string, signatures = 1): number {
  const raw = Math.ceil(rawDataHex.replace(/^0x/, '').length / 2)
  return 1 + varintLen(raw) + raw + signatures * (1 + 1 + SIGNATURE_BYTES) + RESULT_RESERVE_BYTES
}

// Mainnet defaults for chain parameters a node (or a test double) may omit.
const PARAM_DEFAULTS: Record<string, bigint> = {
  getMemoFee: 1_000_000n,
  getCreateAccountFee: 100_000n,
  getCreateNewAccountFeeInSystemContract: 1_000_000n,
  getCreateNewAccountBandwidthRate: 1n,
}

export interface Resources { freeNetLimit?: number; freeNetUsed?: number; NetLimit?: number; NetUsed?: number; EnergyLimit?: number; EnergyUsed?: number }
interface ChainParam { key: string; value?: number }
export interface ConstantCallResponse {
  Error?: string
  constant_result?: string[]
  energy_used?: number
  transaction?: TronRawTransaction
  result?: { result?: boolean; code?: string; message?: string }
}

/** keccak256("\x19TRON Signed Message:\n" + byteLength + message) — TIP-191 (tronweb `signMessageV2`). */
export function hashMessage(message: string | Uint8Array): Uint8Array {
  const bytes = typeof message === 'string' ? new TextEncoder().encode(message) : message
  const prefix = new TextEncoder().encode(`\x19TRON Signed Message:\n${bytes.length}`)
  const all = new Uint8Array(prefix.length + bytes.length)
  all.set(prefix, 0)
  all.set(bytes, prefix.length)
  return keccak_256(all)
}

/** Address that produced a TIP-191 signature (`0x` + r||s||v, v = 27|28 or 0|1), or undefined. */
export function recoverMessageAddress(message: string | Uint8Array, signature: string): string | undefined {
  try {
    const sig = hexToBytes(signature.replace(/^0x/, ''))
    if (sig.length !== 65) return undefined
    let v = sig[64]!
    if (v >= 27) v -= 27
    if (v > 1) return undefined
    const recovered = new Uint8Array(65)
    recovered[0] = v
    recovered.set(sig.slice(0, 64), 1)
    return addressFromPublicKey(secp256k1.recoverPublicKey(recovered, hashMessage(message), { prehash: false }))
  } catch { return undefined }
}

/** First contract of a prebuilt transaction — from `raw_data_hex` when it decodes (the bytes are what gets signed), else from the JSON. */
const contractOf = (tx: TronRawTransaction) => {
  let c = tx.raw_data?.contract?.[0]
  if (typeof tx.raw_data_hex === 'string' && tx.raw_data_hex.length) { try { c = decodeRawData(tx.raw_data_hex).raw_data.contract[0] } catch { /* verifyRawTransaction reports it before anything is signed */ } }
  return { type: c?.type, value: (c?.parameter?.value ?? {}) as Record<string, unknown> }
}

/**
 * A Tron address without a key: TRX and TRC-20 balances, allowances, resources, fee estimates,
 * simulation, receipts and signature checks.
 */
export class WalletAccountReadOnlyTron implements IWalletAccountReadOnly {
  /** base58 T… */
  readonly address: string
  /** Hex form (`41…`). */
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

  /** The base58 address. */
  async getAddress(): Promise<string> { return this.address }

  /** TRX balance in sun; 0 for an account that does not exist yet. */
  async getBalance(): Promise<bigint> {
    const acc = await this.post<{ balance?: number | string }>('/wallet/getaccount', { address: this.addressHex, visible: false }, 'retrieve balances')
    return sunFromJson(acc.balance, 'balance')
  }

  /** Read-only contract call. Returns constant_result hex strings. */
  protected async constantCall(contract: string, functionSelector: string, parameters: Array<{ type: string; value: unknown }>, what: string, extra: Record<string, unknown> = {}) {
    return this.post<ConstantCallResponse>(
      '/wallet/triggerconstantcontract',
      { owner_address: this.addressHex, contract_address: toHexAddress(contract), function_selector: functionSelector, parameter: encodeParameters(parameters), visible: false, ...extra },
      what,
    )
  }

  /** TRC-20 `balanceOf` in the token's base units. */
  async getTokenBalance(token: string): Promise<bigint> {
    const r = await this.constantCall(token, 'balanceOf(address)', [{ type: 'address', value: this.address }], 'retrieve token balances')
    return decodeUint(r.constant_result?.[0] ?? '0')
  }

  /** Several TRC-20 balances in parallel, keyed by the tokens as given. */
  async getTokenBalances(tokens: string[]): Promise<Record<string, bigint>> {
    const out: Record<string, bigint> = {}
    await Promise.all(tokens.map(async (t) => { out[t] = await this.getTokenBalance(t) }))
    return out
  }

  /** TRC-20 `allowance(owner, spender)` in base units. */
  async getAllowance(token: string, spender: string): Promise<bigint> {
    const r = await this.constantCall(token, 'allowance(address,address)', [{ type: 'address', value: this.address }, { type: 'address', value: spender }], 'read allowances')
    return decodeUint(r.constant_result?.[0] ?? '0')
  }

  /** Does an account exist on chain (`/wallet/getaccount` non-empty)? */
  async accountExists(address: string): Promise<boolean> {
    const acc = await this.post<Record<string, unknown>>('/wallet/getaccount', { address: toHexAddress(address), visible: false }, 'check the recipient account')
    return Object.keys(acc).length > 0
  }

  // ── Building ────────────────────────────────────────────────────────────────

  /**
   * Ask the node for `raw_data`. Contract calls are simulated first so `fee_limit`
   * can be derived from the energy they need (×1.2, capped at `transactionMaxFee` and the call's
   * `cap`) when the caller gives none; the simulation rides along so nobody pays for a second one.
   */
  protected async buildWithSimulation(tx: TronTransaction, cap?: bigint | number): Promise<{ built: TronRawTransaction; sim?: TronSimulation }> {
    if (isPrebuilt(tx)) return { built: tx }
    if (isContractCall(tx)) {
      const { contractAddress, functionSelector, parameters = [], options = {} } = tx
      const sim = await this.simulateCall({ contractAddress, functionSelector, parameters, options })
      let feeLimit = options.feeLimit
      if (feeLimit === undefined) {
        const energyPrice = bigintToNumber(await this.getChainParameter('getEnergyFee'))
        feeLimit = sim.ok && sim.energy > 0 ? Math.ceil(sim.energy * energyPrice * FEE_LIMIT_MARGIN) : DEFAULT_FEE_LIMIT_SUN
        const max = feeLimit_(this._config.transactionMaxFee, cap === undefined ? {} : { maxFee: BigInt(cap) })
        if (max !== undefined && BigInt(feeLimit) > max) feeLimit = sunToJson(max, 'fee cap')
      }
      const r = await this.post<{ transaction?: TronRawTransaction; result?: { result?: boolean } }>('/wallet/triggersmartcontract', {
        owner_address: this.addressHex, contract_address: toHexAddress(contractAddress), function_selector: functionSelector,
        parameter: encodeParameters(parameters), fee_limit: feeLimit, call_value: options.callValue ?? 0, visible: false,
      }, 'build a contract call')
      if (!r.transaction) throw new Error('triggersmartcontract returned no transaction')
      const built = tx.memo ? attachMemo(r.transaction, tx.memo, tx.memoEncoding) : r.transaction
      // The node is not trusted with what it builds (scan F7): the bytes must be exactly this call.
      assertNodeBuild(built, {
        type: 'TriggerSmartContract', owner: this.addressHex, contract: contractAddress,
        data: selector(functionSelector) + encodeParameters(parameters), callValue: BigInt(options.callValue ?? 0), feeLimit: BigInt(feeLimit),
      }, tx.memo ? memoBytes(tx.memo, tx.memoEncoding) : undefined)
      return { built, sim }
    }
    const { to, value, memo, memoEncoding } = tx as TronNativeTransfer
    const node = await this.post<TronRawTransaction>('/wallet/createtransaction', { owner_address: this.addressHex, to_address: toHexAddress(to), amount: sunToJson(BigInt(value), 'transfer amount'), visible: false }, 'build a transfer')
    const built = memo ? attachMemo(node, memo, memoEncoding) : node
    assertNodeBuild(built, { type: 'TransferContract', owner: this.addressHex, to, amount: BigInt(value) }, memo ? memoBytes(memo, memoEncoding) : undefined)
    return { built }
  }

  protected async buildTransaction(tx: TronTransaction): Promise<TronRawTransaction> {
    return (await this.buildWithSimulation(tx)).built
  }

  // ── Simulation ──────────────────────────────────────────────────────────────

  /** Constant call by selector + params (unbuilt contract call). Never throws on a revert. */
  protected async simulateCall(tx: TronContractCall): Promise<TronSimulation> {
    return this.constantSimulation({
      owner_address: this.addressHex, contract_address: toHexAddress(tx.contractAddress), function_selector: tx.functionSelector,
      parameter: encodeParameters(tx.parameters ?? []), call_value: tx.options?.callValue ?? 0, visible: false,
    })
  }

  private async constantSimulation(body: Record<string, unknown>): Promise<TronSimulation> {
    const res = (await this.requireClient('simulate transactions')('/wallet/triggerconstantcontract', body)) as ConstantCallResponse
    if (res?.Error) return { ok: false, energy: 0, reason: res.Error }
    const energy = res.energy_used ?? 0
    if (res.result && res.result.result === false) {
      return { ok: false, energy, reason: `${res.result.code ?? 'CONTRACT_VALIDATE_ERROR'}${res.result.message ? `: ${hexToText(res.result.message)}` : ''}` }
    }
    const ret = res.transaction?.ret?.[0]
    const failed = ret?.ret === 'FAILED' || (ret?.contractRet !== undefined && ret.contractRet !== 'SUCCESS')
    if (failed) {
      const reason = decodeRevertReason(res.constant_result?.[0]) ?? ret?.contractRet ?? 'REVERT'
      const prefix = ret?.contractRet && ret.contractRet !== 'REVERT' ? `${ret.contractRet}: ` : ''
      return { ok: false, energy, reason: prefix + reason, constantResult: res.constant_result }
    }
    return { ok: true, energy, constantResult: res.constant_result }
  }

  /**
   * Predict the outcome without signing: contract calls run through
   * `/wallet/triggerconstantcontract` (revert reason ABI-decoded); TRX transfers check
   * that the balance covers amount + fees. Transport failures throw, predicted failures don't.
   */
  async simulateTransaction(tx: TronTransaction): Promise<TronSimulation> {
    this.requireClient('simulate transactions')
    if (isContractCall(tx)) return this.simulateCall(tx)
    if (!isPrebuilt(tx)) {
      const { to, value } = tx as TronNativeTransfer
      return this.simulateNativeTransfer(BigInt(value))
    }
    return this.simulateRaw(tx)
  }

  protected async simulateRaw(tx: TronRawTransaction): Promise<TronSimulation> {
    const { type, value } = contractOf(tx)
    if (type === 'TriggerSmartContract') {
      return this.constantSimulation({
        owner_address: value.owner_address, contract_address: value.contract_address, data: value.data, call_value: value.call_value ?? 0, visible: tx.visible ?? false,
      })
    }
    if (type === 'TransferContract') return this.simulateNativeTransfer(BigInt((value.amount as number | string) ?? 0), tx)
    return { ok: true, energy: 0 }
  }

  private async simulateNativeTransfer(amount: bigint, built?: TronRawTransaction): Promise<TronSimulation> {
    const balance = await this.getBalance()
    const burn = built ? (await this.estimateRaw(built)).trxBurn : 0n
    if (balance < amount + burn) return { ok: false, energy: 0, reason: `Insufficient TRX: need ${amount + burn} sun, have ${balance}` }
    return { ok: true, energy: 0 }
  }

  // ── Fees ────────────────────────────────────────────────────────────────────

  protected async getResources(): Promise<Resources> {
    return this.post<Resources>('/wallet/getaccountresource', { address: this.addressHex, visible: false }, 'read account resources')
  }

  protected async getChainParameters(): Promise<Record<string, bigint>> {
    const r = await this.post<{ chainParameter?: ChainParam[] }>('/wallet/getchainparameters', {}, 'read chain parameters')
    const out: Record<string, bigint> = { ...PARAM_DEFAULTS }
    for (const p of r.chainParameter ?? []) if (p.value !== undefined) out[p.key] = BigInt(p.value)
    return out
  }

  protected async getChainParameter(key: string): Promise<bigint> {
    const p = (await this.getChainParameters())[key]
    if (p === undefined) throw new Error(`Chain parameter ${key} not found`)
    return p
  }

  /**
   * Resource-by-resource cost of a node-built transaction. `energy` comes from a
   * constant call unless the caller already has one (`sim`).
   */
  protected async estimateRaw(tx: TronRawTransaction, sim?: TronSimulation): Promise<TronFeeEstimate> {
    const { type, value } = contractOf(tx)
    const [params, res] = await Promise.all([this.getChainParameters(), this.getResources()])
    const energyPrice = params.getEnergyFee ?? 0n
    const bandwidthPrice = params.getTransactionFee ?? 0n

    const energy = type === 'TriggerSmartContract' ? (sim ?? (await this.simulateRaw(tx))).energy : 0
    const bandwidth = bandwidthPoints(tx.raw_data_hex, Math.max(1, tx.signature?.length ?? 1))

    const bandwidthFree = Math.max(0, (res.freeNetLimit ?? 0) - (res.freeNetUsed ?? 0))
    const bandwidthStaked = Math.max(0, (res.NetLimit ?? 0) - (res.NetUsed ?? 0))
    const energyStaked = Math.max(0, (res.EnergyLimit ?? 0) - (res.EnergyUsed ?? 0))

    // Account creation (TransferContract to an address the chain has never seen):
    // 1 TRX system fee, plus 0.1 TRX unless STAKED bandwidth covers the bytes — free
    // bandwidth is not accepted for creation (java-tron BandwidthProcessor).
    let accountCreationFee = 0n
    let creating = false
    if ((type === 'TransferContract' || type === 'TransferAssetContract') && value.to_address) {
      creating = !(await this.accountExists(String(value.to_address)))
      if (creating) {
        const rate = bigintToNumber(params.getCreateNewAccountBandwidthRate ?? 1n)
        accountCreationFee = params.getCreateNewAccountFeeInSystemContract! + (bandwidthStaked >= bandwidth * rate ? 0n : params.getCreateAccountFee!)
      }
    }
    // Ordinary bandwidth: staked first, then free, else burn at getTransactionFee per byte.
    const bandwidthBurn = creating || bandwidthStaked >= bandwidth || bandwidthFree >= bandwidth ? 0n : BigInt(bandwidth) * bandwidthPrice
    const energyBurn = BigInt(Math.max(0, energy - energyStaked)) * energyPrice
    const memoFee = tx.raw_data?.data ? params.getMemoFee! : 0n

    return {
      bandwidth, energy,
      trxBurn: bandwidthBurn + energyBurn + accountCreationFee + memoFee,
      breakdown: { bandwidthFree, bandwidthStaked, energyStaked, energyPrice, bandwidthPrice, memoFee, accountCreationFee, bandwidthBurn, energyBurn },
    }
  }

  /** Build (if needed) and price a transaction: bandwidth, energy and the sun the sender burns. */
  async estimateFee(tx: TronTransaction): Promise<TronFeeEstimate> {
    this.requireClient('estimate fees')
    const { built, sim } = await this.buildWithSimulation(tx)
    return this.estimateRaw(built, sim)
  }

  protected async quoteTransaction(tx: TronRawTransaction, sim?: TronSimulation): Promise<TronQuote> {
    const estimate = await this.estimateRaw(tx, sim)
    return { fee: estimate.trxBurn, activationFee: estimate.breakdown.accountCreationFee, estimate }
  }

  /** `fee` = the sun the sender burns, after staked / free resources. */
  async quoteSendTransaction(tx: TronTransaction): Promise<TronQuote> {
    this.requireClient('quote transactions')
    const { built, sim } = await this.buildWithSimulation(tx)
    return this.quoteTransaction(built, sim)
  }

  protected trc20TransferParams(recipient: string, amount: bigint | number | string) {
    return [{ type: 'address', value: recipient }, { type: 'uint256', value: BigInt(amount) }]
  }

  protected asTransaction(o: TronTransferOptions): TronTransaction {
    const memo = o.memo ? { memo: o.memo, ...(o.memoEncoding ? { memoEncoding: o.memoEncoding } : {}) } : {}
    return o.token
      ? { contractAddress: o.token, functionSelector: 'transfer(address,uint256)', parameters: this.trc20TransferParams(o.recipient, o.amount), options: { callValue: 0 }, ...memo }
      : { to: o.recipient, value: o.amount, ...memo }
  }

  /** Fee of a transfer in sun, including account activation when the recipient is new. */
  async quoteTransfer(o: TronTransferOptions): Promise<TronQuote> {
    this.requireClient('quote transfer operations')
    return this.quoteSendTransaction(this.asTransaction(o))
  }

  // ── Describe ────────────────────────────────────────────────────────────────

  /** `describeTransaction` plus the `unactivated-recipient` check against the node. */
  async describeTransactionOnline(tx: TronTransaction, ctx: DescribeContext = {}): Promise<TronTxDescription> {
    const offline = describeTransaction(tx, ctx)
    if (ctx.recipientExists !== undefined || !offline.to || (offline.kind !== 'trx-transfer' && offline.kind !== 'trc20-transfer')) return offline
    return describeTransaction(tx, { ...ctx, recipientExists: await this.accountExists(offline.to) })
  }

  /** The receipt, or `undefined` while the transaction is unconfirmed. */
  async getTransactionReceipt(hash: string): Promise<TronReceipt | undefined> {
    const info = await this.post<Record<string, unknown>>('/wallet/gettransactioninfobyid', { value: hash }, 'fetch transaction receipts')
    if (!info || Object.keys(info).length === 0) return undefined
    const receipt = info.receipt as { result?: string } | undefined
    const failed = info.result === 'FAILED' || (receipt?.result !== undefined && receipt.result !== 'SUCCESS')
    return { hash, status: failed ? 0 : 1, blockNumber: BigInt((info.blockNumber as number) ?? 0), fee: BigInt((info.fee as number) ?? 0), raw: info }
  }

  /** Verify a TIP-191 signature produced by `sign` (0x + r||s||v, v = 27|28 or 0|1). */
  async verify(message: string | Uint8Array, signature: string): Promise<boolean> {
    return recoverMessageAddress(message, signature) === this.address
  }
}

export { selector }
