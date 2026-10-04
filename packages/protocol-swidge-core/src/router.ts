import type {
  CrossChainProvider,
  IntentRef,
  IntentStatus,
  Quote,
  QuoteParams,
  RoutedQuote,
  ScoreWeights,
} from "./types.js";

const DEFAULT_WEIGHTS: ScoreWeights = {price: 0.6, speed: 0.3, reliability: 0.1};
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

/** Shared quote validator used by both the aggregate and single-provider paths. */
export function validQuote(q: Quote, params: QuoteParams, provider: string): boolean {
  try {
    if (q.provider !== provider || q.sourceAmount !== params.amountIn) return false;
    if (typeof q.intentId !== "string" || !q.intentId || typeof q.depositAddress !== "string" || (q.depositMemo !== null && typeof q.depositMemo !== "string")) return false;
    if (![q.sourceAmount, q.destAmount, q.minDestAmount].every((value) => /^[0-9]+$/.test(value))) return false;
    const source = BigInt(q.sourceAmount);
    const dest = BigInt(q.destAmount);
    const min = BigInt(q.minDestAmount);
    if (source <= 0n || dest <= 0n || min <= 0n || min > dest) return false;
    if (params.minAmountOut !== undefined) {
      if (!/^[0-9]+$/.test(params.minAmountOut) || BigInt(params.minAmountOut) <= 0n || min < BigInt(params.minAmountOut)) return false;
    }
    if (params.slippageBps !== undefined) {
      if (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps >= 10_000) return false;
      const required = (dest * BigInt(10_000 - params.slippageBps) + 9_999n) / 10_000n;
      if (min < required) return false;
    }
    if (!Number.isFinite(q.etaSeconds) || q.etaSeconds < 0) return false;
    if (!Number.isFinite(q.reliability) || q.reliability < 0 || q.reliability > 1) return false;
    if (!Number.isFinite(q.feeUsd) || q.feeUsd < 0) return false;
    if (q.fees && (!Array.isArray(q.fees) || !q.fees.every((fee) =>
      ["network", "protocol", "affiliate", "other"].includes(fee.type) &&
      /^[0-9]+$/.test(fee.amount) &&
      typeof fee.token === "string" && fee.token.length > 0 &&
      typeof fee.included === "boolean" &&
      (fee.description === undefined || typeof fee.description === "string")
    ))) return false;
    if (q.providerData && (Array.isArray(q.providerData) || typeof q.providerData !== "object" || !Object.values(q.providerData).every((value) => typeof value === "string"))) return false;
    const tx = q.txRequest;
    if (tx) {
      if (tx.value !== undefined && !/^[0-9]+$/.test(tx.value)) return false;
      if (tx.gasLimit !== undefined && !/^[0-9]+$/.test(tx.gasLimit)) return false;
      if (tx.chainId !== undefined && (!Number.isSafeInteger(tx.chainId) || tx.chainId <= 0)) return false;
      if ([tx.to, tx.data, tx.approvalAddress, tx.serializedTx].some((value) => value !== undefined && typeof value !== "string")) return false;
    }
    // Execution is always re-quoted. An unknown/zero expiry cannot prove that
    // the transaction is still safe to sign, so contribution packages reject it.
    if (!Number.isFinite(q.validUntilMs) || q.validUntilMs <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
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
  get lastRejections(): readonly string[] {
    return this._lastRejections;
  }
  private readonly weights: ScoreWeights;

  constructor(providers: CrossChainProvider[], weightsSpec?: string) {
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
      ...(provider.close ? {close: provider.close.bind(provider)} : {}),
      ...(provider.supportsChain ? {supportsChain: provider.supportsChain.bind(provider)} : {}),
      ...(provider.supportsChainPair ? {supportsChainPair: provider.supportsChainPair.bind(provider)} : {}),
      ...(provider.supportsSameChain !== undefined ? {supportsSameChain: provider.supportsSameChain} : {}),
    }));
    this.weights = parseWeights(weightsSpec);
  }

  getProvider(name: string): CrossChainProvider | undefined {
    return this.providers.find((p) => p.name === name);
  }

  hasProvider(name: string): boolean {
    return this.providers.some((p) => p.name === name);
  }

  hasEnabledProvider(name: string): boolean {
    return this.providers.some((p) => {
      try { return p.name === name && p.enabled(); } catch { return false; }
    });
  }

  supportsChain(caip2: string): boolean {
    return this.providers.some((p) => {
      try { return p.enabled() && !!p.supportsChain?.(caip2); } catch { return false; }
    });
  }

  supportsChainPair(fromChain: string, toChain: string): boolean {
    return this.providers.some((p) => {
      try {
        return p.enabled() && (p.supportsChainPair?.(fromChain, toChain) ?? false);
      } catch { return false; }
    });
  }

  async getBestQuote(
    params: QuoteParams,
    options?: {requireImmediateExecution?: boolean},
  ): Promise<RoutedQuote | null> {
    // A public engine caller — or one provider running in the same auction —
    // must not be able to rewrite another provider's request while async quote
    // work is in flight. QuoteParams is intentionally flat, so a frozen copy is
    // a complete execution snapshot.
    this._lastRejections = [];
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
    const settled = await Promise.all(eligible.map(async (p) => {
      const controller = new AbortController();
      try {
        const result = await withTimeout(p.getQuote(snapshot, controller.signal), timeoutMs);
        return result;
      } catch (err) {
        // A failed venue sitting out silently is indistinguishable from "no
        // route" — record why (surfaced through lastRejections) and say it in
        // the console (same posture as onModuleSkipped).
        const reason = `${p.name}: ${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`;
        this._lastRejections.push(reason);
        console.warn(`swidge-router: quote failed — ${reason}`);
        return null;
      }
      finally { controller.abort(); }
    }));
    // Provider identity is an execution security boundary. Never trust the
    // provider field returned by an untrusted adapter; bind it to its slot.
    let quotes = settled
      .map((q, i) => {
        if (!q) {
          // A provider RETURNING null (vs throwing) was the one silent path
          // left — record it so the surfaced no-route error names the venue.
          this._lastRejections.push(`${eligible[i]!.name}: returned no quote`);
          return null;
        }
        if (!validQuote(q, snapshot, eligible[i]!.name)) {
          const reason = `${eligible[i]!.name}: rejected by validation (minDest=${q.minDestAmount} vs floor=${snapshot.minAmountOut ?? "-"}, validUntil=${q.validUntilMs}, now=${Date.now()})`;
          this._lastRejections.push(reason);
          console.warn(`swidge-router: ${reason}`);
          return null;
        }
        return {...q, provider: eligible[i]!.name};
      })
      .filter((q): q is Quote => q !== null);
    // Legacy deposit-address screens cannot execute order-based quotes that
    // require a separate build/sign/register lifecycle. Keep their preview and
    // live selection on providers that are immediately executable as returned.
    if (options?.requireImmediateExecution) {
      quotes = quotes.filter((q) => q.depositAddress.length > 0 || q.txRequest !== undefined);
    }
    if (quotes.length === 0) return null;

    return this.score(quotes);
  }

  async trackIntent(providerName: string, ref: IntentRef): Promise<IntentStatus> {
    const provider = this.getProvider(providerName);
    if (!provider) return {state: "failed"};
    return provider.trackIntent(ref);
  }

  /** Forward a source-broadcast notification to the intent's provider. */
  async notifyDeposit(providerName: string, intentId: string, txHash: string): Promise<void> {
    await this.getProvider(providerName)?.notifyDeposit?.(intentId, txHash);
  }

  close(): void {
    for (const provider of this.providers) provider.close?.();
  }

  private score(quotes: Quote[]): RoutedQuote {
    // Exact-in: every candidate spends the same source amount, so price
    // quality = how much lands on the destination.
    // Optimize the guaranteed delivery, not an optimistic nominal amount.
    const dests = quotes.map((q) => BigInt(q.minDestAmount));
    const minDst = dests.reduce((a, b) => (b < a ? b : a));
    const maxDst = dests.reduce((a, b) => (b > a ? b : a));
    const etas = quotes.map((q) => q.etaSeconds);
    const minEta = Math.min(...etas);
    const maxEta = Math.max(...etas);

    const w = this.weights;
    const scored = quotes.map((q) => {
      const dst = BigInt(q.minDestAmount);
      // more delivered = higher price score
      const priceScore = maxDst === minDst ? 1 : fraction(dst - minDst, maxDst - minDst);
      const speedScore = maxEta === minEta ? 1 : (maxEta - q.etaSeconds) / (maxEta - minEta);
      const score = w.price * priceScore + w.speed * speedScore + w.reliability * q.reliability;
      return {quote: q, score};
    });
    scored.sort((a, b) => b.score - a.score);

    const best = scored[0]!;
    return {
      ...best.quote,
      routeScore: {
        score: best.score,
        weights: w,
        candidates: scored.map((s) => ({
          provider: s.quote.provider,
          sourceAmount: s.quote.sourceAmount,
          etaSeconds: s.quote.etaSeconds,
          score: s.score,
        })),
      },
    };
  }
}

/** Ratio of two non-negative bigints as a 0..1 number. */
function fraction(num: bigint, den: bigint): number {
  if (den === 0n) return 1;
  // scale to keep precision, then to float
  return Number((num * 10_000n) / den) / 10_000;
}
