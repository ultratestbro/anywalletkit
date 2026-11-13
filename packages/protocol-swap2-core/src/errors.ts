/**
 * Which stage of a swap failed: configuration, input validation, quote, execution, an unsupported
 * operation, a fee ceiling, or status tracking.
 */
export type Swap2ErrorCode =
  | "CONFIGURATION"
  | "VALIDATION"
  | "QUOTE"
  | "EXECUTION"
  | "UNSUPPORTED_OPERATION"
  | "FEE_LIMIT"
  | "STATUS";

/**
 * Why a venue or the engine refused, as a stable value an app can switch on. The refusal's text is
 * unchanged and stays the human-readable account; `reason` only classifies it.
 *
 * - `no_route`: the venue has no route for this request, or the venues that sat out did so for
 *   different reasons (the engine's "no route available").
 * - `unsupported_pair`: the venue does not serve this chain, token, pair, direction or flow.
 * - `amount_too_small` / `amount_too_large`: outside the venue's limits (fees above the output count as too small).
 * - `insufficient_liquidity`: the venue reports too little liquidity for the amount.
 * - `rate_limited`: the venue throttled the request; `retryAfterMs` when it said how long to wait.
 * - `key_rejected`: the venue rejected the API key (or its absence).
 * - `upstream_unavailable`: the venue failed, timed out or answered in another shape; `httpStatus` when there was one.
 * - `chain_halted`: the chain, its trading or the venue's handling of it is halted or paused.
 * - `recipient_unverifiable`: the transaction does not bind the delivery to a recipient this side can check.
 * - `recipient_mismatch`: the transaction pays or refunds an address other than the requested one, or one that cannot receive.
 * - `vault_mismatch`: the deposit target (vault, inbound address, router, escrow, settlement contract) is not the
 *   confirmed or pinned one.
 * - `stale_node`: the node or indexer that answered trails the chain too far to be trusted.
 * - `quote_expired`: the quote or its deadline ran out.
 * - `price_check_failed`: the output, floor, slippage or value fails the check.
 * - `simulation_failed`: the transaction reverted in simulation or preflight.
 * - `policy_refused`: a policy of the app or the SDK refuses it (fee caps, sponsorship, addresses the app did not allow).
 */
export type Swap2RefusalReason =
  | "no_route"
  | "unsupported_pair"
  | "amount_too_small"
  | "amount_too_large"
  | "insufficient_liquidity"
  | "rate_limited"
  | "key_rejected"
  | "upstream_unavailable"
  | "chain_halted"
  | "recipient_unverifiable"
  | "recipient_mismatch"
  | "vault_mismatch"
  | "stale_node"
  | "quote_expired"
  | "price_check_failed"
  | "simulation_failed"
  | "policy_refused";

/** Every {@link Swap2RefusalReason}, in the order the type lists them. */
export const SWAP2_REFUSAL_REASONS: readonly Swap2RefusalReason[] = Object.freeze([
  "no_route",
  "unsupported_pair",
  "amount_too_small",
  "amount_too_large",
  "insufficient_liquidity",
  "rate_limited",
  "key_rejected",
  "upstream_unavailable",
  "chain_halted",
  "recipient_unverifiable",
  "recipient_mismatch",
  "vault_mismatch",
  "stale_node",
  "quote_expired",
  "price_check_failed",
  "simulation_failed",
  "policy_refused",
] as const);

const REASONS: ReadonlySet<string> = new Set(SWAP2_REFUSAL_REASONS);

/** True for one of the {@link SWAP2_REFUSAL_REASONS}. */
export function isSwap2RefusalReason(value: unknown): value is Swap2RefusalReason {
  return typeof value === "string" && REASONS.has(value);
}

/** The machine-readable side of a refusal. */
export interface Swap2RefusalInfo {
  readonly reason: Swap2RefusalReason;
  /** How long the venue asked to wait before trying again (`rate_limited`), when it said. */
  readonly retryAfterMs?: number;
  /** The HTTP status the venue answered (`upstream_unavailable`, `key_rejected`, `rate_limited`), when there was one. */
  readonly httpStatus?: number;
}

/** One refusal: its text, its reason when classified, and the venue that gave it. */
export interface Swap2Refusal {
  /** The refusal's text, as it always read. */
  readonly message: string;
  /** Absent when the refusal is not classified. */
  readonly reason?: Swap2RefusalReason;
  readonly retryAfterMs?: number;
  readonly httpStatus?: number;
  /** The venue that refused; absent for the engine's own refusals. */
  readonly provider?: string;
}

/** Longest `retryAfterMs` kept: a day. */
const RETRY_AFTER_MAX_MS = 86_400_000;

const retryMs = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? Math.min(v, RETRY_AFTER_MAX_MS) : undefined;
const httpStatusOf = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) && v >= 100 && v <= 599 ? v : undefined;

/** A copy holding only the valid fields, or undefined when `reason` is not one of the reasons. */
function normalized(info: {reason?: unknown; retryAfterMs?: unknown; httpStatus?: unknown}): Swap2RefusalInfo | undefined {
  if (!isSwap2RefusalReason(info.reason)) return undefined;
  const retryAfterMs = retryMs(info.retryAfterMs);
  const httpStatus = httpStatusOf(info.httpStatus);
  return {
    reason: info.reason,
    ...(retryAfterMs !== undefined ? {retryAfterMs} : {}),
    ...(httpStatus !== undefined ? {httpStatus} : {}),
  };
}

/** Puts the valid fields of `info` on `target`. */
function stamp(target: object, info: Swap2RefusalInfo | undefined): void {
  if (!info) return;
  Object.assign(target, info);
}

/**
 * Tags an error with a refusal reason and returns the same error: its class, name and message stay
 * as they are. A value that is not one of the reasons leaves the error untouched, and so does an
 * error that already has a `reason`: the first classification stands, and a field of another meaning
 * is kept (a wallet's `SimulationError` keeps its revert text).
 */
export function withReason<E extends Error>(error: E, info: Swap2RefusalReason | Swap2RefusalInfo): E {
  if ((error as {reason?: unknown}).reason !== undefined) return error;
  stamp(error, normalized(typeof info === "string" ? {reason: info} : info));
  return error;
}

/** `new Error(message)` tagged with a reason: a provider's `throw refusal("no_route", "lifi: …")`. */
export function refusal(
  reason: Swap2RefusalReason,
  message: string,
  extra?: {retryAfterMs?: number; httpStatus?: number; cause?: unknown},
): Error {
  const error = extra?.cause !== undefined ? new Error(message, {cause: extra.cause}) : new Error(message);
  return withReason(error, {
    reason,
    ...(extra?.retryAfterMs !== undefined ? {retryAfterMs: extra.retryAfterMs} : {}),
    ...(extra?.httpStatus !== undefined ? {httpStatus: extra.httpStatus} : {}),
  });
}

/**
 * The reason an error carries, validated: its own, else the first one found down its `cause` chain
 * (six deep). Undefined when there is none.
 */
export function refusalOf(error: unknown): Swap2RefusalInfo | undefined {
  let e = error as {reason?: unknown; retryAfterMs?: unknown; httpStatus?: unknown; cause?: unknown} | undefined;
  for (let i = 0; e && typeof e === "object" && i < 6; e = e.cause as typeof e, i++) {
    const info = normalized(e);
    if (info) return info;
  }
  return undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** RFC 9110's IMF-fixdate ("Sun, 06 Nov 1994 08:49:37 GMT"), read by hand: engines' Date.parse accept other strings too. */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/** A Retry-After header in milliseconds: delta-seconds, or an HTTP date (IMF-fixdate). Undefined when it is neither. */
export function parseRetryAfter(header: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (typeof header !== "string") return undefined;
  const value = header.trim();
  if (/^\d{1,9}$/.test(value)) return Math.min(Number(value) * 1000, RETRY_AFTER_MAX_MS);
  const m = IMF_FIXDATE.exec(value);
  if (!m) return undefined;
  const at = Date.UTC(Number(m[3]), MONTHS.indexOf(m[2]!), Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(at) ? Math.min(Math.max(0, at - nowMs), RETRY_AFTER_MAX_MS) : undefined;
}

/**
 * The reason an HTTP status gives on its own: 429 → `rate_limited` (with Retry-After), 401 / 403 →
 * `key_rejected`, 408 / 425 / 5xx → `upstream_unavailable`. Undefined for any other status, which
 * only the venue's own answer can classify.
 */
export function httpRefusal(status: number, retryAfter?: string | null, nowMs: number = Date.now()): Swap2RefusalInfo | undefined {
  const httpStatus = httpStatusOf(status);
  if (httpStatus === undefined) return undefined;
  if (httpStatus === 429) {
    const wait = parseRetryAfter(retryAfter, nowMs);
    return {reason: "rate_limited", httpStatus, ...(wait !== undefined ? {retryAfterMs: wait} : {})};
  }
  if (httpStatus === 401 || httpStatus === 403) return {reason: "key_rejected", httpStatus};
  if (httpStatus === 408 || httpStatus === 425 || httpStatus >= 500) return {reason: "upstream_unavailable", httpStatus};
  return undefined;
}

/**
 * The reason several refusals add up to: theirs when every one carries the same reason (the
 * shortest wait for `rate_limited`), else `no_route`.
 */
export function combinedRefusal(refusals: readonly Swap2Refusal[]): Swap2RefusalInfo {
  const first = refusals[0]?.reason;
  if (!first || refusals.some((r) => r.reason !== first)) return {reason: "no_route"};
  if (first === "rate_limited") {
    const waits = refusals.map((r) => r.retryAfterMs);
    const wait = waits.every((w): w is number => w !== undefined) ? Math.min(...waits) : undefined;
    return {reason: first, ...(wait !== undefined ? {retryAfterMs: wait} : {})};
  }
  const statuses = new Set(refusals.map((r) => r.httpStatus));
  const [status] = statuses;
  return {reason: first, ...(statuses.size === 1 && status !== undefined ? {httpStatus: status} : {})};
}

/**
 * For pins whose `verifyQuote` / `verifyBuild` return text: `note` hands back the text and remembers its reason,
 * `reasonOf` (the `RemotePins` hook) reads it back. Keeps the last `limit` texts (default 64), so it never grows.
 */
export function refusalNotes(limit = 64): {
  note(text: string, info: Swap2RefusalReason | Swap2RefusalInfo): string;
  reasonOf(text: string): Swap2RefusalInfo | undefined;
} {
  const seen = new Map<string, Swap2RefusalInfo>();
  return {
    note(text, info) {
      const valid = normalized(typeof info === "string" ? {reason: info} : info);
      seen.delete(text);
      if (valid) {
        seen.set(text, valid);
        if (seen.size > limit) seen.delete(seen.keys().next().value!);
      }
      return text;
    },
    reasonOf: (text) => seen.get(text),
  };
}

/** `ErrorOptions` plus a refusal's reason and, for an engine-wide "no route", every venue's refusal. */
export interface Swap2ErrorOptions extends ErrorOptions {
  reason?: Swap2RefusalReason;
  retryAfterMs?: number;
  httpStatus?: number;
  refusals?: readonly Swap2Refusal[];
}

/** Public, machine-readable error base shared by every contribution package. */
export class Swap2Error extends Error {
  /** Why it was refused, when it is a refusal (see {@link Swap2RefusalReason}). */
  declare readonly reason?: Swap2RefusalReason;
  declare readonly retryAfterMs?: number;
  declare readonly httpStatus?: number;
  /** Each venue's refusal behind an engine-wide "no route". */
  declare readonly refusals?: readonly Swap2Refusal[];
  constructor(message: string, readonly code: Swap2ErrorCode, options?: Swap2ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    stamp(this, options ? normalized(options) : undefined);
    if (options?.refusals) this.refusals = Object.freeze(options.refusals.map((r) => Object.freeze({...r})));
  }
}

export class Swap2ConfigurationError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "CONFIGURATION", options); }
}
export class Swap2ValidationError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "VALIDATION", options); }
}
export class Swap2QuoteError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "QUOTE", options); }
}
export class Swap2ExecutionError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "EXECUTION", options); }
}
export class Swap2UnsupportedOperationError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "UNSUPPORTED_OPERATION", options); }
}
export class Swap2FeeLimitError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "FEE_LIMIT", options); }
}
export class Swap2StatusError extends Swap2Error {
  constructor(message: string, options?: Swap2ErrorOptions) { super(message, "STATUS", options); }
}
/** An identical swap2() is still running on this account (double tap): nothing was sent for this call. */
export class Swap2InFlightError extends Swap2ExecutionError {}
/** The account cannot pay the source leg's gas (approvals + main call + value); nothing was signed. */
export class Swap2InsufficientGasError extends Swap2ExecutionError {}
/**
 * The source broadcast failed AFTER the transaction may have reached the node
 * (lost response, timeout). Do NOT retry: poll `getSwap2Status(id)` / the
 * chain for `hash`. The approval is left in place (the deposit may spend it).
 */
export class Swap2MaybeSentError extends Swap2ExecutionError {
  constructor(message: string, readonly hash?: string, readonly id?: string, options?: Swap2ErrorOptions) { super(message, options); }
}
