import {BaseSwap2Protocol} from "./base.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../types.js";
import {validQuote} from "../validate.js";

/** A single-provider swap2: quoting/tracking route through one solver. The
 *  per-provider packages subclass this — the contribution unit shape. */
export abstract class SingleProviderSwap2 extends BaseSwap2Protocol {
  protected abstract readonly provider: CrossChainProvider;
  protected async resolveQuote(params: QuoteParams): Promise<Quote | null> {
    const snapshot = Object.freeze({...params});
    const from = Object.freeze({chain: snapshot.sourceChain, token: snapshot.sourceToken});
    const to = Object.freeze({chain: snapshot.destChain, token: snapshot.destToken});
    try {
      // Standalone contribution classes must enforce the same dark flag,
      // capability and quote-integrity boundary as the aggregator. Previously
      // they called getQuote directly, so `enabled: false` was advisory only.
      if (!this.provider.enabled() || !this.provider.supportsRoute(from, to)) return null;
      if (snapshot.sourceChain === snapshot.destChain && this.provider.supportsSameChain !== true) return null;
      const quote = await this.provider.getQuote(snapshot);
      return quote && validQuote(quote, snapshot, this.provider.name)
        ? {...quote, provider: this.provider.name}
        : null;
    } catch {
      return null;
    }
  }
  protected providerFor(name: string): CrossChainProvider | undefined {
    return name === this.provider.name ? this.provider : undefined;
  }
  protected override protocolEnabled(): boolean {
    try { return this.provider.enabled(); } catch { return false; }
  }
  close(): void {
    this.provider.close?.();
  }
}
