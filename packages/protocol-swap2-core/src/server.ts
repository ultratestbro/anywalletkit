import type {Asset, CrossChainProvider, IntentRef, Quote, QuoteParams, TxRequest, UnsignedTx} from "./types.js";
import {redactUrls} from "./util.js";
import {validQuote} from "./validate.js";

/**
 * The server side of {@link remoteProvider}: runs real providers behind your backend so API
 * keys, affiliate settings and non-CORS endpoints never ship in the app.
 *
 * Framework-free: wire `handle(action, body, context)` into any HTTP route that receives
 * `POST {baseUrl}/{action}` with a JSON body, and send back `{status, body}` as JSON.
 *
 * What it guarantees:
 * - every field of every request is validated (types, lengths, digit-only amounts) before a
 *   provider sees it; unknown actions, providers and malformed bodies are refused;
 * - `quote` answers are sealed with HMAC-SHA256 under `sealSecret`; `build` and `preflight`
 *   refuse a quote that was not sealed here, was changed in transit, or has expired — so a
 *   client cannot make your server build a deposit for terms the provider never quoted;
 * - every quote's `intentId` leaves with an intent token appended (`<id>~<tag>`): `track`,
 *   `claim`, `notify` and `register` refuse an id without a valid one (403), and the provider
 *   only ever sees its own id. With `subject`, quotes and tokens are bound to the caller, so
 *   another user's sealed quote or swap id is refused too; without it the token is a bearer
 *   capability for that one swap (share a transaction hash with support, not the swap id);
 * - a provider's named refusal travels in-band (`{noQuote}`) so the app can show WHY;
 * - error text crossing the boundary has URLs redacted (no upstream endpoints or keys).
 *
 * What it does NOT do, and you must: authenticate the caller and rate-limit per user/IP in
 * `guard` (see {@link Swap2HandlerOptions.guard}), cap the raw request size before parsing
 * (`serializedTx` may legitimately be ~2 MB), and log without request bodies.
 *
 * Server-only (WebCrypto HMAC; Node ≥ 20, Deno, Bun, edge runtimes). Never import it into an app.
 */

/** One call, as `guard` sees it. `dry` quotes are display quotes: give them their own, larger bucket. */
export interface Swap2Call {
  action: Swap2Action;
  provider: string;
  dry: boolean;
  /**
   * The validated request as the provider will get it — amounts, recipients, the provider's own
   * intent id (token removed) — for limits that depend on what is asked. Not yet checked against
   * the seal or the intent token: those run after the guard.
   */
  request: Swap2Request;
}

/** The validated body of each action. */
export type Swap2Request =
  | {params: QuoteParams}
  | {quote: Quote; tx?: UnsignedTx}
  | {ref: IntentRef}
  | {intentId: string; txHash: string}
  | {intentId: string; signature: string}
  | {from: Asset; to: Asset};

export type Swap2Action = "quote" | "build" | "preflight" | "track" | "claim" | "notify" | "register" | "supports";

export interface Swap2HandlerOptions<C> {
  /** The real providers, by `name` (the same names the app's `remoteProvider`s use). */
  providers: readonly CrossChainProvider[];
  /** HMAC key for quote seals: at least 32 bytes of randomness, kept server-side, rotated with care. */
  sealSecret: string | Uint8Array;
  /**
   * Authentication and rate limiting — required, because this endpoint spends your provider
   * quotas and builds deposits. Throw {@link Swap2HandlerError} (401 / 403 / 429) to refuse.
   * `context` is whatever your route passes as the third argument (the request, a session…).
   */
  guard: (call: Swap2Call, context: C) => void | Promise<void>;
  /**
   * Who is calling: a stable id of the authenticated user — the Sign-In with Ethereum address,
   * not an email — or undefined. Quotes are sealed for, and intent tokens issued to, this subject:
   * another caller's quote or swap id is refused (403). Without it, the intent token in a swap
   * id is a bearer capability. Runs after `guard`.
   */
  subject?: (context: C) => string | undefined | Promise<string | undefined>;
  /**
   * Moving to this handler from another backend: until this time (ms since epoch), `track`
   * accepts a swap id without an intent token, so swaps started before the move can still be
   * followed. Read-only: `claim`, `notify` and `register` always require the token.
   */
  acceptUntokenedTrackUntil?: number;
  /**
   * Quote tokens the swap catalog does not list (`params.sourceToken` an EVM contract or Solana
   * mint, with `params.sourceDecimals`), for apps whose users add their own tokens. Off by default:
   * `sourceDecimals` is then dropped and the providers refuse an unlisted source. Destination tokens
   * are addresses either way.
   */
  allowUnlistedTokens?: boolean;
  /** Clock for expiry checks (tests). */
  now?: () => number;
}

export interface Swap2Response {
  status: number;
  body: unknown;
}

/** Throw from `guard` (or anywhere) to answer with this status and message. */
export class Swap2HandlerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "Swap2HandlerError";
    this.status = status;
  }
}

const ACTIONS: ReadonlySet<string> = new Set(["quote", "build", "preflight", "track", "claim", "notify", "register", "supports"]);
const SEAL_FIELD = "__remoteSeal";
const SEAL_PREFIX = "swap2-remote-quote:v1:";
const INTENT_PREFIX = "swap2-remote-intent:v1";
/** `<provider's intent id>~<128-bit HMAC tag>`. */
const TOKENED = /^([\s\S]+)~([0-9a-f]{32})$/;
const INTENT_MAX = 2000;
const WIRE_INTENT_MAX = INTENT_MAX + 33;

export function createSwap2Handler<C = unknown>(opts: Swap2HandlerOptions<C>): (action: string, body: unknown, context: C) => Promise<Swap2Response> {
  if (typeof opts.guard !== "function") throw new Error("swap2-server: guard is required (authentication + rate limiting)");
  const secret = typeof opts.sealSecret === "string" ? new TextEncoder().encode(opts.sealSecret) : opts.sealSecret;
  if (!(secret instanceof Uint8Array) || secret.length < 32) throw new Error("swap2-server: sealSecret must be at least 32 bytes");
  const byName = new Map<string, CrossChainProvider>();
  for (const p of opts.providers) {
    if (byName.has(p.name)) throw new Error(`swap2-server: duplicate provider '${p.name}'`);
    byName.set(p.name, p);
  }
  const now = opts.now ?? Date.now;
  const keyPromise = crypto.subtle.importKey("raw", secret as BufferSource, {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);

  // The subject is JSON-quoted, so it cannot run into the canonical quote that follows ("{").
  const sealInput = (provider: string, subject: string | undefined, quote: Quote) =>
    new TextEncoder().encode(SEAL_PREFIX + provider + ":" + (subject === undefined ? "" : JSON.stringify(subject) + ":") + canonical(withoutSeal(quote)));
  async function seal(provider: string, subject: string | undefined, quote: Quote): Promise<Quote> {
    const tag = new Uint8Array(await crypto.subtle.sign("HMAC", await keyPromise, sealInput(provider, subject, quote)));
    return {...quote, providerData: {...(quote.providerData ?? {}), [SEAL_FIELD]: toHex(tag)}};
  }
  async function verify(provider: string, subject: string | undefined, quote: Quote): Promise<boolean> {
    if (quote.provider !== provider) return false;
    const sealHex = quote.providerData?.[SEAL_FIELD];
    if (!sealHex || !/^[0-9a-f]{64}$/.test(sealHex)) return false;
    return crypto.subtle.verify("HMAC", await keyPromise, fromHex(sealHex) as BufferSource, sealInput(provider, subject, quote)); // constant-time
  }
  /** The intent token: HMAC over (provider, subject, the provider's intent id), domain-separated from the seal. */
  async function intentTag(provider: string, subject: string | undefined, intentId: string): Promise<string> {
    const data = new TextEncoder().encode(JSON.stringify([INTENT_PREFIX, provider, subject ?? null, intentId]));
    return toHex(new Uint8Array(await crypto.subtle.sign("HMAC", await keyPromise, data)).subarray(0, 16));
  }
  /** A swap id from the app → the provider's own id, or 403. */
  async function untoken(provider: string, subject: string | undefined, wireId: string, action: Swap2Action): Promise<string> {
    const m = TOKENED.exec(wireId);
    if (!m) {
      if (action === "track" && opts.acceptUntokenedTrackUntil !== undefined && now() < opts.acceptUntokenedTrackUntil) return wireId;
      throw new Swap2HandlerError(403, "swap id carries no intent token from this server");
    }
    if (!sameHex(await intentTag(provider, subject, m[1]!), m[2]!)) {
      throw new Swap2HandlerError(403, subject === undefined ? "swap id carries an invalid intent token" : "swap id was not issued to this caller");
    }
    return m[1]!;
  }
  /** The quote as the provider issued it: no seal, its own intent id. */
  const forProvider = (quote: Quote): Quote => ({...stripSeal(quote), intentId: TOKENED.exec(quote.intentId)?.[1] ?? quote.intentId});

  return async function handle(action: string, body: unknown, context: C): Promise<Swap2Response> {
    try {
      if (!ACTIONS.has(action)) return fail(404, `unknown action '${String(action).slice(0, 40)}'`);
      const b = record(body, "body");
      const providerName = str(b.provider, "provider", 40);
      const act = action as Swap2Action;
      const request = validated(act, b, opts.allowUnlistedTokens === true);
      const dry = "params" in request && request.params.dry === true;
      // The guard sees the provider's own intent id, as the provider will.
      const shown: Swap2Request = "ref" in request ? {ref: {...request.ref, intentId: TOKENED.exec(request.ref.intentId)?.[1] ?? request.ref.intentId}}
        : "quote" in request ? {...request, quote: forProvider(request.quote)}
        : "intentId" in request ? {...request, intentId: TOKENED.exec(request.intentId)?.[1] ?? request.intentId}
        : request;
      await opts.guard({action: act, provider: providerName, dry, request: shown}, context);
      const subject = opts.subject ? await opts.subject(context) : undefined;

      const provider = byName.get(providerName);
      if (!provider) return fail(404, `unknown provider '${providerName}'`);
      if (!provider.enabled()) return fail(403, `provider '${providerName}' is disabled`);

      switch (act) {
        case "quote": {
          const {params} = request as {params: QuoteParams};
          let refusal: string | null = null; // per request: a shared field races under parallel quotes
          const quote = await provider.getQuote({...params, onRefusal: (reason) => { refusal = reason; }});
          if (quote) {
            let normalized: Quote;
            try { normalized = normalizeQuote(quote, INTENT_MAX); } catch { return fail(502, `${providerName} returned a quote this server refuses to seal`); }
            // A seal vouches for the quote: hold it to the engine's own checks (provider, input, floor,
            // slippage, expiry) so a client that does not re-validate cannot be handed a bad one.
            if (!validQuote(normalized, params, providerName) || normalized.validUntilMs <= now()) {
              return fail(502, `${providerName} returned a quote the swap engine would reject`);
            }
            const tokened = {...normalized, intentId: `${normalized.intentId}~${await intentTag(providerName, subject, normalized.intentId)}`};
            return ok(await seal(providerName, subject, tokened));
          }
          if (refusal) return ok({noQuote: redactUrls(String(refusal)).slice(0, 300)});
          return ok(params.dry === false ? {noQuote: `${providerName} refused without naming a reason`} : null);
        }
        case "build":
        case "preflight": {
          const {quote, tx} = request as {quote: Quote; tx?: UnsignedTx};
          if (!(await verify(providerName, subject, quote))) {
            return subject === undefined ? fail(400, "quote integrity check failed") : fail(403, "quote was not sealed for this caller");
          }
          if (quote.validUntilMs < now()) return fail(410, "quote expired: ask for a new one");
          if (act === "build") return ok(await refused(() => provider.buildDeposit(forProvider(quote))));
          if (!provider.preflightDeposit) return ok({});
          await refused(() => provider.preflightDeposit!(forProvider(quote), tx!));
          return ok({});
        }
        case "track":
        case "claim": {
          const {ref} = request as {ref: IntentRef};
          const own = {...ref, intentId: await untoken(providerName, subject, ref.intentId, act)};
          if (act === "track") return ok(await provider.trackIntent(own));
          if (!provider.buildClaim) return ok({});
          return ok(await refused(() => provider.buildClaim!(own)));
        }
        case "notify": {
          const {intentId, txHash} = request as {intentId: string; txHash: string};
          await provider.notifyDeposit?.(await untoken(providerName, subject, intentId, act), txHash);
          return ok({});
        }
        case "register": {
          if (!provider.registerSignedOrder) return fail(400, `provider '${providerName}' has no signed-order flow`);
          const {intentId, signature} = request as {intentId: string; signature: string};
          await provider.registerSignedOrder(await untoken(providerName, subject, intentId, act), signature);
          return ok({});
        }
        case "supports": {
          const {from, to} = request as {from: Asset; to: Asset};
          return ok({supported: provider.supportsRoute(from, to)});
        }
      }
    } catch (err) {
      if (err instanceof Swap2HandlerError) return fail(err.status, err.message);
      return fail(500, "internal error"); // never echo provider internals or upstream URLs
    }
  };
}

/** Each action's body, validated field by field before anyone (guard, provider) sees it. */
function validated(action: Swap2Action, b: Record<string, unknown>, allowUnlisted: boolean): Swap2Request {
  switch (action) {
    case "quote": return {params: quoteParams(b.params, allowUnlisted)};
    case "build": return {quote: normalizeQuote(b.quote, WIRE_INTENT_MAX)};
    case "preflight": return {quote: normalizeQuote(b.quote, WIRE_INTENT_MAX), tx: unsignedTx(b.tx)};
    case "track":
    case "claim": return {ref: intentRef(b.ref)};
    case "notify": return {intentId: str(b.intentId, "intentId", WIRE_INTENT_MAX), txHash: str(b.txHash, "txHash", 200)};
    case "register": {
      const signature = str(b.signature, "signature", 302);
      if (!/^0x[0-9a-fA-F]{2,300}$/.test(signature)) throw new Swap2HandlerError(400, "signature: not a hex signature");
      return {intentId: str(b.intentId, "intentId", WIRE_INTENT_MAX), signature};
    }
    case "supports": return {from: asset(b.from, "from"), to: asset(b.to, "to")};
  }
}

/** Constant-time comparison of two lowercase hex strings. */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---- refusals -------------------------------------------------------------------------------

/** A provider's own refusal ("lifi: …") is actionable: 422 with the redacted text. Anything else is a 500. */
async function refused<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && /^[a-z0-9_-]+: \S/i.test(err.message)) {
      throw new Swap2HandlerError(422, redactUrls(err.message).slice(0, 300));
    }
    throw err;
  }
}

const ok = (body: unknown): Swap2Response => ({status: 200, body: body === undefined ? null : body});
const fail = (status: number, error: string): Swap2Response => ({status, body: {error: redactUrls(error).slice(0, 300)}});

// ---- validation (the limits mirror a production backend's schema) --------------------------

const DIGITS = (max: number) => new RegExp(`^\\d{1,${max}}$`);

function bad(field: string, why: string): never {
  throw new Swap2HandlerError(400, `${field}: ${why}`);
}
function record(v: unknown, field: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) bad(field, "expected an object");
  return v as Record<string, unknown>;
}
function str(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") bad(field, "expected a string");
  if (v.length > max) bad(field, `longer than ${max}`);
  return v;
}
function optStr(v: unknown, field: string, max: number): string | undefined {
  return v === undefined ? undefined : str(v, field, max);
}
function digits(v: unknown, field: string, max: number): string {
  const s = str(v, field, max);
  if (!DIGITS(max).test(s)) bad(field, "expected base units (digits only)");
  return s;
}
function num(v: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) bad(field, "expected a finite number in range");
  return v;
}
function bool(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") bad(field, "expected a boolean");
  return v;
}

function quoteParams(v: unknown, allowUnlisted = false): QuoteParams {
  const p = record(v, "params");
  const sourceDecimals = !allowUnlisted || p.sourceDecimals === undefined ? undefined : num(p.sourceDecimals, "params.sourceDecimals", 0, 77);
  if (sourceDecimals !== undefined && !Number.isInteger(sourceDecimals)) bad("params.sourceDecimals", "expected an integer");
  const slippage = p.slippageBps === undefined ? undefined : num(p.slippageBps, "params.slippageBps", 0, 10_000);
  if (slippage !== undefined && !Number.isInteger(slippage)) bad("params.slippageBps", "expected an integer");
  const refundAddress = optStr(p.refundAddress, "params.refundAddress", 120);
  const minAmountOut = p.minAmountOut === undefined ? undefined : digits(p.minAmountOut, "params.minAmountOut", 60);
  const dry = bool(p.dry, "params.dry");
  const flex = bool(p.flex, "params.flex");
  return {
    sourceChain: str(p.sourceChain, "params.sourceChain", 64),
    sourceToken: str(p.sourceToken, "params.sourceToken", 64),
    ...(sourceDecimals !== undefined ? {sourceDecimals} : {}),
    destChain: str(p.destChain, "params.destChain", 64),
    destToken: str(p.destToken, "params.destToken", 120),
    amountIn: digits(p.amountIn, "params.amountIn", 40),
    destAddress: str(p.destAddress, "params.destAddress", 120),
    ...(refundAddress !== undefined ? {refundAddress} : {}),
    ...(minAmountOut !== undefined ? {minAmountOut} : {}),
    ...(slippage !== undefined ? {slippageBps: slippage} : {}),
    ...(dry !== undefined ? {dry} : {}),
    ...(flex !== undefined ? {flex} : {}),
  };
}

const FEE_TYPES = new Set(["network", "protocol", "affiliate", "other"]);

/** Keeps only the known Quote fields, each checked: what is sealed is exactly what is verified. */
function normalizeQuote(v: unknown, intentMax: number): Quote {
  const q = record(v, "quote");
  const out: Quote = {
    provider: str(q.provider, "quote.provider", 40),
    intentId: str(q.intentId, "quote.intentId", intentMax),
    depositAddress: str(q.depositAddress, "quote.depositAddress", 200),
    depositMemo: q.depositMemo === null ? null : str(q.depositMemo, "quote.depositMemo", 400),
    sourceAmount: digits(q.sourceAmount, "quote.sourceAmount", 60),
    destAmount: digits(q.destAmount, "quote.destAmount", 60),
    minDestAmount: digits(q.minDestAmount, "quote.minDestAmount", 60),
    feeUsd: num(q.feeUsd, "quote.feeUsd"),
    etaSeconds: num(q.etaSeconds, "quote.etaSeconds"),
    reliability: num(q.reliability, "quote.reliability", 0, 1),
    validUntilMs: num(q.validUntilMs, "quote.validUntilMs"),
  };
  if (q.txRequest !== undefined) out.txRequest = txRequest(q.txRequest);
  if (q.fees !== undefined) {
    if (!Array.isArray(q.fees) || q.fees.length > 32) bad("quote.fees", "expected up to 32 entries");
    out.fees = q.fees.map((f, i) => {
      const fee = record(f, `quote.fees[${i}]`);
      const type = str(fee.type, `quote.fees[${i}].type`, 20);
      if (!FEE_TYPES.has(type)) bad(`quote.fees[${i}].type`, "unknown fee type");
      const description = optStr(fee.description, `quote.fees[${i}].description`, 500);
      const included = bool(fee.included, `quote.fees[${i}].included`);
      if (included === undefined) bad(`quote.fees[${i}].included`, "expected a boolean");
      return {
        type: type as "network" | "protocol" | "affiliate" | "other",
        amount: digits(fee.amount, `quote.fees[${i}].amount`, 80),
        token: str(fee.token, `quote.fees[${i}].token`, 200),
        included,
        ...(description !== undefined ? {description} : {}),
      };
    });
  }
  if (q.providerData !== undefined) {
    const data = record(q.providerData, "quote.providerData");
    const keys = Object.keys(data);
    if (keys.length > 64) bad("quote.providerData", "more than 64 entries");
    out.providerData = Object.fromEntries(keys.map((k) => [str(k, "quote.providerData key", 200), str(data[k], `quote.providerData.${k.slice(0, 40)}`, 10_000)]));
  }
  return out;
}

function txRequest(v: unknown): TxRequest {
  const t = record(v, "quote.txRequest");
  const out: TxRequest = {};
  if (t.to !== undefined) out.to = str(t.to, "quote.txRequest.to", 200);
  if (t.data !== undefined) out.data = str(t.data, "quote.txRequest.data", 1_000_000);
  if (t.value !== undefined) out.value = digits(t.value, "quote.txRequest.value", 80);
  if (t.chainId !== undefined) {
    const id = num(t.chainId, "quote.txRequest.chainId", 1);
    if (!Number.isInteger(id)) bad("quote.txRequest.chainId", "expected an integer");
    out.chainId = id;
  }
  if (t.gasLimit !== undefined) out.gasLimit = digits(t.gasLimit, "quote.txRequest.gasLimit", 80);
  if (t.approvalAddress !== undefined) out.approvalAddress = str(t.approvalAddress, "quote.txRequest.approvalAddress", 200);
  if (t.serializedTx !== undefined) out.serializedTx = str(t.serializedTx, "quote.txRequest.serializedTx", 2_000_000);
  if (t.nativeFee !== undefined) out.nativeFee = digits(t.nativeFee, "quote.txRequest.nativeFee", 80);
  return out;
}

/** The transaction the client built from `build` (bigints arrive as decimal strings). */
function unsignedTx(v: unknown): UnsignedTx {
  const t = record(v, "tx");
  const out: UnsignedTx = {chain: str(t.chain, "tx.chain", 64), to: str(t.to, "tx.to", 200), value: digits(t.value, "tx.value", 80)};
  const optional: [keyof UnsignedTx, number][] = [["data", 1_000_000], ["gasLimit", 80], ["approvalAddress", 200], ["serializedTx", 2_000_000], ["memo", 2_000], ["bodyBoc", 200_000], ["stateInitBoc", 200_000], ["typedData", 200_000]];
  for (const [k, max] of optional) if (t[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = k === "gasLimit" ? digits(t[k], `tx.${k}`, max) : str(t[k], `tx.${k}`, max);
  if (t.memoEncoding !== undefined) {
    if (t.memoEncoding !== "utf8" && t.memoEncoding !== "hex") bad("tx.memoEncoding", "expected utf8 or hex");
    out.memoEncoding = t.memoEncoding;
  }
  if (t.chainId !== undefined) out.chainId = num(t.chainId, "tx.chainId", 1);
  return out;
}

function intentRef(v: unknown): IntentRef {
  const r = record(v, "ref");
  const nullable = (x: unknown, f: string) => (x === null || x === undefined ? undefined : str(x, f, 200));
  const sourceTxHash = nullable(r.sourceTxHash, "ref.sourceTxHash");
  const destTxHash = nullable(r.destTxHash, "ref.destTxHash");
  return {
    intentId: str(r.intentId, "ref.intentId", WIRE_INTENT_MAX),
    ...(sourceTxHash !== undefined ? {sourceTxHash} : {}),
    ...(destTxHash !== undefined ? {destTxHash} : {}),
  };
}

function asset(v: unknown, field: string): Asset {
  const a = record(v, field);
  return {chain: str(a.chain, `${field}.chain`, 64), token: str(a.token, `${field}.token`, 120)};
}

// ---- seal ------------------------------------------------------------------------------------

function withoutSeal(quote: Quote): Quote {
  const {providerData, ...rest} = quote;
  if (!providerData) return rest;
  const {[SEAL_FIELD]: _seal, ...data} = providerData;
  return Object.keys(data).length ? {...rest, providerData: data} : rest;
}
/** The provider gets its quote back exactly as it produced it. */
const stripSeal = withoutSeal;

/** Deterministic JSON: sorted keys, `undefined` dropped, non-finite numbers refused. */
function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Swap2HandlerError(400, "quote contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const r = value as Record<string, unknown>;
    return `{${Object.keys(r).filter((k) => r[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(r[k])}`).join(",")}}`;
  }
  throw new Swap2HandlerError(400, "quote is not JSON-safe");
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
