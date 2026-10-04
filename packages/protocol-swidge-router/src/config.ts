/** Re-assembled per-provider capability configs. Deployment config is explicit. */
import {evmRef, isEvm} from "@forgewallet/protocol-swidge-core/util";

export {nearIntents} from "@forgewallet/protocol-swidge-near-intents/config";
export {thorchain} from "@forgewallet/protocol-swidge-thorchain/config";
export {omniston} from "@forgewallet/protocol-swidge-omniston/config";

// ── LI.FI capability gate (EVM calldata routes) ──────────────────────────────
// The aggregator ships WITHOUT a LI.FI provider package — LI.FI publishes its
// own module, which plugs in via
// `modules[]`. This slice only gates discovery for a deployment that injects a
// lifi-model engine provider under the name "lifi".
// 2026-08 sweep (li.quest/v1/chains): + Avalanche 43114, Scroll 534352,
// Berachain 80094 (HyperEVM 999 / Robinhood 4663 covered by provider maps).
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
