/**
 * Across API V5 (`https://api.across.to/v1`) — the shapes this module will speak, and how its refusals are read.
 * SKELETON: no request is made from this file yet. The quoting layer arrives with an API key (dashboard.across.to,
 * server-side only) and Across's published V5 reference; until then the provider reports itself disabled.
 *
 * Source: Across's own integration skills for V5 (github.com/across-protocol/skills @ f4d425e6, `quote-and-execute`,
 * `tracking-transactions`, `security`), read 2026-11-15. The V5 reference pages and `openapi.yaml` were not published
 * then, so every response field below is typed as what an answer MAY carry: the adapter will read each one strictly
 * and hand the numbers to `build.ts` as a {@link NormalizedAcrossQuote}, never a transaction to sign.
 */
import {httpRefusal, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {ACROSS_API, acrossChain} from "./config.js";
import {ACROSS_DEFAULT_MAX_FEE_BPS, type AcrossRequest} from "./verify.js";
import type {NormalizedAcrossQuote} from "./build.js";

/** The V5 base this module will call (`ACROSS_API` + `/v1`). An app's own proxy may stand in front of it. */
export const ACROSS_API_V1 = `${ACROSS_API}/v1`;

export interface AcrossV5Token {
  chainId: number;
  address: string;
}

/** `POST /v1/quotes` body, exactly the fields this module sends (the API refuses any field it does not know). */
export interface AcrossV5QuoteRequest {
  origin: {token: AcrossV5Token; depositor: string; amount: string};
  destination: {token: AcrossV5Token; recipient: string; refundAddress?: string};
  amountType: "exact_input";
  /** What the client can do: approve a token and send a transaction on an EVM chain. No typed data, no submissions. */
  capabilities: {operations: readonly {kind: "approve_token" | "send_transaction"; ecosystem: "evm"}[]};
  /** An approval of exactly the funded amount — never `infinite`. */
  authorizationPolicy: {allowedTypes: readonly ["approval"]; approvalAmount: "exact"};
  /** The most value the user may lose between input and guaranteed output, in bps (the API's default is 5000). */
  maxFee: {bps: number};
}

/** One step of `nextActions`, as an answer may state it. Only `approve_token` and `send_transaction` will be read. */
export interface AcrossV5Action {
  kind?: unknown;
  id?: unknown;
  chainId?: unknown;
  ecosystem?: unknown;
  /** approve_token */
  tokenAddress?: unknown;
  spender?: unknown;
  amount?: unknown;
  /** send_transaction */
  to?: unknown;
  data?: unknown;
  value?: unknown;
}

/** `POST /v1/quotes` answer, as it may arrive (unverified: every field is read strictly by the adapter). */
export interface AcrossV5QuoteResponse {
  orderId?: unknown;
  /** RFC 3339; about 15 minutes after issue. */
  expiresAt?: unknown;
  /** Last instant the origin deposit may land. */
  originValidUntil?: unknown;
  expectedFillTimeMs?: unknown;
  origin?: {amount?: unknown; maxAmount?: unknown};
  destination?: {amount?: unknown; minAmount?: unknown};
  fee?: {transferFee?: unknown; appFee?: unknown; totalFee?: unknown; maxTransferFee?: unknown; maxTotalFee?: unknown};
  gasEstimates?: unknown;
  refundPolicy?: unknown;
  refundTo?: unknown;
  nextActions?: readonly AcrossV5Action[];
}

/** `GET /v1/transfers/{orderId}` → `status`. Branch on `state`, never on `description`; stop at `isTerminal`. */
export interface AcrossV5TransferStatus {
  state?: "pending" | "completed" | "refunded" | "failed";
  reason?: string;
  description?: string;
  isTerminal?: boolean;
  finalized?: boolean;
}

/**
 * The `POST /v1/quotes` body for a request. Pure: the adapter sends it. `maxFee.bps` is the request's own fee cap, the
 * same number `verify.ts` holds the deposit to, so the API is asked for no more than the device will sign.
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
    maxFee: {bps: request.maxFeeBps ?? ACROSS_DEFAULT_MAX_FEE_BPS},
  };
}

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
  /** The CS-13 classification; undefined when neither the code nor the status says what it is. */
  info?: Swap2RefusalInfo;
  /**
   * `409 conflict.submission_state_unknown`: the execution's outcome is unknown — retry the SAME request with backoff,
   * never quote again (a new quote could fund the transfer twice).
   */
  retrySameRequest: boolean;
}

const text = (v: unknown, max: number): string | undefined => (typeof v === "string" && v.length > 0 ? v.slice(0, max) : undefined);

/** What an error code says on its own (Across's documented codes), before the HTTP status is consulted. */
function reasonOfCode(code: string, message: string | undefined, status: number): Swap2RefusalInfo | undefined {
  switch (code) {
    case "unauthenticated":
    case "auth.missing_credentials":
    case "auth.invalid_credentials":
    // A feature the key is not entitled to (a permission Across grants per integration).
    case "permission.not_entitled":
      return {reason: "key_rejected", httpStatus: status};
    case "policy.amount_out_of_range": {
      // "Amount the route cannot clear, or fee above maxFee": the direction, when the text gives it, decides.
      const m = (message ?? "").toLowerCase();
      if (/\b(?:too low|too small|below|minimum|min)\b/.test(m)) return {reason: "amount_too_small"};
      if (/\b(?:too high|too large|above|maximum|max|liquidity)\b/.test(m)) return {reason: "amount_too_large"};
      return {reason: "price_check_failed"};
    }
    // The API no longer takes what this module sends: an answer of another shape than the one it was built against.
    case "request.unsupported_param":
      return {reason: "upstream_unavailable", httpStatus: status};
    case "request.invalid_field":
      return {reason: "policy_refused"};
    case "conflict.submission_state_unknown":
      return {reason: "upstream_unavailable", httpStatus: status};
    case "not_found.transfer":
      return undefined;
    default:
      return undefined;
  }
}

/**
 * Read a non-2xx V5 answer: the two envelopes Across documents — flat `{code, message, details}` and nested
 * `{error: {type, code, message, param, requestId}}` — and its CS-13 classification. A 429 is `rate_limited` with its
 * Retry-After first; then the code; then the status (401 / 403 → `key_rejected`, 408 / 425 / 5xx →
 * `upstream_unavailable`); a JSON refusal neither names is a quote the API does not have (`no_route`).
 */
export function parseAcrossV5Error(status: number, body: unknown, retryAfter?: string | null, nowMs: number = Date.now()): AcrossV5Error {
  const o = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  const nested = o?.["error"] !== null && typeof o?.["error"] === "object" ? (o["error"] as Record<string, unknown>) : undefined;
  const code = text(nested?.["code"], 80) ?? text(o?.["code"], 80);
  const type = text(nested?.["type"], 80);
  const message = text(nested?.["message"], 240) ?? text(o?.["message"], 240);
  const param = text(nested?.["param"], 80);
  const requestId = text(nested?.["requestId"], 120);
  const byStatus = httpRefusal(status, retryAfter, nowMs);
  let info: Swap2RefusalInfo | undefined;
  if (byStatus?.reason === "rate_limited") info = byStatus;
  else info = (code !== undefined ? reasonOfCode(code, message, status) : undefined) ?? byStatus ?? (o !== undefined && status >= 400 && status < 500 && status !== 404 ? {reason: "no_route"} : undefined);
  return {
    status,
    ...(code !== undefined ? {code} : {}),
    ...(type !== undefined ? {type} : {}),
    ...(message !== undefined ? {message} : {}),
    ...(param !== undefined ? {param} : {}),
    ...(requestId !== undefined ? {requestId} : {}),
    ...(info !== undefined ? {info} : {}),
    retrySameRequest: status === 409 && code === "conflict.submission_state_unknown",
  };
}

/**
 * Placeholder for the V5 adapter: turns an answer into a {@link NormalizedAcrossQuote}. Not implemented in this build —
 * which V5 action funds a plain SpokePool deposit, and where its numbers sit, is not documented yet.
 */
export type AcrossV5Normalizer = (request: AcrossRequest, answer: AcrossV5QuoteResponse) => NormalizedAcrossQuote;
