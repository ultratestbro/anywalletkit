/**
 * Two-step suggestions: when the auction has no route for X → Z, two ordinary swaps through a hub token often do —
 * X → Y, then Y → Z. This module only finds and prices such a pair with two plain `getQuotes` auctions; it executes
 * nothing. The app shows the plan and the user starts each swap on its own (its own review, checks and history), so
 * nothing new is trusted: after the first swap the funds sit in a common token (the chain's native coin or its main
 * stablecoin) on the user's own address.
 *
 * Measured 2026-11-24 over 360 live auctions: 81% of the pairs no provider claimed directly got a two-step quote,
 * mostly from NEAR, Tron, Solana, TON and Bitcoin into tail tokens on EVM chains.
 */
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ccChain, type CcAsset} from "@anywalletkit/swap2-assets";
import type {CrossChainRouter, RankedQuote, RouteSet} from "./router.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const isZero = (t: string): boolean => /^0x0+$/.test(t);
/** The stablecoins tried as a hub, first listed on the chain wins. */
const HUB_STABLES = ["USDC", "USDT", "USDT0", "USDC.e"] as const;

/** A hub token: where the first swap ends and the second begins. */
export interface TwoStepHub {
  chain: string;
  symbol: string;
  /** The contract, or the zero address for the native coin. */
  token: string;
  native: boolean;
}

/**
 * Who pays the second swap's gas on the hub's chain:
 * - `none`: no gas is needed there (both swaps start on the source chain, or the second is gasless — a CoW order);
 * - `from-hub`: the hub is that chain's native coin, so the second swap pays its own gas out of it;
 * - `needed`: the user needs some native coin on that chain first.
 */
export type TwoStepGas = "none" | "from-hub" | "needed";

export interface TwoStepPlan {
  /** `source-hub`: swap on the source chain, then bridge. `destination-hub`: bridge, then swap on the destination. */
  shape: "source-hub" | "destination-hub";
  hub: TwoStepHub;
  /** The first swap's request (X → hub) and its auction. */
  firstParams: QuoteParams;
  first: RouteSet;
  /** The second swap's request (hub → Z), priced on the first swap's guaranteed output, and its auction. */
  secondParams: QuoteParams;
  second: RouteSet;
  /** What the pair guarantees: the second swap's minimum on the first swap's minimum. */
  guaranteedOut: string;
  /** What the pair is expected to deliver (the second swap's output scaled to the first swap's expected output). */
  estimatedOut: string;
  /** Both swaps' ETA added up, or null when either is unknown. Excludes the time the user takes to start step 2. */
  etaSeconds: number | null;
  gasOnHubChain: TwoStepGas;
  /** The second swap's net value less the first swap's source gas, when both auctions priced in USD. */
  netValueUsd: number | null;
}

export interface TwoStepOptions {
  /**
   * Hub tokens to try. Default: the native coin and the first listed stablecoin (USDC, USDT, USDT0, USDC.e) of the
   * source chain and of the destination chain.
   */
  hubs?: readonly TwoStepHub[];
  /** How many plans to return, best first (default 2). */
  maxPlans?: number;
  /**
   * A plan that needs no native coin on the hub's chain is put first when it is worth at most this much less than the
   * best plan, in basis points (default 50).
   */
  gasSafeBandBps?: number;
  /**
   * The user's OWN address on a chain — where the first swap delivers the hub token. Default: `refundAddress` (or
   * `sender`) on the source chain, `destAddress` on the destination chain. When `destAddress` is someone else (the
   * app's "send to another address"), pass this: the hub must land on the user's own address, and only the second
   * swap pays the other recipient. A hub on a chain this returns nothing for is skipped.
   */
  ownAddress?: (chain: string) => string | undefined;
  /**
   * The user's native balance on a chain is below one transaction's gas there — so a plan whose second swap needs
   * native gas (`gasOnHubChain: "needed"`) gives way to a gas-free one within `gasSafeBandBps`. Default: always
   * prefer gas-free plans within the band.
   */
  lacksGas?: (chain: string) => boolean;
}

function hubOf(chain: string, a: CcAsset): TwoStepHub {
  return {chain, symbol: a.symbol, token: a.contract ?? ZERO, native: !a.contract};
}

/** The default hubs of one chain: its native coin and its first listed stablecoin. */
export function defaultHubs(chain: string): TwoStepHub[] {
  const c = ccChain(chain);
  if (!c) return [];
  const out: TwoStepHub[] = [];
  const native = c.assets.find((a) => !a.contract);
  if (native) out.push(hubOf(chain, native));
  const stable = HUB_STABLES.map((s) => c.assets.find((a) => a.symbol === s && a.contract)).find(Boolean);
  if (stable) out.push(hubOf(chain, stable));
  return out;
}

const sameToken = (a: string, b: string): boolean => (isZero(a) && isZero(b)) || a.toLowerCase() === b.toLowerCase();

/** The source asset's token id (contract, or zero for native), as far as the catalog knows the symbol. */
function sourceTokenId(params: QuoteParams): string | null {
  const a = ccChain(params.sourceChain)?.assets.find((x) => x.symbol === params.sourceToken);
  if (a) return a.contract ?? ZERO;
  return params.sourceDecimals !== undefined ? params.sourceToken : null;
}

/** The value a plan is ranked on: net USD when every plan is priced, else the guaranteed output (same token Z). */
function rankValue(plans: readonly TwoStepPlan[]): (p: TwoStepPlan) => number {
  if (plans.every((p) => p.netValueUsd !== null)) return (p) => p.netValueUsd!;
  const max = plans.reduce((m, p) => (BigInt(p.guaranteedOut) > m ? BigInt(p.guaranteedOut) : m), 1n);
  // A share of the best output, exact enough for ranking and the band (outputs are the same token).
  // The share is at most 10^6, so the string round-trip is exact on every engine (Hermes included).
  return (p) => Number(((BigInt(p.guaranteedOut) * 1_000_000n) / max).toString()) / 1_000_000;
}

/**
 * Two-step plans for `params` (X on the source chain → Z on the destination), best first; empty when there is none.
 * Call it when `router.getQuotes(params)` found no route — it does not look for a direct one. Both legs are dry
 * quotes; the second swap must be quoted again with the amount that actually arrived before it is executed.
 */
export async function suggestTwoStep(router: CrossChainRouter, params: QuoteParams, options: TwoStepOptions = {}): Promise<TwoStepPlan[]> {
  const srcToken = sourceTokenId(params);
  const hubs = (options.hubs ?? [...defaultHubs(params.sourceChain), ...(params.destChain === params.sourceChain ? [] : defaultHubs(params.destChain))])
    .filter((h, i, all) => all.findIndex((x) => x.chain === h.chain && sameToken(x.token, h.token)) === i)
    .filter((h) => h.chain === params.sourceChain || h.chain === params.destChain)
    // Neither end of the request is a hub of its own request.
    .filter((h) => !(h.chain === params.sourceChain && (h.symbol === params.sourceToken || (srcToken !== null && sameToken(h.token, srcToken)))))
    .filter((h) => !(h.chain === params.destChain && sameToken(h.token, params.destToken)));

  const legParams = (base: QuoteParams): QuoteParams => {
    const {minAmountOut: _floor, onRefusal: _cb, routeId: _route, sender: _sender, ...rest} = base;
    return {...rest, dry: true};
  };

  const plans = await Promise.all(hubs.map(async (hub): Promise<TwoStepPlan | null> => {
    const onSource = hub.chain === params.sourceChain;
    // The user's own address on the hub's chain: the source account when the hub is there, the recipient otherwise
    // (unless the app says whose address that is).
    const hubAddress = options.ownAddress ? options.ownAddress(hub.chain) : onSource ? params.refundAddress ?? params.sender : params.destAddress;
    if (!hubAddress) return null;
    const firstParams = legParams({...params, destChain: hub.chain, destToken: hub.token, destAddress: hubAddress});
    const first = await router.getQuotes(firstParams).catch(() => null);
    if (!first) return null;
    const amount = BigInt(first.best.minDestAmount);
    if (amount <= 0n) return null;
    const secondParams = legParams({
      ...params,
      sourceChain: hub.chain, sourceToken: hub.symbol, amountIn: amount.toString(),
      refundAddress: hubAddress,
    });
    delete (secondParams as {sourceDecimals?: number}).sourceDecimals;
    const second = await router.getQuotes(secondParams).catch(() => null);
    if (!second) return null;
    return plan(hub, onSource, firstParams, first, secondParams, second);
  }));

  let found = plans.filter((p): p is TwoStepPlan => p !== null);
  if (params.minAmountOut !== undefined) found = found.filter((p) => BigInt(p.guaranteedOut) >= BigInt(params.minAmountOut!));
  if (!found.length) return [];
  const value = rankValue(found);
  found.sort((a, b) => value(b) - value(a));
  const band = (options.gasSafeBandBps ?? 50) / 10_000;
  const top = found[0]!;
  if (top.gasOnHubChain === "needed" && (options.lacksGas?.(top.hub.chain) ?? true)) {
    const safe = found.find((p) => p.gasOnHubChain !== "needed" && value(p) >= value(top) - Math.abs(value(top)) * band);
    if (safe) found = [safe, ...found.filter((p) => p !== safe)];
  }
  return found.slice(0, Math.max(1, options.maxPlans ?? 2));
}

function plan(hub: TwoStepHub, onSource: boolean, firstParams: QuoteParams, first: RouteSet, secondParams: QuoteParams, second: RouteSet): TwoStepPlan {
  const a: RankedQuote = first.best, b: RankedQuote = second.best;
  const aMin = BigInt(a.minDestAmount), aOut = BigInt(a.destAmount);
  const estimated = aMin > 0n ? (BigInt(b.destAmount) * aOut) / aMin : BigInt(b.destAmount);
  const gas: TwoStepGas = onSource || b.gasless === true ? "none" : hub.native ? "from-hub" : "needed";
  return {
    shape: onSource ? "source-hub" : "destination-hub",
    hub,
    firstParams, first, secondParams, second,
    guaranteedOut: b.minDestAmount,
    estimatedOut: estimated.toString(),
    etaSeconds: a.etaSeconds !== null && b.etaSeconds !== null ? a.etaSeconds + b.etaSeconds : null,
    gasOnHubChain: gas,
    netValueUsd: b.netValueUsd !== null ? b.netValueUsd - (a.gasUsd ?? 0) : null,
  };
}
