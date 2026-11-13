import {getAddress} from "viem";
import {evmRef, isEvm, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {refusal, refusalOf, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {encodeExchange, encodeGetDy} from "./abi.js";
import {describeCurveActivity} from "./activity.js";
import {CURVE_DEPLOYMENTS, deploymentOf, type CurveDeployment} from "./deployments.js";
import {CURVE_POOLS} from "./pools/index.js";
import type {CurveChainPools} from "./pools/types.js";
import {findRoutes, routeArgs, routePools, type CurveRoute} from "./routes.js";
import {ethCall, wordUint} from "./rpc.js";
import {curveAutoSlippageBps, curveImpactBps} from "./slippage.js";
import {curveIntentChain, mintCurveIntentId} from "./intent.js";
import {curveOnChain, curveQuoteCheck} from "./verify.js";
import {notes, tagged} from "./reasons.js";

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
 * broadcast `preflightDeposit` re-checks the sealed call byte for byte, each hop pool's code and coins and a fresh
 * `get_dy` of the exact route against the minimum (the router's code hash and version are checked once per chain per
 * process: the router is immutable). ERC-20 sources approve exactly the input to the
 * pinned router (`approvalAddress`); the engine handles that leg (and a USDT-style reset to 0 first).
 */

/** Long enough for an approval to be mined on Ethereum; the router has no deadline of its own. */
const DEFAULT_TTL_MS = 180_000;

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
      const refuse = (why: string, info?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        if (info === undefined) params.onRefusal?.(`curve: ${why}`);
        else params.onRefusal?.(`curve: ${why}`, typeof info === "string" ? {reason: info} : info);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only", "unsupported_pair");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no Curve router, pool allowlist or RPC for ${params.sourceChain}`, "unsupported_pair");
      const d = deploymentOf(deployments, chainId)!;
      const src = sourceAssetOf(params);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`, "unsupported_pair");
      const nativeIn = !src.contract;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address", "unsupported_pair");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address", "recipient_mismatch");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive", "amount_too_small");
      if (params.slippageBps !== undefined && (!Number.isInteger(params.slippageBps) || params.slippageBps < 0 || params.slippageBps >= 10_000)) return refuse("slippage must be 0..9999 bps");
      if (!nativeIn && src.contract!.toLowerCase() === d.eth.toLowerCase()) return refuse("the native coin is named by the catalog, not by the router's 0xEeee sentinel", "unsupported_pair");
      if (!nativeOut && params.destToken.toLowerCase() === d.eth.toLowerCase()) return refuse("name a native output with the zero address, not the router's 0xEeee sentinel", "unsupported_pair");
      const tokenIn = getAddress(nativeIn ? d.eth : src.contract!);
      const tokenOut = getAddress(nativeOut ? d.eth : params.destToken);
      if (tokenIn === tokenOut) return refuse("same token in and out", "unsupported_pair");
      const wrapPair = [getAddress(d.eth), getAddress(d.weth)];
      if (wrapPair.includes(tokenIn) && wrapPair.includes(tokenOut)) return refuse("that is a wrap/unwrap, not a swap", "unsupported_pair");

      try {
        await chain.verifyDeployment(chainId);
        const {routes, truncated} = findRoutes(chainId, d, tableOf(chainId), tokenIn, tokenOut);
        if (!routes.length) return refuse("no allowlisted Curve pool route for this pair", "no_route");
        const outs = await price(chainId, d, routes, amountIn, signal);
        let best: {route: CurveRoute; out: bigint} | null = null;
        outs.forEach((out, i) => {
          if (out !== null && out > 0n && (!best || out > best.out)) best = {route: routes[i]!, out};
        });
        if (!best) return refuse("no allowlisted Curve pool quotes this pair and amount", "no_route");
        const {route, out} = best as {route: CurveRoute; out: bigint};

        // Price impact: a probe 1/1000 the size on the same route gives the marginal rate; the full-size rate's
        // shortfall against it is the impact (pool fees are paid on both sides and cancel). Informational.
        let priceImpactBps: number | undefined;
        const probeIn = amountIn / 1000n;
        if (probeIn > 0n) {
          try {
            const [probeOut] = await price(chainId, d, [route], probeIn, signal);
            priceImpactBps = curveImpactBps(amountIn, out, probeOut);
          } catch {
            /* the quote stands; impact is information, not a gate */
          }
        }

        const bps = params.slippageBps ?? fixedSlippage ?? curveAutoSlippageBps(params, priceImpactBps);
        const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
        if (minOut <= 0n) return refuse("the minimum rounds to zero for this amount", "amount_too_small");
        if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
          return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`, "price_check_failed");
        }
        const args = routeArgs(d.family, route);
        const recipient = getAddress(params.destAddress);
        const data = encodeExchange(d.family, args, amountIn, minOut, recipient);
        // No gas limit: get_dy measures no gas, and a per-step formula was wrong both ways. Run at its limit
        // (eth_call, 2026-11-05) the swap ran out of gas — crvUSD → scrvUSD on Ethereum needs 180 778 (formula
        // 180 000: the vault's deposit), every Monad route 345–352k for one stable-ng pool (formula 300 000) — while a
        // limit with room for the dearest pool overcharges where the limit is what is paid (Monad). The wallet
        // estimates the exact call with headroom right before broadcast, after any approval (as for Uniswap without
        // a quoter figure, THORChain and Chainflip).
        const quote: Quote = {
          provider: "curve",
          // One id per quote: a remote stub keys the request a build is checked against by it.
          intentId: mintCurveIntentId(chainId),
          depositAddress: "",
          depositMemo: null,
          txRequest: {
            to: d.router,
            data,
            value: nativeIn ? amountIn.toString() : "0",
            chainId,
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
        if (why) return refuse(`built a call its own check refuses (${why})`, notes.reasonOf(why) ?? "policy_refused");
        return quote;
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^curve: /, "") : String(e), refusalOf(e));
      }
    },

    /**
     * Right before broadcast (after any approval): the transaction is byte for byte the sealed quote, each hop pool is
     * still the pinned code with the pinned coins (the immutable router's code and version were checked once for the
     * chain), and the exact route still pays at least the signed minimum. Refuse with the reason instead of sending a swap that would revert or was altered.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const reason = await chain.checkSealed(quote, tx);
      if (reason) throw tagged(new Error(`curve: ${reason}. Nothing was sent; refresh the quote.`), notes.reasonOf(reason));
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw refusal("policy_refused", "swap2: Curve quote has no transaction request");
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
      const chainId = curveIntentChain(ref.intentId);
      if (chainId === null || !deploymentOf(deployments, chainId) || !config.rpcUrls[chainId]?.length) return {state: "pending"};
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
