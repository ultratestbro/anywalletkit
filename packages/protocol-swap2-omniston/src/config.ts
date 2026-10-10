import {evmRef, isEvm, namespace} from "@forgewallet/protocol-swap2-core/util";

// ── Omniston (STON.fi) — TON ↔ EVM stables, RFQ over WebSocket ───────────────
// Operational matrix (docs.ston.fi, re-checked 2026-10-08): Ethereum, BNB,
// Base, Arbitrum, Avalanche, Polygon, Robinhood Chain — plus TRON, X Layer
// (196), HyperEVM (999, USDT0 only), Plasma (9745), ARC (5042) which our asset
// catalog does not carry yet; add them here once swap2-assets lists their
// stables. SDK 0.8.11 (chains only since 0.8.9; API v1beta8).
const OMNISTON_EVM = new Set([1, 56, 137, 4663, 8453, 42161, 43114]);
export const omniston = {
  enabled: () => true,
  integratorAddress: () => "",
  integratorFeePips: () => "",
  wsUrl: () => "wss://omni-ws.ston.fi",
  /** Per-swap USD cap — the resolver quotes the corridor up to ~$1000. */
  maxUsd: () => {
    return 1000;
  },
  supportsChain(chain: string): boolean {
    if (namespace(chain) === "ton") return true;
    return isEvm(chain) && OMNISTON_EVM.has(evmRef(chain));
  },
  // TON↔EVM cross-chain (order settlement) and TON↔TON same-chain (swap
  // settlement — immediate DEX routes); never EVM↔EVM.
  supports(from: string, to: string): boolean {
    const tonSide = namespace(from) === "ton" || namespace(to) === "ton";
    return tonSide && this.supportsChain(from) && this.supportsChain(to);
  },
};
