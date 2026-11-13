import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {BaseSwap2Protocol} from "./base.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../types.js";
import {refusalOf, type Swap2Refusal, type Swap2RefusalInfo} from "../errors.js";
import {remotePinRefusal, validQuote} from "../validate.js";

/** A single-provider swap2: quoting/tracking route through one solver. The
 *  per-provider packages subclass this — the contribution unit shape. */
export abstract class SingleProviderSwap2 extends BaseSwap2Protocol {
  protected abstract readonly provider: CrossChainProvider;
  /** Why the last resolveQuote came back empty — the provider's own reason, like the router's. */
  private lastRefusal = "";
  /** The same refusal, classified where the provider could; a venue that sat out without a text still says why here. */
  private lastRefusals: Swap2Refusal[] = [];
  protected async resolveQuote(params: QuoteParams): Promise<Quote | null> {
    this.lastRefusal = "";
    this.lastRefusals = [];
    const name = this.provider.name;
    const outer = params.onRefusal;
    const note = (text: string, info: Swap2RefusalInfo | undefined) => {
      if (this.lastRefusal) return;
      this.lastRefusal = text;
      this.lastRefusals = [{message: text.slice(0, 400), provider: name, ...info}];
    };
    const snapshot = Object.freeze({...params, onRefusal: (reason: string, info?: Swap2RefusalInfo) => {
      note(reason.startsWith(`${name}:`) ? reason : `${name}: ${reason}`, info);
      try { outer?.(reason, info); } catch { /* diagnostics only */ }
    }});
    const from = Object.freeze({chain: snapshot.sourceChain, token: snapshot.sourceToken});
    const to = Object.freeze({chain: snapshot.destChain, token: snapshot.destToken});
    try {
      // Standalone contribution classes must enforce the same dark flag,
      // capability and quote-integrity boundary as the aggregator. Previously
      // they called getQuote directly, so `enabled: false` was advisory only.
      // These sit out without a text (the no-route message is unchanged); only the classified list says why.
      if (!this.provider.enabled()) return this.silent(`${name}: disabled`, "policy_refused");
      if (!this.provider.supportsRoute(from, to)) return this.silent(`${name}: does not serve this route`, "unsupported_pair");
      if (snapshot.sourceChain === snapshot.destChain && this.provider.supportsSameChain !== true) {
        return this.silent(`${name}: does not serve same-chain swaps`, "unsupported_pair");
      }
      const quote = await this.provider.getQuote(snapshot);
      if (!quote) {
        if (!this.lastRefusal) this.lastRefusals = [{message: `${name}: returned no quote`, provider: name, reason: "no_route"}];
        return null;
      }
      if (!validQuote(quote, snapshot, name)) {
        note(`${name}: rejected by validation (minDest=${quote.minDestAmount} vs floor=${snapshot.minAmountOut ?? "-"})`, {reason: "price_check_failed"});
        return null;
      }
      const unpinned = remotePinRefusal(this.provider, quote, snapshot.sourceChain);
      if (unpinned) {
        note(unpinned, {reason: "policy_refused"});
        return null;
      }
      return {...quote, provider: name};
    } catch (err) {
      note(`${name}: ${(err instanceof Error ? err.message : String(err)).slice(0, 160)}`, refusalOf(err));
      return null;
    }
  }
  private silent(message: string, reason: Swap2RefusalInfo["reason"]): null {
    this.lastRefusals = [{message, provider: this.provider.name, reason}];
    return null;
  }
  protected override noRouteDetail(): string {
    return this.lastRefusal.slice(0, 400);
  }
  protected override noRouteRefusals(): readonly Swap2Refusal[] {
    return this.lastRefusals;
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
