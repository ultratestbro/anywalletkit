/**
 * @forgewallet/protocol-swidge-router — the OPTIONAL swidge aggregator.
 *
 * Every swidge provider module runs on its own (install only
 * `@forgewallet/protocol-swidge-lifi` and use `LifiSwidgeProtocol`). Install
 * this package when you want one protocol that auctions a route across several
 * providers: pass the providers you installed and it quotes them in parallel,
 * validates every quote, scores them and executes the winner.
 *
 * ```ts
 * import {RouterSwidgeProtocol} from "@forgewallet/protocol-swidge-router";
 * import {lifiProvider} from "@forgewallet/protocol-swidge-lifi/provider";
 * import {nearIntentsProvider} from "@forgewallet/protocol-swidge-near-intents/provider";
 *
 * const swidge = new RouterSwidgeProtocol(account, {
 *   fromChain: "eip155:1",
 *   providers: [lifiProvider({}), nearIntentsProvider({})],
 * });
 * ```
 *
 * Providers reached through a backend use `remoteProvider` (re-exported from
 * the core package); give it `supportsChain`/`supportsChainPair` — e.g. from
 * the provider package's `config` export — so discovery knows its coverage.
 */
export {CrossChainRouter} from "./router.js";
export {RouterSwidgeProtocol, type RouterSwidgeConfig} from "./swidge/router.js";
export {RouterSwidgeProtocol as default} from "./swidge/router.js";
export {remoteProvider, type RemoteProviderOptions} from "@forgewallet/protocol-swidge-core/remote";
export type * from "@forgewallet/protocol-swidge-core/types";
