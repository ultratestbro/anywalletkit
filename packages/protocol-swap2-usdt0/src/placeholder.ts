// Dry quotes priced for a stand-in address, and the zero account as a recipient (review r3, 2026-11-13).
//
// A dry request may leave out the recipient or the refund address: the provider then prices the route for a stand-in
// (EVM: vitalik.eth as recipient and refund; Tron / TON: the zero account as recipient, `USDT0_MESH_PLACEHOLDER`). The
// fee and the received amount do not depend on who receives, so the price is right — but the `send` built for it pays
// the stand-in from whichever wallet signs it: USDT paid to the zero account is lost for good (Tron T9yD14…, TON
// 0:000…0), vitalik.eth keeps what it is paid. Such a quote therefore carries no transaction: only its price, marked
// `providerData.placeholder`. `buildDeposit`, `preflightDeposit` and `usdt0VerifyQuote` refuse it with the texts below.
// A recipient that IS the zero account (EVM 0x000…0, Tron T9yD14…, TON 0:000…0 in any spelling) is refused outright,
// dry or live.
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {note} from "./refusals.js";

/** Which address of a dry request the provider filled with its stand-in (`providerData.placeholder`). */
export type Usdt0Placeholder = "recipient" | "refund";

/** The stand-in a dry request is priced for — the recipient when it names none, else the refund address — or null (a live request, or both named). */
export function placeholderIn(params: Pick<QuoteParams, "dry" | "destAddress" | "refundAddress">): Usdt0Placeholder | null {
  if (params.dry === false) return null;
  if (!params.destAddress) return "recipient";
  if (!params.refundAddress) return "refund";
  return null;
}

/** The mark as words; anything else a quote carries there is "address" (the mark may come from an untrusted quote). */
const role = (mark: unknown): string => (mark === "refund" ? "refund address" : mark === "recipient" ? "recipient" : "address");

/** `buildDeposit` on a quote marked `providerData.placeholder`. */
export const placeholderBuildRefusal = (mark: unknown): string =>
  `swap2: this USDT0 quote was priced for a placeholder ${role(mark)} (a dry quote without that address) and has no transaction to build — quote again with the recipient and the refund address`;

/** `preflightDeposit` on a quote marked `providerData.placeholder`. */
export const placeholderPreflightRefusal = (mark: unknown): string =>
  `usdt0: this quote was priced for a placeholder ${role(mark)} (a dry quote without that address) and has nothing to sign — quote again with the recipient and the refund address`;

/** `usdt0VerifyQuote` on a quote for a request priced for a stand-in that carries a transaction anyway. */
export const placeholderCarriesRefusal = (mark: Usdt0Placeholder): string =>
  `a dry quote priced for a placeholder ${role(mark)} carries a transaction — it would pay or refund that placeholder, not the wallet that signs it`;

/** A recipient that is the zero account of its family: whatever reaches it is burned or stuck for good. */
export const ZERO_RECIPIENT_REFUSAL = "destination is the zero account — nothing sent there can be recovered";

/** The EVM zero address (`0x` and 40 zeros). */
export const isZeroEvmAddress = (address: unknown): boolean => typeof address === "string" && /^0x0{40}$/i.test(address);

/**
 * A quote with no transaction (priced for a stand-in), held to the request on what it still says: it pays no deposit
 * address, spends exactly the input, delivers no more than the input (a USDT0 / Legacy Mesh send keeps back a fee or
 * nothing), guarantees the caller's floor, and its intent id names `route`. The reason it fails, or null. Each text is
 * noted with its `Swap2RefusalReason`: a deposit address (`vault_mismatch`), amounts that are not integers
 * (`upstream_unavailable`), more out than in or a minimum below the floor (`price_check_failed`), another input or
 * intent (`policy_refused`).
 */
export function priceOnlyMismatch(params: Pick<QuoteParams, "amountIn" | "minAmountOut">, quote: Quote, route: string): string | null {
  if (quote.depositAddress !== "") return note(`a USDT0 quote pays no deposit address, but this one names ${String(quote.depositAddress).slice(0, 64)}`, "vault_mismatch");
  let amountIn: bigint, dest: bigint, min: bigint, floor: bigint | undefined;
  try {
    amountIn = BigInt(params.amountIn);
    if (BigInt(quote.sourceAmount) !== amountIn) return note(`the quote spends ${String(quote.sourceAmount).slice(0, 80)}, not the ${amountIn} input`, "policy_refused");
    dest = BigInt(quote.destAmount);
    min = BigInt(quote.minDestAmount);
    floor = params.minAmountOut !== undefined ? BigInt(params.minAmountOut) : undefined;
  } catch {
    return note("the quote's amounts are not integers", "upstream_unavailable");
  }
  if (dest > amountIn || min > amountIn) return note(`the quote delivers more than the ${amountIn} input`, "price_check_failed");
  if (floor !== undefined && min < floor) return note(`the quoted minimum ${min} is below the caller's floor ${floor}`, "price_check_failed");
  return String(quote.intentId).replace(/~[0-9a-f]{32}$/, "") === route ? null : note("the intent id does not name this send", "policy_refused");
}
