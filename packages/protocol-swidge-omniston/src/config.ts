import {evmRef, isEvm, namespace} from "@forgewallet/protocol-swidge-core/util";

// ── Omniston (STON.fi) — TON ↔ EVM stables, RFQ over WebSocket ───────────────
// 2026-08 operational matrix (docs.ston.fi): Ethereum, BNB, Base, Arbitrum,
// Avalanche, Polygon and Robinhood Chain. TRON is still marked "upcoming".
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
