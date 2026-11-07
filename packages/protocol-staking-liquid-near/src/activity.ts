import type { ActivityItem, ChainTx, DescribeActivityContext } from '@anywalletkit/core'

// Activity recognition for LiNEAR-family liquid staking: pure and offline (NEAR-STAKING-API.md §Activity).
// A transaction is this module's when `call.to` is one of the family contracts (presets for the
// network, or the configured one) and `call.programs` holds a staking method. SCAFFOLD: returns null.

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-liquid-near'

/** Describes a LiNEAR / rNEAR staking transaction for the wallet's feed, or returns null when it is not one. */
export function describeLiquidNearStakingActivity(
  _tx: ChainTx,
  _ctx: DescribeActivityContext,
  _options: { contracts?: ReadonlyArray<{ contract: string; symbol: string; name?: string }> } = {},
): ActivityItem | null {
  return null
}
