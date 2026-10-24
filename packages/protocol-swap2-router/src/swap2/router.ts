/**
 * The optional aggregator: one swap2 protocol that quotes every provider the
 * caller installed and passed in, in parallel, and executes the best route.
 *
 * Every provider package (`@anywalletkit/protocol-swap2-lifi`, `-near-intents`,
 * `-thorchain`, `-omniston`) also works on its own through its single-provider
 * protocol class; this package is only for callers who want an auction across
 * several of them. It has no dependency on any provider: capabilities
 * (supported chains / pairs) come from the providers themselves, or — for a
 * `remoteProvider` stub — from the `supportsChain`/`supportsChainPair` options
 * the caller fills in.
 *
 * ```ts
 * const swap2 = new RouterSwap2Protocol(account, {
 *   fromChain: "eip155:1",
 *   providers: [lifiProvider({...}), nearIntentsProvider({...})],
 * })
 * ```
 */
import {
  BaseSwap2Protocol,
  type Swap2Account,
  type Swap2EngineConfig,
} from "@anywalletkit/protocol-swap2-core/swap2/base";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import type {ActivityItem, ChainTx, DescribeActivityContext, Swap2Options, Swap2Quote} from "@anywalletkit/core";
import {CrossChainRouter, type RouteSet, type RouterOptions} from "../router.js";

/** One route in a picker: the public quote plus its place in the auction. */
export interface Swap2Route {
  provider: string;
  quote: Swap2Quote;
  /** Net USD value when the router prices routes (`valueUsd`), else null. */
  netValueUsd: number | null;
  /** Value against the best route, 0..1. */
  relativeValue: number;
  tags: ("best" | "fastest")[];
}

export interface RouterSwap2Config extends Swap2EngineConfig {
  /** The providers to aggregate over. Only what the caller installs is bundled. */
  providers?: CrossChainProvider[];
  /**
   * Or a ready auction engine (e.g. to share one between protocols or tune its
   * score weights). Exactly one of `providers` / `router` is required.
   */
  router?: CrossChainRouter;
  /** Order inside a price tie for a router built from `providers`, e.g. "price:0.7,speed:0.2,reliability:0.1". */
  weights?: string;
  /** Net USD value of a quote for a router built from `providers` — see `usdValue(prices)`. */
  valueUsd?: RouterOptions["valueUsd"];
  /** Fraction of the best value inside which routes tie on price (default 0.002). */
  tieBand?: number;
  /** What `swap2()` / `quoteSwap2()` execute when several routes answer: the best (default) or the fastest. */
  prefer?: "best" | "fastest";
}

export class RouterSwap2Protocol extends BaseSwap2Protocol {
  private readonly router: CrossChainRouter;
  private readonly account: Swap2Account | undefined;
  private readonly routerConfig: RouterSwap2Config;

  constructor(account: Swap2Account | undefined, config: RouterSwap2Config) {
    super(account, config);
    if (!!config.router === !!config.providers) {
      throw new Error("swap2: RouterSwap2Protocol needs exactly one of `providers` or `router`");
    }
    if (config.prefer !== undefined && config.prefer !== "best" && config.prefer !== "fastest") {
      throw new Error("swap2: prefer must be \"best\" or \"fastest\"");
    }
    this.router = config.router ?? new CrossChainRouter(config.providers!, {
      ...(config.weights !== undefined ? {weights: config.weights} : {}),
      ...(config.valueUsd ? {valueUsd: config.valueUsd} : {}),
      ...(config.tieBand !== undefined ? {tieBand: config.tieBand} : {}),
    });
    this.account = account;
    this.routerConfig = config;
  }

  protected resolveQuote(params: QuoteParams): Promise<Quote | null> {
    return this.router.getBestQuote(params, this.routerConfig.prefer ? {prefer: this.routerConfig.prefer} : undefined);
  }

  /**
   * Every route for a picker, ranked, with the best and the fastest tagged.
   * `onUpdate` gets the ranked list each time another provider answers, so a
   * UI shows the first price as soon as the fastest venue replies. Routes the
   * caller's floor or fee caps refuse are left out. Execute the one the user
   * picks with `using(route.provider).swap2(...)`.
   */
  async quoteSwap2Routes(options: Swap2Options, opts?: {onUpdate?: (routes: Swap2Route[], pending: string[]) => void}): Promise<Swap2Route[]> {
    const snapshot = this.snapshotOf(options);
    const view = (set: RouteSet): Swap2Route[] =>
      set.quotes.flatMap((q) => {
        const quote = this.routeQuote(q, snapshot);
        return quote ? [{provider: q.provider, quote, netValueUsd: q.netValueUsd, relativeValue: q.relativeValue, tags: [...q.tags]}] : [];
      });
    const set = await this.router.getQuotes(this.toParams(snapshot, true), opts?.onUpdate
      ? {onUpdate: (partial) => opts.onUpdate!(view(partial), partial.pending)}
      : undefined);
    return set ? view(set) : [];
  }

  /** This protocol pinned to one provider — the route a user picked from `quoteSwap2Routes`. */
  using(provider: string): RouterSwap2Protocol {
    const {providers: _p, router: _r, ...rest} = this.routerConfig;
    return new RouterSwap2Protocol(this.account, {...rest, router: this.router.only(provider)});
  }

  protected override noRouteDetail(): string {
    return this.router.lastRejections.join("; ").slice(0, 400);
  }

  protected providerFor(name: string): CrossChainProvider | undefined {
    return this.router.getProvider(name);
  }

  /** Delegates to every provider the router holds (first match wins); null with no providers. */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return this.router.describeActivity(tx, ctx);
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
