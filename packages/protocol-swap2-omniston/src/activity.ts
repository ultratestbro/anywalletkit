/**
 * Activity recognition for Omniston on TON.
 *
 * Same-chain swaps settle through the STON.fi DEX router (the wallet pays TON /
 * a jetton to the router and the output jetton or TON comes back) → `swap`.
 * TON → EVM orders lock the input in the Omniston HTLC escrow ("Omniston Escrow
 * Minter", the `srcProtocolContractAddress` of every live quote) → `bridge`;
 * the EVM leg is paid by the resolver and is not recognizable offline.
 * Addresses are compared in raw form, so friendly (EQ…/UQ…) and raw (0:…)
 * notations all match.
 */
import {Address} from "@ton/core";
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {describeSwapLike} from "@anywalletkit/protocol-swap2-core/activity";

export const OMNISTON_MODULE = "@anywalletkit/protocol-swap2-omniston";

/** STON.fi DEX routers (tonapi "STON.fi DEX"; v2.2 observed in the test wallet's swaps, v1 kept for older history). */
export const STONFI_ROUTERS: readonly string[] = [
  "EQCS4UEa5UaJLzOyyKieqQOQ2P9M-7kXpkO5HnP3Bv250cN3",
  "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt",
];
/** Omniston HTLC escrow on TON (Omniston Escrow Minter) — the `srcProtocolContractAddress` of TON→EVM orders. */
export const OMNISTON_ESCROWS: readonly string[] = ["EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ"];

function raw(address: string | null | undefined): string | null {
  if (!address) return null;
  try {
    return Address.parse(address).toRawString();
  } catch {
    return null;
  }
}

const ROUTER_RAW = new Set(STONFI_ROUTERS.map((a) => raw(a)!));
const ESCROW_RAW = new Set(OMNISTON_ESCROWS.map((a) => raw(a)!));

/** Every non-own party of the transaction in raw form: the destination contract and each transfer's other side. */
function counterparties(tx: ChainTx, own: Set<string>): string[] {
  const ownRaw = new Set<string>();
  for (const a of own) {
    const r = raw(a);
    if (r) ownRaw.add(r);
  }
  const out = new Set<string>();
  const add = (a: string | null | undefined) => {
    const r = raw(a);
    if (r && !ownRaw.has(r)) out.add(r);
  };
  add(tx.call?.to);
  add(tx.to);
  for (const t of tx.transfers) {
    add(t.from);
    add(t.to);
  }
  return [...out];
}

export function describeOmnistonActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!tx.chain.startsWith("ton:")) return null;
  const parties = counterparties(tx, ctx.own);
  const escrow = parties.find((p) => ESCROW_RAW.has(p));
  if (escrow) {
    return describeSwapLike(tx, ctx, {protocol: OMNISTON_MODULE, subtitle: "Omniston · STON.fi", kind: "bridge", counterparty: tx.call?.to ?? tx.to ?? escrow});
  }
  const router = parties.find((p) => ROUTER_RAW.has(p));
  if (router) {
    return describeSwapLike(tx, ctx, {protocol: OMNISTON_MODULE, subtitle: "STON.fi · TON", kind: "swap", counterparty: tx.call?.to ?? tx.to ?? router});
  }
  return null;
}
