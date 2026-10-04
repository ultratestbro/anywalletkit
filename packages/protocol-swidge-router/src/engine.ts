import {CrossChainRouter} from "@forgewallet/protocol-swidge-core/router";
import {nearIntentsProvider} from "./providers/nearIntents.js";
import {thorchainProvider} from "./providers/thorchain.js";
import {omnistonProvider} from "./providers/omniston.js";

export {CrossChainRouter} from "@forgewallet/protocol-swidge-core/router";
export type * from "./types.js";

let _router: CrossChainRouter | undefined;

/**
 * The configured router. Provider set: NEAR Intents (1Click,
 * core) + THORChain + Omniston. Each provider is capability-filtered and
 * ships dark by default; deployment glue must inject explicitly enabled,
 * configured providers with {@link setCrossChainRouter}.
 */
export function crossChainRouter(): CrossChainRouter {
  if (!_router) {
    _router = new CrossChainRouter(
      [
        nearIntentsProvider({enabled: false}),
        thorchainProvider({enabled: false}),
        omnistonProvider({enabled: false}),
      ],
      undefined,
    );
  }
  return _router;
}

/** Inject a router (tests / additional providers). Pass `undefined` to reset. */
export function setCrossChainRouter(router: CrossChainRouter | undefined): void {
  _router = router;
}
