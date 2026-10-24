/**
 * The auction engine of the optional aggregator: routes a cross-chain delivery
 * over whichever providers the caller installed and passed in. Protocol
 * modules never need it — each one runs standalone on @anywalletkit/protocol-swap2-core.
 */
import type {
  CrossChainProvider,
  IntentRef,
  IntentStatus,
  Quote,
  QuoteParams,
  RoutedQuote,
  ScoreWeights,
} from "@anywalletkit/protocol-swap2-core/types";
import {validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";

const DEFAULT_WEIGHTS: ScoreWeights = {price: 0.6, speed: 0.3, reliability: 0.1};
/** Quotes within 0.2% of the best net value count as the same price. */
const DEFAULT_TIE_BAND = 0.002;

export interface RouterOptions {
  /**
   * "price:0.6,speed:0.3,reliability:0.1" — how quotes inside the tie band
   * (same price, within `tieBand`) are ordered. Price itself always leads.
   */
  weights?: string;
  /**
   * What a quote is worth to the user in USD: its guaranteed output minus what
   * the route charges on top (a native bridge fee, the source gas). Return null
   * when it cannot be priced — the auction then compares guaranteed outputs.
   * `usdValue(prices)` builds one from a symbol → USD price map.
   */
  valueUsd?: (quote: Quote, params: QuoteParams) => number | null;
  /** Fraction of the best net value inside which quotes tie on price (default 0.002). */
  tieBand?: number;
}

/** A validated quote with its place in the auction. */
export interface RankedQuote extends Quote {
  /** Net USD value (`valueUsd`), or null when the auction compared raw outputs. */
  netValueUsd: number | null;
  /** This quote's value against the best one, 0..1 (1 = the best price). */
  relativeValue: number;
  /** "best": the pick (best price; faster/more reliable among equal prices). "fastest": the lowest ETA. */
  tags: ("best" | "fastest")[];
}

/** Every validated route for one request, ranked by value. */
export interface RouteSet {
  /** Every validated route, best first. */
  quotes: RankedQuote[];
  /** Most delivered value (net of fees when priced) within the tie band. */
  best: RankedQuote;
  /** Lowest ETA. */
  fastest: RankedQuote;
  /** Providers still quoting (only non-empty in progressive `onUpdate` snapshots). */
  pending: string[];
  /** Why the venues that sat out did (same as `lastRejections`). */
  rejections: string[];
}
// LI.FI's /quote routinely takes ~3.5s (it builds executable calldata) — 4s
// raced it out of every round. All providers still run in parallel.
const QUOTE_TIMEOUT_MS = 8000;
/** Pinned single-venue (execution) budget — see the comment at the call site. */
const SOLO_QUOTE_TIMEOUT_MS = 25_000;

function parseWeights(spec?: string): ScoreWeights {
  if (!spec) return DEFAULT_WEIGHTS;
  const w = {...DEFAULT_WEIGHTS};
  for (const part of spec.split(",")) {
    const [k, v] = part.split(":");
    const n = Number(v);
    if ((k === "price" || k === "speed" || k === "reliability") && Number.isFinite(n)) {
      w[k] = Math.max(0, n);
    }
  }
  return w;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    // Timeouts and failures must REJECT: the old `() => resolve(null)` arm
    // swallowed every provider error — including forwarded venue refusals —
    // into a null indistinguishable from "no route", which made execution
    // failures undiagnosable from the surface (the '(c2)' hunt of 2026-08-31).
    const timer = setTimeout(() => reject(new Error(`quote timed out after ${ms}ms`)), ms);
    p.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/**
 * Routes a cross-chain delivery over pluggable providers: queries all that
 * support the route in parallel (with a timeout so a slow provider can't block),
 * normalizes their quotes, scores by configurable weights, and returns the best
 * tagged with `routeScore`. A failed/slow provider simply doesn't participate.
 */
export class CrossChainRouter {
  private readonly providers: CrossChainProvider[];
  /** Why the venues of the LAST getBestQuote call sat out — for error surfaces. */
  private _lastRejections: string[] = [];
  /** Why providers sat out the last auction, one line each. */
  get lastRejections(): readonly string[] {
    return this._lastRejections;
  }
  private readonly weights: ScoreWeights;
  private readonly valueUsd: RouterOptions["valueUsd"];
  private readonly tieBand: number;
  private readonly options: RouterOptions;

  constructor(providers: CrossChainProvider[], options?: string | RouterOptions) {
    const opts: RouterOptions = typeof options === "string" ? {weights: options} : {...(options ?? {})};
    if (opts.tieBand !== undefined && !(Number.isFinite(opts.tieBand) && opts.tieBand >= 0 && opts.tieBand < 1)) {
      throw new Error("cross-chain router: tieBand must be a fraction in [0, 1)");
    }
    const names = new Set<string>();
    for (const provider of providers) {
      if (typeof provider.name !== "string" || !/^[A-Za-z0-9_-]+$/.test(provider.name) || names.has(provider.name)) {
        throw new Error(`cross-chain router: invalid or duplicate provider name '${String(provider.name)}'`);
      }
      names.add(provider.name);
    }
    // Snapshot the dispatch surface. A caller mutating provider.name or method
    // properties after construction must not redirect quote→build/status.
    this.providers = providers.map((provider) => ({
      name: provider.name,
      enabled: provider.enabled.bind(provider),
      supportsRoute: provider.supportsRoute.bind(provider),
      getQuote: provider.getQuote.bind(provider),
      buildDeposit: provider.buildDeposit.bind(provider),
      trackIntent: provider.trackIntent.bind(provider),
      ...(provider.preflightDeposit ? {preflightDeposit: provider.preflightDeposit.bind(provider)} : {}),
      ...(provider.notifyDeposit ? {notifyDeposit: provider.notifyDeposit.bind(provider)} : {}),
      ...(provider.registerSignedOrder ? {registerSignedOrder: provider.registerSignedOrder.bind(provider)} : {}),
      // Two-phase routes (CCTP): the destination claim. Missing here, the engine
      // and the server both reported "provider 'cctp' has no claim step" (2026-10-13).
      ...(provider.buildClaim ? {buildClaim: provider.buildClaim.bind(provider)} : {}),
      ...(provider.close ? {close: provider.close.bind(provider)} : {}),
      ...(provider.supportsChain ? {supportsChain: provider.supportsChain.bind(provider)} : {}),
      ...(provider.supportsChainPair ? {supportsChainPair: provider.supportsChainPair.bind(provider)} : {}),
      ...(provider.describeActivity ? {describeActivity: provider.describeActivity.bind(provider)} : {}),
      ...(provider.supportsSameChain !== undefined ? {supportsSameChain: provider.supportsSameChain} : {}),
    }));
    this.weights = parseWeights(opts.weights);
    this.valueUsd = opts.valueUsd;
    this.tieBand = opts.tieBand ?? DEFAULT_TIE_BAND;
    this.options = opts;
  }

  /** The same auction restricted to one provider — to execute the route a user picked. */
  only(name: string): CrossChainRouter {
    const provider = this.getProvider(name);
    if (!provider) throw new Error(`cross-chain router: provider '${name}' is not registered`);
    return new CrossChainRouter([provider], this.options);
  }

  /**
   * Activity recognition across the installed providers: the first one that
   * claims the transaction describes it. Null when none does (or none is held).
   */
  describeActivity(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null {
    for (const provider of this.providers) {
      const item = provider.describeActivity?.(tx, ctx);
      if (item) return item;
    }
    return null;
  }

  /** A provider by name. */
  getProvider(name: string): CrossChainProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  /** True when a provider of that name is installed. */
  hasProvider(name: string): boolean {
    return this.providers.some((p) => p.name === name);
  }

  /** True when that provider is installed and enabled. */
  hasEnabledProvider(name: string): boolean {
    return this.providers.some((p) => {
      try { return p.name === name && p.enabled(); } catch { return false; }
    });
  }

  /** True when any enabled provider declares the chain. */
  supportsChain(caip2: string): boolean {
    return this.providers.some((p) => {
      try { return p.enabled() && !!p.supportsChain?.(caip2); } catch { return false; }
    });
  }

  /** True when any enabled provider declares the chain pair. */
  supportsChainPair(fromChain: string, toChain: string): boolean {
    return this.providers.some((p) => {
      try {
        return p.enabled() && (p.supportsChainPair?.(fromChain, toChain) ?? false);
      } catch { return false; }
    });
  }

  /**
   * The auction's pick: the best price (net of native fees and gas when
   * `valueUsd` is set; faster, then more reliable, among equal prices), or
   * the fastest route with `prefer: "fastest"`.
   */
  async getBestQuote(
    params: QuoteParams,
    options?: {requireImmediateExecution?: boolean; prefer?: "best" | "fastest"},
  ): Promise<RoutedQuote | null> {
    const set = await this.getQuotes(params, options);
    if (!set) return null;
    const pick = options?.prefer === "fastest" ? set.fastest : set.best;
    const {netValueUsd: _n, relativeValue: _r, tags: _t, ...quote} = pick;
    return {
      ...quote,
      routeScore: {
        score: pick.relativeValue,
        weights: this.weights,
        candidates: set.quotes.map((q) => ({
          provider: q.provider,
          sourceAmount: q.sourceAmount,
          etaSeconds: q.etaSeconds,
          score: q.relativeValue,
          minDestAmount: q.minDestAmount,
          netValueUsd: q.netValueUsd,
        })),
      },
    };
  }

  /**
   * Every validated route, ranked — for a route picker that shows the best and
   * the fastest and lets the user choose. Providers run in parallel; with
   * `onUpdate` each one that answers re-publishes the ranked set at once (the
   * first price shows in the time of the fastest venue, not the slowest).
   */
  async getQuotes(
    params: QuoteParams,
    options?: {requireImmediateExecution?: boolean; onUpdate?: (set: RouteSet) => void},
  ): Promise<RouteSet | null> {
    // A public engine caller — or one provider running in the same auction —
    // must not be able to rewrite another provider's request while async quote
    // work is in flight. QuoteParams is intentionally flat, so a frozen copy is
    // a complete execution snapshot.
    const rejections: string[] = [];
    this._lastRejections = rejections;
    const snapshot = Object.freeze({...params});
    const from = Object.freeze({chain: snapshot.sourceChain, token: snapshot.sourceToken});
    const to = Object.freeze({chain: snapshot.destChain, token: snapshot.destToken});
    // Only enabled (validated) providers that can serve the route participate.
    let eligible = this.providers.filter((p) => {
      try { return p.enabled() && p.supportsRoute(from, to); } catch { return false; }
    });
    if (snapshot.sourceChain === snapshot.destChain) {
      eligible = eligible.filter((p) => p.supportsSameChain === true);
    }
    if (eligible.length === 0) return null;

    // The short timeout protects the AUCTION — one slow venue must not hold
    // the others hostage. With a single eligible provider (a pinned execution
    // re-quote) there is nobody to protect, and a live deposit-creating quote
    // legitimately takes longer than a dry one (serverless hop + upstream
    // retries) — starving it surfaced as a terminal "no route" on execution.
    const timeoutMs = eligible.length === 1 ? SOLO_QUOTE_TIMEOUT_MS : QUOTE_TIMEOUT_MS;
    // Each venue names its own refusal (per call, so concurrent quotes cannot race).
    const refusals: (string | undefined)[] = [];
    const accepted: Quote[] = [];
    const pending = new Set(eligible.map((p) => p.name));
    const publish = () => {
      if (!options?.onUpdate || accepted.length === 0) return;
      const set = this.rank(accepted, snapshot, [...pending], rejections);
      try { options.onUpdate(set); } catch { /* an observer must not break the auction */ }
    };
    await Promise.all(eligible.map(async (p, i) => {
      const controller = new AbortController();
      const own = Object.freeze({...snapshot, onRefusal: (reason: string) => {
        refusals[i] ??= reason.startsWith(`${p.name}:`) ? reason : `${p.name}: ${reason}`;
        try { snapshot.onRefusal?.(reason); } catch { /* diagnostics only */ }
      }});
      let q: Quote | null = null;
      try {
        q = await withTimeout(p.getQuote(own, controller.signal), timeoutMs);
        if (!q) {
          // A provider RETURNING null (vs throwing) was the one silent path
          // left — record it so the surfaced no-route error names the venue.
          rejections.push(refusals[i] ?? `${p.name}: returned no quote`);
        } else if (!validQuote(q, snapshot, p.name)) {
          const reason = `${p.name}: rejected by validation (minDest=${q.minDestAmount} vs floor=${snapshot.minAmountOut ?? "-"}, validUntil=${q.validUntilMs}, now=${Date.now()})`;
          rejections.push(reason);
          console.warn(`swap2-router: ${reason}`);
          q = null;
        } else if (options?.requireImmediateExecution && !(q.depositAddress.length > 0 || q.txRequest !== undefined)) {
          // Legacy deposit-address screens cannot execute order-based quotes that
          // require a separate build/sign/register lifecycle.
          q = null;
        }
      } catch (err) {
        // A failed venue sitting out silently is indistinguishable from "no
        // route" — record why (surfaced through lastRejections) and say it in
        // the console (same posture as onModuleSkipped).
        const reason = `${p.name}: ${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`;
        rejections.push(reason);
        console.warn(`swap2-router: quote failed — ${reason}`);
        q = null;
      } finally {
        controller.abort();
      }
      pending.delete(p.name);
      // Provider identity is an execution security boundary. Never trust the
      // provider field returned by an untrusted adapter; bind it to its slot.
      if (q) accepted.push({...q, provider: p.name});
      publish();
    }));
    if (accepted.length === 0) return null;
    return this.rank(accepted, snapshot, [], rejections);
  }

  /** Status from the named provider; `failed` when it is not installed. */
  async trackIntent(providerName: string, ref: IntentRef): Promise<IntentStatus> {
    const provider = this.getProvider(providerName);
    if (!provider) return {state: "failed"};
    return provider.trackIntent(ref);
  }

  /** Forward a source-broadcast notification to the intent's provider. */
  async notifyDeposit(providerName: string, intentId: string, txHash: string): Promise<void> {
    await this.getProvider(providerName)?.notifyDeposit?.(intentId, txHash);
  }

  /** Release every provider's resources. */
  close(): void {
    for (const provider of this.providers) provider.close?.();
  }

  /**
   * Price first: each quote's value is its net USD (`valueUsd`) — or, when any
   * quote cannot be priced, its guaranteed output — against the best one.
   * Quotes within `tieBand` of the best are the same price; among those the
   * weights order speed and reliability. A $0.01 edge no longer beats a route
   * that lands in seconds instead of twenty minutes, and a route that charges
   * a native bridge fee on top no longer wins on its gross output.
   */
  private rank(quotes: Quote[], params: QuoteParams, pending: string[], rejections: string[]): RouteSet {
    const usd = this.valueUsd ? quotes.map((q) => {
      try {
        const v = this.valueUsd!(q, params);
        return typeof v === "number" && Number.isFinite(v) ? v : null;
      } catch { return null; }
    }) : quotes.map(() => null);
    const priced = usd.every((v) => v !== null);
    let relative: number[];
    if (priced) {
      const values = usd as number[];
      const max = Math.max(...values);
      relative = values.map((v) => (max > 0 ? Math.max(0, v) / max : v >= max ? 1 : 0));
    } else {
      const outs = quotes.map((q) => BigInt(q.minDestAmount));
      const max = outs.reduce((a, b) => (b > a ? b : a));
      relative = outs.map((o) => fraction(o, max));
    }
    const ranked: RankedQuote[] = quotes.map((q, i) => ({
      ...q,
      netValueUsd: priced ? usd[i]! : null,
      relativeValue: relative[i]!,
      tags: [],
    }));

    const tier = ranked.filter((q) => q.relativeValue >= 1 - this.tieBand - 1e-12);
    const etas = tier.map((q) => q.etaSeconds);
    const minEta = Math.min(...etas);
    const maxEta = Math.max(...etas);
    const w = this.weights;
    const tieScore = (q: RankedQuote) =>
      w.price * q.relativeValue +
      w.speed * (maxEta === minEta ? 1 : (maxEta - q.etaSeconds) / (maxEta - minEta)) +
      w.reliability * q.reliability;
    const best = tier.reduce((a, b) => (tieScore(b) > tieScore(a) ? b : a));
    const fastest = ranked.reduce((a, b) =>
      b.etaSeconds < a.etaSeconds || (b.etaSeconds === a.etaSeconds && b.relativeValue > a.relativeValue) ? b : a);
    best.tags.push("best");
    fastest.tags.push("fastest");

    // The list reads top-down by value; the pick leads its price tier.
    ranked.sort((a, b) => (a === best ? -1 : b === best ? 1 : b.relativeValue - a.relativeValue || a.etaSeconds - b.etaSeconds));
    return {quotes: ranked, best, fastest, pending, rejections: [...rejections]};
  }
}

/** Ratio of two non-negative bigints as a 0..1 number. */
function fraction(num: bigint, den: bigint): number {
  if (den === 0n) return 1;
  // scale to keep precision, then to float
  return Number((num * 10_000n) / den) / 10_000;
}
