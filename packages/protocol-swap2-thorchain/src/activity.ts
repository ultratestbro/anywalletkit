/**
 * Activity recognition for THORChain on its EVM source chains.
 *
 * Routers and Asgard vaults rotate, so nothing is matched by address: the
 * THORChain router ABI is unique enough. `depositWithExpiry` is our source leg
 * (`bridge`, "Bridged A"; `swap` when the swap settled back on the same chain
 * and both legs netted). `transferOut` / `transferOutAndCall` are the router
 * paying a destination leg — recognized only when the owner actually received
 * something ("Received A via THORChain"). Native sends to an inbound vault with
 * a memo (Tron, BTC) carry no router call and are not recognizable offline.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@forgewallet/core";
import {callSelector, describeSwapLike, ownerAssets} from "@forgewallet/protocol-swap2-core/activity";
import {thorchain as thorchainCfg} from "./config.js";

export const THORCHAIN_MODULE = "@forgewallet/protocol-swap2-thorchain";

/** depositWithExpiry(address,address,uint256,string,uint256) */
export const THORCHAIN_DEPOSIT_WITH_EXPIRY = "0x44bc937b";
/** transferOut(address,address,uint256,string) */
export const THORCHAIN_TRANSFER_OUT = "0x574da717";
/** transferOutAndCall(address,address,uint256,address,address,string) */
export const THORCHAIN_TRANSFER_OUT_AND_CALL = "0xec341444";

export function describeThorchainActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!tx.chain.startsWith("eip155:") || !thorchainCfg.supportsChain(tx.chain)) return null;
  const selector = callSelector(tx);
  if (selector === THORCHAIN_DEPOSIT_WITH_EXPIRY) {
    // The owner must be the depositor: a stranger's deposit that paid us is a transferOut, not ours.
    const isOwn = (a: string) => ctx.own.has(a) || ctx.own.has(a.toLowerCase());
    if (!isOwn(tx.from)) return null;
    return describeSwapLike(tx, ctx, {protocol: THORCHAIN_MODULE, subtitle: "THORChain", kind: "auto"});
  }
  if (selector === THORCHAIN_TRANSFER_OUT || selector === THORCHAIN_TRANSFER_OUT_AND_CALL) {
    const {assetsIn} = ownerAssets(tx, ctx);
    if (assetsIn.length === 0) return null;
    return describeSwapLike(tx, ctx, {protocol: THORCHAIN_MODULE, subtitle: "THORChain", kind: "bridge", inSuffix: "via THORChain"});
  }
  return null;
}
