/**
 * Activity recognition for CoW Protocol. Only what the account itself sends shows up as its transactions:
 *
 * - `createOrder` on CoWSwapEthFlow — a native-coin sell being placed → `swap`, "Placed a CoW order" (the coin
 *   leaves now; the bought token arrives later, in a solver's settlement transaction that is not the account's);
 * - `invalidateOrder` on CoWSwapEthFlow — the order cancelled or its refund collected → "Refunded a CoW order";
 * - `invalidateOrder` on GPv2Settlement — a signed order cancelled on-chain → "Cancelled a CoW order".
 *
 * An ERC-20 sell has no transaction of the account at all (the order is signed and a solver settles it), so there
 * is nothing to recognize for it here beyond the approval the approvals module already names.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {COW_DEPLOYMENTS, deploymentOf, type CowDeployment} from "./deployments.js";
import {ETH_FLOW_CREATE_SELECTOR, ETH_FLOW_INVALIDATE_SELECTOR} from "./ethflow.js";

export const COW_MODULE = "@anywalletkit/protocol-swap2-cow";
/** `GPv2Settlement.invalidateOrder(bytes)`. */
export const COW_SETTLEMENT_INVALIDATE_SELECTOR = "0x15337bc0";

export function describeCowActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  deployments: Readonly<Record<number, CowDeployment>> = COW_DEPLOYMENTS,
): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const d = deploymentOf(deployments, evmRef(tx.chain));
  if (!d) return null;
  const subtitle = `CoW Protocol · ${chainLabel(tx.chain)}`;
  if (matchesCall(tx, [d.ethFlow], [ETH_FLOW_CREATE_SELECTOR])) {
    return describeSwapLike(tx, ctx, {protocol: COW_MODULE, subtitle, kind: "swap", title: "Placed a CoW order"});
  }
  if (matchesCall(tx, [d.ethFlow], [ETH_FLOW_INVALIDATE_SELECTOR])) {
    return describeSwapLike(tx, ctx, {protocol: COW_MODULE, subtitle, kind: "contract", title: "Refunded a CoW order"});
  }
  if (matchesCall(tx, [d.settlement], [COW_SETTLEMENT_INVALIDATE_SELECTOR])) {
    return describeSwapLike(tx, ctx, {protocol: COW_MODULE, subtitle, kind: "contract", title: "Cancelled a CoW order"});
  }
  return null;
}
