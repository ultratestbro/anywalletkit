import { NearRpcError, type NearFetch } from '@anywalletkit/wallet-near'
import { LIQUID_PRESETS } from '../src/index.js'

// In-memory NEAR node for one LiNEAR-family contract: the RPC methods the module reads (`validators`,
// `block` by height and finality, `gas_price`, `view_account`, `call_function` with finality or a
// past `block_id`). Contract math follows internal.rs (shares rounded down on stake).

export const NEAR = 10n ** 24n
export const ALICE = 'alice.near'
export const LINEAR = LIQUID_PRESETS.linear.contracts.mainnet.contract
export const LINEAR_HASH = LIQUID_PRESETS.linear.contracts.mainnet.codeHashes[0]
export const RNEAR = LIQUID_PRESETS.rnear.contracts.mainnet.contract
export const RNEAR_HASH = LIQUID_PRESETS.rnear.contracts.mainnet.codeHashes[0]

/** Mainnet-like defaults (2026-11-08): LiNEAR price 1.4301, epoch 4946 starting at 223 487 537. */
export const EPOCH = 4946n
export const EPOCH_START = 223_487_537n
export const EPOCH_LEN = 43_200n
/** ~6.9 h per epoch. */
export const MS_PER_BLOCK = 575
export const GENESIS_MS = 1_794_000_000_000

export interface FakeAccount { shares: bigint; unstaked: bigint; unlockEpoch: bigint; registered: boolean }

export class FakeNear {
  contract: string = LINEAR
  codeHash: string = LINEAR_HASH
  symbol = 'LINEAR'
  /** `is_paused` answer: a boolean, or the method missing / panicking / answering garbage. */
  paused: boolean | 'missing' | 'panics' | 'garbage' = false
  /**
   * `pa_all_paused` answer (near-plugins per-feature pauses, rNEAR): the paused keys, null for none, or
   * the method missing as LiNEAR answers it ('missing': in the call result; 'missing-structured': as a
   * JSON-RPC error), panicking or answering garbage.
   */
  pauseKeys: string[] | null | 'missing' | 'missing-structured' | 'panics' | 'garbage' = 'missing'
  /** `storage_balance_bounds.min` (0.00125 NEAR on both mainnet contracts). */
  storageMin = 1_250_000_000_000_000_000_000n
  totalStaked = 12_766_424_855_885_013_372_832_084_904_913n
  totalShares = 8_926_759_580_492_877_835_961_310_684_912n
  /** The contract's liquid balance (view_account.amount). */
  liquidity = 1_000_000n * NEAR
  /** The contract's storage_usage in bytes (LiNEAR on mainnet: 13.35 MB = 133.5 NEAR of storage). */
  contractStorage = 13_347_387n
  /** `runtime_config.min_gas_purchase_price`; 'fails' makes EXPERIMENTAL_protocol_config throw. */
  minGasPurchasePrice: string | 'fails' = '1000000000'
  beneficiaries: Record<string, number> = { 'linear.sputnik-dao.near': 600 }
  epochHeight = EPOCH
  epochStart = EPOCH_START
  head = EPOCH_START + 10_000n
  gasPrice = 100_000_000n
  /** Heights that were skipped (no block). */
  skipped = new Set<bigint>()
  /** Heights below this are pruned (UNKNOWN_BLOCK / garbage collected), as on a non-archival node. */
  prunedBelow = 0n
  /** Price growth per epoch for past `ft_price` reads, parts per 10^12 (≈ 4.7 % a year by default). */
  growthPerEpoch = 37_000_000n
  accounts = new Map<string, FakeAccount>()
  /** view_account of users: amount / locked / storage_usage. */
  balances = new Map<string, { amount: bigint; locked: bigint; storage: bigint }>()
  calls: Array<{ method: string; params: unknown }> = []
  /** Throw a transport error for these call_function methods (anything but a node answer). */
  failing = new Set<string>()

  constructor(init: Partial<Pick<FakeNear, 'contract' | 'codeHash' | 'symbol' | 'pauseKeys'>> = {}) {
    Object.assign(this, init)
    this.balances.set(ALICE, { amount: 100n * NEAR, locked: 0n, storage: 182n })
  }

  get price(): bigint { return (this.totalStaked * NEAR) / this.totalShares }

  /** Price at a past height: the current price discounted by `growthPerEpoch` per epoch back. */
  priceAt(height: bigint): bigint {
    const epochsBack = (this.head - height) / EPOCH_LEN
    return (this.price * 10n ** 12n) / (10n ** 12n + this.growthPerEpoch * epochsBack)
  }

  timeAt(height: bigint): number {
    return GENESIS_MS + Number((height - (EPOCH_START - 10n * EPOCH_LEN)).toString()) * MS_PER_BLOCK
  }

  account(id: string): FakeAccount {
    let a = this.accounts.get(id)
    if (!a) { a = { shares: 0n, unstaked: 0n, unlockEpoch: 0n, registered: false }; this.accounts.set(id, a) }
    return a
  }

  /** Gives `id` tokens worth `near` NEAR, as deposit_and_stake would. */
  stakeFor(id: string, near: bigint): void {
    const a = this.account(id)
    const shares = (near * this.totalShares) / this.totalStaked
    a.shares += shares
    a.registered = true
    this.totalShares += shares
    this.totalStaked += near
  }

  /** An unstaked balance, locked until `unlockEpoch` (≤ current epoch = can_withdraw). */
  unstakedFor(id: string, amount: bigint, unlockEpoch: bigint): void {
    const a = this.account(id)
    a.unstaked = amount
    a.unlockEpoch = unlockEpoch
    a.registered = true
  }

  private static rpcError(method: string, name: string): NearRpcError {
    return new NearRpcError(method, { name: 'HANDLER_ERROR', cause: { name } })
  }

  private block(height: bigint): unknown {
    if (height < this.prunedBelow) throw FakeNear.rpcError('block', 'UNKNOWN_BLOCK')
    if (this.skipped.has(height) || height > this.head) throw FakeNear.rpcError('block', 'UNKNOWN_BLOCK')
    return { header: { height: Number(height.toString()), timestamp: this.timeAt(height) * 1e6, timestamp_nanosec: (BigInt(this.timeAt(height)) * 1_000_000n).toString(), hash: 'H' } }
  }

  private view(method: string, args: Record<string, unknown>, height: bigint): unknown {
    const id = typeof args.account_id === 'string' ? args.account_id : ''
    const a = this.accounts.get(id)
    switch (method) {
      case 'ft_metadata': return { spec: 'ft-1.0.0', name: this.symbol, symbol: this.symbol, decimals: 24 }
      case 'ft_price': return String(height === this.head ? this.price : this.priceAt(height))
      case 'get_summary': return { total_share_amount: String(this.totalShares), total_staked_near_amount: String(this.totalStaked), ft_price: String(this.price), validators_num: 448 }
      case 'get_beneficiaries': return this.beneficiaries
      case 'ft_balance_of': return String(a?.shares ?? 0n)
      case 'storage_balance_of': return a?.registered ? { total: String(this.storageMin), available: '0' } : null
      case 'storage_balance_bounds': return { min: String(this.storageMin), max: String(this.storageMin) }
      case 'pa_all_paused':
        if (this.pauseKeys === 'garbage') return { internal_withdraw: true }
        return this.pauseKeys
      case 'get_account_details': return {
        account_id: id, unstaked_balance: String(a?.unstaked ?? 0n), staked_balance: String(((a?.shares ?? 0n) * this.totalStaked) / this.totalShares),
        unstaked_available_epoch_height: Number((a?.unlockEpoch ?? 0n).toString()), can_withdraw: (a?.unlockEpoch ?? 0n) <= this.epochHeight,
      }
      case 'is_paused':
        if (this.paused === 'garbage') return 'no'
        return this.paused
      default: return undefined
    }
  }

  readonly fetch: NearFetch = async (method, params) => {
    this.calls.push({ method, params })
    const p = params as Record<string, unknown>
    if (method === 'gas_price') return { gas_price: String(this.gasPrice) }
    if (method === 'EXPERIMENTAL_protocol_config') {
      if (this.minGasPurchasePrice === 'fails') throw FakeNear.rpcError(method, 'INTERNAL_ERROR')
      return { protocol_version: 88, runtime_config: { min_gas_purchase_price: this.minGasPurchasePrice } }
    }
    if (method === 'validators') return { epoch_height: Number(this.epochHeight.toString()), epoch_start_height: Number(this.epochStart.toString()), current_validators: [], next_validators: [] }
    if (method === 'block') return this.block(p.finality === 'final' ? this.head : BigInt(p.block_id as number))
    if (method === 'query' && p.request_type === 'view_account') {
      const id = p.account_id as string
      if (id === this.contract) return { amount: String(this.liquidity), locked: '0', storage_usage: Number(this.contractStorage.toString()), code_hash: this.codeHash }
      const b = this.balances.get(id)
      if (!b) throw FakeNear.rpcError('query', 'UNKNOWN_ACCOUNT')
      return { amount: String(b.amount), locked: String(b.locked), storage_usage: Number(b.storage.toString()), code_hash: '11111111111111111111111111111111' }
    }
    if (method === 'query' && p.request_type === 'call_function') {
      const name = p.method_name as string
      if (this.failing.has(name)) throw new Error(`fetch failed (${name})`)
      const height = p.block_id !== undefined ? BigInt(p.block_id as number) : this.head
      if (height < this.prunedBelow) throw FakeNear.rpcError('query', 'GARBAGE_COLLECTED_BLOCK')
      if (this.skipped.has(height)) throw FakeNear.rpcError('query', 'UNKNOWN_BLOCK')
      if (p.account_id !== this.contract) return { result: [], logs: [], error: 'wasm execution failed with error: CompilationError(CodeDoesNotExist)' }
      const args = JSON.parse(Buffer.from(p.args_base64 as string, 'base64').toString() || '{}') as Record<string, unknown>
      if (name === 'is_paused' && this.paused === 'missing') return { result: [], logs: [], error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
      if (name === 'is_paused' && this.paused === 'panics') return { result: [], logs: [], error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "x" })' }
      if (name === 'pa_all_paused' && this.pauseKeys === 'missing') return { result: [], logs: [], error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
      if (name === 'pa_all_paused' && this.pauseKeys === 'missing-structured') {
        throw new NearRpcError('query', { name: 'HANDLER_ERROR', message: 'Server error', cause: { name: 'CONTRACT_EXECUTION_ERROR', info: { vm_error: 'MethodResolveError(MethodNotFound)' } } })
      }
      if (name === 'pa_all_paused' && this.pauseKeys === 'panics') return { result: [], logs: [], error: 'wasm execution failed with error: HostError(GuestPanic { panic_msg: "x" })' }
      const v = this.view(name, args, height)
      if (v === undefined) return { result: [], logs: [], error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
      return { result: Array.from(Buffer.from(JSON.stringify(v))), logs: [], block_height: Number(height.toString()), block_hash: 'H' }
    }
    throw new Error(`unmocked ${method} ${JSON.stringify(params)}`)
  }
}
