import {getAddress, hashTypedData} from "viem";
import {bigintToNumber} from "@anywalletkit/core";
import {httpRefusal, refusal, refusalOf, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {anySignal, permit2TransferJson, readPermit2Transfer, sourceAssetOf, timeoutSignal, type Permit2Transfer} from "@anywalletkit/protocol-swap2-core/util";
import {slippageFloor} from "@anywalletkit/protocol-swap2-core/validate";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {describeZeroExActivity} from "./activity.js";
import {ZEROEX_NATIVE, ZEROEX_PERMIT2, zeroExChain, zeroExChainId, zeroExChains, type ZeroExChain} from "./chains.js";
import {rpcRequest, rpcUrlsFor, type RpcUrls} from "./rpc.js";
import {checkZeroExTransaction, createSettlerResolver, isZeroExNative, type SettlerResolver, type ZeroExExpectation} from "./settler.js";

/**
 * 0x Swap API v2 (docs.0x.org) as a same-chain swap2 provider, Permit2 flow: `/swap/permit2/price` for
 * indicative quotes, `/swap/permit2/quote` for the swap that is executed.
 *
 * The API needs a key on every request, so `zeroExProvider` with a key runs on your server only, and
 * `zeroExRemoteProvider` in the app: under React Native (Hermes or JSC) it refuses to be built with a
 * key at all — an app bundle keeps no secret, and React Native's fetch follows redirects with the key
 * header whatever `redirect` says. Whichever side quotes, nothing the API returns is signed as it
 * is: the Settler is read from the on-chain registry, the transaction is held to the request and the
 * Permit2 payload is rebuilt locally (see `settler.ts`); the engine then signs it as EIP-712 typed
 * data, appends the signature and estimates the signed call before broadcast. Every call goes out
 * with the account's own gas estimate (`ownGasEstimate`), never the quoted limit.
 *
 * Every refusal carries a `Swap2RefusalReason` next to its unchanged text (CS-13): HTTP 429 →
 * `rate_limited` (with Retry-After), 401/403 → `key_rejected`, 5xx or an unreachable / malformed
 * API → `upstream_unavailable`, no liquidity → `insufficient_liquidity`, a pair 0x does not serve →
 * `unsupported_pair`, a transaction or payload that fails the device's checks → `vault_mismatch` /
 * `recipient_mismatch` / `price_check_failed` / `policy_refused`. A malformed request is the
 * caller's own error and stays unclassified, and so does the caller's own abort.
 */

export const ZEROEX_PROVIDER = "zeroex";
export const ZEROEX_DEFAULT_BASE_URL = "https://api.0x.org";
const DEFAULT_SLIPPAGE_BPS = 50;
/** A firm 0x quote is priced at one block; the Settler enforces the minimum, the engine re-checks this TTL before broadcast. */
const DEFAULT_TTL_MS = 45_000;
const DEFAULT_TIMEOUT_MS = 10_000;
/** The Permit2 deadline must outlive the quote by this much, so a signature is never made seconds before it lapses. */
const DEADLINE_MARGIN_MS = 20_000;
const MAX_RESPONSE_CHARS = 600_000;

export interface ZeroExProviderConfig {
  enabled?: boolean | undefined;
  /**
   * The 0x API key — server only. Best as a getter, read on every request, so the key lives where you keep secrets
   * (server env, a vault) and never in this config object; a string is accepted too (an env value read once). It is
   * sent only as the `0x-api-key` header to `baseUrl`; it is never put in a URL, a refusal, an error or a quote, and an
   * answer that came through a redirect is refused. Without a key (or with one that is not printable ASCII without
   * spaces) the provider serves no route. Under React Native a key is refused outright (the constructor throws): use
   * `zeroExRemoteProvider` in the app.
   */
  apiKey?: string | (() => string | undefined) | undefined;
  /** API origin. Default {@link ZEROEX_DEFAULT_BASE_URL}. Must be https (http only for localhost), or the key would travel in clear. */
  baseUrl?: string | undefined;
  /** Chain table entries merged over the defaults (EVM chain id → entry, `null` removes a chain). */
  chains?: Readonly<Record<number, ZeroExChain | null>> | undefined;
  /** JSON-RPC endpoints per EVM chain id: the Settler registry read (needed for every executable quote) and receipts. */
  rpcUrls?: RpcUrls | undefined;
  /** Slippage when the request names none, bps. Default 50. */
  defaultSlippageBps?: number | undefined;
  quoteTtlMs?: number | undefined;
  timeoutMs?: number | undefined;
  /** Liquidity sources 0x must not route through (its `excludedSources` names). */
  excludedSources?: readonly string[] | undefined;
  /** How long a Settler registry read is reused, ms. Default 5 minutes. */
  settlerMaxAgeMs?: number | undefined;
  /** Share a resolver (e.g. with `zeroExRemoteProvider`); built from `chains` / `rpcUrls` when absent. */
  settlerResolver?: SettlerResolver | undefined;
}

/** 0x error names (`{name, message, data}` bodies) as the refusal a wallet shows, and its reason. Anything else is reported by HTTP status. */
const API_ERRORS: Readonly<Record<string, readonly [string, Swap2RefusalReason]>> = Object.freeze({
  INPUT_INVALID: ["0x rejected the request as invalid", "no_route"],
  SWAP_VALIDATION_FAILED: ["0x could not validate this swap", "no_route"],
  TOKEN_NOT_SUPPORTED: ["0x does not support one of these tokens", "unsupported_pair"],
  RECIPIENT_NOT_SUPPORTED: ["0x does not support a separate recipient for this swap", "unsupported_pair"],
  USER_NOT_AUTHORIZED: ["0x does not serve this account", "unsupported_pair"],
  TAKER_NOT_AUTHORIZED_FOR_TRADE: ["0x does not serve this account", "unsupported_pair"],
  RECIPIENT_NOT_AUTHORIZED_FOR_TRADE: ["0x does not serve this recipient", "unsupported_pair"],
  BUY_TOKEN_NOT_AUTHORIZED_FOR_TRADE: ["0x does not serve the token being bought", "unsupported_pair"],
  SELL_TOKEN_NOT_AUTHORIZED_FOR_TRADE: ["0x does not serve the token being sold", "unsupported_pair"],
  XSTOCKS_NOT_AUTHORIZED: ["0x does not serve this token for this account", "unsupported_pair"],
  INSUFFICIENT_ASSET_LIQUIDITY: ["0x has too little liquidity for this pair and amount", "insufficient_liquidity"],
  INTERNAL_SERVER_ERROR: ["0x had an internal error", "upstream_unavailable"],
  UNCATEGORIZED: ["0x could not quote this swap", "no_route"],
});

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);
const uint = (v: unknown): bigint | null => (typeof v === "string" && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : null);
const same = (a: string, b: string): boolean => a.length === b.length && a.toLowerCase() === b.toLowerCase();
const sameAmount = (a: string, b: string): boolean => /^[0-9]{1,78}$/.test(a) && /^[0-9]{1,78}$/.test(b) && BigInt(a) === BigInt(b);
const isAddress = (v: unknown): v is string => typeof v === "string" && ADDRESS.test(v);
/** How a fee token is named in a quote: `native` for the chain's coin, the checksummed address otherwise. */
const feeToken = (token: string): string => (isZeroExNative(token) ? "native" : getAddress(token));

/** The key for one request: printable ASCII without spaces, or nothing. A throwing getter is "no key". */
function readKey(source: ZeroExProviderConfig["apiKey"]): string | undefined {
  let key: unknown = source;
  if (typeof source === "function") {
    try {
      key = source();
    } catch {
      return undefined;
    }
  }
  return typeof key === "string" && /^[\x21-\x7e]{1,200}$/.test(key) ? key : undefined;
}

/**
 * React Native (Hermes or JSC): an app bundle keeps no secret, and its fetch (OkHttp / NSURLSession) follows redirects
 * — carrying the key header along — whatever `redirect` says.
 */
function onReactNative(): boolean {
  const g = globalThis as {HermesInternal?: unknown; navigator?: {product?: unknown}};
  return g.HermesInternal !== undefined || g.navigator?.product === "ReactNative";
}

/** `scheme://host[:port]` of a URL, lowercase; "" when it has none. No URL class: React Native's lacks `origin`. */
const originOf = (url: string): string => (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0] ?? "").toLowerCase();

/** The API origin, refused unless https (or http on this machine): the key rides on every request to it. */
function apiOrigin(baseUrl: string | undefined): string {
  const url = (baseUrl ?? ZEROEX_DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  if (/^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(url)) return url;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?(?:\/[^\s?#]*)?$/i.test(url)) return url;
  throw new Error("zeroex: baseUrl must be an https:// origin (http only for localhost) — the API key is sent to it");
}

type Fee = NonNullable<Quote["fees"]>[number];

/**
 * The fees of a 0x answer as quote fee entries, or the reason they cannot be read. Strict on purpose: a quote whose
 * fees do not parse is refused, never shown as free.
 *
 *  - `zeroExFee` (0x's on-chain fee, taken out of the trade; `buyAmount` is already net of it) → `protocol`, included.
 *  - `integratorFee` / `integratorFees` — this module asks for none, so anything above zero is refused.
 *  - `gasFee` (only gasless trades carry one) → `network`, included.
 *  - `totalNetworkFee` (wei the taker pays for gas; `gas × gasPrice` when 0x leaves it null) → `network`, not included.
 */
/** The one fee refusal that is a policy (an integrator fee nobody asked for); every other one is a quote that cannot be read. */
const UNASKED_INTEGRATOR_FEE = "the quote carries an integrator fee this wallet did not ask for";

export function zeroExFees(response: Record<string, unknown>, gas: {gas: unknown; gasPrice: unknown}): {fees: Fee[]; networkFeeKnown: boolean} | string {
  const fees = own(response, "fees");
  if (!plain(fees)) return "the quote's fees are missing";
  if (!Object.prototype.hasOwnProperty.call(fees, "zeroExFee")) return "the quote does not say what 0x charges";
  const out: Fee[] = [];
  const amountAndToken = (v: unknown): {amount: bigint; token: string} | null => {
    if (!plain(v)) return null;
    const amount = uint(own(v, "amount"));
    const token = own(v, "token");
    return amount !== null && isAddress(token) ? {amount, token} : null;
  };

  const zeroEx = own(fees, "zeroExFee");
  if (zeroEx !== null) {
    const fee = amountAndToken(zeroEx);
    if (!fee) return "the 0x fee cannot be read";
    if (fee.amount > 0n) out.push({type: "protocol", amount: fee.amount.toString(), token: feeToken(fee.token), included: true, description: "0x fee (taken on-chain, already out of the quoted amount)"});
  }

  const integrator = own(fees, "integratorFee");
  if (integrator !== null && integrator !== undefined) {
    const fee = amountAndToken(integrator);
    if (!fee) return "the integrator fee cannot be read";
    if (fee.amount > 0n) return UNASKED_INTEGRATOR_FEE;
  }
  const integrators = own(fees, "integratorFees");
  if (integrators !== null && integrators !== undefined) {
    if (!Array.isArray(integrators) || integrators.length > 16) return "the integrator fees cannot be read";
    for (const entry of integrators) {
      const fee = amountAndToken(entry);
      if (!fee) return "the integrator fees cannot be read";
      if (fee.amount > 0n) return UNASKED_INTEGRATOR_FEE;
    }
  }

  const gasFee = own(fees, "gasFee");
  if (gasFee !== null && gasFee !== undefined) {
    const fee = amountAndToken(gasFee);
    if (!fee) return "the gas fee cannot be read";
    if (fee.amount > 0n) out.push({type: "network", amount: fee.amount.toString(), token: feeToken(fee.token), included: true, description: "Gas charged by 0x inside the trade"});
  }

  const total = own(response, "totalNetworkFee");
  let network: bigint | null = null;
  if (total !== null && total !== undefined) {
    network = uint(total);
    if (network === null) return "the network fee cannot be read";
  } else if (gas.gas !== null && gas.gas !== undefined && gas.gasPrice !== null && gas.gasPrice !== undefined) {
    const units = uint(gas.gas);
    const price = uint(gas.gasPrice);
    if (units === null || price === null) return "the gas estimate cannot be read";
    network = units * price;
  }
  if (network !== null) out.push({type: "network", amount: network.toString(), token: "native", included: false, description: "Estimated network fee (gas × gas price, as 0x reports it)"});
  return {fees: out, networkFeeKnown: network !== null};
}

/** A tax in bps from `tokenMetadata`: a number or a decimal string; null when the API does not know it. */
function taxBps(v: unknown): number | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === "string" && /^[0-9]{1,6}$/.test(v)) return Number(v);
  return undefined;
}

let sequence = 0;

/** What {@link zeroExProvider} returns: a swap2 provider, plus the Settler resolver it reads through (for signing policies, `zeroExKnownSpenders`). */
export type ZeroExProvider = CrossChainProvider & {readonly ownGasEstimate: true; readonly settlerResolver: SettlerResolver};

export function zeroExProvider(config: ZeroExProviderConfig): ZeroExProvider {
  if (config.apiKey !== undefined && onReactNative()) {
    throw new Error("zeroex: the 0x API key belongs on a server — in a React Native app it would ship in the bundle, and React Native's fetch follows redirects with the key attached. Run zeroExProvider({apiKey}) on your backend (createSwap2Handler) and zeroExRemoteProvider({baseUrl, rpcUrls}) in the app.");
  }
  const baseUrl = apiOrigin(config.baseUrl);
  const apiOriginOnly = originOf(baseUrl);
  const chains = zeroExChains(config.chains);
  const slippageDefault = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const excluded = (config.excludedSources ?? []).filter((s) => typeof s === "string" && /^[A-Za-z0-9_.\- ]{1,60}$/.test(s));
  const resolver = config.settlerResolver ?? createSettlerResolver({chains, rpcUrls: config.rpcUrls, maxAgeMs: config.settlerMaxAgeMs});

  /** The chain id when the chain is in the table and a key is there to ask with. */
  const chainIdOf = (caip2: string): number | null => {
    const id = zeroExChainId(caip2);
    return zeroExChain(chains, id) && readKey(config.apiKey) !== undefined ? id : null;
  };
  const chainOfIntent = (intentId: string): number => {
    const id = Number(intentId.split(":")[1]);
    return zeroExChain(chains, id) ? id : NaN;
  };

  return {
    name: ZEROEX_PROVIDER,
    describeActivity: describeZeroExActivity,
    supportsSameChain: true,
    // The quoted gas limit is the API's word: a native sale (like a Permit2 call) goes out with the account's own estimate.
    ownGasEstimate: true,
    settlerResolver: resolver,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute: (from: Asset, to: Asset) => from.chain === to.chain && chainIdOf(from.chain) !== null,

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string, info?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        params.onRefusal?.(`zeroex: ${why}`, typeof info === "string" ? {reason: info} : info);
        return null;
      };
      /** A refusal raised by the checks (settler.ts, the core reader): its text without the prefix, and its reason. */
      const refuseError = (e: unknown, prefix: RegExp, fallback: string): null =>
        refuse(e instanceof Error ? e.message.replace(prefix, "") : fallback, refusalOf(e) ?? "policy_refused");
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only", "unsupported_pair");
      const chainId = zeroExChainId(params.sourceChain);
      const chain = zeroExChain(chains, chainId);
      if (!chain) return refuse(`0x is not configured for ${String(params.sourceChain).slice(0, 40)}`, "unsupported_pair");
      const key = readKey(config.apiKey);
      if (key === undefined) return refuse("no 0x API key is configured", "key_rejected");

      const src = sourceAssetOf(params);
      if (!src) return refuse(`unknown source token ${String(params.sourceToken).slice(0, 60)}`, "unsupported_pair");
      if (src.contract && !ADDRESS.test(src.contract)) return refuse("source token must be an EVM address");
      const sellToken = src.contract ? getAddress(src.contract) : ZEROEX_NATIVE;
      if (typeof params.destToken !== "string" || !ADDRESS.test(params.destToken)) return refuse("destination token must be an EVM address");
      const buyToken = isZeroExNative(params.destToken) ? ZEROEX_NATIVE : getAddress(params.destToken);
      const nativeSell = sellToken === ZEROEX_NATIVE;
      const nativeBuy = buyToken === ZEROEX_NATIVE;
      if (same(sellToken, buyToken)) return refuse("same token in and out", "unsupported_pair");
      if (chain.wrappedNative && ((nativeSell && same(buyToken, chain.wrappedNative)) || (nativeBuy && same(sellToken, chain.wrappedNative)))) {
        return refuse("wrapping and unwrapping are not 0x swaps", "unsupported_pair");
      }
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const bps = params.slippageBps ?? slippageDefault;
      if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) return refuse("invalid slippage");
      let floor: bigint | null = null;
      if (params.minAmountOut !== undefined) {
        floor = uint(params.minAmountOut);
        if (floor === null) return refuse("minimum output is not an integer");
      }

      const dry = params.dry !== false;
      let taker: string | undefined;
      let recipient: string | undefined;
      if (dry) {
        // An indicative price needs no account; with one, 0x can also report the balance and allowance it sees.
        const known = isAddress(params.refundAddress) ? params.refundAddress : isAddress(params.destAddress) ? params.destAddress : undefined;
        taker = known ? getAddress(known) : undefined;
      } else {
        if (!isAddress(params.destAddress)) return refuse("recipient must be an EVM address", "recipient_mismatch");
        recipient = getAddress(params.destAddress);
        taker = getAddress(isAddress(params.refundAddress) ? params.refundAddress : params.destAddress);
      }

      // The Settler comes from the chain before anything is asked of the API: no registry answer, no executable quote.
      let settlers: readonly string[] = [];
      if (!dry) {
        try {
          settlers = await resolver.resolve(chainId);
        } catch (e) {
          return refuseError(e, /^zeroex: /, "the 0x Settler cannot be resolved");
        }
      }

      const query: [string, string][] = [
        ["chainId", String(chainId)],
        ["sellToken", sellToken],
        ["buyToken", buyToken],
        ["sellAmount", amountIn.toString()],
        ["slippageBps", String(bps)],
      ];
      if (taker) query.push(["taker", taker]);
      if (recipient && taker && !same(recipient, taker)) query.push(["recipient", recipient]);
      if (excluded.length) query.push(["excludedSources", excluded.join(",")]);
      const url = `${baseUrl}/swap/permit2/${dry ? "price" : "quote"}?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")}`;

      let status: number;
      let text: string;
      let retryAfter: string | null = null;
      try {
        const timeout = timeoutSignal(timeoutMs);
        // The key rides in a header: a redirect (a misconfigured baseUrl, a compromised edge) must not carry it on.
        const res = await fetch(url, {method: "GET", redirect: "error", headers: {accept: "application/json", "0x-api-key": key, "0x-version": "v2"}, signal: signal ? anySignal([signal, timeout]) : timeout});
        // A fetch that ignores `redirect: "error"` (React Native's does): an answer that came through a redirect, or
        // from another origin than the configured one, is not used.
        if (res.redirected === true || (typeof res.url === "string" && res.url !== "" && originOf(res.url) !== apiOriginOnly)) {
          return refuse("the API answer came through a redirect or from another origin — refused (the key must not follow one)", "policy_refused");
        }
        status = res.status;
        retryAfter = res.headers?.get?.("retry-after") ?? null;
        text = await res.text();
      } catch (e) {
        // The caller's own abort is not the venue failing.
        return refuse(`API unreachable (${e instanceof Error ? e.name.slice(0, 40) : "error"})`, signal?.aborted ? undefined : "upstream_unavailable");
      }
      if (text.length > MAX_RESPONSE_CHARS) return refuse("the API answer is larger than any quote", "upstream_unavailable");
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (status < 200 || status >= 300) {
        const byStatus = httpRefusal(status, retryAfter);
        const name = plain(body) ? own(body, "name") : undefined;
        if (typeof name === "string" && Object.prototype.hasOwnProperty.call(API_ERRORS, name)) {
          const [why, reason] = API_ERRORS[name]!;
          // A 429 stays a rate limit (with its wait) whatever the body names; an upstream failure keeps its status.
          return refuse(`${why} (${name})`, byStatus?.reason === "rate_limited" ? byStatus : reason === "upstream_unavailable" || reason === "key_rejected" ? {reason, httpStatus: status} : reason);
        }
        if (status === 401 || status === 403) return refuse(`API key rejected (HTTP ${status})`, byStatus);
        if (status === 429) return refuse("rate limited (HTTP 429)", byStatus);
        // Any other status: a JSON refusal is a quote 0x does not have; anything else is an answer of another shape.
        return refuse(`API answered HTTP ${status}`, byStatus ?? (plain(body) ? "no_route" : {reason: "upstream_unavailable", httpStatus: status}));
      }
      if (!plain(body)) return refuse("malformed API response", "upstream_unavailable");
      const r = body;

      if (own(r, "liquidityAvailable") === false) return refuse("no liquidity for this pair and amount", "insufficient_liquidity");
      if (own(r, "liquidityAvailable") !== true) return refuse("malformed API response (liquidity)", "upstream_unavailable");
      const mode = own(r, "mode");
      if (mode !== undefined && mode !== "exact-in") return refuse("the API answered a quote that is not exact-input", "policy_refused");
      const echoedSell = own(r, "sellToken");
      const echoedBuy = own(r, "buyToken");
      if (!isAddress(echoedSell) || !same(echoedSell, sellToken) || !isAddress(echoedBuy) || !same(echoedBuy, buyToken)) return refuse("the API quoted other tokens than the ones asked for", "policy_refused");
      const quotedIn = uint(own(r, "sellAmount"));
      const buyAmount = uint(own(r, "buyAmount"));
      const minBuyAmount = uint(own(r, "minBuyAmount"));
      if (quotedIn === null || buyAmount === null || minBuyAmount === null) return refuse("malformed quote amounts", "upstream_unavailable");
      if (quotedIn !== amountIn) return refuse(`quoted ${quotedIn}, not the requested ${amountIn}`, "policy_refused");
      if (minBuyAmount <= 0n || minBuyAmount > buyAmount) return refuse("the quoted minimum is not between zero and the quoted output", "price_check_failed");
      if (minBuyAmount < slippageFloor(buyAmount, bps)) return refuse(`the quoted minimum ${minBuyAmount} is below the requested slippage (${bps} bps of ${buyAmount})`, "price_check_failed");
      if (floor !== null && minBuyAmount < floor) return refuse(`floor breach (min=${minBuyAmount} < floor=${floor})`, "price_check_failed");

      // A buy token that taxes transfers arrives short of the minimum Settler measured: refused rather than promised.
      // Only what 0x reports can be judged: a tax it does not flag (null / absent counts as none) is not caught here.
      const metadata = own(r, "tokenMetadata");
      const buyMeta = plain(metadata) ? own(metadata, "buyToken") : undefined;
      if (buyMeta !== undefined && buyMeta !== null) {
        if (!plain(buyMeta)) return refuse("malformed API response (token metadata)", "upstream_unavailable");
        for (const field of ["buyTaxBps", "transferTaxBps"]) {
          const tax = taxBps(own(buyMeta, field));
          if (tax === undefined) return refuse("malformed API response (token tax)", "upstream_unavailable");
          if (tax !== null && tax > 0) return refuse("the token being bought taxes transfers — the amount received cannot be guaranteed", "unsupported_pair");
        }
      }

      const transaction = own(r, "transaction");
      if (!dry && !plain(transaction)) return refuse("the quote carries no transaction", "upstream_unavailable");
      const tx = plain(transaction) ? transaction : undefined;
      const parsedFees = zeroExFees(r, tx ? {gas: own(tx, "gas"), gasPrice: own(tx, "gasPrice")} : {gas: own(r, "gas"), gasPrice: own(r, "gasPrice")});
      if (typeof parsedFees === "string") return refuse(parsedFees, parsedFees === UNASKED_INTEGRATOR_FEE ? "policy_refused" : "upstream_unavailable");

      // What 0x says about the account: informative only (the engine checks balance and allowance itself).
      const flags: string[] = [];
      const issues = own(r, "issues");
      if (plain(issues)) {
        if (own(issues, "balance")) flags.push("balance");
        if (own(issues, "simulationIncomplete") === true) flags.push("simulationIncomplete");
        const allowance = own(issues, "allowance");
        if (plain(allowance)) {
          const spender = own(allowance, "spender");
          if (!isAddress(spender) || !same(spender, ZEROEX_PERMIT2)) return refuse("the API asks for an allowance to something other than canonical Permit2", "vault_mismatch");
          flags.push("allowance");
        }
        // A source name 0x does not know is silently not excluded: a misspelt exclusion must not pass as applied.
        const invalid = own(issues, "invalidSourcesPassed");
        if (Array.isArray(invalid) && invalid.length) {
          const names = invalid.filter((n): n is string => typeof n === "string" && /^[A-Za-z0-9_.\- ]{1,60}$/.test(n)).slice(0, 3);
          return refuse(`0x does not know the excluded source${invalid.length > 1 ? "s" : ""} ${names.length ? names.join(", ") : "it was given"}${invalid.length > names.length ? " and more" : ""} — they would not be excluded`, "policy_refused");
        }
      }
      // 0x names canonical Permit2 as the allowance target of every answer, native sales included (where nothing is
      // approved: the transaction below carries no allowance target then). Anything else is refused.
      const allowanceTarget = own(r, "allowanceTarget");
      if (allowanceTarget !== null && allowanceTarget !== undefined) {
        const permit2Target = isAddress(allowanceTarget) && same(allowanceTarget, ZEROEX_PERMIT2);
        if (nativeSell && !permit2Target) return refuse("the API asks for a token allowance on a native-coin sale", "policy_refused");
        if (!permit2Target) return refuse("the API asks for an allowance to something other than canonical Permit2", "vault_mismatch");
      }
      const zidRaw = own(r, "zid");
      const zid = typeof zidRaw === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(zidRaw) ? zidRaw : undefined;

      const now = Date.now();
      let validUntilMs = now + ttl;
      let txRequest: Quote["txRequest"];
      let settler: string | undefined;
      if (!dry && tx && recipient) {
        const to = own(tx, "to");
        const data = own(tx, "data");
        const value = uint(own(tx, "value"));
        if (!isAddress(to) || typeof data !== "string" || value === null) return refuse("malformed quote transaction", "upstream_unavailable");

        let permit2Transfer: string | undefined;
        let permit2: Permit2Transfer | undefined;
        const permit = own(r, "permit2");
        if (nativeSell) {
          if (permit !== null && permit !== undefined) return refuse("the API asks for a Permit2 signature on a native-coin sale", "policy_refused");
        } else {
          const eip712 = plain(permit) ? own(permit, "eip712") : undefined;
          if (!plain(permit) || !plain(eip712)) return refuse("the quote carries no Permit2 payload to sign", "policy_refused");
          try {
            // Only these four members are read; the reader holds them to this swap and the payload is rebuilt from that.
            permit2 = readPermit2Transfer(JSON.stringify({domain: own(eip712, "domain"), types: own(eip712, "types"), primaryType: own(eip712, "primaryType"), message: own(eip712, "message")}), {
              chainId,
              token: sellToken,
              amount: amountIn,
              spender: to,
              nowMs: now,
            });
          } catch (e) {
            return refuseError(e, /^swap2: /, "the Permit2 payload is refused");
          }
          // 0x states the digest it expects signed; the locally rebuilt payload must hash to it.
          const hash = own(permit, "hash");
          if (hash !== null && hash !== undefined) {
            const local = hashTypedData({
              domain: permit2.domain,
              types: {PermitTransferFrom: permit2.types.PermitTransferFrom, TokenPermissions: permit2.types.TokenPermissions},
              primaryType: permit2.primaryType,
              message: permit2.message,
            } as unknown as Parameters<typeof hashTypedData>[0]);
            if (typeof hash !== "string" || !same(hash, local)) return refuse("the Permit2 payload does not hash to what the API says is being signed", "policy_refused");
          }
          permit2Transfer = permit2TransferJson(permit2);
          // The quote lapses before the signature it asks for does (the reader bounds the deadline to the next hour).
          const lapse = permit2.deadline * 1000n - BigInt(DEADLINE_MARGIN_MS);
          if (lapse <= BigInt(now)) return refuse("the Permit2 deadline is too close to sign against", "quote_expired");
          if (lapse < BigInt(validUntilMs)) validUntilMs = bigintToNumber(lapse);
        }

        const gas = uint(own(tx, "gas"));
        // 0x's own limit for the call, with room for the appended signature and a moved route.
        const gasLimit = gas !== null && gas > 0n ? ((gas * 12n) / 10n + 20_000n).toString() : undefined;
        const candidate = {
          to,
          data,
          value: value.toString(),
          chainId,
          ...(gasLimit !== undefined ? {gasLimit} : {}),
          ...(nativeSell ? {} : {approvalAddress: ZEROEX_PERMIT2}),
          ...(permit2Transfer !== undefined ? {permit2Transfer} : {}),
        };
        const expectation = (set: readonly string[]): ZeroExExpectation => ({chainId, settlers: set, sellToken, buyToken, sellAmount: amountIn, recipient: recipient!, minBuyAmount, nowMs: now});
        try {
          try {
            checkZeroExTransaction(candidate, expectation(settlers));
          } catch (first) {
            // 0x may already quote a Settler deployed after the cached registry read: read again, once.
            if (settlers.some((s) => same(s, to))) throw first;
            settlers = await resolver.resolve(chainId, {fresh: true});
            checkZeroExTransaction(candidate, expectation(settlers));
          }
        } catch (e) {
          return refuseError(e, /^zeroex: /, "the transaction is refused");
        }
        settler = getAddress(to);
        txRequest = {
          to: settler,
          data,
          value: value.toString(),
          chainId,
          ...(gasLimit !== undefined ? {gasLimit} : {}),
          ...(nativeSell ? {} : {approvalAddress: getAddress(ZEROEX_PERMIT2)}),
          ...(permit2Transfer !== undefined ? {permit2Transfer} : {}),
        };
      }

      const sources = zeroExSources(own(r, "route"));
      return {
        provider: ZEROEX_PROVIDER,
        intentId: `zeroex:${chainId}:${now.toString(36)}${(sequence = (sequence + 1) % 1_000_000).toString(36)}`,
        depositAddress: "",
        depositMemo: null,
        ...(txRequest ? {txRequest} : {}),
        sourceAmount: amountIn.toString(),
        destAmount: buyAmount.toString(),
        minDestAmount: minBuyAmount.toString(),
        feeUsd: 0,
        fees: parsedFees.fees,
        etaSeconds: 15,
        reliability: 0.96,
        validUntilMs,
        providerData: {
          minOut: minBuyAmount.toString(),
          slippageBps: String(bps),
          ...(taker ? {sender: taker} : {}),
          ...(settler ? {settler} : {}),
          ...(zid ? {zid} : {}),
          ...(sources ? {sources} : {}),
          ...(parsedFees.networkFeeKnown ? {} : {networkFee: "unknown"}),
          ...(flags.length ? {issues: flags.join(",")} : {}),
        },
      };
    },

    /**
     * Before the engine signs: the transaction must be the quoted one, and its target must still be a Settler in the
     * registry now (a fresh read — a Settler paused or replaced since the quote is refused here, with nothing signed).
     * The call itself cannot be simulated yet: it needs the Permit2 signature, which the engine makes next and then
     * estimates as signed.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const quoted = quote.txRequest;
      if (
        !quoted?.to || !quoted.data || typeof tx.to !== "string" || typeof tx.data !== "string" ||
        !same(tx.to, quoted.to) || !same(tx.data, quoted.data) || !sameAmount(tx.value || "0", quoted.value ?? "0") ||
        tx.permit2Transfer !== quoted.permit2Transfer
      ) {
        throw refusal("policy_refused", "zeroex: the transaction is not the quoted swap. Nothing was sent; refresh the quote.");
      }
      const chainId = chainOfIntent(quote.intentId);
      if (Number.isNaN(chainId)) throw refusal("policy_refused", "zeroex: the quote names no chain this provider serves. Nothing was sent.");
      const settlers = await resolver.resolve(chainId, {fresh: true});
      if (!settlers.some((s) => same(s, quoted.to!))) {
        throw refusal("vault_mismatch", "zeroex: the quoted 0x Settler is no longer in the on-chain registry. Nothing was sent; refresh the quote.");
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw refusal("policy_refused", "zeroex: not a live quote — it carries no transaction");
      return {
        chain: "",
        to: tx.to,
        value: tx.value ?? "0",
        data: tx.data,
        ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}),
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}),
        ...(tx.permit2Transfer !== undefined ? {permit2Transfer: tx.permit2Transfer} : {}),
      };
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash || !/^0x[0-9a-fA-F]{64}$/.test(ref.sourceTxHash)) return {state: "pending"};
      const chainId = chainOfIntent(ref.intentId);
      if (Number.isNaN(chainId) || !rpcUrlsFor(config.rpcUrls, chainId).length) return {state: "pending"};
      const answer = await rpcRequest(config.rpcUrls, chainId, "eth_getTransactionReceipt", [ref.sourceTxHash]);
      if (!answer || "error" in answer || !plain(answer.result)) return {state: "pending"};
      const status = own(answer.result, "status");
      if (status === "0x1") return {state: "completed", destTxHash: ref.sourceTxHash};
      return status === "0x0" ? {state: "failed"} : {state: "pending"};
    },
  };
}

/** The liquidity sources of `route.fills`, at most six short names, for display. */
function zeroExSources(route: unknown): string | undefined {
  const fills = plain(route) ? own(route, "fills") : undefined;
  if (!Array.isArray(fills)) return undefined;
  const names: string[] = [];
  for (const fill of fills.slice(0, 64)) {
    const source = plain(fill) ? own(fill, "source") : undefined;
    if (typeof source !== "string" || !/^[A-Za-z0-9_.\- ]{1,40}$/.test(source)) continue;
    if (!names.includes(source)) names.push(source);
    if (names.length === 6) break;
  }
  return names.length ? names.join(",") : undefined;
}
