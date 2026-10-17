/**
 * Activity recognition for Uniswap v3: a call into the chain's SwapRouter02
 * (the deployment table, or the caller's override) with one of the router's
 * swap entry points → `swap`, "Swapped A → B" from the owner's net transfers.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@forgewallet/core";
import {chainLabel, describeSwapLike, matchesCall} from "@forgewallet/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@forgewallet/protocol-swap2-core/util";
import {UNISWAP_V3, type UniswapDeployment} from "./addresses.js";

export const UNISWAP_MODULE = "@forgewallet/protocol-swap2-uniswap";

/** SwapRouter02 entry points (`viem toFunctionSelector`, 2026-10-14). */
export const UNISWAP_ROUTER_SELECTORS: ReadonlySet<string> = new Set([
  "0x5ae401dc", // multicall(uint256 deadline, bytes[] data)
  "0xac9650d8", // multicall(bytes[] data)
  "0x1f0464d1", // multicall(bytes32 previousBlockhash, bytes[] data)
  "0x04e45aaf", // exactInputSingle((address,address,uint24,address,uint256,uint256,uint160))
  "0xb858183f", // exactInput((bytes,address,uint256,uint256))
  "0x5023b4df", // exactOutputSingle((address,address,uint24,address,uint256,uint256,uint160))
  "0x09b81346", // exactOutput((bytes,address,uint256,uint256))
]);

export function describeUniswapActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  deployments: Readonly<Record<number, UniswapDeployment>> = UNISWAP_V3,
): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const deployment = deployments[evmRef(tx.chain)];
  if (!deployment || !matchesCall(tx, [deployment.router], UNISWAP_ROUTER_SELECTORS)) return null;
  return describeSwapLike(tx, ctx, {protocol: UNISWAP_MODULE, subtitle: `Uniswap v3 · ${chainLabel(tx.chain)}`, kind: "swap"});
}
