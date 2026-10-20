import {evmRef, isEvm, namespace} from "@forgewallet/protocol-swap2-core/util";

// ── Omniston (STON.fi) — stable corridors over a WebSocket RFQ ───────────────
// Operational matrix (docs.ston.fi "Supported Chains", re-checked 2026-10-20):
// Arbitrum, Avalanche, Base, BNB, Ethereum, Polygon, Robinhood, X Layer (196),
// HyperEVM (999), Plasma (9745), ARC (5042), TON, TRON. ARC waits for the asset
// catalog; TRON needs its own order/position path. Live RFQ 2026-10-20: every
// listed chain quotes against TON USDT both ways, and EVM↔EVM pairs quote too.
const OMNISTON_EVM = new Set([1, 56, 137, 196, 999, 4663, 8453, 9745, 42161, 43114]);
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
  // TON↔EVM and EVM↔EVM cross-chain (order settlement), TON↔TON same-chain
  // (swap settlement — immediate DEX routes). Same-chain EVM is not an order
  // corridor.
  supports(from: string, to: string): boolean {
    if (!this.supportsChain(from) || !this.supportsChain(to)) return false;
    const tonSide = namespace(from) === "ton" || namespace(to) === "ton";
    return tonSide || from !== to;
  },
};
