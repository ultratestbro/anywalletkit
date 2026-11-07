import { sha256 } from '@noble/hashes/sha2.js'
import { isValidAccountId } from '@anywalletkit/wallet-near'
import { LIQUID_PRESETS, type LiquidPresetName } from './constants.js'
import { LiquidStakingError } from './errors.js'
import type { LiquidPoolConfig, NearNetwork } from './types.js'

/** A pool resolved for one network. */
export interface ResolvedLiquidPool {
  contract: string
  symbol: string
  name: string
  codeHashes: readonly string[]
  preset: LiquidPresetName | null
}

/** Validates a custom pool config (account id, symbol, at least one pinned code hash). */
export function validatePoolConfig(pool: LiquidPresetName | LiquidPoolConfig): void {
  if (typeof pool === 'string') {
    if (!(pool in LIQUID_PRESETS)) throw new LiquidStakingError('invalid-config', `Unknown pool '${pool}': use ${Object.keys(LIQUID_PRESETS).map((k) => `'${k}'`).join(' or ')}, or a { contract, symbol, codeHashes } config.`)
    return
  }
  if (!pool || typeof pool !== 'object' || typeof pool.contract !== 'string' || !isValidAccountId(pool.contract)) throw new LiquidStakingError('invalid-config', 'pool.contract must be a NEAR account id.')
  if (typeof pool.symbol !== 'string' || pool.symbol.length === 0) throw new LiquidStakingError('invalid-config', 'pool.symbol is required.')
  if (!Array.isArray(pool.codeHashes) || pool.codeHashes.length === 0 || !pool.codeHashes.every((h) => typeof h === 'string' && h.length > 0)) {
    throw new LiquidStakingError('invalid-config', 'pool.codeHashes must pin at least one code hash.')
  }
}

/** The contract, symbol and pinned code hashes of a pool on `network`. */
export function resolvePool(pool: LiquidPresetName | LiquidPoolConfig, network: NearNetwork): ResolvedLiquidPool {
  if (typeof pool !== 'string') return { contract: pool.contract, symbol: pool.symbol, name: pool.name ?? pool.symbol, codeHashes: pool.codeHashes, preset: null }
  const preset = LIQUID_PRESETS[pool]
  const on = (preset.contracts as Partial<Record<NearNetwork, { contract: string; codeHashes: readonly string[] }>>)[network]
  if (!on) throw new LiquidStakingError('unsupported-network', `${preset.name} has no contract on NEAR ${network}.`)
  return { contract: on.contract, symbol: preset.symbol, name: preset.name, codeHashes: on.codeHashes, preset: pool }
}

/** Stable request id of the account's unstaked balance in a contract: first 8 bytes of sha256(contract) as a u64. */
export function poolRequestId(contract: string): bigint {
  let id = 0n
  for (const b of sha256(new TextEncoder().encode(contract)).subarray(0, 8)) id = (id << 8n) | BigInt(b)
  return id
}
