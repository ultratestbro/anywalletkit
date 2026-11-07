import type { ActivityItem, ChainTx, DescribeActivityContext } from '@anywalletkit/core'
import type { NearNetwork } from './types.js'

// Activity recognition for NEAR native staking: pure and offline (see NEAR-STAKING-API.md §Activity).
// A transaction is this module's when it calls a factory pool (`call.to` passes factoryOf) with one
// of the delegator methods in `call.programs`. SCAFFOLD: returns null until implemented.

/** Registry name, as `module.json` carries it. */
export const MODULE_NAME = '@anywalletkit/protocol-staking-native-near'

/** Describes a NEAR staking-pool transaction for the wallet's feed, or returns null when it is not one. */
export function describeNativeNearStakingActivity(
  _tx: ChainTx,
  _ctx: DescribeActivityContext,
  _options: { network?: NearNetwork; pools?: ReadonlyArray<{ id: string; name?: string }> } = {},
): ActivityItem | null {
  return null
}
