/**
 * How much a plain SpokePool deposit leaves to relayers — the one number a quote source decides.
 *
 * The risk is two-sided. Asking relayers for too much (`outputAmount` too high) and nobody fills: the funds wait for
 * the fill deadline (two hours) and then Across's refund bundles (hours more). Asking for too little and the user
 * overpays. Across API V5 is the price source, but it prices V5's OWN route, not a plain deposit: an execution step on
 * the origin chain through Across's Gateway that a plain deposit does not have (the user's own wallet pays the
 * deposit's gas), sometimes another rail (USDT Ethereum → Arbitrum went to a 20-minute rail on 2026-11-14), and an
 * auction whose relayers fill large ETH L2 → L2 transfers at ~1 bp, well below what plain deposits are filled at.
 *
 * The rule (study of 2026-11-15: 27 V5 / suggested-fees pairs and 8 272 deposits on Ethereum, Optimism, Base and
 * Arbitrum over 24 h — 1 369 of 1 369 organic plain deposits to Base, Arbitrum and Optimism priced at or above the
 * relayer fee were filled, p50 2 s, p90 13 s):
 *
 * ```
 * F5    = V5 fee.totalFee − Σ V5 gasEstimates[origin, included_in_transfer_fee]     (the add-back rounded down)
 * Fneed = /suggested-fees totalRelayFee.total                                           while Across answers it
 *       = floor(asset, origin, size) + 1.5 × V5's destination gas                       otherwise (studied routes only)
 * fee   = max(F5, Fneed);  outputAmount = input − fee
 * quoteTimestamp = /suggested-fees `timestamp` (the LP fee was priced there), else
 *                  min(latest Ethereum block time − 60 s, latest origin block time)
 * fillDeadline   = quoteTimestamp + 7200;  no exclusivity
 * ```
 *
 * `max()` keeps both bounds: never more than V5 charges for the same transfer (net of the step a plain deposit does
 * not have), never less than plain deposits are filled at today. The device holds whatever a server says to its own
 * per-asset fee floor and to the user's cap (`verify.ts`), so a server can delay a deposit, never take it.
 */
import type {AcrossRoute} from "./config.js";
import {AcrossRefusal} from "./refusal.js";

/** The fill deadline after the quote time: what Across's own quotes give (3 923 of 6 982 plain deposits, 2026-11-14). */
export const ACROSS_FILL_WINDOW_S = 7_200;
/** Without `/suggested-fees`, the quote time lags Ethereum's latest block by this much (the LP fee is priced at a HubPool block). */
export const ACROSS_QUOTE_TIME_LAG_S = 60;

/**
 * The relayer-fee floor without `/suggested-fees`, in hundredths of a basis point (millionths) of the input, read off 24 h of
 * fills priced by it (2026-11-14): stablecoins 1.00 bp, WBTC 3.10 bps, ETH from Ethereum 1.00 bp (fills seen at
 * 0.74–0.84), ETH from an L2 on a size curve. Plus 1.5 × V5's destination gas.
 */
export const ACROSS_FLOOR_CBPS = Object.freeze({stable: 100, wbtc: 310, ethFromEthereum: 100});
/** ETH from an L2: [size in USD, hundredths of a bp], linear between points — the curve every plain ETH L2 → L2 deposit of $1 000+ paid. */
export const ACROSS_ETH_L2_CURVE: readonly (readonly [number, number])[] = Object.freeze([
  [0, 477], [1_000, 515], [2_000, 540], [4_000, 605], [8_000, 715], [16_000, 850], [36_000, 920],
].map((p) => Object.freeze(p as [number, number])));
/** Above this size (USD) no plain ETH L2 deposit was seen: refused when the floor is what prices it. */
export const ACROSS_ETH_L2_FLOOR_MAX_USD = 36_000;
/**
 * The chains the floor was derived on: deposits from Ethereum, Optimism, Base and Arbitrum to Optimism, Base and
 * Arbitrum. Without `/suggested-fees` any other route has no relayer price this module can stand behind.
 */
export const ACROSS_FLOOR_ORIGINS: readonly number[] = Object.freeze([1, 10, 8453, 42161]);
export const ACROSS_FLOOR_DESTINATIONS: readonly number[] = Object.freeze([10, 8453, 42161]);

/**
 * Why a route is not priced at all, or null. Ethereum as the destination: small plain deposits to Ethereum went
 * unfilled in the study's window (some paying more than filled ones), for reasons the data does not show — kept out
 * until studied rather than priced on a guess.
 */
export function acrossRouteUnpriced(route: AcrossRoute): string | null {
  if (route.output.chain.chainId === 1) return "plain deposits to Ethereum are not priced yet — small ones went unfilled in the 2026-11-14 study for reasons the data does not show";
  return null;
}

/** The floor in hundredths of a bp for a route and size (USD), or a refusal text. */
export function acrossFloorCbps(route: AcrossRoute, amountUsd: number | undefined): number | string {
  const src = route.input.chain.chainId;
  if (!ACROSS_FLOOR_ORIGINS.includes(src) || !ACROSS_FLOOR_DESTINATIONS.includes(route.output.chain.chainId)) {
    return `without Across's relayer fee quote there is no relayer price for ${route.input.chain.name} → ${route.output.chain.name} (the pinned floor covers Ethereum, Optimism, Base and Arbitrum to Optimism, Base and Arbitrum)`;
  }
  if (route.asset === "USDC" || route.asset === "USDT") return ACROSS_FLOOR_CBPS.stable;
  if (route.asset === "WBTC") return ACROSS_FLOOR_CBPS.wbtc;
  if (src === 1) return ACROSS_FLOOR_CBPS.ethFromEthereum;
  if (amountUsd === undefined || !Number.isFinite(amountUsd) || amountUsd < 0) return "without Across's relayer fee quote the ETH floor needs the transfer's size in dollars, and the V5 quote states none";
  if (amountUsd > ACROSS_ETH_L2_FLOOR_MAX_USD) return `without Across's relayer fee quote ETH from an L2 is priced up to $${ACROSS_ETH_L2_FLOOR_MAX_USD} (no larger plain deposit was seen)`;
  const c = ACROSS_ETH_L2_CURVE;
  for (let i = 1; i < c.length; i++) {
    const [x1, y1] = c[i]!;
    if (amountUsd <= x1) {
      const [x0, y0] = c[i - 1]!;
      return Math.ceil(y0 + ((y1 - y0) * (amountUsd - x0)) / (x1 - x0));
    }
  }
  return c[c.length - 1]![1];
}

/** `amount × cbps / 1 000 000`, rounded up. */
export const acrossCbpsOf = (amount: bigint, cbps: number): bigint => (amount * BigInt(cbps) + 999_999n) / 1_000_000n;

/** The pinned-floor relayer need for a route without `/suggested-fees`: floor + 1.5 × V5's destination gas, rounded up. */
export function acrossFloorFee(route: AcrossRoute, amount: bigint, amountUsd: number | undefined, destinationGas: bigint | null): bigint {
  const cbps = acrossFloorCbps(route, amountUsd);
  if (typeof cbps === "string") {
    const tooLarge = route.asset === "ETH" && amountUsd !== undefined && amountUsd > ACROSS_ETH_L2_FLOOR_MAX_USD;
    throw new AcrossRefusal("relayer-price", cbps, tooLarge ? "amount_too_large" : "upstream_unavailable");
  }
  if (destinationGas === null) throw new AcrossRefusal("relayer-price", "without Across's relayer fee quote the floor needs V5's destination gas, and it does not read", "upstream_unavailable");
  return acrossCbpsOf(amount, cbps) + (destinationGas * 3n + 1n) / 2n;
}

/** The fee of a plain deposit: `max(F5, Fneed)`, with both terms. */
export interface AcrossPlainFee {
  fee: bigint;
  /** V5's fee net of its origin execution step. */
  f5: bigint;
  /** What a relayer needs (`/suggested-fees`, or the floor). */
  need: bigint;
}

/** `max(F5, Fneed)`. Refuses a fee that eats the whole input (`amount_too_small`). */
export function acrossPlainFee(amount: bigint, v5: {totalFee: bigint; originGas: bigint}, need: bigint): AcrossPlainFee {
  const f5 = v5.totalFee - (v5.originGas > v5.totalFee ? v5.totalFee : v5.originGas);
  const fee = f5 > need ? f5 : need;
  if (fee >= amount) throw new AcrossRefusal("relayer-price", `relayers would keep all of the ${amount} sent (fee ${fee})`, "amount_too_small");
  return {fee, f5, need};
}

/** The deposit's quote time without `/suggested-fees`: `min(Ethereum − 60 s, origin)`, from the chains' latest blocks. */
export function acrossQuoteTimeOf(ethereumBlockTime: number, originBlockTime: number): number {
  return Math.min(ethereumBlockTime - ACROSS_QUOTE_TIME_LAG_S, originBlockTime);
}
