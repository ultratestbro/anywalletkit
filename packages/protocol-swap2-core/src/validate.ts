import type {CrossChainProvider, Quote, QuoteParams} from "./types.js";
import type {Swap2RefusalReason} from "./errors.js";

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
 * provider's or another input's quote (`policy_refused`), a malformed one (`upstream_unavailable`), a minimum
 * under the floor or the slippage (`price_check_failed`), an expired one (`quote_expired`). An empty object
 * when the request itself is malformed.
 */
export function quoteRejection(q: Quote, params: QuoteParams, provider: string): {readonly reason?: Swap2RefusalReason} | null {
  try {
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
    if (!Number.isFinite(q.etaSeconds) || q.etaSeconds < 0) return MALFORMED;
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
      if ([tx.to, tx.data, tx.approvalAddress, tx.serializedTx].some((value) => value !== undefined && typeof value !== "string")) return MALFORMED;
    }
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
