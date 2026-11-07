import { NetworkError, bigintToNumber } from '@anywalletkit/core'
import { NearRpcError, type NearRpc } from '@anywalletkit/wallet-near'
import { EPOCH_LENGTH, TYPICAL_EPOCH_MS } from './constants.js'
import type { NearEpoch } from './types.js'

// Epoch clock from the chain: `validators` (epoch_height, epoch_start_height), `block` (latest final
// height and timestamp) and the first blocks of this and the previous epoch (measured duration).

/** Heights tried after a skipped one before giving up (skipped heights are rare and short). */
const SKIP_TRIES = 10

/** One block header: height and unix ms. */
export interface BlockTime { height: bigint; ms: number }

/** The epoch numbers the validators answer carries. */
export interface EpochNumbers { epochHeight: bigint; epochStartHeight: bigint }

function blockTimeOf(raw: unknown): BlockTime {
  const h = (raw as { header?: Record<string, unknown> } | null)?.header
  if (!h || typeof h.height !== 'number') throw new NetworkError('block: no header in the response')
  // timestamp_nanosec is exact; `timestamp` is a JSON number that has already lost precision.
  let ms: number
  if (typeof h.timestamp_nanosec === 'string' && /^\d+$/.test(h.timestamp_nanosec)) ms = bigintToNumber(BigInt(h.timestamp_nanosec) / 1_000_000n)
  else if (typeof h.timestamp === 'number') ms = Math.floor(h.timestamp / 1e6)
  else throw new NetworkError('block: no timestamp in the header')
  return { height: BigInt(h.height), ms }
}

/** The latest final block. */
export async function finalBlock(rpc: NearRpc): Promise<BlockTime> {
  return blockTimeOf(await rpc.fetch('block', { finality: 'final' }))
}

/** The block at `height`, or the first produced one after it when that height was skipped. */
export async function blockAt(rpc: NearRpc, height: bigint): Promise<BlockTime> {
  let last: unknown
  for (let i = 0n; i <= BigInt(SKIP_TRIES); i++) {
    try {
      return blockTimeOf(await rpc.fetch('block', { block_id: bigintToNumber(height + i) }))
    } catch (e) {
      // Only a skipped height moves on; a pruned block or a transport failure is the caller's to handle.
      if (!(e instanceof NearRpcError) || !/UNKNOWN_BLOCK/i.test(e.errorName ?? '')) throw e
      last = e
    }
  }
  throw last
}

/** `epoch_height` and `epoch_start_height` of the current epoch (one `validators` call). */
export async function readEpochNumbers(rpc: NearRpc): Promise<EpochNumbers> {
  const r = (await rpc.fetch('validators', [null])) as { epoch_height?: unknown; epoch_start_height?: unknown } | null
  if (typeof r?.epoch_height !== 'number' || typeof r.epoch_start_height !== 'number') throw new NetworkError('validators: no epoch_height / epoch_start_height in the response')
  return { epochHeight: BigInt(r.epoch_height), epochStartHeight: BigInt(r.epoch_start_height) }
}

/** Options of {@link readEpoch}: reuse the caller's cached epoch numbers and block times. */
export interface ReadEpochOptions {
  numbers?: () => Promise<EpochNumbers>
  /** Timestamps of blocks already read, by height (block times never change). */
  blockTimes?: Map<bigint, number>
}

/** Reads the epoch clock. Falls back to {@link TYPICAL_EPOCH_MS} only when the epoch start blocks cannot be read. */
export async function readEpoch(rpc: NearRpc, options: ReadEpochOptions = {}): Promise<NearEpoch> {
  const [numbers, latest] = await Promise.all([(options.numbers ?? (() => readEpochNumbers(rpc)))(), finalBlock(rpc)])
  const times = options.blockTimes ?? new Map<bigint, number>()
  const timeAt = async (height: bigint): Promise<number | null> => {
    const known = times.get(height)
    if (known !== undefined) return known
    try {
      const ms = (await blockAt(rpc, height)).ms
      times.set(height, ms)
      return ms
    } catch {
      return null // a node that pruned it: estimated below
    }
  }
  const length = EPOCH_LENGTH
  const startBlock = numbers.epochStartHeight
  const [started, prevStarted] = await Promise.all([timeAt(startBlock), timeAt(startBlock - length)])
  const epochMs = started !== null && prevStarted !== null && started > prevStarted ? started - prevStarted : TYPICAL_EPOCH_MS
  const msPerBlock = epochMs / bigintToNumber(length)
  const into = latest.height > startBlock ? latest.height - startBlock : 0n
  const startedAt = started ?? Math.round(latest.ms - bigintToNumber(into) * msPerBlock)
  const blocksLeft = startBlock + length > latest.height ? startBlock + length - latest.height : 0n
  return {
    height: numbers.epochHeight,
    startBlock,
    length,
    block: latest.height,
    blocksLeft,
    startedAt,
    epochMs,
    endsAt: Math.round(latest.ms + bigintToNumber(blocksLeft) * msPerBlock),
  }
}

/**
 * Unix ms estimate of the start of epoch `height`. Past and current epochs count from `startedAt`;
 * later ones from `endsAt` (which follows the current epoch's real progress), one `epochMs` each.
 */
export function epochStartsAt(epoch: NearEpoch, height: bigint): number {
  if (height <= epoch.height) return epoch.startedAt - bigintToNumber(epoch.height - height) * epoch.epochMs
  return epoch.endsAt + bigintToNumber(height - epoch.height - 1n) * epoch.epochMs
}
