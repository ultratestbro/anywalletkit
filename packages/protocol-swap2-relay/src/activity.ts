/**
 * Activity recognition for Relay on every pinned chain: `depositNative` / `depositErc20` on the chain's
 * RelayDepository is our source leg ("Bridged ETH").
 *
 * The destination leg is not claimed. A fill is sent by one of Relay's many relayer keys as an ordinary transfer (or
 * through a router for a destination swap) and names neither the order nor Relay on chain, so there is nothing to
 * recognise it by that a stranger could not imitate; it reads as a plain incoming transfer.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_ERC20_ALLOWANCE, RELAY_DEPOSIT_NATIVE, relayChain} from "./config.js";

export const RELAY_MODULE = "@anywalletkit/protocol-swap2-relay";

export function describeRelayActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const chain = relayChain(tx.chain);
  if (!chain) return null;
  // All three deposit functions are read here (history is not ours alone); only two are ever built or signed.
  if (!matchesCall(tx, [chain.depository], [RELAY_DEPOSIT_NATIVE, RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_ERC20_ALLOWANCE])) return null;
  return describeSwapLike(tx, ctx, {protocol: RELAY_MODULE, subtitle: `Relay · ${chainLabel(tx.chain)}`, kind: "bridge", outVerb: "Bridged"});
}
