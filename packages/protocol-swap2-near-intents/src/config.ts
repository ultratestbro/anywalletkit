import {namespace} from "@forgewallet/protocol-swap2-core/util";
import {ccChain} from "@forgewallet/swap2-assets";

// ── NEAR Intents (1Click) — core, broadest coverage ─────────────────────────
const NEAR_INTENTS_NS = new Set([
  "eip155", "solana", "tron", "bitcoin", "near", "sui", "ton", "zcash",
  "litecoin", "doge", "xrp", "bch", "cardano", "stellar", "aptos",
]);

/**
 * Corridors the APP has paused (caip2 → why), passed in through the provider
 * config: a venue-side degradation (1Click's HOT omni-bridge assets answering
 * "not available" for days) is an operational switch, not SDK knowledge — the
 * wallet flips an env var and lifts it the same way when the venue recovers.
 */
export type NearIntentsSuspendedChains = Readonly<Record<string, string>>;

/** Why a chain is refused up front, or null when 1Click can serve it. */
export function nearIntentsChainRefusal(chain: string, suspended: NearIntentsSuspendedChains = {}): string | null {
  if (!NEAR_INTENTS_NS.has(namespace(chain))) return `1Click does not serve ${chain}`;
  const why = suspended[chain];
  if (why) return `1Click corridor paused by the app: ${chain} — ${why}`;
  // A chain the catalog knows but carries no 1Click asset id for (World Chain,
  // Sei, Ink, Plume, X Layer, Unichain, MegaETH, Linea, Sonic, …) is LI.FI /
  // CCTP territory: the eip155 namespace alone used to claim it, and every
  // quote then died as "unknown asset" (2026-10-16 funded run).
  const listed = ccChain(chain)?.assets.some((a) => a.assetId.length > 0) ?? false;
  return listed ? null : `1Click does not list ${chain}`;
}

export const nearIntents = {
  enabled: () => true,
  // Routes between any pair of 1Click-listed chains. 1Click is a NEAR-intents
  // solver network — it settles non-EVM↔non-EVM directly (BTC→Solana, Tron→
  // Base …), so this pre-filter must NOT require an EVM leg (the old "vault
  // leg is always EVM" assumption of the off-ramp flow silently blocked those
  // swap routes). A chain counts as listed when the shared catalog carries at
  // least one 1Click asset id for it and it is not suspended above; `getQuote`
  // is the real per-pair check and fail-closes (returns null, naming why) for
  // any pair 1Click can't actually route.
  // 2026-08 sweep: 1Click added LTC/DOGE/XRP/BCH/ADA/XLM/APT (+ the EVM
  // additions Avalanche/Scroll/Berachain, covered by the catalog ids).
  supportsChain(chain: string): boolean {
    return nearIntentsChainRefusal(chain) === null;
  },
  supports(from: string, to: string): boolean {
    return this.supportsChain(from) && this.supportsChain(to);
  },
};
