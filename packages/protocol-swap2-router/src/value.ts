import {bigintToNumber, bigintToUnits} from "@anywalletkit/core";
import {ccAssetByToken, ccChain} from "@anywalletkit/swap2-assets";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

/** Stables priced at par when the map has no entry for them. */
const PAR = /^(USDC|USDT|USDT0|USD₮0|DAI|USDC\.E)$/i;

/** symbol → USD, trying the exact symbol, upper case, the unwrapped native (WETH → ETH, wS → S), then par for stables. */
function priceOf(prices: Readonly<Record<string, number>>, symbol: string): number | null {
  const tries = [symbol, symbol.toUpperCase()];
  if (/^w/i.test(symbol) && symbol.length > 2) tries.push(symbol.slice(1), symbol.slice(1).toUpperCase());
  for (const t of tries) {
    const p = prices[t];
    if (typeof p === "number" && Number.isFinite(p) && p > 0) return p;
  }
  return PAR.test(symbol) ? 1 : null;
}

const units = (amount: string | bigint, decimals: number) => bigintToUnits(BigInt(amount), decimals);

/**
 * A `valueUsd` for the router: the guaranteed output in USD, minus the native
 * fee the route charges on top of the input (bridge messaging fees), minus
 * the source gas when `gasUsd` can say it. null when a needed price is missing
 * — the auction then falls back to comparing guaranteed outputs.
 */
export function usdValue(
  prices: Readonly<Record<string, number>>,
  options?: {gasUsd?: (quote: Quote, params: QuoteParams) => number | null},
): (quote: Quote, params: QuoteParams) => number | null {
  return (quote, params) => {
    const dest = ccAssetByToken(params.destChain, params.destToken);
    if (!dest) return null;
    const destPrice = priceOf(prices, dest.symbol);
    if (destPrice === null) return null;
    let value = units(quote.minDestAmount, dest.decimals) * destPrice;
    const nativeFee = quote.txRequest?.nativeFee;
    if (nativeFee && BigInt(nativeFee) > 0n) {
      const native = ccAssetByToken(params.sourceChain, "");
      const nativePrice = native ? priceOf(prices, native.symbol) : null;
      if (!native || nativePrice === null) return null;
      value -= units(nativeFee, native.decimals) * nativePrice;
    }
    if (options?.gasUsd) {
      const gas = options.gasUsd(quote, params);
      if (gas === null || !Number.isFinite(gas)) return null;
      value -= gas;
    }
    return value;
  };
}

// ---------------------------------------------------------------------------
// Value information for the user (SDK-127): never a refusal, always a fact.
// ---------------------------------------------------------------------------

export interface QuoteValue {
  provider: string;
  /** USD the user pays: the source amount at the current price. null when unpriced. */
  valueUsdIn: number | null;
  /** USD the quote delivers: the expected `destAmount` at the current price, minus a native fee paid on top. null when unpriced. */
  valueUsdOut: number | null;
  /** (in − out) / in × 100. Positive = the user receives less value than they pay. null when either side is unpriced. */
  lossPct: number | null;
  /** Another provider in the same set that delivers more than `betterByPct` more. Every quote of a request pays out the
   *  same destination token, so the comparison is by delivered USD when priced and by raw `destAmount` otherwise. */
  betterAlternative?: {provider: string; valueUsdOut: number | null; destAmount: string; byPct: number};
  /** The venue's own price impact in basis points (`providerData.priceImpactBps`), when it measures one. */
  priceImpactBps?: number;
}

export interface QuoteValueOptions {
  /** How much more (percent of this quote's value) another provider must deliver to be named as the better alternative. Default 2. */
  betterByPct?: number;
}

type ValueParams = Pick<QuoteParams, "sourceChain" | "sourceToken" | "destChain" | "destToken" | "amountIn">;
type ValueQuote = Pick<Quote, "provider" | "destAmount"> & Partial<Pick<Quote, "txRequest" | "providerData">>;

/** The catalog asset for a token given as a contract / asset id (the wire form) or as a symbol (what apps pass for the source). */
function assetFor(chain: string, token: string) {
  const byToken = ccAssetByToken(chain, token);
  if (byToken) return byToken;
  const want = token.toLowerCase();
  return ccChain(chain)?.assets.find((a) => a.symbol.toLowerCase() === want);
}

/**
 * USD in / out / loss for every quote of one request, and the better
 * alternative inside the set. Prices are the caller's current spot prices
 * (symbol → USD). The owner's rule (2026-10-16): the wallet shows this and
 * says "be careful"; it never blocks — the Oct 16 funded run lost ~$33 on
 * two Uniswap legs that nothing compared to the other venues' quotes.
 */
export function quoteValues(prices: Readonly<Record<string, number>>, params: ValueParams, quotes: readonly ValueQuote[], options: QuoteValueOptions = {}): QuoteValue[] {
  const betterBy = options.betterByPct ?? 2;
  const src = assetFor(params.sourceChain, params.sourceToken);
  const dest = assetFor(params.destChain, params.destToken);
  const srcPrice = src ? priceOf(prices, src.symbol) : null;
  const destPrice = dest ? priceOf(prices, dest.symbol) : null;
  let valueUsdIn: number | null = null;
  if (src && srcPrice !== null) {
    try {
      valueUsdIn = units(params.amountIn, src.decimals) * srcPrice;
    } catch {
      valueUsdIn = null;
    }
  }
  const out: QuoteValue[] = quotes.map((q) => {
    let valueUsdOut: number | null = null;
    if (dest && destPrice !== null) {
      try {
        valueUsdOut = units(q.destAmount, dest.decimals) * destPrice;
        const nativeFee = q.txRequest?.nativeFee;
        if (nativeFee && BigInt(nativeFee) > 0n) {
          const native = ccAssetByToken(params.sourceChain, "");
          const nativePrice = native ? priceOf(prices, native.symbol) : null;
          if (native && nativePrice !== null) valueUsdOut -= units(nativeFee, native.decimals) * nativePrice;
        }
      } catch {
        valueUsdOut = null;
      }
    }
    const lossPct = valueUsdIn !== null && valueUsdIn > 0 && valueUsdOut !== null ? ((valueUsdIn - valueUsdOut) / valueUsdIn) * 100 : null;
    const impact = q.providerData?.priceImpactBps;
    const priceImpactBps = typeof impact === "string" && /^\d+$/.test(impact) ? Number(impact) : undefined;
    const v: QuoteValue = {provider: q.provider, valueUsdIn, valueUsdOut, lossPct};
    if (priceImpactBps !== undefined) v.priceImpactBps = priceImpactBps;
    return v;
  });
  // The best delivery in the set names itself as the alternative for every quote it beats by more than betterBy %.
  // Priced: by delivered USD (native fees netted). Unpriced: by raw destAmount — same token for every quote, so the ratio is exact.
  const allPriced = out.length > 1 && out.every((v) => v.valueUsdOut !== null);
  if (out.length > 1) {
    const measure = (v: QuoteValue): number => (allPriced ? v.valueUsdOut! : bigintToNumber(BigInt(quotes.find((q) => q.provider === v.provider)!.destAmount)));
    const top = out.reduce((a, b) => (measure(b) > measure(a) ? b : a));
    const topQuote = quotes.find((q) => q.provider === top.provider)!;
    for (const v of out) {
      if (v === top) continue;
      const mine = measure(v);
      const byPct = mine > 0 ? ((measure(top) - mine) / mine) * 100 : Infinity;
      if (byPct > betterBy) v.betterAlternative = {provider: top.provider, valueUsdOut: top.valueUsdOut, destAmount: topQuote.destAmount, byPct};
    }
  }
  return out;
}
