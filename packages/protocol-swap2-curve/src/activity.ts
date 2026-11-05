/**
 * Activity recognition for Curve: a call into the chain's pinned Router NG — or, on Ethereum, the older v1.1 / v1.0
 * routers (history only) — with one of the family's `exchange` entry points → `swap`, "Swapped A → B" from the owner's
 * net transfers. A swap whose receiver is not one of the owner's addresses (an explicit `_receiver`, read from the
 * calldata or the router's `Exchange` log) says so in the subtitle and names that receiver as the counterparty.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {calledContract, chainLabel, describeSwapLike, shortAddress} from "@anywalletkit/protocol-swap2-core/activity";
import {evmRef, isEvm} from "@anywalletkit/protocol-swap2-core/util";
import {EXCHANGE_TOPIC, ROUTER_SELECTORS, decodeExchange} from "./abi.js";
import {CURVE_DEPLOYMENTS, CURVE_LEGACY_ROUTERS, deploymentOf, type CurveDeployment, type CurveRouterFamily} from "./deployments.js";

export const CURVE_MODULE = "@anywalletkit/protocol-swap2-curve";

/** The router family `to` speaks on `chainId`, when it is a router this module knows there. */
function familyOf(deployments: Readonly<Record<number, CurveDeployment>>, chainId: number, to: string): CurveRouterFamily | null {
  const d = deploymentOf(deployments, chainId);
  if (d && d.router.toLowerCase() === to) return d.family;
  const legacy = Object.prototype.hasOwnProperty.call(CURVE_LEGACY_ROUTERS, chainId) ? CURVE_LEGACY_ROUTERS[chainId]! : [];
  return legacy.some((r) => r.router.toLowerCase() === to) ? "ng5" : null;
}

/** Who the swap paid: the calldata's `_receiver`, else the router's `Exchange` log (topic 2), else the sender. */
function receiverOf(tx: ChainTx, family: CurveRouterFamily): string {
  const data = tx.call?.data;
  if (data) {
    const call = decodeExchange(family, data);
    if (call?.receiver) return call.receiver.toLowerCase();
    if (call) return tx.from.toLowerCase();
  }
  const logs = (tx.raw as {logs?: unknown} | undefined)?.logs ?? (tx.raw as {receipt?: {logs?: unknown}} | undefined)?.receipt?.logs;
  if (Array.isArray(logs)) {
    const to = calledContract(tx);
    for (const l of logs as {address?: string; topics?: string[]}[]) {
      if (l?.address?.toLowerCase() !== to || l.topics?.[0]?.toLowerCase() !== EXCHANGE_TOPIC[family]) continue;
      const t = l.topics[2];
      if (typeof t === "string" && /^0x[0-9a-fA-F]{64}$/.test(t)) return `0x${t.slice(-40)}`.toLowerCase();
    }
  }
  return tx.from.toLowerCase();
}

export function describeCurveActivity(
  tx: ChainTx,
  ctx: DescribeActivityContext,
  deployments: Readonly<Record<number, CurveDeployment>> = CURVE_DEPLOYMENTS,
): ActivityItem | null {
  if (!isEvm(tx.chain)) return null;
  const to = calledContract(tx);
  if (!to) return null;
  const family = familyOf(deployments, evmRef(tx.chain), to);
  if (!family) return null;
  const sel = tx.call?.selector?.toLowerCase() ?? tx.call?.data?.slice(0, 10).toLowerCase();
  if (!sel || !ROUTER_SELECTORS[family].has(sel)) return null;
  const receiver = receiverOf(tx, family);
  const ownReceiver = ctx.own.has(receiver) || [...ctx.own].some((a) => a.toLowerCase() === receiver);
  const subtitle = `Curve · ${chainLabel(tx.chain)}${ownReceiver ? "" : ` · paid to ${shortAddress(receiver)}`}`;
  return describeSwapLike(tx, ctx, {protocol: CURVE_MODULE, subtitle, kind: "swap", ...(ownReceiver ? {} : {counterparty: receiver})});
}
