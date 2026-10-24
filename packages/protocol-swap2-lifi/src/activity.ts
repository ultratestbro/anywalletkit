/**
 * Activity recognition for LI.FI: any call into the LI.FI Diamond on an EVM
 * chain this module routes. Same-chain swaps go through GenericSwapFacetV3
 * (fixed selectors below → `swap`, "Swapped A → B"); every other facet is a
 * bridge facet (`swapAndStartBridgeTokensVia…`, `startBridgeTokensVia…`) whose
 * source leg we see here → `bridge`, "Bridged A". The destination leg lands on
 * another chain through a third-party relayer and cannot be tied back offline,
 * so `related` stays empty (the kit's intent journal links the two).
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {calledContract, callSelector, describeSwapLike} from "@anywalletkit/protocol-swap2-core/activity";

export const LIFI_MODULE = "@anywalletkit/protocol-swap2-lifi";

/** GenericSwapFacetV3 — same-chain swaps (`viem toFunctionSelector`, 2026-10-14). */
export const LIFI_SAME_CHAIN_SELECTORS: ReadonlySet<string> = new Set([
  "0x4666fc80", // swapTokensSingleV3ERC20ToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool))
  "0x733214a3", // swapTokensSingleV3ERC20ToNative(…)
  "0xaf7060fd", // swapTokensSingleV3NativeToERC20(…)
  "0x5fd9ae2e", // swapTokensMultipleV3ERC20ToERC20(bytes32,string,string,address,uint256,(…)[])
  "0x2c57e884", // swapTokensMultipleV3ERC20ToNative(…[])
  "0x736eac0b", // swapTokensMultipleV3NativeToERC20(…[])
]);

/**
 * @param isDiamond the provider's trust check: the documented Diamond for the
 *   chain plus any `trustedTransactionTargets` the caller configured.
 */
export function describeLifiActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  isDiamond: (chain: string, address: string) => boolean,
): ActivityItem | null {
  if (!tx.chain.startsWith("eip155:")) return null;
  const to = calledContract(tx);
  if (!to || !isDiamond(tx.chain, to)) return null;
  const selector = callSelector(tx);
  const sameChain = selector !== undefined && LIFI_SAME_CHAIN_SELECTORS.has(selector);
  return describeSwapLike(tx, ctx, {
    protocol: LIFI_MODULE,
    subtitle: "LI.FI",
    // Unknown selector: trust the legs — both netted here means a same-chain route.
    kind: sameChain ? "swap" : selector === undefined ? "auto" : "bridge",
  });
}
