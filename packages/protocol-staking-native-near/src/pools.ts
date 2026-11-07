import { sha256 } from '@noble/hashes/sha2.js'
import { isValidAccountId } from '@anywalletkit/wallet-near'
import { POOL_FACTORY_SUFFIXES, type PoolFactory } from './constants.js'
import { NearStakingError } from './errors.js'
import type { NearNetwork, NormalizedPools, PoolConfig, PoolsOption } from './types.js'

/** The factory that deployed `poolId`, by its account-id suffix; null for anything else. Local check: no RPC can change it. */
export function factoryOf(poolId: string, network: NearNetwork): PoolFactory | null {
  for (const { suffix, factory } of POOL_FACTORY_SUFFIXES[network]) {
    // The part before the suffix must be one non-empty name segment: "x.poolv1.near", not ".poolv1.near" or "a.b.poolv1.near".
    if (poolId.endsWith(suffix)) {
      const head = poolId.slice(0, -suffix.length)
      if (head.length > 0 && !head.includes('.') && isValidAccountId(poolId)) return factory
    }
  }
  return null
}

/**
 * Stable request id of a pool's unstaked balance: the first 8 bytes of sha256(pool id) as a u64.
 * A pool keeps one unstaked balance per account, so the pool is the request.
 */
export function poolRequestId(poolId: string): bigint {
  let id = 0n
  for (const b of sha256(new TextEncoder().encode(poolId)).subarray(0, 8)) id = (id << 8n) | BigInt(b)
  return id
}

/** Validates the `pools` option: required, valid account ids, duplicates dropped. Factory checks happen per network at use. */
export function normalizePools(option: PoolsOption | undefined): NormalizedPools {
  if (option === 'any') return 'any'
  if (!Array.isArray(option) || option.length === 0) {
    throw new NearStakingError('invalid-config', "NativeStakingProtocolNear needs `pools`: the pool ids it may stake into (or 'any' to let users pick from the validator set).")
  }
  const seen = new Set<string>()
  const out: Array<{ id: string; name?: string }> = []
  for (const p of option as ReadonlyArray<string | PoolConfig>) {
    const raw = typeof p === 'string' ? { id: p } : p
    if (!raw || typeof raw.id !== 'string' || !isValidAccountId(raw.id)) throw new NearStakingError('invalid-config', `'${String(raw?.id)}' is not a valid NEAR account id.`)
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    out.push(typeof raw.name === 'string' ? { id: raw.id, name: raw.name } : { id: raw.id })
  }
  return out
}
