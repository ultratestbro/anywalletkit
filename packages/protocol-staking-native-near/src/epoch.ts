import { NetworkError, bigintToNumber } from '@anywalletkit/core'
import { NearRpcError, type NearRpc } from '@anywalletkit/wallet-near'
import { EPOCH_LENGTH, TYPICAL_EPOCH_MS } from './constants.js'
import type { NearEpoch } from './types.js'
import { readValidators, type ValidatorSet } from './validators.js'

// Epoch clock from the chain: `validators` (epoch_height, epoch_start_height), `block` (latest final
// height and timestamp) and the first blocks of this and the previous epoch (measured duration).

/** How many heights after a skipped one are tried before giving up (skipped heights are rare and short). */
const SKIP_TRIES = 10

interface Header { height: bigint; ms: number; epochId: string | null }

function headerOf(raw: unknown): Header {
  const h = (raw as { header?: Record<string, unknown> } | null)?.header
  if (!h || typeof h.height !== 'number') throw new NetworkError('block: no header in the response')
  // timestamp_nanosec is the exact string; `timestamp` is a JSON number that has already lost precision.
  let ms: number
  if (typeof h.timestamp_nanosec === 'string' && /^\d+$/.test(h.timestamp_nanosec)) ms = bigintToNumber(BigInt(h.timestamp_nanosec) / 1_000_000n)
  else if (typeof h.timestamp === 'number') ms = Math.floor(h.timestamp / 1e6)
  else throw new NetworkError('block: no timestamp in the header')
  return { height: BigInt(h.height), ms, epochId: typeof h.epoch_id === 'string' ? h.epoch_id : null }
}

/** The latest final block. */
export async function finalHeader(rpc: NearRpc): Promise<Header> {
  return headerOf(await rpc.fetch('block', { finality: 'final' }))
}

/** The block at `height`, or the first produced one after it when that height was skipped. */
export async function headerAt(rpc: NearRpc, height: bigint): Promise<Header> {
  let last: unknown
  for (let i = 0n; i <= BigInt(SKIP_TRIES); i++) {
    try {
      return headerOf(await rpc.fetch('block', { block_id: bigintToNumber(height + i) }))
    } catch (e) {
      // Only a skipped height moves on; anything else (garbage-collected block, transport) is the caller's fallback.
      if (!(e instanceof NearRpcError) || !/UNKNOWN_BLOCK/i.test(e.errorName ?? '')) throw e
      last = e
    }
  }
  throw last
}

/** Options of {@link readEpoch}: share the module's cached validator set and block times. */
export interface ReadEpochOptions {
  validators?: () => Promise<ValidatorSet>
  /** Timestamps of blocks already read, by height (block times never change). */
  blockTimes?: Map<bigint, number>
}

/** Reads the epoch clock. */
export async function readEpoch(rpc: NearRpc, options: ReadEpochOptions = {}): Promise<NearEpoch> {
  const [set, latest] = await Promise.all([(options.validators ?? (() => readValidators(rpc)))(), finalHeader(rpc)])
  const times = options.blockTimes ?? new Map<bigint, number>()
  const timeAt = async (height: bigint): Promise<number | null> => {
    const known = times.get(height)
    if (known !== undefined) return known
    try {
      const ms = (await headerAt(rpc, height)).ms
      times.set(height, ms)
      return ms
    } catch {
      return null // a node that pruned it: estimated below
    }
  }
  const length = EPOCH_LENGTH
  const startBlock = set.epochStartHeight
  const [started, prevStarted] = await Promise.all([timeAt(startBlock), timeAt(startBlock - length)])
  const epochMs = started !== null && prevStarted !== null && started > prevStarted ? started - prevStarted : TYPICAL_EPOCH_MS
  const msPerBlock = epochMs / bigintToNumber(length)
  const into = latest.height > startBlock ? latest.height - startBlock : 0n
  const startedAt = started ?? Math.round(latest.ms - bigintToNumber(into) * msPerBlock)
  const blocksLeft = startBlock + length > latest.height ? startBlock + length - latest.height : 0n
  return {
    height: set.epochHeight,
    startBlock,
    length,
    block: latest.height,
    blocksLeft,
    startedAt,
    epochMs,
    endsAt: Math.round(latest.ms + bigintToNumber(blocksLeft) * msPerBlock),
  }
}

/** Unix ms estimate of the start of epoch `height`, from the clock (`startedAt + (height − current) × epochMs`). */
export function epochStartsAt(epoch: NearEpoch, height: bigint): number {
  const delta = height - epoch.height
  // Epoch counts are tiny (thousands), so the conversion below is exact.
  // eslint-disable-next-line anywalletkit/no-number-bigint
  return epoch.startedAt + Number(delta) * epoch.epochMs
}

/**
 * The epoch a block belongs to, by height arithmetic from the current epoch's start: exact except
 * for a block within a few heights of a boundary that was skipped.
 */
export function epochOfHeight(epoch: Pick<NearEpoch, 'height' | 'startBlock' | 'length'>, block: bigint): bigint {
  if (block >= epoch.startBlock) return epoch.height + (block - epoch.startBlock) / epoch.length
  return epoch.height - (epoch.startBlock - block + epoch.length - 1n) / epoch.length
}
