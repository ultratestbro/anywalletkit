/**
 * Activity recognition for NEAR Intents (1Click).
 *
 * The source leg on EVM / TON / Solana / Tron / BTC is a plain transfer to a
 * one-time 1Click deposit address, and the destination leg is a plain transfer
 * from a solver / bridge account that changes per swap — neither carries a
 * stable on-chain marker, so they are NOT recognizable offline. The kit's
 * intent journal (the `intentId` returned by `swap2()`) ties those legs back to
 * the swap; this hook only answers for the legs that do have a fixed
 * counterparty: on NEAR itself, deposits into and withdrawals out of the
 * `intents.near` verifier contract (NEP-141 `ft_transfer_call` / `ft_withdraw`).
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {describeSwapLike} from "@anywalletkit/protocol-swap2-core/activity";

export const NEAR_INTENTS_MODULE = "@anywalletkit/protocol-swap2-near-intents";

/** The NEAR Intents verifier / settlement contract. */
export const NEAR_INTENTS_CONTRACT = "intents.near";

export function describeNearIntentsActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
  if (!tx.chain.startsWith("near:")) return null;
  const isOwn = (a: string) => ctx.own.has(a);
  const touches = tx.transfers.some((t) => (t.from === NEAR_INTENTS_CONTRACT && isOwn(t.to)) || (t.to === NEAR_INTENTS_CONTRACT && isOwn(t.from)));
  if (!touches) return null;
  return describeSwapLike(tx, ctx, {
    protocol: NEAR_INTENTS_MODULE,
    subtitle: "NEAR Intents",
    kind: "bridge",
    counterparty: NEAR_INTENTS_CONTRACT,
    inSuffix: "via NEAR Intents",
  });
}
