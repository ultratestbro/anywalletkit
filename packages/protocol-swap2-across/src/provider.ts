import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {refusal, refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {describeAcrossActivity} from "./activity.js";
import {
  ACROSS_SUGGESTED_FEES_URL, acrossHttp, acrossSuggestedFeesQuery, acrossV5QuoteRequest, parseAcrossV5Error, readAcrossSuggestedFees, readAcrossV5Quote,
  type AcrossSuggestedFees,
} from "./api.js";
import {acrossQuoteOf, type NormalizedAcrossQuote} from "./build.js";
import {ACROSS_API, ACROSS_NATIVE, across as acrossCfg, acrossChain, acrossRouteOf, type AcrossRoute} from "./config.js";
import {ACROSS_FILL_WINDOW_S, acrossFloorFee, acrossPlainFee, acrossQuoteTimeOf, acrossRouteUnpriced} from "./pricing.js";
import {AcrossRefusal} from "./refusal.js";
import {acrossRpc, trackAcrossDeposit, type AcrossRpc} from "./status.js";
import {ACROSS_MAX_FEE_BPS_LIMIT, ACROSS_PLACEHOLDER, acrossRequestOf, checkAcrossQuote, checkAcrossTxShape, parseAcrossIntentId, type AcrossRequest} from "./verify.js";

/**
 * Across Protocol — an intent bridge. ONE source transaction: `deposit(...)` on the source chain's SpokePool, whose
 * arguments name the recipient, the output token and amount, the destination chain and the fill deadline; a relayer
 * pays the recipient on the destination from its own funds, or the deposit is refunded to the depositor on the source
 * chain after the deadline.
 *
 *  - The deposit is built HERE (`build.ts`) from the pins and the user's request; the quote source only supplies the
 *    numbers, and `verify.ts` holds every argument to the request again at build time and right before signing. An
 *    ERC-20 input sets `approvalAddress` to the pinned SpokePool and the engine approves exactly the input amount.
 *  - EVM → EVM, exact input, the same asset on both sides (USDC, USDT / USDT0, ETH / WETH, WBTC), empty message only.
 *    Periphery calls (origin swaps, `depositNative`), CCTP / OFT routes, destination actions, speed-up signatures and
 *    integrator fees are refused by name.
 *  - Pricing (`pricing.ts`): Across API V5 is the price source and `/suggested-fees` (keyless) what a relayer needs;
 *    the deposit leaves `max(V5's fee net of its origin step, the relayer need)`. V5's `nextActions` are never
 *    executed. The V5 key is server-only: under React Native an `apiKey` is refused — the app runs
 *    `acrossRemoteProvider` against a backend that runs this provider (`createSwap2Handler`).
 *  - Status is read on chain (`status.ts`): the intent's own deposit from the source receipt, its relay hash, the
 *    destination's `fillStatuses` — with an RPC URL per chain in `rpcUrls`. Unfilled past its fill deadline it is
 *    `expired` (Across refunds it). Display only, nothing is signed on its word.
 *  - The depositor is the signing account (`QuoteParams.sender`, set by the engine), never a `refundAddress` the caller
 *    names: an Across depositor can sign a speed-up that re-points the output, so a different refund address is refused.
 */

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_QUOTE_TTL_MS = 60_000;

export interface AcrossProviderConfig {
  /** Dark flag (the app convention is `ACROSS_ENABLED`). Default true; without an `apiKey` the provider is disabled anyway. */
  enabled?: boolean | undefined;
  /**
   * The Across API V5 key (dashboard.across.to) — server only; the app convention is `ACROSS_API_KEY`. Best as a
   * getter read on every request, so the key lives where you keep secrets; a string is accepted too. It is sent only
   * as the `Authorization: Bearer` header to `baseUrl`, never put in a URL, a refusal or a quote, and an answer that
   * came through a redirect is refused. Without one (or one that is not printable ASCII) the provider quotes nothing
   * and reports itself disabled — it still builds, verifies and tracks. Under React Native a key is refused outright
   * (the constructor throws): use `acrossRemoteProvider` in the app. Across's older integrator id and V4 key are not
   * used by this module.
   */
  apiKey?: string | (() => string | undefined) | undefined;
  /** V5 origin. Default `https://api.across.to`. Must be https (http only for localhost): the key rides on it. */
  baseUrl?: string | undefined;
  /**
   * Across's keyless relayer-fee quote (default {@link ACROSS_SUGGESTED_FEES_URL}); `null` turns it off and prices
   * every quote with the pinned floor (which needs `rpcUrls` for Ethereum and the source chain, for the quote time).
   */
  suggestedFeesUrl?: string | null | undefined;
  /**
   * JSON-RPC URLs per CAIP-2 chain: status (the source chain's to read the deposit, the destination's to read its
   * fill), and the quote time when `/suggested-fees` does not answer (Ethereum's and the source chain's latest block).
   */
  rpcUrls?: Readonly<Record<string, string>> | undefined;
  /** Fee cap in bps of the input that a deposit may leave to relayers (default 1000 = 10 %, at most 5000). */
  maxFeeBps?: number | undefined;
  /** Local lifetime of a quote (default 60 s, at most 5 min). */
  quoteTtlMs?: number | undefined;
  /** Per API request, ms (default 10 000). */
  timeoutMs?: number | undefined;
  /** Injectable for tests and for runtimes that bring their own. */
  fetchImpl?: typeof fetch | undefined;
}

/** The key for one request: printable ASCII without spaces, or nothing. A throwing getter is "no key". */
function readKey(source: AcrossProviderConfig["apiKey"]): string | undefined {
  let key: unknown = source;
  if (typeof source === "function") {
    try {
      key = source();
    } catch {
      return undefined;
    }
  }
  return typeof key === "string" && /^[\x21-\x7e]{1,256}$/.test(key) ? key : undefined;
}

/**
 * React Native (Hermes or JSC): an app bundle keeps no secret, and its fetch (OkHttp / NSURLSession) follows redirects
 * — carrying the key header along — whatever `redirect` says.
 */
function onReactNative(): boolean {
  const g = globalThis as {HermesInternal?: unknown; navigator?: {product?: unknown}};
  return g.HermesInternal !== undefined || g.navigator?.product === "ReactNative";
}

/** An API URL, refused unless https (or http on this machine). */
function apiUrl(url: string, what: string): string {
  const u = String(url).trim().replace(/\/+$/, "");
  if (/^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(u)) return u;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?(?:\/[^\s?#]*)?$/i.test(u)) return u;
  throw new Error(`across: ${what} must be an https:// URL (http only for localhost)`);
}

/**
 * Whether this module serves a route — the source a catalog symbol (or a contract), the destination an address (zero
 * for the native coin): pinned chains and tokens, the same asset, and a route the pricing covers (not Ethereum as the
 * destination). The local and the remote provider answer alike.
 */
export function acrossServesRoute(from: Asset, to: Asset): boolean {
  if (!acrossCfg.supports(from.chain, to.chain)) return false;
  let token: string;
  if (ADDRESS.test(from.token)) token = from.token;
  else {
    const asset = ccAsset(from.chain, from.token);
    if (!asset) return false;
    token = asset.contract ?? ACROSS_NATIVE;
  }
  const route = acrossRouteOf(from.chain, token, to.chain, to.token);
  return !("code" in route) && acrossRouteUnpriced(route) === null;
}

export function acrossProvider(config: AcrossProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  if (config.apiKey !== undefined && onReactNative()) {
    throw new Error("across: the Across API key belongs on a server — in a React Native app it would ship in the bundle, and React Native's fetch follows redirects with the key attached. Run acrossProvider({apiKey}) on your backend (createSwap2Handler) and acrossRemoteProvider({baseUrl}) in the app.");
  }
  const maxFeeBps = config.maxFeeBps;
  if (maxFeeBps !== undefined && (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > ACROSS_MAX_FEE_BPS_LIMIT)) {
    throw new Error(`across: maxFeeBps must be an integer between 0 and ${ACROSS_MAX_FEE_BPS_LIMIT}`);
  }
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 300_000) throw new Error("across: quoteTtlMs must be an integer between 1 and 300000");
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) throw new Error("across: timeoutMs must be an integer between 1 and 60000");
  const v5Url = `${apiUrl(config.baseUrl ?? ACROSS_API, "baseUrl")}/v1/quotes`;
  const feesUrl = config.suggestedFeesUrl === null ? null : apiUrl(config.suggestedFeesUrl ?? ACROSS_SUGGESTED_FEES_URL, "suggestedFeesUrl");
  const rpcUrls: Readonly<Record<string, string>> = Object.freeze(Object.assign(Object.create(null) as Record<string, string>, config.rpcUrls ?? {}));
  for (const [chain, url] of Object.entries(rpcUrls)) {
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) throw new Error(`across: the RPC URL for ${chain} must use http or https`);
  }
  const rpcFor = (caip2: string): AcrossRpc | undefined => (Object.prototype.hasOwnProperty.call(rpcUrls, caip2) ? acrossRpc(rpcUrls[caip2]!, config.fetchImpl) : undefined);

  /** The request a quote is checked against before a build or a signature: the one its `providerData` seals. */
  function requestOf(quote: Quote): AcrossRequest {
    const pd = quote.providerData ?? {};
    const sealed: AcrossRequest = {
      sourceChain: pd.sourceChain ?? "", destChain: pd.destChain ?? "", sourceToken: pd.sourceToken ?? "", destToken: pd.destToken ?? "",
      amount: /^[1-9]\d{0,77}$/.test(pd.amount ?? "") ? BigInt(pd.amount!) : 0n,
      depositor: pd.depositor ?? "", recipient: pd.recipient ?? "",
      ...(/^\d{1,78}$/.test(pd.minAmountOut ?? "") ? {minAmountOut: BigInt(pd.minAmountOut!)} : {}),
      ...(maxFeeBps !== undefined ? {maxFeeBps} : {}),
    };
    // A dry quote (pricing only) is never a deposit to sign, whatever addresses it was priced for.
    if (pd.placeholder === "1" || sealed.depositor.toLowerCase() === ACROSS_PLACEHOLDER.toLowerCase() || sealed.recipient.toLowerCase() === ACROSS_PLACEHOLDER.toLowerCase()) {
      throw new AcrossRefusal("request-invalid", "a quote priced for display (a dry quote) is never built or signed — quote again with the signing account", "policy_refused");
    }
    return sealed;
  }

  /** `/suggested-fees` for a request, read; a failure is `unavailable`, never a throw (but the caller's own abort). */
  async function suggestedFees(request: AcrossRequest, route: AcrossRoute, signal: AbortSignal | undefined): Promise<AcrossSuggestedFees> {
    if (feesUrl === null) return {kind: "unavailable", detail: "it is turned off"};
    try {
      const a = await acrossHttp(`${feesUrl}?${acrossSuggestedFeesQuery(request, route)}`, {method: "GET", headers: {accept: "application/json"}}, {fetchImpl: config.fetchImpl, timeoutMs, signal, what: "Across's relayer fee quote"});
      return readAcrossSuggestedFees(request, route, a.status, a.body, Math.floor(Date.now() / 1000));
    } catch (err) {
      if (signal?.aborted) throw err;
      return {kind: "unavailable", detail: err instanceof Error ? err.message.replace(/^across: /, "") : "no answer"};
    }
  }

  /** The quote time without `/suggested-fees`: from the chains' latest blocks over the configured RPCs. */
  async function quoteTimeFromChains(route: AcrossRoute): Promise<number> {
    const eth = rpcFor("eip155:1");
    const origin = rpcFor(route.input.chain.caip2);
    if (!eth || !origin) {
      throw new AcrossRefusal("relayer-price", "Across's relayer fee quote did not answer, and the quote time then needs rpcUrls for Ethereum and the source chain", "upstream_unavailable");
    }
    const timeOf = async (rpc: AcrossRpc): Promise<number> => {
      const block = (await rpc("eth_getBlockByNumber", ["latest", false])) as {timestamp?: unknown} | null;
      const t = typeof block?.timestamp === "string" && /^0x[0-9a-fA-F]{1,10}$/.test(block.timestamp) ? parseInt(block.timestamp, 16) : NaN;
      if (!Number.isInteger(t) || t <= 0) throw new Error("no block time");
      return t;
    };
    try {
      const [e, o] = await Promise.all([timeOf(eth), route.input.chain.chainId === 1 ? Promise.resolve(null) : timeOf(origin)]);
      return acrossQuoteTimeOf(e, o ?? e);
    } catch {
      throw new AcrossRefusal("relayer-price", "Across's relayer fee quote did not answer, and the chains' latest block times could not be read for the quote time", "upstream_unavailable");
    }
  }

  return {
    name: "across",
    describeActivity: describeAcrossActivity,
    enabled: () => (config.enabled ?? true) && readKey(config.apiKey) !== undefined,
    supportsChain: (chain: string) => acrossCfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => acrossCfg.supports(from, to),
    supportsRoute: (from: Asset, to: Asset) => acrossServesRoute(from, to),

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (reason: string, info?: Swap2RefusalInfo) => { params.onRefusal?.(reason, info); return null; };
      const dry = params.dry !== false;
      try {
        const request = acrossRequestOf(params, {
          ...(dry ? {placeholder: ACROSS_PLACEHOLDER} : {}),
          ...(maxFeeBps !== undefined ? {maxFeeBps} : {}),
        });
        const route = acrossRouteOf(request.sourceChain, request.sourceToken, request.destChain, request.destToken) as AcrossRoute;
        const key = readKey(config.apiKey);
        if (key === undefined) throw new AcrossRefusal("quote-unavailable", "no Across API key is configured — give the server's acrossProvider an apiKey, and run acrossRemoteProvider in the app", "key_rejected");

        const [v5, fees] = await Promise.all([
          acrossHttp(v5Url, {
            method: "POST",
            headers: {accept: "application/json", "content-type": "application/json", authorization: `Bearer ${key}`},
            body: JSON.stringify(acrossV5QuoteRequest(request)),
          }, {fetchImpl: config.fetchImpl, timeoutMs, signal, what: "Across API V5"}),
          suggestedFees(request, route, signal),
        ]);
        if (v5.status < 200 || v5.status >= 300) {
          const e = parseAcrossV5Error(v5.status, v5.body, v5.retryAfter);
          const bound = e.amountLimit?.amount ? ` (the amount must be ${e.amountLimit.side === "min" ? "at least" : "at most"} ${e.amountLimit.amount} base units)` : "";
          throw new AcrossRefusal("api-error", `Across API V5 answered HTTP ${e.status}${e.code ? ` ${e.code}` : ""}${bound}`, e.info?.reason);
        }
        const price = readAcrossV5Quote(request, route, v5.body);

        // What a relayer needs, and the quote time the deposit carries.
        if (fees.kind === "refused") throw new AcrossRefusal("relayer-price", fees.detail, fees.reason);
        let need: bigint;
        let quoteTimestamp: number;
        let etaSec: number;
        if (fees.kind === "fees") {
          need = fees.totalRelayFee;
          quoteTimestamp = fees.timestamp;
          etaSec = fees.estimatedFillTimeSec;
        } else {
          need = acrossFloorFee(route, request.amount, price.amountUsd, price.destinationGas);
          quoteTimestamp = await quoteTimeFromChains(route);
          etaSec = price.expectedFillTimeMs / 1000;
        }
        const fee = acrossPlainFee(request.amount, price, need);
        const nq: NormalizedAcrossQuote = {
          sourceChainId: route.input.chain.chainId,
          destinationChainId: route.output.chain.chainId,
          inputToken: request.sourceToken,
          outputToken: request.destToken,
          inputAmount: request.amount.toString(10),
          outputAmount: (request.amount - fee.fee).toString(10),
          quoteTimestamp,
          fillDeadline: quoteTimestamp + ACROSS_FILL_WINDOW_S,
          exclusiveRelayer: ACROSS_NATIVE,
          exclusivityParameter: 0,
          expectedFillTimeSec: etaSec,
          fees: {total: fee.fee.toString(10)},
        };
        const quote = acrossQuoteOf(request, nq, {quoteTtlMs, ...(dry ? {placeholder: true} : {})});
        // How the number was reached (display and support): the price source, V5's net fee, the relayer need.
        return {...quote, providerData: {...quote.providerData, priceSource: fees.kind === "fees" ? "suggested-fees" : "floor", v5Fee: fee.f5.toString(10), relayerFee: fee.need.toString(10)}};
      } catch (err) {
        if (err instanceof AcrossRefusal) return refuse(err.message, refusalOf(err));
        throw err;
      }
    },

    /** The quote's own transaction — after the deposit it carries has been verified once more. */
    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx || !parseAcrossIntentId(quote.intentId)) throw refusal("policy_refused", "swap2: Across quote has no transaction request");
      const request = requestOf(quote);
      const v = checkAcrossQuote(request, quote);
      return {
        chain: request.sourceChain,
        to: v.deposit.to,
        value: v.deposit.value,
        data: v.deposit.data,
        chainId: v.deposit.chainId,
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(v.deposit.approvalAddress ? {approvalAddress: v.deposit.approvalAddress} : {}),
      };
    },

    /** Right before signing: the whole verification again, against the request and the exact transaction about to be signed. */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const request = requestOf(quote);
      if (tx.chain !== request.sourceChain) throw new AcrossRefusal("tx-chain", `the deposit is for ${tx.chain}, not ${request.sourceChain}`, "vault_mismatch");
      checkAcrossTxShape(tx);
      checkAcrossQuote(request, quote, tx);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const intent = parseAcrossIntentId(ref.intentId);
      if (!intent) return {state: "failed"};
      const source = acrossChain(`eip155:${intent.sourceChainId}`);
      const dest = acrossChain(`eip155:${intent.destChainId}`);
      if (!source || !dest || source === dest) return {state: "failed"};
      // Nothing was sent yet.
      if (!ref.sourceTxHash) return {state: "pending"};
      const sourceRpc = rpcFor(source.caip2);
      const destRpc = rpcFor(dest.caip2);
      const t = await trackAcrossDeposit({sourceTxHash: ref.sourceTxHash, intentDigest: intent.digest, source, dest, ...(sourceRpc ? {sourceRpc} : {}), ...(destRpc ? {destRpc} : {})});
      return t.status;
    },
  };
}
