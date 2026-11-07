import { NotImplementedError } from '@anywalletkit/core'
import type { NearRpc } from '@anywalletkit/wallet-near'
import type { NearEpoch } from './types.js'

// Epoch clock from the chain: `validators` (epoch_height, epoch_start_height), `block` (latest final
// height and timestamp) and the previous epoch's first block (measured duration). SCAFFOLD.

/** Reads the epoch clock. */
export async function readEpoch(_rpc: NearRpc): Promise<NearEpoch> {
  throw new NotImplementedError('readEpoch(rpc)')
}

/** Unix ms estimate of the start of epoch `height`, from the clock (`startedAt + (height − current) × epochMs`). */
export function epochStartsAt(epoch: NearEpoch, height: bigint): number {
  const delta = height - epoch.height
  // Epoch counts are tiny (thousands), so the conversion below is exact.
  // eslint-disable-next-line anywalletkit/no-number-bigint
  return epoch.startedAt + Number(delta) * epoch.epochMs
}
