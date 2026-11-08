import { KNOWN_POOL_CODE_HASHES } from '@anywalletkit/protocol-staking-native-near'
import { LIQUID_PRESETS } from '@anywalletkit/protocol-staking-liquid-near'

// An offline NEAR mainnet behind `fetch`, for the Earn guide's NEAR snippets: JSON-RPC on any URL
// (validators, block, gas_price, EXPERIMENTAL_protocol_config, view_account and the view calls of
// two staking pools and the two liquid-staking contracts) and fastnear's staking index. Anything
// else throws, so a test can never reach the network. Figures are in the range mainnet shows
// (November 2026): ~6.9 h epochs, ~5 % gross APR, LINEAR at ~1.43 NEAR, rNEAR at ~1.07 NEAR.

export const NEAR = 10n ** 24n
export const ASTRO = 'astro-stakers.poolv1.near'
export const FIGMENT = 'figment.poolv1.near'
export const LINEAR = 'linear-protocol.near'
export const RNEAR = 'lst.rhealab.near'

const EPOCH = 4948
const EPOCH_LENGTH = 43_200
const START = 223_574_400
const HEAD = START + 40_000
const MS_PER_BLOCK = 575 // 43 200 heights ≈ 6.9 h
const START_MS = 1_794_000_000_000
const timeAt = (height: number) => START_MS + (height - START) * MS_PER_BLOCK

const POOLS: Record<string, { stake: bigint; reward: bigint; fee: { numerator: number; denominator: number } }> = {
  // reward = last epoch's payout: ~5.2 % a year at ~1 270 epochs a year
  [ASTRO]: { stake: 33_000_000n * NEAR, reward: 1_350n * NEAR, fee: { numerator: 1, denominator: 100 } },
  [FIGMENT]: { stake: 28_000_000n * NEAR, reward: 1_146n * NEAR, fee: { numerator: 10, denominator: 100 } },
}

interface Lst { symbol: string; codeHash: string; totalStaked: bigint; price: bigint; storage: number; liquidity: bigint; beneficiaries: Record<string, number> }
const LST: Record<string, Lst> = {
  [LINEAR]: { symbol: 'LINEAR', codeHash: LIQUID_PRESETS.linear.contracts.mainnet.codeHashes[0], totalStaked: 7_000_000n * NEAR, price: 1_430_000_000_000_000_000_000_000n, storage: 13_300_000, liquidity: 5_000n * NEAR, beneficiaries: { 'linear.sputnik-dao.near': 600 } },
  [RNEAR]: { symbol: 'rNEAR', codeHash: LIQUID_PRESETS.rnear.contracts.mainnet.codeHashes[0], totalStaked: 18_800_000n * NEAR, price: 1_068_481_000_000_000_000_000_000n, storage: 5_200_000, liquidity: 30_000n * NEAR, beneficiaries: { 'ref-finance.sputnik-dao.near': 500 } },
}
/** The token price at `height`: ~4.7 % a year of growth (54 885 000 heights a year at 575 ms), linear in height. */
const priceAt = (lst: Lst, height: number) => lst.price - (lst.price * 47n * BigInt(HEAD - height)) / (1000n * 54_885_000n)

/** What the wallet under test holds: 5 NEAR staked in astro-stakers, 2 LINEAR, nothing in rNEAR. */
export const HOLDINGS = { staked: { [ASTRO]: 5n * NEAR } as Record<string, bigint>, shares: { [LINEAR]: 2n * NEAR } as Record<string, bigint> }

/** A node error, as the JSON-RPC answer carries it. */
class RpcError {
  constructor(readonly name: string, readonly cause: { name: string }) {}
}

const bytes = (v: unknown) => [...new TextEncoder().encode(JSON.stringify(v))]

function view(contract: string, method: string, args: Record<string, unknown>): unknown {
  const who = String(args.account_id ?? '')
  const pool = POOLS[contract]
  if (pool) {
    switch (method) {
      case 'is_staking_paused': return false
      case 'get_reward_fee_fraction': return pool.fee
      case 'get_account': return { account_id: who, unstaked_balance: '0', staked_balance: String(HOLDINGS.staked[contract] ?? 0n), can_withdraw: true }
    }
  }
  const lst = LST[contract]
  if (lst) {
    const totalShares = (lst.totalStaked * NEAR) / lst.price
    const shares = HOLDINGS.shares[contract] ?? 0n
    switch (method) {
      case 'ft_metadata': return { spec: 'ft-1.0.0', name: lst.symbol, symbol: lst.symbol, decimals: 24 }
      case 'get_summary': return { total_share_amount: String(totalShares), total_staked_near_amount: String(lst.totalStaked), ft_price: String(lst.price), validators_num: 120 }
      case 'is_paused': return false
      case 'pa_all_paused': return null // rNEAR's per-feature pauses: none (LiNEAR is not asked)
      case 'get_beneficiaries': return lst.beneficiaries
      case 'ft_price': return String(lst.price)
      case 'ft_balance_of': return String(shares)
      case 'storage_balance_of': return shares > 0n ? { total: '1250000000000000000000', available: '0' } : null
      case 'get_account_details': return {
        account_id: who, unstaked_balance: '0', staked_balance: String((shares * lst.price) / NEAR), unstaked_available_epoch_height: 0, can_withdraw: true,
      }
    }
  }
  throw new RpcError('HANDLER_ERROR', { name: 'CONTRACT_EXECUTION_ERROR' })
}

function query(p: Record<string, unknown>): unknown {
  const id = String(p.account_id)
  const height = typeof p.block_id === 'number' ? p.block_id : HEAD
  if (p.request_type === 'view_account') {
    if (POOLS[id]) return { amount: String(1_000n * NEAR), locked: String(POOLS[id]!.stake), storage_usage: 300_000, code_hash: KNOWN_POOL_CODE_HASHES.mainnet[0], block_height: height }
    if (LST[id]) return { amount: String(LST[id]!.liquidity), locked: '0', storage_usage: LST[id]!.storage, code_hash: LST[id]!.codeHash, block_height: height }
    // Any other account is the wallet under test: 10 NEAR, a plain implicit account.
    return { amount: String(10n * NEAR), locked: '0', storage_usage: 182, code_hash: '11111111111111111111111111111111', block_height: height }
  }
  if (p.request_type === 'call_function') {
    const text = new TextDecoder().decode(Uint8Array.from(atob(String(p.args_base64)), (c) => c.charCodeAt(0)))
    const args = JSON.parse(text || '{}') as Record<string, unknown>
    const lst = LST[id]
    const value = lst && p.method_name === 'ft_price' ? String(priceAt(lst, height)) : view(id, String(p.method_name), args)
    return { result: bytes(value), logs: [], block_height: height, block_hash: 'GJ2rdmT1NR5zLDyN2ZdN5YhZuRsxXjrxfX7h1yA9mpRZ' }
  }
  throw new RpcError('HANDLER_ERROR', { name: 'UNKNOWN_REQUEST' })
}

function rpc(method: string, params: unknown): unknown {
  const p = (params ?? {}) as Record<string, unknown>
  switch (method) {
    case 'validators': {
      const current = Object.entries(POOLS).map(([account_id, v]) => ({
        account_id, stake: String(v.stake), num_produced_blocks: 900, num_expected_blocks: 900, num_produced_chunks: 3600, num_expected_chunks: 3600,
      }))
      return {
        epoch_height: EPOCH, epoch_start_height: START, current_validators: current,
        next_validators: current.map(({ account_id, stake }) => ({ account_id, stake })),
        validator_reward_paid_prev_epoch: Object.fromEntries(Object.entries(POOLS).map(([id, v]) => [id, String(v.reward)])),
      }
    }
    case 'block': {
      const height = typeof p.block_id === 'number' ? p.block_id : HEAD
      return { header: { height, epoch_id: `epoch-${EPOCH + Math.floor((height - START) / EPOCH_LENGTH)}`, timestamp_nanosec: String(BigInt(timeAt(height)) * 1_000_000n), hash: 'GJ2rdmT1NR5zLDyN2ZdN5YhZuRsxXjrxfX7h1yA9mpRZ' } }
    }
    case 'gas_price': return { gas_price: '100000000' }
    case 'EXPERIMENTAL_protocol_config': return { runtime_config: { min_gas_purchase_price: '1000000000' } }
    case 'query': return query(p)
  }
  throw new RpcError('METHOD_NOT_FOUND', { name: 'METHOD_NOT_FOUND' })
}

/** A `fetch` that answers NEAR JSON-RPC and fastnear's staking index offline, recording every URL it was asked for. */
export function offlineNear() {
  const urls: string[] = []
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    urls.push(url)
    const staking = /^https:\/\/api\.fastnear\.com\/v1\/account\/([^/]+)\/staking$/.exec(url)
    if (staking) {
      const account = decodeURIComponent(staking[1]!)
      return json({ account_id: account, pools: Object.keys(HOLDINGS.staked).map((pool_id) => ({ pool_id, last_update_block_height: HEAD - 100 })) })
    }
    if (init?.method !== 'POST') throw new Error(`offline: GET ${url}`)
    const { id, method, params } = JSON.parse(String(init.body)) as { id: string; method: string; params: unknown }
    try {
      return json({ jsonrpc: '2.0', id, result: rpc(method, params) })
    } catch (e) {
      if (!(e instanceof RpcError)) throw e
      return json({ jsonrpc: '2.0', id, error: { name: e.name, message: e.cause.name, cause: e.cause } })
    }
  }
  return { fetch, urls }
}
