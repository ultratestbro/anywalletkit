/**
 * Activity recognition for Jupiter swaps. Solana history (wallet-solana) names the first non-plumbing program a
 * transaction runs as `call.to`: a swap sent to Jupiter v6 directly (this module's /build transactions, jup.ag) has it
 * there. A route that only passes through Jupiter inside another program (an aggregator or bridge CPI-ing into it) names
 * that program instead and is left to its module. The owner must both give and receive an asset: a leg that only sends
 * (a bridge's source leg with a Jupiter pre-swap) is not called a swap.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {describeSwapLike} from "@anywalletkit/protocol-swap2-core/activity";
import {JUPITER_PROGRAM, SOLANA_CHAINS} from "./config.js";

export const JUPITER_MODULE = "@anywalletkit/protocol-swap2-jupiter";

export function describeJupiterActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!SOLANA_CHAINS.has(tx.chain) || tx.call?.to !== JUPITER_PROGRAM) return null;
  const item = describeSwapLike(tx, ctx, {protocol: JUPITER_MODULE, subtitle: "Jupiter", kind: "swap", counterparty: JUPITER_PROGRAM});
  if (item && tx.status !== "failed" && (item.assetsIn.length === 0 || item.assetsOut.length === 0)) return null;
  return item;
}
