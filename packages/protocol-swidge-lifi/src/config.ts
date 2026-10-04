import {evmRef, isEvm} from "@forgewallet/protocol-swidge-core/util";

// ── LI.FI — EVM calldata routes implemented by this contribution adapter ─────
// 2026-08 sweep (li.quest/v1/chains): + Avalanche 43114, Scroll 534352,
// Berachain 80094 (HyperEVM 999 / Robinhood 4663 were already routed by the
// provider's own chain map).
const LIFI_EVM = new Set([1, 8453, 56, 137, 42161, 10, 100, 143, 130, 999, 4663, 43114, 534352, 80094]);
export const lifi = {
  enabled: () => true,
  apiKey: () => undefined,
  integrator: () => "",
  supportsChain(chain: string): boolean {
    if (isEvm(chain)) return LIFI_EVM.has(evmRef(chain));
    // Non-EVM serialized transaction formats are not implemented here.
    return false;
  },
  supports(from: string, to: string): boolean {
    return this.supportsChain(from) && this.supportsChain(to);
  },
};
