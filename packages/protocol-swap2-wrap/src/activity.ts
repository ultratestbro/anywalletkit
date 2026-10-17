/**
 * Activity recognition for the Wrap module: WETH9 `deposit()` → `wrap`
 * ("Wrapped ETH"), `withdraw(uint256)` → `unwrap` ("Unwrapped WETH"), on the
 * wrapper the table (or the caller's override) names for the chain.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@forgewallet/core";
import {assetLabel, describeSwapLike, matchesCall, ownerAssets} from "@forgewallet/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@forgewallet/protocol-swap2-core/util";
import {WRAPPED_NATIVE} from "./provider.js";

export const WRAP_MODULE = "@forgewallet/protocol-swap2-wrap";

/** deposit() */
export const WETH_DEPOSIT = "0xd0e30db0";
/** withdraw(uint256 wad) */
export const WETH_WITHDRAW = "0x2e1a7d4d";

export function describeWrapActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  wrapped: Readonly<Record<number, {address: `0x${string}`; symbol: string}>> = WRAPPED_NATIVE,
): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const w = wrapped[evmRef(tx.chain)];
  if (!w) return null;
  const isDeposit = matchesCall(tx, [w.address], [WETH_DEPOSIT]);
  const isWithdraw = !isDeposit && matchesCall(tx, [w.address], [WETH_WITHDRAW]);
  if (!isDeposit && !isWithdraw) return null;
  const {assetsIn, assetsOut} = ownerAssets(tx, ctx);
  const native = [...assetsIn, ...assetsOut].find((a) => a.token === null);
  const nativeLabel = native ? assetLabel(tx, native) : w.symbol.replace(/^[Ww]/, "");
  return describeSwapLike(tx, ctx, {
    protocol: WRAP_MODULE,
    subtitle: w.symbol,
    kind: isDeposit ? "wrap" : "unwrap",
    title: isDeposit ? `Wrapped ${nativeLabel}` : `Unwrapped ${w.symbol}`,
  });
}
