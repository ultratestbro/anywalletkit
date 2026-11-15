/**
 * The app's side of Across when the V5 key stays on a server.
 *
 * `acrossRemoteProvider({baseUrl})` forwards quotes and builds to your backend (which runs `acrossProvider({apiKey})`
 * under `createSwap2Handler`) and checks, on the device, everything that comes back before the engine signs:
 *
 *  - `acrossPinsWith({maxFeeBps})` holds every deposit to the request the app itself sent — the pinned SpokePool as the
 *    only call target and spender, depositor = the signing account, recipient, tokens, amounts, destination, empty
 *    message, no exclusive relayer, deadlines, the app's fee cap and the per-asset fee floor — and the numbers the
 *    quote shows (its amounts, its fee list and `feeUsd`, which the engine's fee caps and the router's scoring read)
 *    to the deposit's own;
 *  - Across's keyless relayer fee (`/suggested-fees`), read by the app itself for every quote, dry or live: a deposit
 *    leaving relayers more than 10 % under it is refused ({@link acrossCheckRelayerFee}) — so a backend cannot get a
 *    deposit signed that relayers would leave unfilled for two hours, nor win the router's comparison with one;
 *  - right before signing, the build once more by the device's clock (a quote time the SpokePool no longer takes is
 *    refused before the backend is asked).
 *
 * The backend chooses only the output amount within those bounds; it cannot get a deposit signed for anyone else.
 * With `rpcUrls` the app also reads the deposit's status from the chains itself; without, it asks the backend.
 */
import {remoteProvider, type RemoteProviderOptions} from "@anywalletkit/protocol-swap2-core/remote";
import type {CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {describeAcrossActivity} from "./activity.js";
import {ACROSS_SUGGESTED_FEES_URL, acrossApiUrl, acrossHttp, acrossSuggestedFeesQuery, readAcrossSuggestedFees, type AcrossSuggestedFees} from "./api.js";
import {across as acrossCfg, type AcrossRoute} from "./config.js";
import {acrossCheckRelayerFee} from "./pricing.js";
import {acrossProvider, acrossServesRoute} from "./provider.js";
import {AcrossRefusal} from "./refusal.js";
import {acrossCheckBuild, acrossPinsRequestOf, acrossPinsWith, checkAcrossQuote, type AcrossPinsOptions, type AcrossRequest} from "./verify.js";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Quotes remembered for the preflight, most recent first out last (the engine signs the one it just quoted). */
const MAX_CHECKED = 64;

export interface AcrossRemoteOptions extends AcrossPinsOptions, Pick<RemoteProviderOptions, "baseUrl" | "enabled" | "fetchImpl" | "headers" | "timeoutMs" | "allowInsecureBaseUrl"> {
  /**
   * The app's own JSON-RPC URLs per CAIP-2 chain: with both chains of a deposit here, its status is read on the device
   * (the source receipt and the destination's `fillStatuses`), not asked of the backend.
   */
  rpcUrls?: Readonly<Record<string, string>> | undefined;
  /**
   * Across's keyless relayer-fee quote, read by the app for every quote the backend sends (default
   * `https://app.across.to/api/suggested-fees`, through `fetchImpl`; a browser app's CSP must allow it in
   * `connect-src`). Nothing secret is sent: the deposit's tokens, chains, amount and recipient. `null` turns the read
   * off: a route the pinned floor covers (Ethereum, Optimism, Base, Arbitrum to Optimism, Base, Arbitrum) is then held
   * to the per-asset floor alone — a backend could get a deposit signed that pays relayers too little to fill, which
   * waits for its deadline and the refund — and every other route is refused.
   */
  suggestedFeesUrl?: string | null | undefined;
}

/**
 * Across through your backend: `remoteProvider` with {@link acrossPinsWith} (the app's fee cap), the routes this
 * module prices, Across's relayer fee read on the device, and on-device status when `rpcUrls` names both chains.
 *
 * ```ts
 * const across = acrossRemoteProvider({baseUrl: "https://api.example.com/swap2", rpcUrls});
 * ```
 */
export function acrossRemoteProvider(options: AcrossRemoteOptions): CrossChainProvider {
  const cap = options.maxFeeBps !== undefined ? {maxFeeBps: options.maxFeeBps} : {};
  const pins = acrossPinsWith(cap);
  const feesUrl = options.suggestedFeesUrl === null ? null : acrossApiUrl(options.suggestedFeesUrl ?? ACROSS_SUGGESTED_FEES_URL, "suggestedFeesUrl");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inner = remoteProvider({
    name: "across",
    baseUrl: options.baseUrl,
    supportsChain: (chain) => acrossCfg.supportsChain(chain),
    supportsChainPair: (from, to) => acrossCfg.supports(from, to),
    supportsRoute: acrossServesRoute,
    ...pins,
    ...(options.enabled ? {enabled: options.enabled} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.headers ? {headers: options.headers} : {}),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
    ...(options.allowInsecureBaseUrl !== undefined ? {allowInsecureBaseUrl: options.allowInsecureBaseUrl} : {}),
  });
  const rpcUrls = options.rpcUrls;
  // Keyless: it never quotes, only reads the chains.
  const local = rpcUrls ? acrossProvider({rpcUrls, ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {})}) : undefined;
  const has = (caip2: string): boolean => !!rpcUrls && Object.prototype.hasOwnProperty.call(rpcUrls, caip2);

  // The quotes that passed this device's checks, with the request each answered: only those are preflighted.
  const checked = new Map<string, QuoteParams>();
  const remember = (intentId: string, params: QuoteParams): void => {
    checked.delete(intentId);
    checked.set(intentId, params);
    if (checked.size > MAX_CHECKED) checked.delete(checked.keys().next().value!);
  };

  /** Across's relayer fee for a deposit, read here; a failure is `unavailable`, never a throw (but the caller's own abort). */
  async function relayerFee(request: AcrossRequest, route: AcrossRoute, signal: AbortSignal | undefined): Promise<AcrossSuggestedFees> {
    if (feesUrl === null) return {kind: "unavailable", detail: "the app turned it off"};
    try {
      const a = await acrossHttp(`${feesUrl}?${acrossSuggestedFeesQuery(request, route)}`, {method: "GET", headers: {accept: "application/json"}}, {fetchImpl: options.fetchImpl, timeoutMs, signal, what: "Across's relayer fee quote"});
      return readAcrossSuggestedFees(request, route, a.status, a.body, Math.floor(Date.now() / 1000));
    } catch (err) {
      if (signal?.aborted) throw err;
      return {kind: "unavailable", detail: err instanceof Error ? err.message.replace(/^across: /, "") : "no answer"};
    }
  }

  return {
    ...inner,
    describeActivity: describeAcrossActivity,
    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      // The pins first (inside the remote stub): the deposit against the request, the numbers against the deposit.
      const quote = await inner.getQuote(params, signal);
      if (!quote) return quote;
      const request = acrossPinsRequestOf(params, cap);
      const v = checkAcrossQuote(request, quote);
      acrossCheckRelayerFee(v.route, request.amount, v.fee, await relayerFee(request, v.route, signal));
      remember(quote.intentId, params);
      return quote;
    },
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const params = checked.get(quote.intentId);
      if (!params) throw new AcrossRefusal("quote-shape", "the quote was not checked on this device — quote again", "policy_refused");
      // By the clock right before signing (an approval or a long review can outlast the quote time the SpokePool
      // takes), before the backend is asked.
      acrossCheckBuild(quote, tx, params, cap);
      await inner.preflightDeposit!(quote, tx);
    },
    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const m = /^across:([1-9]\d{0,15}):([1-9]\d{0,15}):/.exec(typeof ref.intentId === "string" ? ref.intentId : "");
      if (local && m && has(`eip155:${m[1]}`) && has(`eip155:${m[2]}`)) return local.trackIntent(ref);
      return inner.trackIntent(ref);
    },
  };
}
