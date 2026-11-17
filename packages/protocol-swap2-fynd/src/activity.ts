/**
 * Activity recognition for Fynd: a swap entry point of TychoRouterV3 on a
 * chain the module serves → `swap`, "Swapped A → B" from the owner's net
 * transfers. The active router and the routers it replaced both count, so
 * swaps made before a redeploy keep their label.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {FYND_CHAINS, TYCHO_ROUTER_SELECTORS} from "./router.js";

export const FYND_MODULE = "@anywalletkit/protocol-swap2-fynd";

/**
 * TychoRouterV3 deployments the registry listed before the active one, per chain — for reading
 * history only. Never a call target or a spender: quotes and approvals accept only `FYND_CHAINS`
 * (Fynd License §3). These were effective 2026-09-01, paused 2026-11-16 and replaced the same day
 * (registry commit 8aab890).
 */
export const FYND_PREVIOUS_ROUTERS: Readonly<Record<number, readonly `0x${string}`[]>> = Object.freeze({
  1: Object.freeze(["0x1644D2477f809cc2C71bCCFd6Dc9497E3F83210d"] as const),
  8453: Object.freeze(["0xAbA5B53b03eAfaD1C5fc8BD5Fc765fC85Bb3de67"] as const),
  42161: Object.freeze(["0x924F147c50eA59f5180a26031A8b65B2aA1e81Cd"] as const),
  56: Object.freeze(["0x7f3D12BBaFb8955E51B3ab9588b34c8ad95BDA4e"] as const),
  137: Object.freeze(["0xbd4e6011F03355C2A377Fd9Af939322A7d0A1bC1"] as const),
  130: Object.freeze(["0xCba5574597Ad00EA250Fd106DAB4Fc7461949635"] as const),
  4663: Object.freeze(["0x09215a470bD585E59EB3F4B612fBD2678131fF9e"] as const),
});

export function describeFyndActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const id = evmRef(tx.chain);
  const chain = FYND_CHAINS[id];
  if (!chain) return null;
  if (!matchesCall(tx, [chain.router, ...(FYND_PREVIOUS_ROUTERS[id] ?? [])], TYCHO_ROUTER_SELECTORS)) return null;
  return describeSwapLike(tx, ctx, {protocol: FYND_MODULE, subtitle: `Fynd · ${chainLabel(tx.chain)}`, kind: "swap"});
}
