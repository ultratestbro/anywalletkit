/**
 * Activity recognition for Across on every pinned chain: a `deposit` / `depositV3` call on the chain's SpokePool is our
 * source leg ("Bridged USDC").
 *
 * Deposits that reach the SpokePool through another contract (Across's periphery, an aggregator, a Safe) are not
 * claimed: the call the history shows is that contract's. The destination leg is not claimed either — a fill is paid
 * by one of many relayers as an ordinary token transfer (or a native payment when the wrapped native token is
 * unwrapped) and reads as a plain incoming transfer.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {ACROSS_DEPOSIT, ACROSS_DEPOSIT_V3, acrossChain} from "./config.js";

export const ACROSS_MODULE = "@anywalletkit/protocol-swap2-across";

export function describeAcrossActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const chain = acrossChain(tx.chain);
  if (!chain) return null;
  // Both deposit functions are read here (history is not ours alone); only `deposit` is ever built or signed.
  if (!matchesCall(tx, [chain.spokePool], [ACROSS_DEPOSIT, ACROSS_DEPOSIT_V3])) return null;
  return describeSwapLike(tx, ctx, {protocol: ACROSS_MODULE, subtitle: `Across · ${chainLabel(tx.chain)}`, kind: "bridge", outVerb: "Bridged"});
}
