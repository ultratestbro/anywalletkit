import {getAddress} from "viem";
import {bigintToNumber} from "@anywalletkit/core";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {suggestSlippage} from "@anywalletkit/protocol-swap2-core/slippage";
import {evmRef, isEvm, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {encodeExchange, encodeGetDy} from "./abi.js";
import {describeCurveActivity} from "./activity.js";
import {CURVE_DEPLOYMENTS, deploymentOf, type CurveDeployment} from "./deployments.js";
import {CURVE_POOLS} from "./pools/index.js";
import type {CurveChainPools} from "./pools/types.js";
import {findRoutes, routeArgs, routePools, type CurveRoute} from "./routes.js";
import {ethCall, wordUint} from "./rpc.js";
import {curveOnChain, curveQuoteCheck} from "./verify.js";

/**
 * Curve, straight from the contracts — Router NG on every chain in `CURVE_DEPLOYMENTS`.
 *
 * Quote: candidate routes of one or two pools from the curated allowlist the package pins (plus the router's
 * wrap hop through the pinned wrapped native, and on Ethereum's v1.2 router the crvUSD ↔ scrvUSD ERC-4626 hop),
 * each priced with the router's own `get_dy` in JSON-RPC batches; the best output wins. Execution: the
 * explicit-receiver `exchange(route, params, amount, min_dy, [pools,] receiver)` — the router pays only the
 * recipient and reverts under `min_dy`, which is never 0. No API, no key, no fee.
 *
 * Router NG has no deadline: the quote's lifetime (`quoteTtlMs`) is enforced by the engine, and right before
 * broadcast `preflightDeposit` re-checks the sealed call byte for byte, the router and pool code, the pools' coins
 * and a fresh `get_dy` of the exact route against the minimum. ERC-20 sources approve exactly the input to the
 * pinned router (`approvalAddress`); the engine handles that leg (and a USDT-style reset to 0 first).
 */

/** Long enough for an approval to be mined on Ethereum; the router has no deadline of its own. */
const DEFAULT_TTL_MS = 180_000;
/** Router overhead (transfer in, transfer out) and per-step gas, from estimateGas on Ethereum v1.2 (2026-11-05:
 *  native → USDT one pool 224 180, ETH → WETH → crvUSD 283 245) with headroom. */
const GAS_BASE = 120_000n;
const GAS_POOL = 180_000n;
const GAS_PSEUDO = 60_000n;

export interface CurveProviderConfig {
  enabled?: boolean;
  /** JSON-RPC endpoints per EVM chain id, tried in order. A chain without one is not offered. */
  rpcUrls: Readonly<Record<number, readonly string[]>>;
  /**
   * Slippage when the caller names none (bps). Default: `suggestSlippage` from swap2-core for the pair and the
   * route's price impact (stable ↔ stable 10 bps, majors 50, others 100, plus half the impact).
   */
  defaultSlippageBps?: number;
  /** Local quote lifetime. Router NG has no deadline, so this is the only expiry. Default 3 min. */
  quoteTtlMs?: number;
  /** Override the deployments (tests, new chains). Still verified on-chain before use. */
  deployments?: Readonly<Record<number, CurveDeployment>>;
  /** Override the pool allowlist (tests). */
  pools?: Readonly<Record<number, CurveChainPools>>;
  /** Told when a chain's AddressProvider lists another router than the pinned one (never acted on). Default console.warn. */
  onWarning?: (message: string) => void;
}

export function curveProvider(config: CurveProviderConfig): CrossChainProvider {
  const deployments = config.deployments ?? CURVE_DEPLOYMENTS;
  const pools = config.pools ?? CURVE_POOLS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const fixedSlippage = config.defaultSlippageBps;
  if (fixedSlippage !== undefined && (!Number.isInteger(fixedSlippage) || fixedSlippage <= 0 || fixedSlippage >= 5_000)) throw new Error("curve: defaultSlippageBps must be 1..4999");
  const chain = curveOnChain({rpcUrls: config.rpcUrls, deployments, pools, ...(config.onWarning ? {onWarning: config.onWarning} : {})});
  const rpc = chain.rpc;
  const selfCheck = curveQuoteCheck({deployments, pools});
  const tableOf = (chainId: number) => (Object.prototype.hasOwnProperty.call(pools, chainId) ? pools[chainId] : undefined);

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return deploymentOf(deployments, id) && config.rpcUrls[id]?.length && tableOf(id)?.pools.length ? id : null;
  };

  /** get_dy of each route at `amount` (null where the router reverts). */
  async function price(chainId: number, d: CurveDeployment, routes: readonly CurveRoute[], amount: bigint, signal?: AbortSignal): Promise<(bigint | null)[]> {
    const raw = await rpc(chainId, routes.map((r) => ethCall(d.router, encodeGetDy(d.family, routeArgs(d.family, r), amount))), signal);
    return raw.map(wordUint);
  }

  return {
    name: "curve",
    describeActivity: (tx, ctx) => describeCurveActivity(tx, ctx, deployments),
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      return from.chain === to.chain && chainIdOf(from.chain) !== null;
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string): null => {
        params.onRefusal?.(`curve: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no Curve router, pool allowlist or RPC for ${params.sourceChain}`);
      const d = deploymentOf(deployments, chainId)!;
      const src = sourceAssetOf(params);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`);
      const nativeIn = !src.contract;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      if (params.slippageBps !== undefined && (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps >= 10_000)) return refuse("slippage must be 0..9999 bps");
      if (!nativeIn && src.contract!.toLowerCase() === d.eth.toLowerCase()) return refuse("the native coin is named by the catalog, not by the router's 0xEeee sentinel");
      if (!nativeOut && params.destToken.toLowerCase() === d.eth.toLowerCase()) return refuse("name a native output with the zero address, not the router's 0xEeee sentinel");
      const tokenIn = getAddress(nativeIn ? d.eth : src.contract!);
      const tokenOut = getAddress(nativeOut ? d.eth : params.destToken);
      if (tokenIn === tokenOut) return refuse("same token in and out");
      const wrapPair = [getAddress(d.eth), getAddress(d.weth)];
      if (wrapPair.includes(tokenIn) && wrapPair.includes(tokenOut)) return refuse("that is a wrap/unwrap, not a swap");

      try {
        await chain.verifyDeployment(chainId);
        const {routes, truncated} = findRoutes(chainId, d, tableOf(chainId), tokenIn, tokenOut);
        if (!routes.length) return refuse("no allowlisted Curve pool route for this pair");
        const outs = await price(chainId, d, routes, amountIn, signal);
        let best: {route: CurveRoute; out: bigint} | null = null;
        outs.forEach((out, i) => {
          if (out !== null && out > 0n && (!best || out > best.out)) best = {route: routes[i]!, out};
        });
        if (!best) return refuse("no allowlisted Curve pool quotes this pair and amount");
        const {route, out} = best as {route: CurveRoute; out: bigint};

        // Price impact: a probe 1/1000 the size on the same route gives the marginal rate; the full-size rate's
        // shortfall against it is the impact (pool fees are paid on both sides and cancel). Informational.
        let priceImpactBps: number | undefined;
        const probeIn = amountIn / 1000n;
        if (probeIn > 0n) {
          try {
            const [probeOut] = await price(chainId, d, [route], probeIn, signal);
            if (probeOut !== null && probeOut !== undefined && probeOut > 0n) {
              const ratioBps = (out * probeIn * 10_000n) / (probeOut * amountIn);
              priceImpactBps = Math.max(0, bigintToNumber(10_000n - ratioBps));
            }
          } catch {
            /* the quote stands; impact is information, not a gate */
          }
        }

        const bps = params.slippageBps ?? fixedSlippage ?? suggestSlippage({
          fromChain: params.sourceChain,
          toChain: params.destChain,
          fromSymbol: src.symbol,
          toSymbol: ccAssetByToken(params.destChain, nativeOut ? "" : params.destToken)?.symbol ?? "",
          ...(priceImpactBps !== undefined ? {priceImpactBps} : {}),
        }).bps;
        const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
        if (minOut <= 0n) return refuse("the minimum rounds to zero for this amount");
        if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
          return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`);
        }
        const args = routeArgs(d.family, route);
        const recipient = getAddress(params.destAddress);
        const data = encodeExchange(d.family, args, amountIn, minOut, recipient);
        const poolSteps = BigInt(routePools(args).length);
        const pseudoSteps = BigInt(route.steps.length) - poolSteps;
        const gasLimit = GAS_BASE + GAS_POOL * poolSteps + GAS_PSEUDO * pseudoSteps;

        const quote: Quote = {
          provider: "curve",
          intentId: `curve:${chainId}`,
          depositAddress: "",
          depositMemo: null,
          txRequest: {
            to: d.router,
            data,
            value: nativeIn ? amountIn.toString() : "0",
            chainId,
            gasLimit: gasLimit.toString(),
            ...(nativeIn ? {} : {approvalAddress: d.router}),
          },
          sourceAmount: amountIn.toString(),
          destAmount: out.toString(),
          minDestAmount: minOut.toString(),
          feeUsd: 0,
          etaSeconds: 15,
          reliability: 0.97,
          validUntilMs: Date.now() + ttl,
          // Pool fees are inside the router-priced output; nothing is added on top.
          providerData: {
            route: route.label,
            poolFee: "pools",
            router: d.router,
            family: d.family,
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            minOut: minOut.toString(),
            slippageBps: String(bps),
            pools: routePools(args).join(","),
            candidates: `${routes.length}${truncated ? "+" : ""}`,
            ...(priceImpactBps !== undefined ? {priceImpactBps: String(priceImpactBps)} : {}),
          },
        };
        // The same check a client runs on a remote quote, on what this provider just built.
        const why = selfCheck(params, quote);
        if (why) return refuse(`built a call its own check refuses (${why})`);
        return quote;
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^curve: /, "") : String(e));
      }
    },

    /**
     * Right before broadcast (after any approval): the transaction is byte for byte the sealed quote, the router and
     * each hop pool are still the pinned code with the pinned coins, and the exact route still pays at least the
     * signed minimum. Refuse with the reason instead of sending a swap that would revert or was altered.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const reason = await chain.checkSealed(quote, tx);
      if (reason) throw new Error(`curve: ${reason}. Nothing was sent; refresh the quote.`);
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw new Error("swap2: Curve quote has no transaction request");
      return {
        chain: "",
        to: tx.to,
        value: tx.value ?? "0",
        data: tx.data,
        ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}),
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}),
      };
    },

    /** Same-chain: the swap is done when its transaction is mined successfully. */
    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const chainId = Number(ref.intentId.split(":")[1]);
      if (!deploymentOf(deployments, chainId) || !config.rpcUrls[chainId]?.length) return {state: "pending"};
      try {
        const [receipt] = (await rpc(chainId, [{method: "eth_getTransactionReceipt", params: [ref.sourceTxHash]}])) as [{status?: string} | null];
        if (!receipt) return {state: "pending"};
        return receipt.status === "0x1" ? {state: "completed", destTxHash: ref.sourceTxHash} : {state: "failed"};
      } catch {
        return {state: "pending"};
      }
    },
  };
}
