/**
 * The optional aggregator: one swidge protocol that quotes every provider the
 * caller installed and passed in, in parallel, and executes the best route.
 *
 * Every provider package (`@forgewallet/protocol-swidge-lifi`, `-near-intents`,
 * `-thorchain`, `-omniston`) also works on its own through its single-provider
 * protocol class; this package is only for callers who want an auction across
 * several of them. It has no dependency on any provider: capabilities
 * (supported chains / pairs) come from the providers themselves, or — for a
 * `remoteProvider` stub — from the `supportsChain`/`supportsChainPair` options
 * the caller fills in.
 *
 * ```ts
 * const swidge = new RouterSwidgeProtocol(account, {
 *   fromChain: "eip155:1",
 *   providers: [lifiProvider({...}), nearIntentsProvider({...})],
 * })
 * ```
 */
import {
  BaseSwidgeProtocol,
  type SwidgeAccount,
  type SwidgeEngineConfig,
} from "@forgewallet/protocol-swidge-core/swidge/base";
import type {CrossChainProvider, Quote, QuoteParams} from "@forgewallet/protocol-swidge-core/types";
import {CrossChainRouter} from "../router.js";

export interface RouterSwidgeConfig extends SwidgeEngineConfig {
  /** The providers to aggregate over. Only what the caller installs is bundled. */
  providers?: CrossChainProvider[];
  /**
   * Or a ready auction engine (e.g. to share one between protocols or tune its
   * score weights). Exactly one of `providers` / `router` is required.
   */
  router?: CrossChainRouter;
  /** Score weights for a router built from `providers`, e.g. "price:0.7,speed:0.2,reliability:0.1". */
  weights?: string;
}

export class RouterSwidgeProtocol extends BaseSwidgeProtocol {
  private readonly router: CrossChainRouter;

  constructor(account: SwidgeAccount | undefined, config: RouterSwidgeConfig) {
    super(account, config);
    if (!!config.router === !!config.providers) {
      throw new Error("swidge: RouterSwidgeProtocol needs exactly one of `providers` or `router`");
    }
    this.router = config.router ?? new CrossChainRouter(config.providers!, config.weights);
  }

  protected resolveQuote(params: QuoteParams): Promise<Quote | null> {
    return this.router.getBestQuote(params);
  }

  protected override noRouteDetail(): string {
    return this.router.lastRejections.join("; ").slice(0, 400);
  }

  protected providerFor(name: string): CrossChainProvider | undefined {
    return this.router.getProvider(name);
  }

  protected chainSupported(caip2: string): boolean {
    return this.router.supportsChain(caip2);
  }

  protected override pairSupported(fromChain: string, toChain: string): boolean {
    return this.router.supportsChainPair(fromChain, toChain);
  }

  close(): void {
    this.router.close();
  }
}
