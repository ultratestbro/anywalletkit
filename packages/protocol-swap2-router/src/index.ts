/**
 * @forgewallet/protocol-swap2-router — the OPTIONAL swap2 aggregator.
 *
 * Every swap2 provider module runs on its own (install only
 * `@forgewallet/protocol-swap2-lifi` and use `LifiSwap2Protocol`). Install
 * this package when you want one protocol that auctions a route across several
 * providers: pass the providers you installed and it quotes them in parallel,
 * validates every quote, scores them and executes the winner.
 *
 * ```ts
 * import {RouterSwap2Protocol} from "@forgewallet/protocol-swap2-router";
 * import {lifiProvider} from "@forgewallet/protocol-swap2-lifi/provider";
 * import {nearIntentsProvider} from "@forgewallet/protocol-swap2-near-intents/provider";
 *
 * const swap2 = new RouterSwap2Protocol(account, {
 *   fromChain: "eip155:1",
 *   providers: [lifiProvider({}), nearIntentsProvider({})],
 * });
 * ```
 *
 * Providers reached through a backend use `remoteProvider` (re-exported from
 * the core package); give it `supportsChain`/`supportsChainPair` — e.g. from
 * the provider package's `config` export — so discovery knows its coverage.
 */
export {CrossChainRouter, type RouterOptions, type RankedQuote, type RouteSet} from "./router.js";
export {usdValue, quoteValues} from "./value.js";
export type {QuoteValue, QuoteValueOptions} from "./value.js";
export {RouterSwap2Protocol, type RouterSwap2Config, type Swap2Route} from "./swap2/router.js";
export {RouterSwap2Protocol as default} from "./swap2/router.js";
export {remoteProvider, type RemoteProviderOptions} from "@forgewallet/protocol-swap2-core/remote";
export type * from "@forgewallet/protocol-swap2-core/types";
