import { readFileSync } from 'node:fs'
import { NearRpcError, type NearFetch, type NearTransaction } from '@anywalletkit/wallet-near'
import { createMockAccount } from '@anywalletkit/conformance'
import type { TransferResult, WriteOptions } from '@anywalletkit/core'

// An in-memory NEAR node behind the JSON-RPC transport: `validators`, `block` (final / by height,
// with skipped and pruned heights), `gas_price`, `view_account` and the staking-pool views
// (`get_account`, `is_staking_paused`, `get_reward_fee_fraction`). It starts from the answers
// recorded on mainnet (fixtures/rpc/mainnet.json, scripts/capture-fixtures.mjs) and tests change it.

export const NEAR = 10n ** 24n
export const TGAS = 10n ** 12n
export const ME = 'alice.near'
export const ASTRO = 'astro-stakers.poolv1.near'
export const FIGMENT = 'figment.poolv1.near'
export const ZAVODIL = 'zavodil.poolv1.near'
export const AURORA = 'aurora.pool.near'

interface Header { height: number; timestamp: number; timestamp_nanosec: string; epoch_id: string; hash: string }
interface Recording {
  validators: {
    epoch_height: number
    epoch_start_height: number
    current_validators: Array<Record<string, unknown> & { account_id: string; stake: string }>
    next_validators: Array<{ account_id: string; stake: string; public_key?: string }>
    validator_reward_paid_prev_epoch: Record<string, string>
    _network: { validators: number; rewards: string; stake: string }
  }
  blocks: { final: Header; start: Header; prev: Header }
  gasPrice: string
  accounts: Record<string, { result?: { amount: string; locked: string; storage_usage: number; code_hash: string }; error?: unknown }>
  calls: Record<string, unknown>
}

export const recording = (): Recording =>
  JSON.parse(readFileSync(new URL('../fixtures/rpc/mainnet.json', import.meta.url), 'utf8')) as Recording

/** A pool view's behaviour: a value, a missing method, or a failing call. */
export type View<T> = T | { missing: true } | { throws: string }
export interface Delegation { staked: bigint; unstaked: bigint; canWithdraw: boolean }
export interface FakePool { paused: View<unknown>; fee: View<unknown>; delegators: Map<string, Delegation>; summary?: View<unknown> }
export interface FakeAccount { amount: bigint; locked: bigint; storage: number; codeHash: string }

const rpcError = (name: string, message = name) => new NearRpcError('query', { name: 'HANDLER_ERROR', message, cause: { name } })

export class FakeNear {
  readonly rec = recording()
  validators = structuredClone(this.rec.validators)
  final: Header = { ...this.rec.blocks.final }
  gasPrice = this.rec.gasPrice
  /** `runtime_config.min_gas_purchase_price` of EXPERIMENTAL_protocol_config (mainnet, protocol 88); a { throws } fails the call. */
  minGasPurchasePrice: View<string> = '1000000000'
  /** Code hashes the pool.near factory allows (`is_contract_allowed`). */
  factoryAllowed = new Set<string>(['AjD4YJaXgpiRdiArqnzyDi7Bkr1gJms9Z2w7Ev5esTKB', 'GGfKUF9TuAFN4AzbecPonNGuRTuVqx8UPXmViogN8pRm', '5vf2Jkqpk11H7szLnY4XdPA6maJi1ND8xe346xtbtX8e'])
  accounts = new Map<string, FakeAccount>()
  pools = new Map<string, FakePool>()
  /** Heights the chain skipped (UNKNOWN_BLOCK) and blocks a node pruned (any other error). */
  skipped = new Set<number>()
  pruned = new Set<number>()
  /** Every request, for "no RPC call" assertions. */
  requests: Array<{ method: string; params: unknown }> = []
  /** epoch_id → epoch_height for `validators { epoch_id }`. */
  epochIds = new Map<string, number>()

  constructor() {
    for (const [id, r] of Object.entries(this.rec.accounts)) {
      if (r.result) this.accounts.set(id, { amount: BigInt(r.result.amount), locked: BigInt(r.result.locked), storage: r.result.storage_usage, codeHash: r.result.code_hash })
    }
    for (const id of [ASTRO, FIGMENT, AURORA, ZAVODIL, 'lst-pool.near', 'meta-pool.near']) {
      const view = (m: string): View<unknown> => {
        const v = this.rec.calls[`${id} ${m}`]
        return typeof v === 'string' && /MethodNotFound/.test(v) ? { missing: true } : v
      }
      this.pools.set(id, { paused: view('is_staking_paused'), fee: view('get_reward_fee_fraction'), delegators: new Map() })
    }
    // staking-farm pools answer get_pool_summary; unless a test sets one, it repeats the current fee as the next one.
    this.accounts.set('pool.near', { amount: 100n * NEAR, locked: 0n, storage: 2_000_000, codeHash: 'factory' })
    const nima = this.rec.calls[`${ASTRO} get_account nima.near`] as { staked_balance: string; unstaked_balance: string; can_withdraw: boolean }
    this.pools.get(ASTRO)!.delegators.set('nima.near', { staked: BigInt(nima.staked_balance), unstaked: BigInt(nima.unstaked_balance), canWithdraw: nima.can_withdraw })
    // The wallet under test: 10 NEAR, a plain named account (182 bytes of storage).
    this.accounts.set(ME, { amount: 10n * NEAR, locked: 0n, storage: 182, codeHash: '11111111111111111111111111111111' })
    this.epochIds.set(this.rec.blocks.start.epoch_id, this.rec.validators.epoch_height)
    this.epochIds.set(this.rec.blocks.prev.epoch_id, this.rec.validators.epoch_height - 1)
  }

  get epochHeight(): bigint { return BigInt(this.validators.epoch_height) }

  /** A delegation of `who` in `pool` (created empty). */
  delegation(pool: string, who = ME): Delegation {
    const p = this.pools.get(pool) ?? this.addPool(pool)
    let d = p.delegators.get(who)
    if (!d) { d = { staked: 0n, unstaked: 0n, canWithdraw: true }; p.delegators.set(who, d) }
    return d
  }

  /** A pool account with the standard code, a 1 % fee, not paused (not in the validator set unless added there). */
  addPool(id: string, o: Partial<FakePool & { codeHash: string }> = {}): FakePool {
    this.accounts.set(id, { amount: 1000n * NEAR, locked: 0n, storage: 300_000, codeHash: o.codeHash ?? 'J1arLz48fgXcGyCPVckFwLnewNH6j1uw79thsvwqGYTY' })
    const pool: FakePool = { paused: o.paused ?? false, fee: o.fee ?? { numerator: 1, denominator: 100 }, delegators: o.delegators ?? new Map() }
    this.pools.set(id, pool)
    return pool
  }

  /** Puts a pool in the current and/or next set (optionally with a last-epoch reward). */
  addValidator(id: string, o: { stake?: bigint; current?: boolean; next?: boolean; reward?: bigint; produced?: number; expected?: number } = {}) {
    const stake = String(o.stake ?? 10_000_000n * NEAR)
    if (o.current ?? true) this.validators.current_validators.push({ account_id: id, stake, num_produced_blocks: o.produced ?? 100, num_expected_blocks: o.expected ?? 100, num_produced_chunks: o.produced ?? 100, num_expected_chunks: o.expected ?? 100 })
    if (o.next ?? true) this.validators.next_validators.push({ account_id: id, stake })
    if (o.reward !== undefined) this.validators.validator_reward_paid_prev_epoch[id] = String(o.reward)
  }

  removeValidator(id: string, from: 'current' | 'next' | 'both' = 'both') {
    if (from !== 'next') this.validators.current_validators = this.validators.current_validators.filter((v) => v.account_id !== id)
    if (from !== 'current') this.validators.next_validators = this.validators.next_validators.filter((v) => v.account_id !== id)
  }

  private header(height: number): Header {
    if (this.skipped.has(height)) throw new NearRpcError('block', { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' } })
    if (this.pruned.has(height)) throw new NearRpcError('block', { name: 'HANDLER_ERROR', message: 'DB Not Found Error: BLOCK', cause: { name: 'GARBAGE_COLLECTED_BLOCK' } })
    for (const h of [this.final, this.rec.blocks.start, this.rec.blocks.prev]) if (h.height === height) return h
    // Any other height: linear in time between the recorded epoch starts (~575 ms per height).
    const start = this.rec.blocks.start, prev = this.rec.blocks.prev
    const nsPerHeight = (BigInt(start.timestamp_nanosec) - BigInt(prev.timestamp_nanosec)) / BigInt(start.height - prev.height)
    const ns = BigInt(start.timestamp_nanosec) + BigInt(height - start.height) * nsPerHeight
    const epoch = this.validators.epoch_height + Math.floor((height - this.validators.epoch_start_height) / 43_200)
    const epochId = `epoch-${epoch}`
    if (!this.epochIds.has(epochId)) this.epochIds.set(epochId, epoch)
    return { height, timestamp: Number(ns), timestamp_nanosec: ns.toString(), epoch_id: epochId, hash: `h${height}` }
  }

  private view(pool: string, method: string, args: Record<string, unknown>): unknown {
    const account = this.accounts.get(pool)
    if (!account) throw rpcError('UNKNOWN_ACCOUNT', `account ${pool} does not exist while viewing`)
    if (pool === 'pool.near') {
      if (method === 'is_contract_allowed') return this.factoryAllowed.has(String(args.code_hash))
      return { __error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
    }
    const p = this.pools.get(pool)
    const answer = (v: View<unknown> | undefined): unknown => {
      if (v === undefined || (typeof v === 'object' && v !== null && 'missing' in v)) return { __error: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' }
      if (typeof v === 'object' && v !== null && 'throws' in v) return { __error: (v as { throws: string }).throws }
      return v
    }
    if (!p) return answer(undefined)
    if (method === 'is_staking_paused') return answer(p.paused)
    if (method === 'get_reward_fee_fraction') return answer(p.fee)
    if (method === 'get_pool_summary') {
      if (p.summary !== undefined) return answer(p.summary)
      const fee = answer(p.fee)
      if (fee && typeof fee === 'object' && '__error' in fee) return fee
      return { owner: 'owner.near', total_staked_balance: '1', reward_fee_fraction: fee, next_reward_fee_fraction: fee, burn_fee_fraction: { numerator: 0, denominator: 1 }, farms: [] }
    }
    if (method === 'get_account') {
      const d = p.delegators.get(String(args.account_id))
      return { account_id: args.account_id, unstaked_balance: String(d?.unstaked ?? 0n), staked_balance: String(d?.staked ?? 0n), can_withdraw: d?.canWithdraw ?? true }
    }
    return answer(undefined)
  }

  readonly fetch: NearFetch = async (method, params) => {
    this.requests.push({ method, params })
    const p = params as Record<string, unknown>
    if (method === 'gas_price') return { gas_price: this.gasPrice }
    if (method === 'EXPERIMENTAL_protocol_config') {
      const v = this.minGasPurchasePrice
      if (typeof v === 'object' && 'throws' in v) throw new NearRpcError(method, { name: 'HANDLER_ERROR', message: v.throws, cause: { name: 'INTERNAL_ERROR' } })
      if (typeof v === 'object') return { protocol_version: 88, runtime_config: {} }
      return { protocol_version: 88, runtime_config: { min_gas_purchase_price: v } }
    }
    if (method === 'validators') {
      if (Array.isArray(params) && params[0] === null) return structuredClone(this.validators)
      if (typeof p?.epoch_id === 'string') {
        const h = this.epochIds.get(p.epoch_id)
        if (h === undefined) throw new NearRpcError('validators', { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_EPOCH' } })
        return { ...structuredClone(this.validators), epoch_height: h }
      }
      throw new NearRpcError('validators', { name: 'HANDLER_ERROR', cause: { name: 'VALIDATOR_INFO_UNAVAILABLE' } })
    }
    if (method === 'block') {
      if (p.finality === 'final') return { header: this.final }
      return { header: this.header(Number(p.block_id)) }
    }
    if (method === 'query') {
      if (p.request_type === 'view_account') {
        const a = this.accounts.get(String(p.account_id))
        if (!a) throw rpcError('UNKNOWN_ACCOUNT', `account ${String(p.account_id)} does not exist while viewing`)
        return { amount: a.amount.toString(), locked: a.locked.toString(), storage_usage: a.storage, code_hash: a.codeHash, block_height: this.final.height, block_hash: this.final.hash }
      }
      if (p.request_type === 'call_function') {
        const args = JSON.parse(Buffer.from(String(p.args_base64), 'base64').toString()) as Record<string, unknown>
        const out = this.view(String(p.account_id), String(p.method_name), args)
        if (out && typeof out === 'object' && '__error' in out) return { error: (out as { __error: string }).__error, logs: [], block_height: this.final.height }
        return { result: Array.from(Buffer.from(JSON.stringify(out))), logs: [], block_height: this.final.height }
      }
    }
    throw new Error(`fake node: unmocked ${method} ${JSON.stringify(params)}`)
  }

  count(method: string, filter?: (params: Record<string, unknown>) => boolean): number {
    return this.requests.filter((r) => r.method === method && (!filter || filter(r.params as Record<string, unknown>))).length
  }

  /** Requests that touched an account (view_account or a view call on it). */
  touched(account: string): number {
    return this.count('query', (p) => p.account_id === account)
  }
}

/** A NEAR mock account that records what it is asked to send; `batch` adds the one-approval hook. */
export function nearAccount(o: { address?: string; chain?: string; batch?: boolean; fee?: bigint } = {}) {
  const account = createMockAccount({ chain: o.chain ?? 'near:mainnet', address: o.address ?? ME, fee: o.fee ?? 500_000_000_000_000_000_000n })
  const batches: NearTransaction[][] = []
  if (o.batch) {
    let n = 0
    Object.assign(account, {
      sendTransactions: async (txs: NearTransaction[], _options?: WriteOptions): Promise<TransferResult[]> => {
        batches.push(txs)
        account.sent.push(...txs)
        return txs.map(() => ({ hash: `BATCH${++n}`, fee: o.fee ?? 500_000_000_000_000_000_000n }))
      },
    })
  }
  return Object.assign(account, { batches })
}
