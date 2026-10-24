/**
 * Activity recognition for Balancer v2: `swap` / `batchSwap` on the Vault
 * (one address on every chain) on a chain the module serves → `swap`,
 * "Swapped A → B" from the owner's net transfers.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {BALANCER_V2_CHAINS, BALANCER_V2_VAULT} from "./provider.js";

export const BALANCER_MODULE = "@anywalletkit/protocol-swap2-balancer";

/** Vault swap entry points (`viem toFunctionSelector`, 2026-10-14). */
export const BALANCER_VAULT_SELECTORS: ReadonlySet<string> = new Set([
  "0x945bcec9", // batchSwap(uint8,(bytes32,uint256,uint256,uint256,bytes)[],address[],(address,bool,address,bool),int256[],uint256)
  "0x52bbbe29", // swap((bytes32,uint8,address,address,uint256,bytes),(address,bool,address,bool),uint256,uint256)
]);

export function describeBalancerActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!isEvm(tx.chain) || !BALANCER_V2_CHAINS[evmRef(tx.chain)]) return null;
  if (!matchesCall(tx, [BALANCER_V2_VAULT], BALANCER_VAULT_SELECTORS)) return null;
  return describeSwapLike(tx, ctx, {protocol: BALANCER_MODULE, subtitle: `Balancer v2 · ${chainLabel(tx.chain)}`, kind: "swap"});
}
