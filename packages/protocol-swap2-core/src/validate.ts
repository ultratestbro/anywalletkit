import type {CrossChainProvider, Quote, QuoteParams} from "./types.js";

/** Shared quote validator used by both the aggregate and single-provider paths. */
export function validQuote(q: Quote, params: QuoteParams, provider: string): boolean {
  try {
    if (q.provider !== provider || q.sourceAmount !== params.amountIn) return false;
    if (typeof q.intentId !== "string" || !q.intentId || typeof q.depositAddress !== "string" || (q.depositMemo !== null && typeof q.depositMemo !== "string")) return false;
    if (![q.sourceAmount, q.destAmount, q.minDestAmount].every((value) => /^[0-9]+$/.test(value))) return false;
    const source = BigInt(q.sourceAmount);
    const dest = BigInt(q.destAmount);
    const min = BigInt(q.minDestAmount);
    if (source <= 0n || dest <= 0n || min <= 0n || min > dest) return false;
    if (params.minAmountOut !== undefined) {
      if (!/^[0-9]+$/.test(params.minAmountOut) || BigInt(params.minAmountOut) <= 0n || min < BigInt(params.minAmountOut)) return false;
    }
    if (params.slippageBps !== undefined) {
      if (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps >= 10_000) return false;
      // Providers round the floor DOWN (1Click, LI.FI: floor(dest × (1 − s))).
      // A ceil here refused nearly every slippage-bounded quote by one base unit.
      const required = (dest * BigInt(10_000 - params.slippageBps)) / 10_000n;
      if (min < required) return false;
    }
    if (!Number.isFinite(q.etaSeconds) || q.etaSeconds < 0) return false;
    if (!Number.isFinite(q.reliability) || q.reliability < 0 || q.reliability > 1) return false;
    if (!Number.isFinite(q.feeUsd) || q.feeUsd < 0) return false;
    if (q.fees && (!Array.isArray(q.fees) || !q.fees.every((fee) =>
      ["network", "protocol", "affiliate", "other"].includes(fee.type) &&
      /^[0-9]+$/.test(fee.amount) &&
      typeof fee.token === "string" && fee.token.length > 0 &&
      typeof fee.included === "boolean" &&
      (fee.description === undefined || typeof fee.description === "string")
    ))) return false;
    if (q.providerData && (Array.isArray(q.providerData) || typeof q.providerData !== "object" || !Object.values(q.providerData).every((value) => typeof value === "string"))) return false;
    const tx = q.txRequest;
    if (tx) {
      if (tx.value !== undefined && !/^[0-9]+$/.test(tx.value)) return false;
      if (tx.gasLimit !== undefined && !/^[0-9]+$/.test(tx.gasLimit)) return false;
      if (tx.chainId !== undefined && (!Number.isSafeInteger(tx.chainId) || tx.chainId <= 0)) return false;
      if ([tx.to, tx.data, tx.approvalAddress, tx.serializedTx].some((value) => value !== undefined && typeof value !== "string")) return false;
    }
    // Execution is always re-quoted. An unknown/zero expiry cannot prove that
    // the transaction is still safe to sign, so contribution packages reject it.
    if (!Number.isFinite(q.validUntilMs) || q.validUntilMs <= Date.now()) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Why a remote provider's quote cannot execute in this app, or null: its EVM transaction calls or
 * approves an address the app did not pin (`remoteProvider` `callTargets` / `spenders`). The router
 * and the single-provider path drop such a quote with this reason, so the auction never picks a
 * route execution would refuse (scan 2026-10-27 modules, F8/F9/F16); execution checks the build
 * again, in full. Local providers and deposit-address routes are not judged here.
 */
export function remotePinRefusal(provider: Pick<CrossChainProvider, "name" | "remote" | "callTargets" | "spenders">, q: Quote, chain: string): string | null {
  if (provider.remote !== true || !chain.startsWith("eip155:")) return null;
  const tx = q.txRequest;
  if (!tx || tx.serializedTx !== undefined) return null;
  const pinned = (list: readonly string[] | undefined, address: string) =>
    (list ?? []).some((a) => typeof a === "string" && a.toLowerCase() === address.toLowerCase());
  if (tx.approvalAddress && !pinned(provider.spenders?.(chain), tx.approvalAddress)) {
    return `${provider.name}: the route approves ${tx.approvalAddress}, which the app did not pin as a spender on ${chain} (remoteProvider spenders)`;
  }
  if (tx.data !== undefined && tx.to && !pinned(provider.callTargets?.(chain), tx.to)) {
    return `${provider.name}: the route calls ${tx.to}, which the app did not pin as a call target on ${chain} (remoteProvider callTargets)`;
  }
  return null;
}
