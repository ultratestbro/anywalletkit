import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import {BaseSwap2Protocol} from "./base.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../types.js";
import {refusalInfo, refusalOf, type Swap2Refusal, type Swap2RefusalInfo, type Swap2RefusalReason} from "../errors.js";
import {quoteRejection, remotePinRefusal} from "../validate.js";

/** A single-provider swap2: quoting/tracking route through one solver. The
 *  per-provider packages subclass this — the contribution unit shape. */
export abstract class SingleProviderSwap2 extends BaseSwap2Protocol {
  protected abstract readonly provider: CrossChainProvider;
  /**
   * Why a resolveQuote came back empty — the provider's own text, like the router's, and the same refusal classified —
   * per call (keyed by the params it was given), so overlapping quotes on one instance never read each other's.
   */
  private readonly outcomes = new WeakMap<QuoteParams, {text: string; refusals: Swap2Refusal[]}>();
  /** The latest call's outcome, for a subclass that asks without naming the call. */
  private latest: {text: string; refusals: Swap2Refusal[]} = {text: "", refusals: []};
  protected async resolveQuote(params: QuoteParams): Promise<Quote | null> {
    const outcome: {text: string; refusals: Swap2Refusal[]} = {text: "", refusals: []};
    this.outcomes.set(params, outcome);
    this.latest = outcome;
    const name = this.provider.name;
    const outer = params.onRefusal;
    // The provider's classification is normalized, and the venue's own text and name are written last: an adapter
    // can neither smuggle a value outside the reasons nor put its refusal under another venue's name.
    const note = (text: string, info: unknown) => {
      if (outcome.text) return;
      outcome.text = text;
      outcome.refusals = [{...refusalInfo(info), message: text.slice(0, 400), provider: name}];
    };
    const silent = (message: string, reason: Swap2RefusalReason): null => {
      outcome.refusals = [{reason, message, provider: name}];
      return null;
    };
    const snapshot = Object.freeze({...params, onRefusal: (reason: string, info?: Swap2RefusalInfo) => {
      note(reason.startsWith(`${name}:`) ? reason : `${name}: ${reason}`, info);
      try { outer?.(reason, refusalInfo(info)); } catch { /* diagnostics only */ }
    }});
    const from = Object.freeze({chain: snapshot.sourceChain, token: snapshot.sourceToken});
    const to = Object.freeze({chain: snapshot.destChain, token: snapshot.destToken});
    try {
      // Standalone contribution classes must enforce the same dark flag,
      // capability and quote-integrity boundary as the aggregator. Previously
      // they called getQuote directly, so `enabled: false` was advisory only.
      // These sit out without a text (the no-route message is unchanged); only the classified list says why.
      if (!this.provider.enabled()) return silent(`${name}: disabled`, "policy_refused");
      if (!this.provider.supportsRoute(from, to)) return silent(`${name}: does not serve this route`, "unsupported_pair");
      if (snapshot.sourceChain === snapshot.destChain && this.provider.supportsSameChain !== true) {
        return silent(`${name}: does not serve same-chain swaps`, "unsupported_pair");
      }
      const quote = await this.provider.getQuote(snapshot);
      if (!quote) {
        if (!outcome.text) outcome.refusals = [{reason: "no_route", message: `${name}: returned no quote`, provider: name}];
        return null;
      }
      const rejected = quoteRejection(quote, snapshot, name);
      if (rejected) {
        note(`${name}: rejected by validation (minDest=${quote.minDestAmount} vs floor=${snapshot.minAmountOut ?? "-"})`, rejected);
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
  protected override noRouteDetail(params?: QuoteParams): string {
    return ((params && this.outcomes.get(params)) ?? this.latest).text.slice(0, 400);
  }
  protected override noRouteRefusals(params?: QuoteParams): readonly Swap2Refusal[] {
    return ((params && this.outcomes.get(params)) ?? this.latest).refusals;
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
