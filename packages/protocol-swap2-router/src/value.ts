import {ccAssetByToken} from "@forgewallet/swap2-assets";
import type {Quote, QuoteParams} from "@forgewallet/protocol-swap2-core/types";

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

const units = (amount: string | bigint, decimals: number) => Number(BigInt(amount)) / 10 ** decimals;

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
