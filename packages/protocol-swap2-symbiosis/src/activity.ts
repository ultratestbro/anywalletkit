/**
 * Activity recognition for Symbiosis source transactions:
 *  - EVM and Tron: `metaRoute` on the chain's pinned MetaRouterGateway — the one call every source
 *    transaction of this module is ("Bridged USDT");
 *  - TON: a jetton transfer from the owner to the pinned TON Portal.
 * The delivery on the destination chain is a relayer's transaction the user signs nothing in; it is
 * left to the wallet's plain "received" item.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {chainLabel, describeSwapLike, matchesCall} from "@anywalletkit/protocol-swap2-core/activity";
import {tonRawAddress} from "@anywalletkit/protocol-swap2-core/util";
import {SYMBIOSIS_TON_PORTAL_RAW, evmToTron, symbiosisChain} from "./config.js";

export const SYMBIOSIS_MODULE = "@anywalletkit/protocol-swap2-symbiosis";
/** `metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))` — MetaRouterGateway. */
export const SYMBIOSIS_META_ROUTE = "0xa11b1198";

export function describeSymbiosisActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const chain = symbiosisChain(tx.chain);
  if (!chain) return null;
  const subtitle = `Symbiosis · ${chainLabel(chain.caip2)}`;
  if (chain.family === "evm" && chain.gateway) {
    if (!matchesCall(tx, [chain.gateway], [SYMBIOSIS_META_ROUTE])) return null;
    return describeSwapLike(tx, ctx, {protocol: SYMBIOSIS_MODULE, subtitle, kind: "bridge", outVerb: "Bridged"});
  }
  if (chain.family === "tron" && chain.gateway) {
    // A Tron history source names the contract in base58 or in 20-byte hex, depending on the indexer.
    if (!matchesCall(tx, [evmToTron(chain.gateway), chain.gateway, `0x41${chain.gateway.slice(2)}`], [SYMBIOSIS_META_ROUTE])) return null;
    return describeSwapLike(tx, ctx, {protocol: SYMBIOSIS_MODULE, subtitle, kind: "bridge", outVerb: "Bridged", counterparty: evmToTron(chain.gateway)});
  }
  if (chain.family === "ton") {
    const own = new Set<string>();
    for (const a of ctx.own) { const raw = tonRawAddress(a); if (raw) own.add(raw); }
    const sent = tx.transfers.some((t) => t.token !== null && tonRawAddress(t.to) === SYMBIOSIS_TON_PORTAL_RAW && own.has(tonRawAddress(t.from) ?? ""));
    if (!sent) return null;
    return describeSwapLike(tx, ctx, {protocol: SYMBIOSIS_MODULE, subtitle, kind: "bridge", outVerb: "Bridged"});
  }
  return null;
}
