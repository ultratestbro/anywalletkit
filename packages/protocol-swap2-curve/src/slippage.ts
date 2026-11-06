import {bigintToNumber} from "@anywalletkit/core";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {suggestSlippage} from "@anywalletkit/protocol-swap2-core/slippage";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

/**
 * The route's price impact in bps: a probe 1/1000 the size on the same route gives the marginal rate; the full-size
 * rate's shortfall against it is the impact (pool fees are paid on both sides and cancel). Undefined without a probe.
 */
export function curveImpactBps(amountIn: bigint, out: bigint, probeOut: bigint | null | undefined): number | undefined {
  const probeIn = amountIn / 1000n;
  if (probeIn <= 0n || probeOut === null || probeOut === undefined || probeOut <= 0n) return undefined;
  const ratioBps = (out * probeIn * 10_000n) / (probeOut * amountIn);
  return Math.max(0, bigintToNumber(10_000n - ratioBps));
}

/**
 * Slippage when the caller names none: `suggestSlippage` from swap2-core for the pair (catalog symbols) and the route's
 * price impact — stable ↔ stable 10 bps, majors 50, others 100, plus half the impact. The provider sizes its minimum
 * with it, and `curveRemotePins` re-derives it on the device to bound a remote build's minimum.
 */
export function curveAutoSlippageBps(params: QuoteParams, priceImpactBps: number | undefined): number {
  const nativeOut = /^0x0+$/.test(params.destToken);
  return suggestSlippage({
    fromChain: params.sourceChain,
    toChain: params.destChain,
    fromSymbol: sourceAssetOf(params)?.symbol ?? "",
    toSymbol: ccAssetByToken(params.destChain, nativeOut ? "" : params.destToken)?.symbol ?? "",
    ...(priceImpactBps !== undefined ? {priceImpactBps} : {}),
  }).bps;
}
