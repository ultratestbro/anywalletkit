import {getAddress, isAddress} from "viem";
import {bigintToUnits} from "@anywalletkit/core";
import {ccAsset, ccAssetByToken, type CcAsset} from "@anywalletkit/swap2-assets";
import {suggestSlippage} from "@anywalletkit/protocol-swap2-core/slippage";
import {anySignal, redactUrls, sourceAssetOf, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentState, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {httpRefusal, parseRetryAfter, refusal, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {describeSymbiosisActivity} from "./activity.js";
import {notes} from "./reasons.js";
import {
  SYMBIOSIS_API, SYMBIOSIS_BY_ID, SYMBIOSIS_REVERTER, account20, evmToTron, gatewayAddress, symbiosis as symbiosisCfg, symbiosisChain, symbiosisToken, tronToEvm,
  validAddress, type SymbiosisChain,
} from "./config.js";
import {
  SYMBIOSIS_META_ROUTE_SELECTOR, SYMBIOSIS_META_ROUTE_SIGNATURE, symbiosisInspectQuote, symbiosisTonMessage, symbiosisVerifyBuild, type SymbiosisBound,
} from "./verify.js";

/**
 * Symbiosis — any-to-any cross-chain swaps through Symbiosis' own bridge (Portal → host-chain pools
 * → Portal), with EVM chains, Tron and TON as sources and destinations. ONE source transaction:
 *
 *  - EVM / Tron: `metaRoute` on the chain's MetaRouterGateway (after an approval of the gateway for
 *    the sell amount when a token is sold);
 *  - TON: one jetton transfer to the TON Portal carrying the bridge request;
 *  - Bitcoin (opt-in, `btcSource`): a payment to a deposit address the API names.
 *
 * Quotes and transactions come from Symbiosis' public REST API (`POST /v2/quote`; `POST /v2/swap`
 * for a live Bitcoin deposit). Nothing the API returns is trusted as it is: the response must be
 * for the requested token, chain and recipient, its fees must parse, and its transaction is decoded
 * and held against the request by `verify.ts` — before the quote is returned and again right
 * before signing: the gateway, the bridge request, every host-chain pool step (pinned pools and
 * token indexes), the burned synthetic token and the destination call. A route may swap before or
 * after the bridge only on an allow-listed router (two aggregators, a V2 router per chain), in a
 * call that decodes; anything else is refused. What the check rests on beyond that is listed there and reported on the quote
 * (`providerData.sourceSwap` / `destSwap` / `sourceRouter` / `destRouter` / `serviceReverts`).
 *
 *  - Partner routes the API can also return (exchange deposits, third-party bridges, intents) are
 *    switched off in the request and refused in the response: they pay addresses nothing here can check.
 *  - Limits: `GET /v1/swap-limits`, enforced locally on the sell token and on the received token.
 *  - Status: `GET /v2/tx/{chainId}/{hash}` by the source transaction. The API reports a stuck
 *    operation as "Pending", so a pending one is also looked up in `GET /v1/stucked/{address}`.
 *    Symbiosis reverts stuck operations itself; a revert pays the token that crossed the bridge
 *    (a stablecoin or wrapped coin — not always the token sold) on the source chain.
 */

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
/** Stands in for a TON account in a dry (display) quote that names none. */
const TON_PLACEHOLDER = "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N";
const BTC_PLACEHOLDER = "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4";
const DEFAULT_QUOTE_TTL_MS = 60_000;
const API_TIMEOUT_MS = 20_000;
const STATUS_TIMEOUT_MS = 12_000;
const LIMITS_TTL_MS = 5 * 60_000;
/** The API asks 200 TRX for a Tron source (2026-11-10); a response above this ceiling is refused. */
const DEFAULT_TRON_FEE_LIMIT_CAP = 300_000_000n;
/**
 * What the API is never asked to route through: third parties that hold the funds (every one pays
 * an address this module cannot check). Swap venues are not pre-selected: the API picks one, and
 * when it picks a venue whose call `verify.ts` does not read, the quote is asked for again without
 * it — which may end in "no route" where only such venues have liquidity.
 */
const DISABLED_PROVIDERS = ["changelly", "thorchain-bridge", "chainflip-bridge"];
/** The route steps a response may name; a response naming another venue is asked for again without it. */
const READABLE_PROVIDERS = ["symbiosis", "wrap", "1inch", "kyber-swap", "uni-v2"];
/** Venues a route can do without: an answer whose leg on one of them is refused is asked again without it. */
const OPTIONAL_PROVIDERS = ["1inch", "kyber-swap", "uni-v2"];
const MAX_QUOTE_ATTEMPTS = 4;
/** The API serves one quote per second per client. */
const RETRY_WAIT_MS = 1_100;
/** Response labels of routes this module never returns. */
const REFUSED_LABELS = ["partner-swap", "semi-centralized", "intent"];
const HASH_RE = /^(0x)?[0-9a-fA-F]{64}$/;

export interface SymbiosisProviderConfig {
  enabled?: boolean;
  /** API base (default https://api.symbiosis.finance/crosschain) — e.g. the app's own proxy. */
  apiUrl?: string;
  /** Local lifetime of a quote in ms (default 60 000, at most 300 000). Symbiosis asks to rebuild calldata often. */
  quoteTtlMs?: number;
  /**
   * Slippage in bps when the caller names none. Default: `suggestSlippage` from swap2-core for the
   * pair, the route's price impact and its time to settle.
   */
  slippageBps?: number;
  /**
   * Quote Tron sources (default off). The quote and its checked `metaRoute` call are complete, but
   * the engine does not execute contract calls on Tron yet — an app signs it itself with
   * {@link symbiosisTronCall}.
   */
  tronSource?: boolean;
  /**
   * Quote Bitcoin sources (default off). A Bitcoin source pays a deposit address the API names;
   * nothing on the device can tell whose address it is.
   */
  btcSource?: boolean;
  /**
   * Refuse routes that swap on the source chain before bridging (default off). Such a swap is a call
   * to an allow-listed router whose tokens, amount, receiver and minimum are checked, but whose
   * liquidity is a third party's; with this on, no third-party contract touches the sell token.
   */
  boundSourceOnly?: boolean;
  /**
   * The user's own EVM address, needed when neither side is an EVM chain (Tron ↔ TON): it receives
   * the synthetic tokens on Symbiosis' host chain if the last leg is reverted.
   */
  fallbackReceiver?: string;
  /** Optional: a registered partner address that shares the protocol fee (the API's `partnerAddress`). */
  partnerAddress?: string;
  /** Optional: sent as `X-Partner-Id`. */
  partnerId?: string;
  /** Optional: sent as `X-Api-Key`. Never put a key in an app bundle — point `apiUrl` at a proxy that adds it. */
  apiKey?: string;
  /** The highest Tron `fee_limit` (sun) a response may ask for (default 300 TRX). */
  tronFeeLimitCap?: bigint | number | string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface ApiToken {symbol?: unknown; address?: unknown; amount?: unknown; chainId?: unknown; decimals?: unknown; priceUsd?: unknown}
interface ApiFee {provider?: unknown; value?: ApiToken; description?: unknown}
interface ApiQuote {
  type?: unknown; kind?: unknown; labels?: unknown; routes?: unknown; approveTo?: unknown; estimatedTime?: unknown; priceImpact?: unknown; recommendedSlippage?: unknown;
  tokenAmountOut?: ApiToken; tokenAmountOutMin?: ApiToken; amountInUsd?: ApiToken; fees?: unknown;
  tx?: {
    chainId?: unknown; to?: unknown; data?: unknown; value?: unknown; from?: unknown; feeLimit?: unknown; functionSelector?: unknown;
    validUntil?: unknown; messages?: unknown; depositAddress?: unknown; expiresAt?: unknown;
  };
}
interface ApiLimit {chainId: number; address: string; min: bigint; max: bigint}

/** `GET /v2/tx/{chainId}/{hash}` as far as this module reads it. */
export interface SymbiosisTxResponse {
  status?: {code?: unknown; text?: unknown};
  tx?: {hash?: unknown; chainId?: unknown; tokenAmount?: ApiToken};
  txIn?: {hash?: unknown; chainId?: unknown};
}

/** What a status answer says beyond the engine's state: where the funds went. */
export interface SymbiosisStatusDetail extends IntentStatus {
  /** Symbiosis' own code: -1 not found, 1 pending, 0 success, 2 stuck, 3 reverted. */
  code: number | null;
  /** The transaction that paid the user (delivery or revert): chain id as Symbiosis numbers it, hash, token. */
  payout?: {chainId: number; hash: string; symbol?: string; token?: string; amount?: string};
}

/**
 * How Symbiosis' operation states map to the engine's, and what each means for the user's funds.
 * `refunded` is reported only when the answer carries the revert transaction itself.
 */
export const SYMBIOSIS_STATUS: Readonly<Record<string, {state: IntentState; meaning: string}>> = Object.freeze({
  "-1": {state: "pending", meaning: "Not found: the source transaction is not indexed yet (or never happened). Nothing has left the wallet as far as the API knows."},
  "1": {state: "pending", meaning: "Pending: the source transaction is seen and the operation is in flight. A stuck operation is also reported this way — see the stuck list."},
  "0": {state: "completed", meaning: "Success: the destination transaction paid out. If it paid another token or on another chain than requested, the state is 'partial' (a destination swap failed and the bridged token was delivered instead)."},
  "2": {state: "refund-pending", meaning: "Stuck: a leg failed. Symbiosis reverts stuck operations itself, usually within an hour; the revert pays the token that crossed the bridge (a stablecoin or wrapped coin, not always the token sold) to the sender on the source chain, minus the bridge fee."},
  "3": {state: "refunded", meaning: "Reverted: the revert transaction is in the answer. Reported as 'refunded' only with that transaction; without it the state stays 'refund-pending'."},
});

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const digits = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);
const sameText = (a: unknown, b: string): boolean => typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** The error with its reason when there is one (the class and text as they are). */
const tagged = <E extends Error>(error: E, info: Swap2RefusalInfo | undefined): E => (info ? withReason(error, info) : error);

/**
 * What Symbiosis' own error message says, where it names one of the refusal reasons ("Price impact is too high",
 * "This swap is not available", an amount below its minimum, …). Undefined for anything else.
 *
 * A key rejection only when the message names the credential: a bare "Forbidden" / "Unauthorized" on a 401 / 403 is
 * already the status's, and on any other status (a forbidden token or address) it says nothing about the key. "Not
 * available" is Symbiosis' wording for a pair it does not route; a gateway's "Service Unavailable" is no such answer.
 */
function apiReason(message: string): Swap2RefusalReason | undefined {
  if (/price impact/i.test(message)) return "price_check_failed";
  if (/too many requests|rate.?limit/i.test(message)) return "rate_limited";
  if (/api.?key|partner.?id/i.test(message)) return "key_rejected";
  if (/less than (the )?fee|fees? (exceeds?|is (more|greater|higher) than)|amount.{0,40}(too (low|small)|below|less than)|min(imum)? amount/i.test(message)) return "amount_too_small";
  if (/amount.{0,40}(too (high|large|big)|above|exceeds?|more than)|max(imum)? amount/i.test(message)) return "amount_too_large";
  if (/liquidity/i.test(message)) return "insufficient_liquidity";
  if (/paused|halted|maintenance|suspended/i.test(message)) return "chain_halted";
  if (/no (route|path|transit)|route not found|not available|not supported|(can ?not|could not|unable to) find|no quote/i.test(message)) return "no_route";
  return undefined;
}

/**
 * The engine state of a status answer. `dst` and `destToken` (Symbiosis' spelling; "" for the native
 * coin) say what a delivery must be to count as completed; pass none to accept any payout.
 */
export function symbiosisStatus(body: SymbiosisTxResponse, want: {dstChainId?: number; destToken?: string} = {}): SymbiosisStatusDetail {
  const code = typeof body?.status?.code === "number" ? body.status.code : null;
  const hash = str(body?.tx?.hash);
  const chainId = typeof body?.tx?.chainId === "number" ? body.tx.chainId : undefined;
  const t = body?.tx?.tokenAmount;
  const payout = hash && chainId !== undefined
    ? {chainId, hash, ...(str(t?.symbol) !== undefined ? {symbol: str(t?.symbol)!} : {}), ...(str(t?.address) !== undefined ? {token: str(t?.address)!} : {}), ...(digits(t?.amount) ? {amount: String(t?.amount)} : {})}
    : undefined;
  if (code === 0) {
    if (!payout) return {code, state: "pending", depositReceived: true};
    const elsewhere = want.dstChainId !== undefined && payout.chainId !== want.dstChainId;
    const otherToken = want.destToken !== undefined && payout.token !== undefined && !sameText(payout.token, want.destToken);
    return {code, state: elsewhere || otherToken ? "partial" : "completed", depositReceived: true, destTxHash: payout.hash, payout};
  }
  if (code === 2) return {code, state: "refund-pending", depositReceived: true};
  if (code === 3) return payout ? {code, state: "refunded", depositReceived: true, destTxHash: payout.hash, payout} : {code, state: "refund-pending", depositReceived: true};
  if (code === 1) return {code, state: "pending", depositReceived: true};
  return {code, state: "pending", depositReceived: false};
}

interface Intent {src: SymbiosisChain; dst: SymbiosisChain; destToken: string; owners: string[]}

function parseIntent(intentId: string): Intent | null {
  const [tag, s, d, token, owners, ...rest] = intentId.split(":");
  if (tag !== "symbiosis" || rest.length > 0 || token === undefined || owners === undefined) return null;
  const src = SYMBIOSIS_BY_ID[Number(s)];
  const dst = SYMBIOSIS_BY_ID[Number(d)];
  if (!src || !dst || src === dst) return null;
  if (token !== "native" && !/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
  const list = owners === "" ? [] : owners.split(".");
  if (list.length > 3 || list.some((o) => !/^0x[0-9a-f]{40}$/.test(o))) return null;
  return {src, dst, destToken: token === "native" ? "" : token, owners: list};
}

/** The request a sealed quote answered (`providerData`), as the `QuoteParams` the checks read. */
function sealedParams(quote: Quote): QuoteParams | null {
  const d = quote.providerData ?? {};
  if (!d.sourceChain || !d.sourceToken || !d.destChain || d.destToken === undefined || !d.recipient || !d.sender || !digits(d.amountIn)) return null;
  return {
    sourceChain: d.sourceChain, sourceToken: d.sourceToken, ...(d.sourceDecimals !== undefined ? {sourceDecimals: Number(d.sourceDecimals)} : {}),
    destChain: d.destChain, destToken: d.destToken, amountIn: d.amountIn, destAddress: d.recipient, refundAddress: d.sender,
  };
}

/** What an app needs to sign a Tron-source quote itself. */
export interface SymbiosisTronCall {
  /** The TRC-20 approval the gateway needs first; null for a TRX sale. */
  approval: {token: string; spender: string; amount: string} | null;
  /** `POST /wallet/triggersmartcontract` (visible: false is implied by the hex addresses a wallet sends). */
  call: {owner: string; contract: string; functionSelector: string; parameter: string; feeLimit: number; callValue: string};
  /**
   * What the node's answer must be, byte for byte — the shape `assertNodeBuild` of
   * `@anywalletkit/wallet-tron` takes: one TriggerSmartContract by the owner on the pinned
   * gateway with exactly this calldata, call value and fee limit.
   */
  expected: {type: "TriggerSmartContract"; owner: string; contract: string; data: string; callValue: bigint; feeLimit: bigint};
}

/**
 * The Tron call of a Tron-source quote, re-checked against the request sealed in the quote: the
 * node request to build it and the exact transaction the node must return. The wallet still
 * verifies the node's bytes (`assertNodeBuild`, txID = sha256(raw_data_hex)) before signing.
 * Throws when the quote is not a verified Tron-source quote of this module.
 */
export function symbiosisTronCall(quote: Quote, options: {fallbackReceiver?: string; feeLimitCap?: bigint} = {}): SymbiosisTronCall {
  const params = sealedParams(quote);
  const tx = quote.txRequest;
  if (quote.provider !== "symbiosis" || !params || !tx || symbiosisChain(params.sourceChain)?.family !== "tron") throw new Error("symbiosis: not a Tron-source quote");
  const why = symbiosisInspectQuote(params, quote, options);
  if ("refusal" in why) throw tagged(new Error(why.refusal), notes.reasonOf(why.refusal));
  const cap = options.feeLimitCap ?? DEFAULT_TRON_FEE_LIMIT_CAP;
  if (!digits(tx.gasLimit) || BigInt(tx.gasLimit) <= 0n || BigInt(tx.gasLimit) > cap) throw refusal("policy_refused", `symbiosis: Tron fee limit ${String(tx.gasLimit)} is missing or above the ${cap} sun ceiling`);
  const data = tx.data!;
  const asset = sourceAssetOf(params);
  const feeLimit = BigInt(tx.gasLimit);
  return {
    approval: asset?.contract && tx.approvalAddress ? {token: asset.contract, spender: tx.approvalAddress, amount: params.amountIn} : null,
    call: {owner: params.refundAddress!, contract: tx.to!, functionSelector: SYMBIOSIS_META_ROUTE_SIGNATURE, parameter: data.slice(10), feeLimit: Number(tx.gasLimit), callValue: tx.value ?? "0"},
    expected: {type: "TriggerSmartContract", owner: params.refundAddress!, contract: tx.to!, data, callValue: BigInt(tx.value ?? "0"), feeLimit},
  };
}

export function symbiosisProvider(config: SymbiosisProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const api = (config.apiUrl ?? SYMBIOSIS_API).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(api)) throw new Error("symbiosis: apiUrl must use http or https");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 300_000) throw new Error("symbiosis: quoteTtlMs must be an integer between 1 and 300000");
  const fixedSlippage = config.slippageBps;
  if (fixedSlippage !== undefined && (!Number.isInteger(fixedSlippage) || fixedSlippage < 0 || fixedSlippage >= 10_000)) throw new Error("symbiosis: slippageBps must be 0..9999");
  if (config.fallbackReceiver !== undefined && (!isAddress(config.fallbackReceiver) || /^0x0{40}$/i.test(config.fallbackReceiver))) throw new Error("symbiosis: fallbackReceiver must be an EVM address");
  if (config.partnerAddress !== undefined && !isAddress(config.partnerAddress)) throw new Error("symbiosis: partnerAddress must be an EVM address");
  for (const [k, v] of [["partnerId", config.partnerId], ["apiKey", config.apiKey]] as const) {
    if (v !== undefined && !/^[\x21-\x7e]{1,256}$/.test(v)) throw new Error(`symbiosis: ${k} must be 1..256 printable characters`);
  }
  let tronFeeLimitCap: bigint;
  try { tronFeeLimitCap = BigInt(config.tronFeeLimitCap ?? DEFAULT_TRON_FEE_LIMIT_CAP); } catch { throw new Error("symbiosis: tronFeeLimitCap must be a whole number of sun"); }
  if (tronFeeLimitCap <= 0n || tronFeeLimitCap > 10_000_000_000n) throw new Error("symbiosis: tronFeeLimitCap must be between 1 and 10000000000 sun");
  const verifyOptions = config.fallbackReceiver !== undefined ? {fallbackReceiver: config.fallbackReceiver} : {};
  const doFetch: typeof fetch = (input, init) => (config.fetchImpl ?? fetch)(input, init);
  const headers = (json: boolean): Record<string, string> => ({
    accept: "application/json",
    ...(json ? {"content-type": "application/json"} : {}),
    ...(config.partnerId !== undefined ? {"X-Partner-Id": config.partnerId} : {}),
    ...(config.apiKey !== undefined ? {"X-Api-Key": config.apiKey} : {}),
  });

  async function call(path: string, init: {body?: unknown; timeoutMs: number; signal?: AbortSignal}): Promise<unknown> {
    const timeout = timeoutSignal(init.timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${api}${path}`, {
        method: init.body === undefined ? "GET" : "POST",
        headers: headers(init.body !== undefined),
        ...(init.body !== undefined ? {body: JSON.stringify(init.body)} : {}),
        signal: init.signal ? anySignal([init.signal, timeout]) : timeout,
      });
    } catch (err) {
      // The API unreachable, or its time ran out: upstream_unavailable. The caller's own abort stays unclassified.
      throw err instanceof Error && !init.signal?.aborted ? withReason(err, "upstream_unavailable") : err;
    }
    let body: unknown;
    try { body = await res.json(); } catch { body = undefined; }
    if (!res.ok) {
      const message = str((body as {message?: unknown} | undefined)?.message);
      // A throttle or a rejected key by its status; otherwise what the API's message says (a throttle with the wait the
      // Retry-After header names; on a 5xx, "no route" is the venue failing, not an answer about the pair), else the
      // status (5xx), else a quote request Symbiosis refused (400 / 422, its own refusals' status) is no route and any
      // other answer (404, 405, 415, a refused limits read …) an unusable one.
      const retryAfter = res.headers?.get?.("retry-after");
      const http = httpRefusal(res.status, retryAfter);
      const said = message ? apiReason(message) : undefined;
      const wait = said === "rate_limited" ? parseRetryAfter(retryAfter) : undefined;
      const info: Swap2RefusalInfo = http && http.reason !== "upstream_unavailable" ? http
        : said && !(http && said === "no_route") ? {reason: said, ...(wait !== undefined ? {retryAfterMs: wait} : {})}
        : http ?? (init.body !== undefined && (res.status === 400 || res.status === 422) ? {reason: "no_route"} : {reason: "upstream_unavailable", httpStatus: res.status});
      throw withReason(new Error(message ? `Symbiosis: ${message.slice(0, 300)}` : `Symbiosis API → ${res.status}`), info);
    }
    return body;
  }

  let limits: {at: number; list: Promise<ApiLimit[]>} | null = null;
  /** `GET /v1/swap-limits`: what a chain's bridged tokens may carry, both ways. An unreadable list is an error, not "no limits". */
  function swapLimits(signal?: AbortSignal): Promise<ApiLimit[]> {
    if (limits && Date.now() - limits.at < LIMITS_TTL_MS) return limits.list;
    const list = (async () => {
      const body = await call("/v1/swap-limits", {timeoutMs: API_TIMEOUT_MS, ...(signal ? {signal} : {})});
      // No list: the API's fault, unless the caller aborted while the body was read (call() reads such a body as none).
      if (!Array.isArray(body) || body.length === 0) throw signal?.aborted ? new Error("Symbiosis limits are unreadable") : refusal("upstream_unavailable", "Symbiosis limits are unreadable");
      return body.map((e: {chainId?: unknown; address?: unknown; min?: unknown; max?: unknown}) => {
        if (typeof e?.chainId !== "number" || typeof e.address !== "string" || !digits(e.min) || !digits(e.max)) throw refusal("upstream_unavailable", "Symbiosis limits are unreadable");
        return {chainId: e.chainId, address: e.address.toLowerCase(), min: BigInt(e.min), max: BigInt(e.max)};
      });
    })();
    const entry = {at: Date.now(), list};
    list.catch(() => { if (limits === entry) limits = null; });
    limits = entry;
    return list;
  }
  const limitRefusal = (list: ApiLimit[], chain: SymbiosisChain, token: string, amount: bigint, what: string): {text: string; reason: Swap2RefusalReason} | null => {
    const l = list.find((e) => e.chainId === chain.id && e.address === token.toLowerCase());
    if (!l) return null;
    if (l.min > 0n && amount < l.min) return {text: `${what} ${amount} is below Symbiosis' minimum ${l.min} on ${chain.name}`, reason: "amount_too_small"};
    if (l.max > 0n && amount > l.max) return {text: `${what} ${amount} is above Symbiosis' maximum ${l.max} on ${chain.name}`, reason: "amount_too_large"};
    return null;
  };

  const sourceOpen = (c: SymbiosisChain): boolean =>
    c.family === "evm" || c.family === "ton" || (c.family === "tron" && config.tronSource === true) || (c.family === "bitcoin" && config.btcSource === true);
  const placeholder = (c: SymbiosisChain): string =>
    c.family === "evm" ? EVM_PLACEHOLDER : c.family === "tron" ? evmToTron(EVM_PLACEHOLDER) : c.family === "ton" ? TON_PLACEHOLDER : BTC_PLACEHOLDER;
  const assetOf = (chain: string, token: string): CcAsset | undefined => ccAsset(chain, token) ?? ccAssetByToken(chain, token);

  return {
    name: "symbiosis",
    describeActivity: describeSymbiosisActivity,
    // A Bitcoin source pays an address the API names; an app's route policy reads this flag.
    ...(config.btcSource === true ? {depositAddressRoutes: true} : {}),
    enabled: () => config.enabled ?? true,
    supportsChain: (chain: string) => symbiosisCfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => symbiosisCfg.supports(from, to) && sourceOpen(symbiosisChain(from)!),
    supportsRoute(from: Asset, to: Asset): boolean {
      const src = symbiosisChain(from.chain);
      const dst = symbiosisChain(to.chain);
      if (!src || !dst || !symbiosisCfg.supports(from.chain, to.chain) || !sourceOpen(src)) return false;
      const a = assetOf(from.chain, from.token);
      const b = assetOf(to.chain, to.token);
      if (!a || !b) return false;
      // TON's native coin leaves only through a partner exchange.
      return !(src.family === "ton" && !a.contract);
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (reason: string, why?: Swap2RefusalReason | Swap2RefusalInfo) => {
        if (why === undefined) params.onRefusal?.(reason);
        else params.onRefusal?.(reason, typeof why === "string" ? {reason: why} : why);
        return null;
      };
      if (params.flex) return refuse("the amount is sealed into the transaction (no flexible deposits)", "unsupported_pair");
      const src = symbiosisChain(params.sourceChain);
      const dst = symbiosisChain(params.destChain);
      if (!src || !dst) return refuse("Symbiosis is not wired for this chain", "unsupported_pair");
      if (src === dst) return refuse("same-chain swaps are not served", "unsupported_pair");
      if (dst.family === "bitcoin") return refuse("Bitcoin is not a destination", "unsupported_pair");
      if (!sourceOpen(src)) return refuse(`${src.name} sources are switched off (${src.family === "tron" ? "tronSource" : "btcSource"})`, "policy_refused");
      if (typeof params.amountIn !== "string" || !/^\d+$/.test(params.amountIn)) return refuse("amount must be a base-unit integer");
      const amount = BigInt(params.amountIn);
      if (amount <= 0n) return refuse("amount must be positive", "amount_too_small");
      if (params.slippageBps !== undefined && (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps >= 10_000)) return refuse("slippage must be 0..9999 bps");
      const sell = sourceAssetOf(params);
      if (!sell) return refuse(`unknown source token ${params.sourceToken} on ${src.name}`, "unsupported_pair");
      if (src.family === "ton" && !sell.contract) return refuse("TON's native coin is not bridged by Symbiosis itself", "unsupported_pair");
      const buy = ccAssetByToken(params.destChain, params.destToken);
      if (!buy) return refuse(`destination token ${params.destToken} is not in the catalog (its decimals are unknown)`, "unsupported_pair");
      const tokenIn = symbiosisToken(src, sell.contract);
      const tokenOut = symbiosisToken(dst, buy.contract);
      if (!tokenIn || !tokenOut) return refuse("malformed token address", "unsupported_pair");

      // The placeholder prices a dry quote; a live one without addresses would be built for it.
      const dry = params.dry !== false;
      const recipient = params.destAddress || (dry ? placeholder(dst) : "");
      if (!recipient) return refuse("a live quote needs a recipient");
      if (!validAddress(dst, recipient)) return refuse(`the recipient is not a ${dst.name} address`, "recipient_mismatch");
      const sender = params.refundAddress || (dry ? placeholder(src) : "");
      if (!sender) return refuse("a live quote needs the sender (refund address)");
      if (!validAddress(src, sender)) return refuse(`the sender is not a ${src.name} address`, "recipient_mismatch");
      let fallbackReceiver: string | undefined;
      if (src.family !== "evm") {
        fallbackReceiver = dst.family === "evm" ? getAddress(recipient) : config.fallbackReceiver ?? (dry ? EVM_PLACEHOLDER : undefined);
        if (!fallbackReceiver) return refuse(`${src.name} → ${dst.name} needs the user's own EVM address (fallbackReceiver)`, "unsupported_pair");
      }
      const request: QuoteParams = {...params, destAddress: recipient, refundAddress: sender};
      const options = fallbackReceiver !== undefined && dst.family !== "evm" ? {fallbackReceiver} : {};

      try {
        const list = await swapLimits(signal);
        const below = limitRefusal(list, src, tokenIn.address, amount, "amount");
        if (below) return refuse(below.text, below.reason);

        const bps = params.slippageBps ?? fixedSlippage ?? suggestSlippage({fromChain: params.sourceChain, toChain: params.destChain, fromSymbol: sell.symbol, toSymbol: buy.symbol}).bps;
        const btc = src.family === "bitcoin";
        const body = {
          tokenAmountIn: {address: tokenIn.address, chainId: src.id, decimals: sell.decimals, amount: amount.toString(), ...(tokenIn.ton ? {attributes: {ton: tokenIn.ton}} : {})},
          tokenOut: {address: tokenOut.address, chainId: dst.id, decimals: buy.decimals, ...(tokenOut.ton ? {attributes: {ton: tokenOut.ton}} : {})},
          from: sender,
          to: recipient,
          slippage: bps,
          ...(fallbackReceiver !== undefined ? {fallbackReceiver} : {}),
          ...(btc ? {refundAddress: sender} : {}),
          ...(config.boundSourceOnly === true ? {disableSrcChainRouting: true} : {}),
          ...(config.partnerAddress !== undefined ? {partnerAddress: getAddress(config.partnerAddress)} : {}),
        };
        // A Bitcoin deposit address is opened only for a live quote (`/v2/swap`); everything else is `/v2/quote`.
        // Venues left out after an answer whose swap leg could not be read as one canonical call.
        const avoided: string[] = [];
        for (let pass = 1; ; pass++) {
        const disabled = [...DISABLED_PROVIDERS, ...avoided];
        let r: ApiQuote;
        for (let attempt = 1; ; attempt++) {
          r = (await call(btc && !dry ? "/v2/swap" : "/v2/quote", {body: {...body, disabledProviders: disabled.join(",")}, timeoutMs: API_TIMEOUT_MS, ...(signal ? {signal} : {})})) as ApiQuote;
          if (!r || typeof r !== "object") return refuse("Symbiosis returned no quote", signal?.aborted ? undefined : "upstream_unavailable");
          // A venue this module cannot read (a new one the list above does not know yet): ask again without it.
          const venues = (Array.isArray(r.routes) ? r.routes : []).map((x: {provider?: unknown}) => x?.provider)
            .filter((v): v is string => typeof v === "string" && /^[a-z0-9-]{1,32}$/.test(v) && !READABLE_PROVIDERS.includes(v) && !disabled.includes(v));
          if (btc || venues.length === 0 || attempt >= MAX_QUOTE_ATTEMPTS) break;
          disabled.push(...new Set(venues));
          await new Promise<void>((done) => setTimeout(done, RETRY_WAIT_MS));
          if (signal?.aborted) return refuse("aborted");
        }

        // ── The answer must be for the request ───────────────────────────────
        const want = btc ? "btc" : src.family;
        if (r.type !== want) return refuse(`Symbiosis answered with a '${String(r.type)}' route, not a ${src.name} transaction`, "upstream_unavailable");
        if (r.kind !== "crosschain-swap") return refuse(`Symbiosis answered with a '${String(r.kind)}' route`, "upstream_unavailable");
        const labels = Array.isArray(r.labels) ? r.labels.filter((l): l is string => typeof l === "string") : [];
        const partner = labels.find((l) => REFUSED_LABELS.includes(l));
        if (partner) return refuse(`Symbiosis answered with a ${partner} route (a third party holds the funds)`, "recipient_unverifiable");
        const out = r.tokenAmountOut;
        const min = r.tokenAmountOutMin;
        for (const t of [out, min]) {
          if (!t || t.chainId !== dst.id || !sameText(t.address, tokenOut.address) || t.decimals !== buy.decimals || !digits(t.amount)) {
            return refuse("Symbiosis quoted another token or chain than requested", "price_check_failed");
          }
        }
        const destAmount = BigInt(out!.amount as string);
        const minDest = BigInt(min!.amount as string);
        if (destAmount <= 0n || minDest <= 0n || minDest > destAmount) return refuse("Symbiosis quoted an unusable output amount", "price_check_failed");
        if (params.minAmountOut !== undefined && minDest < BigInt(params.minAmountOut)) return refuse(`the route guarantees ${minDest}, below the caller's floor ${params.minAmountOut}`, "price_check_failed");
        const above = limitRefusal(list, dst, tokenOut.address, destAmount, "received amount");
        if (above) return refuse(above.text, above.reason);

        // ── Fees: every one the API reports, or no quote ─────────────────────
        const inUsd = typeof r.amountInUsd?.priceUsd === "number" && r.amountInUsd.priceUsd > 0 && digits(r.amountInUsd.amount) && typeof r.amountInUsd.decimals === "number"
          ? bigintToUnits(BigInt(r.amountInUsd.amount), r.amountInUsd.decimals) * r.amountInUsd.priceUsd
          : null;
        const outPrice = typeof out!.priceUsd === "number" && out!.priceUsd > 0 ? out!.priceUsd : inUsd !== null ? inUsd / bigintToUnits(destAmount, buy.decimals) : null;
        if (!Array.isArray(r.fees) || r.fees.length === 0) return refuse("Symbiosis reported no fees — a quote without readable fees is not shown", "upstream_unavailable");
        const fees: Quote["fees"] = [];
        let feeUsd = 0;
        for (const f of r.fees as ApiFee[]) {
          const v = f?.value;
          if (!v || !digits(v.amount) || typeof v.decimals !== "number" || !Number.isInteger(v.decimals) || v.decimals < 0 || v.decimals > 36 || typeof v.symbol !== "string" || typeof v.chainId !== "number") {
            return refuse("Symbiosis reported a fee that cannot be read", "upstream_unavailable");
          }
          const units = bigintToUnits(BigInt(v.amount), v.decimals);
          if (units > 0) {
            const price = typeof v.priceUsd === "number" && v.priceUsd > 0 ? v.priceUsd : v.chainId === dst.id && sameText(v.address, tokenOut.address) ? outPrice : null;
            if (price === null || !Number.isFinite(price)) return refuse(`Symbiosis reported a fee in ${v.symbol} without a price`, "upstream_unavailable");
            feeUsd += units * price;
          }
          const where = SYMBIOSIS_BY_ID[v.chainId]?.name ?? (v.chainId === 13863860 ? "Symbiosis' host chain" : `chain ${v.chainId}`);
          fees.push({type: "protocol", amount: v.amount, token: v.symbol.slice(0, 32), included: true, description: `${str(f.description)?.slice(0, 80) || "Symbiosis fee"} (${str(f.provider)?.slice(0, 32) || "symbiosis"}, ${where})`});
        }
        if (!Number.isFinite(feeUsd) || feeUsd < 0) return refuse("Symbiosis fees do not add up", "upstream_unavailable");
        const eta = typeof r.estimatedTime === "number" && Number.isFinite(r.estimatedTime) && r.estimatedTime > 0 ? Math.ceil(r.estimatedTime) : 600;
        const impact = typeof r.priceImpact === "string" && /^-?\d+(\.\d+)?$/.test(r.priceImpact) ? r.priceImpact : undefined;

        const owners = [account20(src, sender), account20(dst, recipient), fallbackReceiver?.toLowerCase()].filter((o, i, all): o is string => !!o && all.indexOf(o) === i);
        const base = {
          provider: "symbiosis",
          intentId: `symbiosis:${src.id}:${dst.id}:${tokenOut.address || "native"}:${owners.join(".")}`,
          depositMemo: null,
          sourceAmount: amount.toString(),
          destAmount: destAmount.toString(),
          minDestAmount: minDest.toString(),
          destDecimals: buy.decimals,
          feeUsd,
          fees,
          etaSeconds: eta,
          reliability: 0.95,
          validUntilMs: Date.now() + quoteTtlMs,
        };
        const sealed: Record<string, string> = {
          sourceChain: src.caip2, sourceToken: params.sourceToken, ...(params.sourceDecimals !== undefined ? {sourceDecimals: String(params.sourceDecimals)} : {}),
          destChain: dst.caip2, destToken: params.destToken, recipient, sender, amountIn: amount.toString(), slippageBps: String(bps),
          ...(options.fallbackReceiver ? {fallbackReceiver: options.fallbackReceiver} : {}),
          ...(impact !== undefined ? {priceImpact: impact} : {}),
          ...(typeof r.recommendedSlippage === "number" ? {recommendedSlippageBps: String(r.recommendedSlippage)} : {}),
          ...(labels.length ? {labels: labels.join(",").slice(0, 200)} : {}),
        };
        const tx = r.tx ?? {};
        let quote: Quote;
        if (btc) {
          if (dry) {
            // `/v2/quote` opens no deposit address: a display quote only.
            quote = {...base, depositAddress: "", providerData: {...sealed, depositAddressAssigned: "1", display: "1"}};
            return quote;
          }
          const deposit = str(tx.depositAddress);
          if (!deposit || !validAddress(src, deposit)) return refuse("Symbiosis returned no Bitcoin deposit address", "upstream_unavailable");
          const expires = typeof tx.expiresAt === "string" ? Date.parse(tx.expiresAt) : typeof tx.expiresAt === "number" ? tx.expiresAt * (tx.expiresAt < 1e12 ? 1000 : 1) : NaN;
          quote = {
            ...base, depositAddress: deposit,
            ...(Number.isFinite(expires) ? {validUntilMs: Math.min(base.validUntilMs, expires)} : {}),
            providerData: {...sealed, depositAddressAssigned: "1"},
          };
        } else if (src.family === "ton") {
          const messages = Array.isArray(tx.messages) ? (tx.messages as {address?: unknown; amount?: unknown; payload?: unknown}[]) : [];
          const m = messages[0];
          if (messages.length !== 1 || !m || typeof m.address !== "string" || !digits(m.amount) || typeof m.payload !== "string") return refuse("Symbiosis returned something other than one TON message", "upstream_unavailable");
          const until = typeof tx.validUntil === "number" && Number.isFinite(tx.validUntil) ? tx.validUntil * 1000 : NaN;
          quote = {
            ...base, depositAddress: "",
            ...(Number.isFinite(until) ? {validUntilMs: Math.min(base.validUntilMs, until)} : {}),
            providerData: {...sealed, tonTo: m.address, tonValue: m.amount, tonBody: m.payload},
          };
        } else {
          if (tx.chainId !== src.id) return refuse(`Symbiosis built a transaction for chain ${String(tx.chainId)}, not ${src.name}`, "policy_refused");
          if (typeof tx.to !== "string" || typeof tx.data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(tx.data)) return refuse("Symbiosis returned no transaction", "upstream_unavailable");
          const value = tx.value === undefined || tx.value === null ? "0" : String(tx.value);
          if (!digits(value)) return refuse("Symbiosis returned a malformed transaction value", "upstream_unavailable");
          const gateway = gatewayAddress(src)!;
          const token = !!sell.contract;
          if (token && !sameText(r.approveTo, gateway)) return refuse(`Symbiosis asks to approve ${String(r.approveTo)}, not the pinned ${src.name} MetaRouterGateway`, "vault_mismatch");
          if (src.family === "tron") {
            if (tx.functionSelector !== SYMBIOSIS_META_ROUTE_SIGNATURE) return refuse("Symbiosis built a Tron call that is not metaRoute", "policy_refused");
            if (tx.from !== undefined && (typeof tx.from !== "string" || tronToEvm(tx.from) !== tronToEvm(sender))) return refuse("Symbiosis built the Tron call for another owner", "policy_refused");
            const limit = typeof tx.feeLimit === "number" && Number.isSafeInteger(tx.feeLimit) ? BigInt(tx.feeLimit) : digits(tx.feeLimit) ? BigInt(tx.feeLimit) : null;
            if (limit === null || limit <= 0n) return refuse("Symbiosis named no Tron fee limit", "upstream_unavailable");
            if (limit > tronFeeLimitCap) return refuse(`Symbiosis asks a Tron fee limit of ${limit} sun, above the ${tronFeeLimitCap} ceiling`, "policy_refused");
            if (tronToEvm(tx.to) === null) return refuse("Symbiosis returned a malformed Tron contract", "upstream_unavailable");
            quote = {
              ...base, depositAddress: "",
              txRequest: {to: tx.to, data: `${SYMBIOSIS_META_ROUTE_SELECTOR}${tx.data.slice(2)}`, value, chainId: src.id, gasLimit: limit.toString(), ...(token ? {approvalAddress: gateway} : {})},
              providerData: sealed,
            };
          } else {
            if (!isAddress(tx.to)) return refuse("Symbiosis returned a malformed contract address", "upstream_unavailable");
            quote = {
              ...base, depositAddress: "",
              txRequest: {to: getAddress(tx.to), data: tx.data, value, chainId: src.id, ...(token ? {approvalAddress: gateway} : {})},
              providerData: sealed,
            };
          }
        }

        // ── The transaction itself, against the request ──────────────────────
        const seen = symbiosisInspectQuote(request, quote, options);
        if ("refusal" in seen) {
          // The refused transaction swaps on an optional venue (1inch, for one, appends a tracking tag
          // to its call, which is then not the canonical encoding of one swap): ask again without
          // that venue instead of losing the pair. The new answer goes through every check above.
          const legs = (Array.isArray(r.routes) ? r.routes : []).map((x: {provider?: unknown}) => x?.provider)
            .filter((v, i, all): v is string => typeof v === "string" && OPTIONAL_PROVIDERS.includes(v) && !avoided.includes(v) && all.indexOf(v) === i);
          if (btc || legs.length === 0 || pass > OPTIONAL_PROVIDERS.length || !/^symbiosis: (source|destination) swap: /.test(seen.refusal)) return refuse(seen.refusal, notes.reasonOf(seen.refusal));
          avoided.push(...legs);
          await new Promise<void>((done) => setTimeout(done, RETRY_WAIT_MS));
          if (signal?.aborted) return refuse("aborted");
          continue;
        }
        const bound: SymbiosisBound | null = seen.bound;
        if (bound) {
          if (config.boundSourceOnly === true && bound.sourceSwap) return refuse("the route swaps on the source chain before bridging (boundSourceOnly)", "policy_refused");
          quote.providerData = {
            ...quote.providerData, sourceSwap: bound.sourceSwap ? "1" : "0", destSwap: bound.destSwap ? "1" : "0", serviceReverts: bound.serviceReverts ? "1" : "0",
            ...(bound.sourceSwap ? {sourceRouter: bound.sourceSwap} : {}), ...(bound.destSwap ? {destRouter: bound.destSwap} : {}),
          };
        }
        return quote;
        }
      } catch (err) {
        return refuse(redactUrls(err instanceof Error ? err.message : String(err)), refusalOf(err));
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const parsed = parseIntent(quote.intentId);
      if (!parsed) throw refusal("policy_refused", "swap2: malformed Symbiosis intent id");
      const chain = parsed.src.caip2;
      const tx = quote.txRequest;
      if (tx) {
        return {
          chain,
          to: tx.to ?? "",
          value: tx.value ?? "0",
          ...(tx.data ? {data: tx.data} : {}),
          ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}),
          ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
          ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}),
        };
      }
      const ton = symbiosisTonMessage(quote);
      if (parsed.src.family === "ton" && ton) return {chain, to: ton.to, value: ton.value, bodyBoc: ton.bodyBoc};
      if (parsed.src.family === "bitcoin" && quote.depositAddress) return {chain, to: quote.depositAddress, value: quote.sourceAmount};
      throw refusal("policy_refused", "swap2: Symbiosis quote carries no transaction");
    },

    /** Right before signing: the build is the quote's own transaction and still passes every check against the sealed request. */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const parsed = parseIntent(quote.intentId);
      const params = sealedParams(quote);
      if (!parsed || !params || symbiosisChain(params.sourceChain) !== parsed.src || symbiosisChain(params.destChain) !== parsed.dst) throw refusal("policy_refused", "symbiosis: quote carries no sealed request");
      if (!sourceOpen(parsed.src)) throw refusal("policy_refused", `symbiosis: ${parsed.src.name} sources are switched off`);
      if (Date.now() >= quote.validUntilMs) throw refusal("quote_expired", "symbiosis: the quote expired — re-quote");
      // The user's own EVM address comes from this provider's configuration, never from the quote.
      const why = symbiosisVerifyBuild(quote, tx, params, verifyOptions);
      if (why) throw tagged(new Error(why), notes.reasonOf(why));
      const q = quote.txRequest;
      if (q) {
        if (tx.to !== q.to || (tx.data ?? "") !== (q.data ?? "") || tx.value !== (q.value ?? "0") || tx.chainId !== q.chainId || tx.approvalAddress !== q.approvalAddress) {
          throw refusal("policy_refused", "symbiosis: the build differs from the quoted transaction");
        }
        if (parsed.src.family === "tron" && (!digits(tx.gasLimit) || BigInt(tx.gasLimit) > tronFeeLimitCap)) throw refusal("policy_refused", "symbiosis: Tron fee limit above the ceiling");
      } else if (parsed.src.family === "ton") {
        const m = symbiosisTonMessage(quote);
        if (!m || tx.to !== m.to || tx.value !== m.value || tx.bodyBoc !== m.bodyBoc) throw refusal("policy_refused", "symbiosis: the build differs from the quoted TON message");
      } else if (tx.value !== quote.sourceAmount) {
        throw refusal("policy_refused", "symbiosis: the Bitcoin payment is not the quoted amount");
      }
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const parsed = parseIntent(ref.intentId);
      if (!parsed) return {state: "failed"};
      const hash = ref.sourceTxHash;
      if (!hash) return {state: "pending"};
      if (!HASH_RE.test(hash)) return {state: "pending"};
      let detail: SymbiosisStatusDetail;
      try {
        const body = (await call(`/v2/tx/${parsed.src.id}/${encodeURIComponent(hash)}`, {timeoutMs: STATUS_TIMEOUT_MS})) as SymbiosisTxResponse;
        detail = symbiosisStatus(body, {dstChainId: parsed.dst.id, destToken: parsed.destToken});
      } catch {
        return {state: "pending"};
      }
      if (detail.code === 1) {
        // The API reports a stuck operation as "Pending"; the stuck lists say which ones are.
        const bare = hash.replace(/^0x/, "").toLowerCase();
        const lists = await Promise.all([SYMBIOSIS_REVERTER, ...parsed.owners].map(async (address) => {
          try {
            const list = await call(`/v1/stucked/${address}`, {timeoutMs: STATUS_TIMEOUT_MS});
            return Array.isArray(list) ? (list as {hash?: unknown; chainId?: unknown}[]) : [];
          } catch {
            return [];
          }
        }));
        if (lists.flat().some((s) => s?.chainId === parsed.src.id && typeof s.hash === "string" && s.hash.replace(/^0x/, "").toLowerCase() === bare)) {
          return {state: "refund-pending", depositReceived: true};
        }
      }
      return {state: detail.state, ...(detail.depositReceived !== undefined ? {depositReceived: detail.depositReceived} : {}), ...(detail.destTxHash ? {destTxHash: detail.destTxHash} : {})};
    },
  };
}
