/**
 * @forgewallet/protocol-swidge-router
 *
 * A "swidge" (swap+bridge) protocol: cross-chain asset delivery over a set
 * of pluggable solver networks — NEAR Intents (1Click), LI.FI, THORChain and
 * Omniston — behind one scoring router. Two surfaces are exported:
 *
 *  1. The engine (`CrossChainRouter` + `CrossChainProvider`s) — the low-level
 *     deposit-address / calldata execution model.
 *  2. The protocol layer (`./swidge`) — `SwidgeProtocol` subclasses that
 *     implement `@forgewallet/core`'s protocol contract on top of the engine,
 *     so the same routes are reachable through a registered account.
 */

// ── Engine (low-level) ───────────────────────────────────────────────────────
export * from "./types.js";
export {CrossChainRouter} from "./router.js";
export {crossChainRouter, setCrossChainRouter} from "./engine.js";
export {nearIntents, lifi, thorchain, omniston} from "./config.js";
export {nearIntentsProvider} from "./providers/nearIntents.js";
export {thorchainProvider} from "./providers/thorchain.js";
export {
  omnistonProvider,
  inMemoryQuoteStore,
  type OmnistonQuoteStore,
  inMemorySecretStore,
  type HtlcSecretStore,
  type OmnistonProviderOptions,
  type OmnistonClientLike,
} from "./providers/omniston.js";

// ── Remote (browser → backend) provider ──────────────────────────────────────
export {remoteProvider, type RemoteProviderOptions} from "./remote.js";

// ── swidge layer ─────────────────────────────────────────────────────────
export * from "./swidge/index.js";
export {RouterSwidgeProtocol as default} from "./swidge/router.js";
