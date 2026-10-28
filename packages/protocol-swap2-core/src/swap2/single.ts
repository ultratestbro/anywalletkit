import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {BaseSwap2Protocol} from "./base.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../types.js";
import {remotePinRefusal, validQuote} from "../validate.js";

/** A single-provider swap2: quoting/tracking route through one solver. The
 *  per-provider packages subclass this — the contribution unit shape. */
export abstract class SingleProviderSwap2 extends BaseSwap2Protocol {
  protected abstract readonly provider: CrossChainProvider;
  /** Why the last resolveQuote came back empty — the provider's own reason, like the router's. */
  private lastRefusal = "";
  protected async resolveQuote(params: QuoteParams): Promise<Quote | null> {
    this.lastRefusal = "";
    const name = this.provider.name;
    const outer = params.onRefusal;
    const snapshot = Object.freeze({...params, onRefusal: (reason: string) => {
      this.lastRefusal ||= reason.startsWith(`${name}:`) ? reason : `${name}: ${reason}`;
      try { outer?.(reason); } catch { /* diagnostics only */ }
    }});
    const from = Object.freeze({chain: snapshot.sourceChain, token: snapshot.sourceToken});
    const to = Object.freeze({chain: snapshot.destChain, token: snapshot.destToken});
    try {
      // Standalone contribution classes must enforce the same dark flag,
      // capability and quote-integrity boundary as the aggregator. Previously
      // they called getQuote directly, so `enabled: false` was advisory only.
      if (!this.provider.enabled() || !this.provider.supportsRoute(from, to)) return null;
      if (snapshot.sourceChain === snapshot.destChain && this.provider.supportsSameChain !== true) return null;
      const quote = await this.provider.getQuote(snapshot);
      if (!quote) return null;
      if (!validQuote(quote, snapshot, name)) {
        this.lastRefusal ||= `${name}: rejected by validation (minDest=${quote.minDestAmount} vs floor=${snapshot.minAmountOut ?? "-"})`;
        return null;
      }
      const unpinned = remotePinRefusal(this.provider, quote, snapshot.sourceChain);
      if (unpinned) {
        this.lastRefusal ||= unpinned;
        return null;
      }
      return {...quote, provider: name};
    } catch (err) {
      this.lastRefusal ||= `${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`;
      return null;
    }
  }
  protected override noRouteDetail(): string {
    return this.lastRefusal.slice(0, 400);
  }
  protected providerFor(name: string): CrossChainProvider | undefined {
    return name === this.provider.name ? this.provider : undefined;
  }
  /** Activity recognition lives on the provider (shared with the router); null when it has none. */
  override describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    return this.provider.describeActivity?.(tx, ctx) ?? null;
  }
  protected override protocolEnabled(): boolean {
    try { return this.provider.enabled(); } catch { return false; }
  }
  close(): void {
    this.provider.close?.();
  }
}
