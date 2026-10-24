/**
 * Auto slippage — how far below the quoted output a swap may settle before
 * it reverts or refunds. Slippage covers price movement between the quote
 * and execution, so it is sized by what moves the price in that window:
 *
 * - the pair: stablecoin ↔ stablecoin barely moves, majors move a little,
 *   everything else more (the base);
 * - the trade's own price impact: a large order in a thin pool is more
 *   exposed to the next trade landing first;
 * - time to settle: same-chain swaps land in seconds, cross-chain routes take
 *   minutes (ignored for stable ↔ stable, where the price does not drift);
 * - recent volatility of the more volatile side, when the app knows it.
 *
 * The sum is clamped to [minBps, maxBps]. A higher slippage is not free on a
 * same-chain EVM swap: a sandwich bot can take up to all of it, so the bases
 * stay small and room is added only where it is needed. Route policy lives in
 * the app: it decides whether to use this, show it, and let the user override.
 */

export type SlippageClass = "stable" | "major" | "other";

export interface SlippageContext {
  fromChain: string;
  toChain: string;
  /** Catalog symbols of the two sides, e.g. "USDC", "ETH", "cbBTC". */
  fromSymbol: string;
  toSymbol: string;
  /** Price impact of this trade as the provider reports it, in bps. */
  priceImpactBps?: number;
  /** The route's expected time to settle, in seconds. */
  etaSeconds?: number;
  /** Recent price range of the more volatile side (e.g. over 1 h), in bps. */
  volatilityBps?: number;
}

export interface SlippageOptions {
  /** Default 5 bps. */
  minBps?: number;
  /** Default 300 bps; anything above needs the user's own choice. */
  maxBps?: number;
}

export interface SlippageSuggestion {
  bps: number;
  pair: SlippageClass;
  parts: {base: number; impact: number; time: number; volatility: number};
  /** True when the sum was cut down to `maxBps`. */
  capped: boolean;
}

const STABLES = new Set(["USDT", "USDC", "USDT0", "USD₮0", "USD₮", "DAI", "USDS", "USDE", "FDUSD", "PYUSD", "USDBC", "USDC.E", "USDT.E", "BUSD", "TUSD", "LUSD", "GHO", "CRVUSD", "FRAX", "USDP"]);
const MAJORS = new Set(["ETH", "WETH", "STETH", "WSTETH", "BTC", "WBTC", "CBBTC", "TBTC", "LBTC", "SOL", "WSOL", "BNB", "WBNB", "POL", "WPOL", "MATIC", "AVAX", "WAVAX", "TON", "GRAM", "TRX", "NEAR", "WNEAR", "ARB", "OP", "HYPE", "WHYPE", "XDAI", "WXDAI"]);

/** Which bucket a symbol falls in. Unknown symbols are "other". */
export function slippageClassOf(symbol: string): SlippageClass {
  const s = symbol.trim().toUpperCase();
  if (STABLES.has(s)) return "stable";
  if (MAJORS.has(s)) return "major";
  return "other";
}

const BASE_BPS: Record<SlippageClass, number> = {stable: 10, major: 50, other: 100};

function pairClass(a: SlippageClass, b: SlippageClass): SlippageClass {
  if (a === "stable" && b === "stable") return "stable";
  if (a !== "other" && b !== "other") return "major";
  return "other";
}

function timeBps(eta: number | undefined): number {
  if (eta === undefined || !Number.isFinite(eta) || eta <= 60) return 0;
  if (eta <= 600) return 20;
  if (eta <= 1800) return 40;
  return 60;
}

export function suggestSlippage(ctx: SlippageContext, options: SlippageOptions = {}): SlippageSuggestion {
  const minBps = options.minBps ?? 5;
  const maxBps = options.maxBps ?? 300;
  const pair = pairClass(slippageClassOf(ctx.fromSymbol), slippageClassOf(ctx.toSymbol));
  const base = BASE_BPS[pair];
  const impact = Math.min(100, Math.max(0, Math.round((ctx.priceImpactBps ?? 0) / 2)));
  const crossChain = ctx.fromChain !== ctx.toChain;
  const time = crossChain && pair !== "stable" ? Math.round(timeBps(ctx.etaSeconds) * (pair === "other" ? 1.5 : 1)) : 0;
  const volatility = Math.min(100, Math.max(0, Math.round((ctx.volatilityBps ?? 0) / 4)));
  const sum = base + impact + time + volatility;
  const bps = Math.min(maxBps, Math.max(minBps, sum));
  return {bps, pair, parts: {base, impact, time, volatility}, capped: sum > maxBps};
}
