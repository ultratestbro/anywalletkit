/**
 * Activity recognition for Fynd: a swap entry point of the pinned
 * TychoRouterV3 on a chain the module serves → `swap`, "Swapped A → B" from
 * the owner's net transfers.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {FYND_CHAINS, TYCHO_ROUTER_SELECTORS} from "./router.js";

export const FYND_MODULE = "@anywalletkit/protocol-swap2-fynd";

export function describeFyndActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const chain = FYND_CHAINS[evmRef(tx.chain)];
  if (!chain) return null;
  if (!matchesCall(tx, [chain.router], TYCHO_ROUTER_SELECTORS)) return null;
  return describeSwapLike(tx, ctx, {protocol: FYND_MODULE, subtitle: `Fynd · ${chainLabel(tx.chain)}`, kind: "swap"});
}
