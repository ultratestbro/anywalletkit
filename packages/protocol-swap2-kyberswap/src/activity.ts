/**
 * Activity recognition for KyberSwap: a `swap()` call to MetaAggregationRouterV2 on a chain the module serves →
 * `swap`, "Swapped A → B" from the owner's net transfers.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {KYBER_ROUTER_V2, KYBER_SWAP_SELECTOR, kyberChain} from "./router.js";

export const KYBERSWAP_MODULE = "@anywalletkit/protocol-swap2-kyberswap";

export function describeKyberActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!isEvm(tx.chain) || !kyberChain(evmRef(tx.chain))) return null;
  if (!matchesCall(tx, [KYBER_ROUTER_V2], [KYBER_SWAP_SELECTOR])) return null;
  return describeSwapLike(tx, ctx, {protocol: KYBERSWAP_MODULE, subtitle: `KyberSwap · ${chainLabel(tx.chain)}`, kind: "swap"});
}
