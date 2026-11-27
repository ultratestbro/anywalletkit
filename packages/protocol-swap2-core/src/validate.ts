import type {CrossChainProvider, GasEstimateSource, Quote, QuoteParams} from "./types.js";
import type {Swap2RefusalReason} from "./errors.js";

/** Every {@link GasEstimateSource}, in the order the type lists them. */
export const GAS_ESTIMATE_SOURCES: readonly GasEstimateSource[] = Object.freeze(["venue", "simulated", "model"] as const);
const GAS_ESTIMATE_SOURCE_SET: ReadonlySet<string> = new Set(GAS_ESTIMATE_SOURCES);
/** Canonical gas units: "0", or at most 10 digits with no leading zero (below 10^10 gas — far above any block). */
const GAS_ESTIMATE = /^(?:0|[1-9][0-9]{0,9})$/;

/**
 * Why a quote's `gasEstimate` / `gasEstimateSource` break their contract (see {@link Quote.gasEstimate}), or null
 * when they hold — or are both absent. `sourceChain` is the request's (CAIP-2). {@link quoteRejection} refuses a quote
 * this names as malformed; module tests can call it to say which rule a recording breaks.
 */
export function gasEstimateProblem(q: Pick<Quote, "gasEstimate" | "gasEstimateSource" | "gasless" | "txRequest">, sourceChain: string): string | null {
  const estimate = q.gasEstimate as unknown;
  const origin = q.gasEstimateSource as unknown;
  if (estimate === undefined && origin === undefined) return null;
  if (estimate === undefined) return "gasEstimateSource is set without gasEstimate";
  if (typeof estimate !== "string" || !GAS_ESTIMATE.test(estimate)) return "gasEstimate is not canonical gas units (decimal digits, no leading zero, at most 10 digits)";
  if (typeof origin !== "string" || !GAS_ESTIMATE_SOURCE_SET.has(origin)) return "gasEstimateSource is not one of venue / simulated / model";
  if (typeof sourceChain !== "string" || !sourceChain.startsWith("eip155:")) return `gasEstimate is set for a non-EVM source chain (${String(sourceChain).slice(0, 64)})`;
  const units = BigInt(estimate);
  if (q.gasless === true && units !== 0n) return `a gasless quote carries gasEstimate ${estimate} (it must be "0")`;
  if (q.gasless !== true && units === 0n) return "gasEstimate is 0 on a quote that is not gasless";
  const limit = q.txRequest?.gasLimit;
  if (limit !== undefined && /^[0-9]+$/.test(limit) && units > BigInt(limit)) return `gasEstimate ${estimate} is above txRequest.gasLimit ${limit}`;
  return null;
}

/**
 * How far past the requested slippage a quote's minimum may sit and still count as "at" it. Providers derive the
 * minimum with their own rounding: LI.FI's Mayan answers land a few base units under an exact floor on 18-decimal
 * outputs (50.0000000001 bps at a requested 50, live 2026-11-02), which refused half of them. A minimum that is more
 * than this past the request is still refused.
 */
export const SLIPPAGE_ROUNDING_BPS = 1;

/** The lowest minimum a quote of `dest` may carry at `slippageBps`: floor(dest × (10 000 − slippageBps − {@link SLIPPAGE_ROUNDING_BPS}) / 10 000). */
export function slippageFloor(dest: bigint, slippageBps: number): bigint {
  const keep = 10_000 - slippageBps - SLIPPAGE_ROUNDING_BPS;
  return keep <= 0 ? 0n : (dest * BigInt(keep)) / 10_000n;
}

/** Bounded opaque ASCII selector; providers define its stable meaning. */
export function validRouteId(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value);
}

/**
 * The {@link gasEstimateProblem} that alone makes {@link quoteRejection} refuse `q`, or null (no such problem, or the
 * quote fails for another reason too). Refusal texts name it.
 */
export function gasEstimateCulprit(q: Quote, params: QuoteParams, provider: string): string | null {
  try {
    if (!q || typeof q !== "object") return null;
    const problem = gasEstimateProblem(q, params.sourceChain);
    if (problem === null) return null;
    const {gasEstimate: _estimate, gasEstimateSource: _source, ...rest} = q;
    return quoteRejection(rest, params, provider) === null ? problem : null;
  } catch {
    return null;
  }
}

/** Shared quote validator used by both the aggregate and single-provider paths. */
export function validQuote(q: Quote, params: QuoteParams, provider: string): boolean {
  return quoteRejection(q, params, provider) === null;
}

const OTHER_QUOTE = Object.freeze({reason: "policy_refused"} as const);
const MALFORMED = Object.freeze({reason: "upstream_unavailable"} as const);
const BELOW = Object.freeze({reason: "price_check_failed"} as const);
const EXPIRED = Object.freeze({reason: "quote_expired"} as const);
/** The caller's own request is malformed (a bad floor or slippage): refused, but not the venue's refusal. */
const BAD_REQUEST = Object.freeze({});

/**
 * Why {@link validQuote} refuses a quote, or null when it passes (the same checks, in the same order): another
 * provider's or another input's quote (`policy_refused`), a malformed one (`upstream_unavailable`; a gas estimate
 * that breaks its contract, {@link gasEstimateProblem}, is one), a minimum under the floor or the slippage
 * (`price_check_failed`), an expired one (`quote_expired`). An empty object when the request itself is malformed.
 */
export function quoteRejection(q: Quote, params: QuoteParams, provider: string): {readonly reason?: Swap2RefusalReason} | null {
  try {
    if (q.routeId !== undefined && !validRouteId(q.routeId)) return MALFORMED;
    if (params.routeId !== undefined && (!validRouteId(params.routeId) || q.routeId !== params.routeId)) return OTHER_QUOTE;
    if (q.provider !== provider || q.sourceAmount !== params.amountIn) return OTHER_QUOTE;
    if (typeof q.intentId !== "string" || !q.intentId || typeof q.depositAddress !== "string" || (q.depositMemo !== null && typeof q.depositMemo !== "string")) return MALFORMED;
    if (![q.sourceAmount, q.destAmount, q.minDestAmount].every((value) => /^[0-9]+$/.test(value))) return MALFORMED;
    const source = BigInt(q.sourceAmount);
    const dest = BigInt(q.destAmount);
    const min = BigInt(q.minDestAmount);
    if (source <= 0n || dest <= 0n || min <= 0n || min > dest) return MALFORMED;
    if (params.minAmountOut !== undefined) {
      if (!/^[0-9]+$/.test(params.minAmountOut) || BigInt(params.minAmountOut) <= 0n) return BAD_REQUEST;
      if (min < BigInt(params.minAmountOut)) return BELOW;
    }
    if (params.slippageBps !== undefined) {
      if (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps >= 10_000) return BAD_REQUEST;
      // Providers round the floor DOWN (1Click, LI.FI: floor(dest × (1 − s))), some through
      // floats. A ceil here refused nearly every slippage-bounded quote by one base unit.
      if (min < slippageFloor(dest, params.slippageBps)) return BELOW;
    }
    if (q.etaSeconds !== null && (!Number.isFinite(q.etaSeconds) || q.etaSeconds < 0)) return MALFORMED;
    if (!Number.isFinite(q.reliability) || q.reliability < 0 || q.reliability > 1) return MALFORMED;
    if (!Number.isFinite(q.feeUsd) || q.feeUsd < 0) return MALFORMED;
    if (q.fees && (!Array.isArray(q.fees) || !q.fees.every((fee) =>
      ["network", "protocol", "affiliate", "other"].includes(fee.type) &&
      /^[0-9]+$/.test(fee.amount) &&
      typeof fee.token === "string" && fee.token.length > 0 &&
      typeof fee.included === "boolean" &&
      (fee.description === undefined || typeof fee.description === "string")
    ))) return MALFORMED;
    if (q.providerData && (Array.isArray(q.providerData) || typeof q.providerData !== "object" || !Object.values(q.providerData).every((value) => typeof value === "string"))) return MALFORMED;
    const tx = q.txRequest;
    if (tx) {
      if (tx.value !== undefined && !/^[0-9]+$/.test(tx.value)) return MALFORMED;
      if (tx.gasLimit !== undefined && !/^[0-9]+$/.test(tx.gasLimit)) return MALFORMED;
      if (tx.chainId !== undefined && (!Number.isSafeInteger(tx.chainId) || tx.chainId <= 0)) return MALFORMED;
      if ([tx.to, tx.data, tx.approvalAddress, tx.serializedTx, tx.permit2Transfer].some((value) => value !== undefined && typeof value !== "string")) return MALFORMED;
      // A Permit2 signature transfer pays with the token it permits and nothing else: native value or a native fee
      // riding along is never part of it.
      if (tx.permit2Transfer !== undefined && ((tx.value !== undefined && BigInt(tx.value) !== 0n) || (tx.nativeFee !== undefined && BigInt(tx.nativeFee) !== 0n))) return OTHER_QUOTE;
    }
    if (gasEstimateProblem(q, params.sourceChain) !== null) return MALFORMED;
    // Execution is always re-quoted. An unknown/zero expiry cannot prove that
    // the transaction is still safe to sign, so contribution packages reject it.
    if (!Number.isFinite(q.validUntilMs)) return MALFORMED;
    if (q.validUntilMs <= Date.now()) return EXPIRED;
    return null;
  } catch {
    return MALFORMED;
  }
}

/**
 * Why a remote provider's quote cannot execute in this app, or null: its EVM transaction calls or
 * approves an address the app did not pin (`remoteProvider` `callTargets` / `spenders`), or it pays
 * an address the backend named — a deposit address or a plain value send — on a stub the app did not
 * open to such routes (`depositAddressRoutes`, scan 2026-10-28 F9), or it is EVM calldata on a stub without the
 * app's own check of what that calldata does (`verifyQuote` / `verifyBuild`, scan 2026-10-30 F3). The router and the
 * single-provider path drop such a quote with this reason, so the auction never picks a route
 * execution would refuse (scan 2026-10-27 modules, F8/F9/F16); execution checks the build again, in
 * full. Local providers are not judged here.
 */
export function remotePinRefusal(provider: Pick<CrossChainProvider, "name" | "remote" | "callTargets" | "spenders" | "depositAddressRoutes" | "verifiesQuotes" | "verifiesBuilds">, q: Quote, chain: string): string | null {
  if (provider.remote !== true) return null;
  const tx = q.txRequest;
  const plain = tx ? tx.data === undefined && tx.serializedTx === undefined : typeof q.depositAddress === "string" && q.depositAddress !== "";
  if (plain && provider.depositAddressRoutes !== true) {
    return `${provider.name}: the route pays ${tx?.to || q.depositAddress}, an address the backend named, and the app did not allow deposit-address routes for this provider (remoteProvider depositAddressRoutes)`;
  }
  if (!chain.startsWith("eip155:")) return null;
  if (!tx || tx.serializedTx !== undefined) return null;
  const pinned = (list: readonly string[] | undefined, address: string) =>
    (list ?? []).some((a) => typeof a === "string" && a.toLowerCase() === address.toLowerCase());
  if (tx.approvalAddress && !pinned(provider.spenders?.(chain), tx.approvalAddress)) {
    return `${provider.name}: the route approves ${tx.approvalAddress}, which the app did not pin as a spender on ${chain} (remoteProvider spenders)`;
  }
  if (tx.data !== undefined && tx.to && !pinned(provider.callTargets?.(chain), tx.to)) {
    return `${provider.name}: the route calls ${tx.to}, which the app did not pin as a call target on ${chain} (remoteProvider callTargets)`;
  }
  if (tx.data !== undefined && provider.verifiesQuotes !== true && provider.verifiesBuilds !== true) {
    return `${provider.name}: the route's calldata is not checked by the app (remoteProvider verifyQuote / verifyBuild) — a pinned target alone does not say whom it pays`;
  }
  return null;
}
