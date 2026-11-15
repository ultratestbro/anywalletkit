/**
 * The two Across APIs this module reads — for NUMBERS only. Nothing either one answers is signed or executed: the
 * deposit is encoded on the device from the pins and the user's request (`build.ts`) and verified (`verify.ts`).
 *
 *  - **Across API V5** (`POST https://api.across.to/v1/quotes`, a key from dashboard.across.to, server-side only) is
 *    the price source. A V5 quote prices V5's own route — an execution step on the origin chain (Across's Gateway),
 *    sometimes another rail (CCTP, an OFT) — and funds it through `nextActions` that pay an escrow keyed by an order
 *    id the device cannot open (the recipient, the destination and the floor are not in anything it would sign). So
 *    `nextActions`, `orderId`, `minAmount` and the attestation are never read: only the fee, its gas legs, the fill
 *    estimate and the USD prices, each read strictly ({@link readAcrossV5Quote}).
 *  - **`/suggested-fees`** (`GET https://app.across.to/api/suggested-fees`, keyless, the Across app's own relayer-fee
 *    quote — Across calls it legacy) is the independent statement of what an Across relayer needs to fill a plain
 *    SpokePool deposit, and the `timestamp` its LP fee was priced at ({@link readAcrossSuggestedFees}).
 *
 * `pricing.ts` turns the two into the deposit's numbers. Sources: Across's V5 integration skills
 * (github.com/across-protocol/skills @ f4d425e6, `quote-and-execute`, `security`) and real answers of both APIs
 * recorded 2026-11-15 (fixtures/api).
 */
import {httpRefusal, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {anySignal, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {ACROSS_API, acrossChain, type AcrossRoute} from "./config.js";
import {AcrossRefusal} from "./refusal.js";
import type {AcrossRequest} from "./verify.js";

/** The V5 base (`ACROSS_API` + `/v1`). */
export const ACROSS_API_V1 = `${ACROSS_API}/v1`;
/** Across's keyless relayer-fee quote (the Across app's own `/suggested-fees`). */
export const ACROSS_SUGGESTED_FEES_URL = "https://app.across.to/api/suggested-fees";
/**
 * `maxFee.bps` sent with every V5 quote request: the widest V5 takes. It only bounds V5's own guaranteed minimum,
 * which is never used here (V5's estimate does not move with it: 24 962 036 / 24 962 140 / 24 963 399 base units for
 * the same 25 USDC at three caps, 2026-11-14); at 1000 V5 refused Ethereum-origin transfers under ~$16.5–19 because
 * its own origin gas alone was over the cap. The user's own cap is held on the deposit, by the verifier.
 */
export const ACROSS_V5_PRICING_MAX_FEE_BPS = 5_000;
/** Longest answer read from either API, in characters (a V5 quote is ~12 kB). */
const MAX_ANSWER_CHARS = 512 * 1024;

export interface AcrossV5Token {
  chainId: number;
  address: string;
}

/** `POST /v1/quotes` body, exactly the fields this module sends (the API refuses any field it does not know). */
export interface AcrossV5QuoteRequest {
  origin: {token: AcrossV5Token; depositor: string; amount: string};
  destination: {token: AcrossV5Token; recipient: string};
  amountType: "exact_input";
  /** What the client can do: approve a token and send a transaction on an EVM chain. No typed data, no submissions. */
  capabilities: {operations: readonly {kind: "approve_token" | "send_transaction"; ecosystem: "evm"}[]};
  /** An approval of exactly the funded amount — never `infinite`. */
  authorizationPolicy: {allowedTypes: readonly ["approval"]; approvalAmount: "exact"};
  /** {@link ACROSS_V5_PRICING_MAX_FEE_BPS}. */
  maxFee: {bps: number};
}

/**
 * The `POST /v1/quotes` body for a request. Pure. Native ETH is the zero address on both sides, as V5 names it; the
 * funding is the plain approval flow (`approve_token` + `send_transaction`, exact amount) — the one whose price was
 * studied; nothing it returns is executed.
 */
export function acrossV5QuoteRequest(request: AcrossRequest): AcrossV5QuoteRequest {
  const src = acrossChain(request.sourceChain);
  const dst = acrossChain(request.destChain);
  if (!src || !dst) throw new Error("across: the request's chains are not pinned");
  return {
    origin: {token: {chainId: src.chainId, address: request.sourceToken.toLowerCase()}, depositor: request.depositor.toLowerCase(), amount: request.amount.toString(10)},
    destination: {token: {chainId: dst.chainId, address: request.destToken.toLowerCase()}, recipient: request.recipient.toLowerCase()},
    amountType: "exact_input",
    capabilities: {operations: [{kind: "approve_token", ecosystem: "evm"}, {kind: "send_transaction", ecosystem: "evm"}]},
    authorizationPolicy: {allowedTypes: ["approval"], approvalAmount: "exact"},
    maxFee: {bps: ACROSS_V5_PRICING_MAX_FEE_BPS},
  };
}

// ── reading answers ────────────────────────────────────────────────────────────

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
const UINT = /^(?:0|[1-9]\d{0,77})$/;
/** A non-negative decimal as V5 writes USD amounts ("0.012048778559999999"). */
const DECIMAL = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,30})?$/;
const plain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o: Record<string, unknown>, key: string): unknown => (Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined);
const uint = (v: unknown): bigint | null => (typeof v === "string" && UINT.test(v) ? BigInt(v) : null);
const sameAddress = (a: unknown, b: string): boolean => typeof a === "string" && ADDRESS.test(a) && a.toLowerCase() === b.toLowerCase();

/** A decimal string as an integer scaled by 10^`scale`, rounded down; null when it is not one. */
function scaled(text: string, scale: number): bigint | null {
  if (!DECIMAL.test(text)) return null;
  const [whole, frac = ""] = text.split(".");
  return BigInt(whole! + frac.slice(0, scale).padEnd(scale, "0"));
}

const USD_SCALE = 18;
const PRICE_SCALE = 12;

/**
 * A USD amount as base units of a token priced at `priceUsd`, rounded down — integer math only (no `Number` of a big
 * value): `amountUsd × 10^decimals / priceUsd`. Null when either is not a usable number.
 */
export function acrossUsdToUnits(amountUsd: unknown, priceUsd: unknown, decimals: number): bigint | null {
  if (typeof amountUsd !== "string" || typeof priceUsd !== "number" || !Number.isFinite(priceUsd) || priceUsd <= 0 || priceUsd >= 1e12) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;
  const usd = scaled(amountUsd, USD_SCALE);
  const price = scaled(priceUsd.toFixed(PRICE_SCALE), PRICE_SCALE);
  if (usd === null || price === null || price === 0n) return null;
  return (usd * 10n ** BigInt(decimals) * 10n ** BigInt(PRICE_SCALE)) / (price * 10n ** BigInt(USD_SCALE));
}

/** What a V5 quote says that the pricing rule reads — every amount in base units of the input token. */
export interface AcrossV5Price {
  /** `fee.totalFee.amount`: input − `destination.amount` (checked to add up). */
  totalFee: bigint;
  /** V5's estimate of what arrives (`destination.amount`). */
  destinationAmount: bigint;
  /**
   * Σ `gasEstimates[leg = "origin", effect = "included_in_transfer_fee"]`: V5's own execution step on the origin
   * chain, charged inside its fee. Exact wei on an ETH route; a token route converts its USD figure at the
   * destination token's price, rounded down. A leg that cannot be read adds nothing (the fee stays higher).
   */
  originGas: bigint;
  /** Σ `gasEstimates[leg = "destination", effect = "included_in_transfer_fee"]`, converted alike; null when a leg cannot be. */
  destinationGas: bigint | null;
  /** `expectedFillTimeMs`. Over a minute it is not an Across relayer fill: V5 prices another rail (`acrossV5OtherRail`). */
  expectedFillTimeMs: number;
  /** `origin.amountUsd`, when given: the transfer's size in dollars (the floor curve for ETH from an L2 is by size). */
  amountUsd?: number;
}

/**
 * A V5 quote answer, read strictly against the request it was asked for. Throws {@link AcrossRefusal} `api-answer`:
 * `policy_refused` for an answer about another transfer (tokens, chains, amount, an app fee nobody asked for),
 * `upstream_unavailable` for one that does not read or does not add up. `nextActions`, `orderId`, `minAmount` and any
 * attestation are not read.
 */
export function readAcrossV5Quote(request: AcrossRequest, route: AcrossRoute, body: unknown): AcrossV5Price {
  const malformed = (what: string): never => { throw new AcrossRefusal("api-answer", `the V5 quote ${what}`, "upstream_unavailable"); };
  const other = (what: string): never => { throw new AcrossRefusal("api-answer", `the V5 quote ${what}`, "policy_refused"); };
  if (!plain(body)) return malformed("is not a JSON object");
  const amountType = own(body, "amountType");
  if (amountType !== undefined && amountType !== "exact_input") other(`is ${String(amountType).slice(0, 20)}, not exact input`);
  const src = route.input.chain;
  const dst = route.output.chain;

  const origin = own(body, "origin");
  const destination = own(body, "destination");
  if (!plain(origin) || !plain(destination)) return malformed("has no origin or destination");
  const oToken = own(origin, "token");
  const dToken = own(destination, "token");
  if (!plain(oToken) || !plain(dToken)) return malformed("names no tokens");
  if (own(oToken, "chainId") !== src.chainId || !sameAddress(own(oToken, "address"), request.sourceToken)) other("is for another input token or chain");
  if (own(dToken, "chainId") !== dst.chainId || !sameAddress(own(dToken, "address"), request.destToken)) other("is for another output token or chain");
  const amountIn = uint(own(origin, "amount"));
  if (amountIn === null) return malformed("states no input amount");
  if (amountIn !== request.amount) other(`sends ${amountIn}, the request ${request.amount}`);
  const destinationAmount = uint(own(destination, "amount"));
  if (destinationAmount === null) return malformed("states no output estimate");
  if (destinationAmount > request.amount) other("expects more to arrive than goes in");

  const fee = own(body, "fee");
  if (!plain(fee)) return malformed("has no fee");
  const total = own(fee, "totalFee");
  if (!plain(total)) return malformed("has no total fee");
  const totalFee = uint(own(total, "amount"));
  if (totalFee === null) return malformed("states a total fee that is not a base-unit integer");
  const feeToken = own(total, "token");
  if (!plain(feeToken) || own(feeToken, "chainId") !== dst.chainId || !sameAddress(own(feeToken, "address"), request.destToken) || own(feeToken, "decimals") !== route.output.decimals) {
    malformed("states its fee in another token");
  }
  if (totalFee !== request.amount - destinationAmount) malformed(`fee ${totalFee} is not its input minus its estimate (${request.amount - destinationAmount})`);
  const appFee = own(fee, "appFee");
  if (appFee !== undefined && appFee !== null) {
    const app = plain(appFee) ? uint(own(appFee, "amount")) : null;
    if (app === null) return malformed("states an app fee that does not read");
    if (app > 0n) other("carries an app fee this module never asks for");
  }

  const fill = own(body, "expectedFillTimeMs");
  if (typeof fill !== "number" || !Number.isFinite(fill) || fill < 0) return malformed("states no fill time");
  const priceUsd = own(dToken, "priceUsd");
  const legs = own(body, "gasEstimates");
  if (!Array.isArray(legs) || legs.length > 16) return malformed("has no gas estimates");
  let originGas = 0n;
  let destinationGas: bigint | null = 0n;
  for (const leg of legs as unknown[]) {
    if (!plain(leg)) return malformed("has a gas estimate that is not an object");
    if (own(leg, "effect") !== "included_in_transfer_fee") continue;
    const side = own(leg, "leg");
    if (side !== "origin" && side !== "destination") continue;
    const units = legUnits(leg, route, priceUsd);
    if (side === "origin") originGas += units ?? 0n;
    else destinationGas = units === null || destinationGas === null ? null : destinationGas + units;
  }
  // An add-back is never more than the fee it is taken from.
  if (originGas > totalFee) originGas = totalFee;

  const usdText = own(origin, "amountUsd");
  const amountUsd = typeof usdText === "string" && DECIMAL.test(usdText) ? Number(usdText) : undefined;
  return {totalFee, destinationAmount, originGas, destinationGas, expectedFillTimeMs: fill, ...(amountUsd !== undefined && Number.isFinite(amountUsd) ? {amountUsd} : {})};
}

/**
 * One gas leg in base units of the input token. On an ETH route a leg paid in the native ether of either chain is
 * exact (wei is the bridged asset's own unit); anything else is its `amountUsd` at the destination token's price.
 */
function legUnits(leg: Record<string, unknown>, route: AcrossRoute, priceUsd: unknown): bigint | null {
  const token = own(leg, "token");
  const amount = uint(own(leg, "amount"));
  if (route.asset === "ETH" && plain(token) && amount !== null && ZERO.test(String(own(token, "address"))) && own(token, "decimals") === 18) {
    const chainId = own(token, "chainId");
    const side = chainId === route.input.chain.chainId ? route.input.chain : chainId === route.output.chain.chainId ? route.output.chain : undefined;
    if (side?.nativeIsEth) return amount;
  }
  return acrossUsdToUnits(own(leg, "amountUsd"), priceUsd, route.input.decimals);
}

/** What `/suggested-fees` answered, as the pricing rule reads it. */
export type AcrossSuggestedFees =
  /** A relayer fee for this exact deposit. */
  | {kind: "fees"; totalRelayFee: bigint; timestamp: number; estimatedFillTimeSec: number}
  /** Across says relayers will not take this deposit (too small, too large, the route not enabled): refuse. */
  | {kind: "refused"; detail: string; reason: Swap2RefusalReason}
  /** No usable answer (unreachable, another shape, stale): the pinned floor stands in. */
  | {kind: "unavailable"; detail: string};

/** The `/suggested-fees` query for a request: the deposit's own tokens (the wrapped native token for ETH) and recipient. */
export function acrossSuggestedFeesQuery(request: AcrossRequest, route: AcrossRoute): string {
  const q: [string, string][] = [
    ["inputToken", route.input.token],
    ["outputToken", route.output.token],
    ["originChainId", String(route.input.chain.chainId)],
    ["destinationChainId", String(route.output.chain.chainId)],
    ["amount", request.amount.toString(10)],
    ["recipient", request.recipient.toLowerCase()],
  ];
  return q.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
}

/**
 * How old a `/suggested-fees` timestamp may be (s). It becomes the deposit's quote time, so it is never taken from
 * ahead of the reader's clock: the SpokePool reverts a quote time ahead of its block, and Across's are HubPool block
 * times minutes in the past (217–245 s on every recorded answer).
 */
export const ACROSS_SUGGESTED_FEES_MAX_AGE_S = 600;
export const ACROSS_SUGGESTED_FEES_MAX_AHEAD_S = 0;

/**
 * A `/suggested-fees` answer for a request, at `nowS`. Across's own refusals of the deposit — any 400 it answers
 * (`AMOUNT_TOO_LOW`, `AMOUNT_TOO_HIGH`, `ROUTE_NOT_ENABLED`, `INVALID_PARAM` for a token or a chain it does not serve,
 * or a code this module does not know), `isAmountTooLow`, an amount outside `limits` — and a SpokePool other than the
 * pinned one are `refused`; no answer, another status, or one that is not a clean, consistent, fresh answer is
 * `unavailable` (the pinned floor may then stand in).
 */
export function readAcrossSuggestedFees(request: AcrossRequest, route: AcrossRoute, status: number, body: unknown, nowS: number): AcrossSuggestedFees {
  const unavailable = (detail: string): AcrossSuggestedFees => ({kind: "unavailable", detail});
  const refused = (detail: string, reason: Swap2RefusalReason): AcrossSuggestedFees => ({kind: "refused", detail, reason});
  if (status !== 200) {
    const code = plain(body) ? own(body, "code") : undefined;
    const label = typeof code === "string" ? ` ${code.slice(0, 40)}` : "";
    if (status === 400) {
      if (code === "AMOUNT_TOO_LOW") return refused("Across's relayer fee quote says the amount is too low relative to fees", "amount_too_small");
      if (code === "AMOUNT_TOO_HIGH") return refused("Across's relayer fee quote says the amount is higher than relayer liquidity", "amount_too_large");
      if (code === "ROUTE_NOT_ENABLED") return refused("Across's relayer fee quote says this route is not enabled for relayers", "unsupported_pair");
      // Only pinned tokens and chains are asked for: one Across calls invalid ("Unsupported token on given origin
      // chain") is one its relayers do not serve — a deposit priced on the floor for it would never be filled.
      const param = plain(body) ? own(body, "param") : undefined;
      const message = plain(body) ? own(body, "message") : undefined;
      if (code === "INVALID_PARAM" && /token|chain/i.test(`${typeof param === "string" ? param : ""} ${typeof message === "string" ? message : ""}`)) {
        return refused(`Across's relayer fee quote does not serve this token or chain (INVALID_PARAM${typeof param === "string" ? ` ${param.slice(0, 40)}` : ""})`, "unsupported_pair");
      }
      // Any other refusal of this exact deposit: Across said no, so nothing stands in for its price.
      return refused(`Across's relayer fee quote refused the deposit (HTTP 400${label})`, "upstream_unavailable");
    }
    return unavailable(`it answered HTTP ${status}${label}`);
  }
  if (!plain(body)) return unavailable("its answer is not a JSON object");
  const inputToken = own(body, "inputToken");
  const outputToken = own(body, "outputToken");
  if (!plain(inputToken) || !plain(outputToken)) return unavailable("its answer names no tokens");
  if (!sameAddress(own(inputToken, "address"), route.input.token) || own(inputToken, "chainId") !== route.input.chain.chainId
    || !sameAddress(own(outputToken, "address"), route.output.token) || own(outputToken, "chainId") !== route.output.chain.chainId) {
    return unavailable("its answer is for another route");
  }
  // The SpokePools relayers watch for this route: the pinned ones, or the pins are out of date.
  const spoke = own(body, "spokePoolAddress");
  const destSpoke = own(body, "destinationSpokePoolAddress");
  const spokeMoved = spoke !== undefined && !sameAddress(spoke, route.input.chain.spokePool);
  if (spokeMoved || (destSpoke !== undefined && !sameAddress(destSpoke, route.output.chain.spokePool))) {
    return refused(`Across quotes this route on another SpokePool than the one pinned for ${spokeMoved ? route.input.chain.name : route.output.chain.name} — the pins need a review`, "vault_mismatch");
  }
  const totalRelay = own(body, "totalRelayFee");
  const total = plain(totalRelay) ? uint(own(totalRelay, "total")) : null;
  const outputAmount = uint(own(body, "outputAmount"));
  if (total === null || outputAmount === null) return unavailable("its answer states no relayer fee");
  if (outputAmount + total !== request.amount) return unavailable("its fee is not the amount minus its output");
  if (own(body, "isAmountTooLow") === true || total >= request.amount) return refused("Across's relayer fee quote says the amount is too low relative to fees", "amount_too_small");
  const limits = own(body, "limits");
  if (plain(limits)) {
    const min = uint(own(limits, "minDeposit"));
    const max = uint(own(limits, "maxDeposit"));
    if (min !== null && request.amount < min) return refused(`Across's relayers take at least ${min} base units on this route`, "amount_too_small");
    if (max !== null && request.amount > max) return refused(`Across's relayers take at most ${max} base units on this route`, "amount_too_large");
  }
  const ts = own(body, "timestamp");
  const timestamp = typeof ts === "string" && /^[1-9]\d{8,9}$/.test(ts) ? Number(ts) : NaN;
  if (!Number.isInteger(timestamp)) return unavailable("its answer states no quote time");
  if (timestamp - nowS > ACROSS_SUGGESTED_FEES_MAX_AHEAD_S) return unavailable(`its quote time is ${timestamp - nowS} s ahead of this clock`);
  if (nowS - timestamp > ACROSS_SUGGESTED_FEES_MAX_AGE_S) return unavailable(`its quote time is ${nowS - timestamp} s old`);
  const eta = own(body, "estimatedFillTimeSec");
  return {kind: "fees", totalRelayFee: total, timestamp, estimatedFillTimeSec: typeof eta === "number" && Number.isFinite(eta) && eta >= 0 ? eta : 2};
}

// ── V5 errors ──────────────────────────────────────────────────────────────────

/** A V5 error answer, read from either envelope, with its classification. */
export interface AcrossV5Error {
  /** HTTP status of the answer. */
  status: number;
  /** `error.code`, else the top-level `code` (`unauthenticated`, `policy.amount_out_of_range`, …). */
  code?: string;
  /** `error.type` (nested envelope only). */
  type?: string;
  message?: string;
  /** The field the error names (`error.param`). */
  param?: string;
  /** Across's id for the request, for support (`error.requestId`). */
  requestId?: string;
  /** `error.details.amountLimits`: which bound the amount crossed and where it lies, base units of the input token. */
  amountLimit?: {side: "min" | "max"; amount?: string};
  /** The CS-13 classification; undefined when neither the code nor the status says what it is. */
  info?: Swap2RefusalInfo;
  /**
   * `409 conflict.submission_state_unknown`: the execution's outcome is unknown — retry the SAME request with backoff,
   * never quote again (a new quote could fund the transfer twice). Quoting never meets it; kept for completeness.
   */
  retrySameRequest: boolean;
}

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);

/**
 * A refusal over the `maxFee` cap, in Across's wording or near it: the cap named (`maxFee`, "maximum fee", "fee cap"),
 * or a fee said to be above something. "Amount too low to cover fees" is not one — that is the amount's own direction.
 */
const FEE_CAP = /\bmax[ _-]?fee\b|\bmaximum (?:total |transfer )?fee\b|\bfee (?:cap|limit)\b|\bfees? (?:is |are )?(?:above|exceeds?|over|greater than|more than)\b/;

/** What an error code says on its own (Across's documented codes), before the HTTP status is consulted. */
function reasonOfCode(code: string, message: string | undefined, param: string | undefined, side: "min" | "max" | undefined, status: number): Swap2RefusalInfo | undefined {
  switch (code) {
    case "unauthenticated":
    case "auth.missing_credentials":
    case "auth.invalid_credentials":
    // A feature the key is not entitled to (a permission Across grants per integration).
    case "permission.not_entitled":
      return {reason: "key_rejected", httpStatus: status};
    case "policy.amount_out_of_range": {
      // The bound V5 names is the answer: the real fee-cap refusal reads "quote value loss exceeds the allowance of
      // 1000 bps plus $0; raise the amount above N base units" with `amountLimits.side = "min"` — its "above" names
      // the amount the user must reach, not an amount that is too large.
      if (side === "min") return {reason: "amount_too_small"};
      if (side === "max") return {reason: "amount_too_large"};
      const m = (message ?? "").toLowerCase();
      if (/\b(?:raise|increase) the amount\b/.test(m)) return {reason: "amount_too_small"};
      if (/\b(?:lower|reduce|decrease) the amount\b/.test(m)) return {reason: "amount_too_large"};
      if (FEE_CAP.test(m)) return {reason: "price_check_failed"};
      if (/\b(?:too low|too small|below|minimum|min)\b/.test(m)) return {reason: "amount_too_small"};
      if (/\b(?:too high|too large|above|maximum|max|liquidity)\b/.test(m)) return {reason: "amount_too_large"};
      return {reason: "price_check_failed"};
    }
    // The API no longer takes what this module sends (a field it does not know, or one it now requires): an API of
    // another shape than the one this module was built against.
    case "request.unsupported_param":
    case "request.missing_field":
      return {reason: "upstream_unavailable", httpStatus: status};
    // Only pinned tokens and chains are sent: one V5 calls invalid ("unknown token … is not a known token") is one it
    // does not serve. Any other value it no longer takes is, like the codes above, an API of another shape.
    case "request.invalid_field":
      return /token|chain/i.test(`${param ?? ""} ${message ?? ""}`) ? {reason: "unsupported_pair"} : {reason: "upstream_unavailable", httpStatus: status};
    case "system.unavailable":
    case "conflict.submission_state_unknown":
      return {reason: "upstream_unavailable", httpStatus: status};
    default:
      return undefined;
  }
}

/**
 * Read a non-2xx V5 answer: the two envelopes Across uses — flat `{code, message, details}` (the gateway's 401) and
 * nested `{error: {type, code, message, param, requestId, details}}` — and its CS-13 classification. A 429 is
 * `rate_limited` with its Retry-After first; then the code (with `details.amountLimits.side` for
 * `policy.amount_out_of_range`); then the status (401 / 403 → `key_rejected`, 408 / 425 / 5xx →
 * `upstream_unavailable`); a JSON refusal neither names is a quote the API does not have (`no_route`).
 */
export function parseAcrossV5Error(status: number, body: unknown, retryAfter?: string | null, nowMs: number = Date.now()): AcrossV5Error {
  const o = plain(body) ? body : undefined;
  const nested = o !== undefined && plain(o["error"]) ? o["error"] : undefined;
  const code = text(nested?.["code"], 80) ?? text(o?.["code"], 80);
  const type = text(nested?.["type"], 80);
  const message = text(nested?.["message"], 240) ?? text(o?.["message"], 240);
  const param = text(nested?.["param"], 80);
  const requestId = text(nested?.["requestId"], 120);
  const details = nested !== undefined && plain(nested["details"]) ? nested["details"] : o !== undefined && plain(o["details"]) ? o["details"] : undefined;
  const limits = details !== undefined && plain(details["amountLimits"]) ? details["amountLimits"] : undefined;
  const rawSide = limits?.["side"];
  const side = rawSide === "min" || rawSide === "max" ? rawSide : undefined;
  const rawBound = limits?.["amount"];
  const bound = typeof rawBound === "string" && UINT.test(rawBound) ? rawBound : undefined;
  const byStatus = httpRefusal(status, retryAfter, nowMs);
  let info: Swap2RefusalInfo | undefined;
  if (byStatus?.reason === "rate_limited") info = byStatus;
  else info = (code !== undefined ? reasonOfCode(code, message, param, side, status) : undefined) ?? byStatus ?? (o !== undefined && status >= 400 && status < 500 && status !== 404 ? {reason: "no_route"} : undefined);
  return {
    status,
    ...(code !== undefined ? {code} : {}),
    ...(type !== undefined ? {type} : {}),
    ...(message !== undefined ? {message} : {}),
    ...(param !== undefined ? {param} : {}),
    ...(requestId !== undefined ? {requestId} : {}),
    ...(side !== undefined ? {amountLimit: {side, ...(bound !== undefined ? {amount: bound} : {})}} : {}),
    ...(info !== undefined ? {info} : {}),
    retrySameRequest: status === 409 && code === "conflict.submission_state_unknown",
  };
}

// ── HTTP ───────────────────────────────────────────────────────────────────────

/** An API URL, trailing slashes trimmed; throws a plain `Error` unless https (or http on this machine). */
export function acrossApiUrl(url: string, what: string): string {
  const u = String(url).trim().replace(/\/+$/, "");
  if (/^https:\/\/[^\s/?#@]+(?:\/[^\s?#]*)?$/i.test(u)) return u;
  if (/^http:\/\/(?:localhost|127\.0\.0\.1)(?::[0-9]{1,5})?(?:\/[^\s?#]*)?$/i.test(u)) return u;
  throw new Error(`across: ${what} must be an https:// URL (http only for localhost)`);
}

/** `scheme://host[:port]` of a URL, lowercase; "" when it has none. No URL class: React Native's lacks `origin`. */
export const acrossOriginOf = (url: string): string => (/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0] ?? "").toLowerCase();

/** An answer as read: status, parsed body (undefined when not JSON), Retry-After. */
export interface AcrossHttpAnswer {
  status: number;
  body: unknown;
  retryAfter: string | null;
}

/**
 * One request to an Across API, bounded by `timeoutMs` (and the caller's signal). An answer that came through a
 * redirect, or from another origin than the URL's, is refused (`policy_refused`) — a key header must not follow one,
 * and React Native's fetch follows redirects whatever `redirect` says. Throws {@link AcrossRefusal} `api-answer` for a
 * redirect, an answer larger than any quote, or no answer (`upstream_unavailable`; unclassified when the caller's own
 * signal fired).
 */
export async function acrossHttp(
  url: string,
  init: {method: "GET" | "POST"; headers: Record<string, string>; body?: string},
  opts: {fetchImpl?: typeof fetch | undefined; timeoutMs: number; signal?: AbortSignal | undefined; what: string},
): Promise<AcrossHttpAnswer> {
  const expected = acrossOriginOf(url);
  let status: number;
  let raw: string;
  let retryAfter: string | null = null;
  try {
    const timeout = timeoutSignal(opts.timeoutMs);
    const res = await (opts.fetchImpl ?? fetch)(url, {...init, redirect: "error", signal: opts.signal ? anySignal([opts.signal, timeout]) : timeout});
    if (res.redirected === true || (typeof res.url === "string" && res.url !== "" && acrossOriginOf(res.url) !== expected)) {
      throw new AcrossRefusal("api-answer", `${opts.what} answered through a redirect or from another origin — refused (a key must not follow one)`, "policy_refused");
    }
    status = res.status;
    retryAfter = res.headers?.get?.("retry-after") ?? null;
    raw = await res.text();
  } catch (err) {
    if (err instanceof AcrossRefusal) throw err;
    const name = err instanceof Error ? err.name.slice(0, 40) : "error";
    throw new AcrossRefusal("api-answer", `${opts.what} did not answer (${name})`, opts.signal?.aborted ? undefined : "upstream_unavailable");
  }
  if (raw.length > MAX_ANSWER_CHARS) throw new AcrossRefusal("api-answer", `${opts.what} answered more than any quote`, "upstream_unavailable");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = undefined;
  }
  return {status, body, retryAfter};
}
