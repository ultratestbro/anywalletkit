/**
 * Activity recognition for Chainflip vault swaps: the source leg is a call to (EVM) or a transfer into (Tron) the
 * Chainflip Vault — a fixed, well-known counterparty, so the leg is recognizable offline. The destination leg is a
 * transfer from Chainflip's egress keys (rotating), tied back through the intent journal.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {describeSwapLike} from "@anywalletkit/protocol-swap2-core/activity";
import {CF_VAULTS} from "./config.js";

export const CHAINFLIP_MODULE = "@anywalletkit/protocol-swap2-chainflip";

const same = (chain: string, a: string | null | undefined, b: string) => !!a && (chain.startsWith("eip155:") ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Wallet history names Tron by its genesis-hash form (`tron:0x2b6653dc`); swap2 routes by chain id (`tron:728126428`). */
const CHAIN_ALIAS: Readonly<Record<string, string>> = {"tron:0x2b6653dc": "tron:728126428"};

export function describeChainflipActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  const vault = CF_VAULTS[CHAIN_ALIAS[tx.chain] ?? tx.chain];
  if (!vault) return null;
  const toVault = same(tx.chain, (tx as {to?: string}).to, vault) || tx.transfers.some((t) => same(tx.chain, t.to, vault) && ctx.own.has(t.from));
  if (!toVault) return null;
  return describeSwapLike(tx, ctx, {protocol: CHAINFLIP_MODULE, subtitle: "Chainflip", kind: "bridge", counterparty: vault, inSuffix: "via Chainflip"});
}
