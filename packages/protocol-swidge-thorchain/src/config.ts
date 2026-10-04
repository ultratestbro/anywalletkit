import {evmRef, isEvm, namespace} from "@forgewallet/protocol-swidge-core/util";

// ── THORChain — native L1 assets: BTC/ETH/BSC/BASE/Cosmos/Tron/Solana, and
//    (2026-08, pools live) XRP/LTC/DOGE/BCH + GAIA.ATOM ──────────────────────
// Only EVM source executors actually implemented by provider.ts.
const THOR_EVM = new Set([1, 8453, 56, 43114]); // ETH, BASE, BSC, AVAX (2026-09-16)
const THOR_NS = new Set(["bitcoin", "cosmos", "solana", "tron", "xrp", "litecoin", "doge", "bch"]);
export const thorchain = {
  enabled: () => true,
  affiliate: () => "",
  affiliateBps: () => "",
  supportsChain(chain: string): boolean {
    if (THOR_NS.has(namespace(chain))) return true;
    return isEvm(chain) && THOR_EVM.has(evmRef(chain));
  },
  supports(from: string, to: string): boolean {
    return this.supportsChain(from) && this.supportsChain(to);
  },
};
