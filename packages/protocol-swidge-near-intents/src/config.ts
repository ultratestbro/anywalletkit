import {namespace} from "@forgewallet/protocol-swidge-core/util";

// ── NEAR Intents (1Click) — core, broadest coverage ─────────────────────────
export const nearIntents = {
  enabled: () => true,
  // Routes between any pair of solver-known chains. 1Click is a NEAR-intents
  // solver network — it settles non-EVM↔non-EVM directly (BTC→TON, Tron→TON,
  // Solana→TON …), so this coarse pre-filter must NOT require an EVM leg (the
  // old "vault leg is always EVM" assumption of the off-ramp flow silently
  // blocked those swap routes). `getQuote` is the real per-pair check and
  // fail-closes (returns null) for any pair 1Click can't actually route.
  // 2026-08 sweep: 1Click added LTC/DOGE/XRP/BCH/ADA/XLM/APT (+ the EVM
  // additions Avalanche/Scroll/Berachain, covered by the eip155 namespace).
  supports(from: string, to: string): boolean {
    const known = (c: string) =>
      [
        "eip155", "solana", "tron", "bitcoin", "near", "sui", "ton", "zcash",
        "litecoin", "doge", "xrp", "bch", "cardano", "stellar", "aptos",
      ].includes(namespace(c));
    return known(from) && known(to);
  },
};
