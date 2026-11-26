/**
 * Activity recognition for Uniswap: a call into the chain's SwapRouter02 (the deployment table, or the caller's
 * override) with one of the router's swap entry points → `swap`, "Swapped A → B" from the owner's net transfers,
 * "Uniswap v3 · <chain>"; and a call into the chain's pinned Universal Router 2.1.2 — `execute(commands, inputs,
 * deadline)` whose commands are exactly `V4_SWAP` (0x10), as this module builds it — "Uniswap v4 · <chain>". Every other
 * Universal Router call (an Across deposit, a position call, a plan of several commands, the no-deadline entry point)
 * is left to other modules: it is not a swap this module made.
 */
import {decodeFunctionData, type Hex} from "viem";
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {UNISWAP_V3, type UniswapDeployment} from "./addresses.js";
import {UNISWAP_UR_SELECTORS, UNISWAP_V4, UR_ABI, UR_COMMANDS, uniswapV4DeploymentOf, type UniswapV4Deployment} from "./v4/addresses.js";

export const UNISWAP_MODULE = "@anywalletkit/protocol-swap2-uniswap";

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

/** True when the call is the pinned router's `execute(bytes,bytes[],uint256)` with the commands exactly `V4_SWAP`. */
function isV4Swap(tx: ChainTx, d4: UniswapV4Deployment): boolean {
  if (!matchesCall(tx, [d4.universalRouter], UNISWAP_UR_SELECTORS)) return false;
  const data = tx.call?.data;
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) return false;
  try {
    const decoded = decodeFunctionData({abi: UR_ABI, data: data as Hex});
    if (decoded.functionName !== "execute") return false;
    const [commands] = decoded.args as readonly [Hex, readonly Hex[], bigint];
    return commands.toLowerCase() === `0x${UR_COMMANDS.V4_SWAP.toString(16).padStart(2, "0")}`;
  } catch {
    return false;
  }
}

export function describeUniswapActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  deployments: Readonly<Record<number, UniswapDeployment>> = UNISWAP_V3,
  v4Deployments: Readonly<Record<number, UniswapV4Deployment>> = UNISWAP_V4,
): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const id = evmRef(tx.chain);
  const deployment = deployments[id];
  if (deployment && matchesCall(tx, [deployment.router], UNISWAP_ROUTER_SELECTORS)) {
    return describeSwapLike(tx, ctx, {protocol: UNISWAP_MODULE, subtitle: `Uniswap v3 · ${chainLabel(tx.chain)}`, kind: "swap"});
  }
  const d4 = uniswapV4DeploymentOf(id, v4Deployments);
  if (d4 && isV4Swap(tx, d4)) return describeSwapLike(tx, ctx, {protocol: UNISWAP_MODULE, subtitle: `Uniswap v4 · ${chainLabel(tx.chain)}`, kind: "swap"});
  return null;
}
