import {decodeFunctionResult, encodeFunctionData, encodePacked, getAddress, parseAbi, type Hex} from "viem";
import {describeUniswapActivity} from "./activity.js";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {evmRef, isEvm, timeoutSignal, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {httpRefusal, refusal, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ADDRESS_THIS, FEE_TIERS, HOP_SYMBOLS, ROUTER_ABI, UNISWAP_V3, type UniswapDeployment} from "./addresses.js";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * Uniswap v3, straight from the contracts — the permissionless swap venue.
 *
 * Quote: QuoterV2 via `eth_call` (one JSON-RPC batch: every fee tier direct,
 * plus two-hop routes through WETH / USDC / USDT / USDT0). Execution: SwapRouter02
 * `multicall(deadline, …)` — `exactInputSingle` or `exactInput`, native input
 * wrapped by the router (`value`, then `refundETH()` when `refundNativeInput`), native output kept in the
 * router and paid out with `unwrapWETH9(min, recipient)`. No API key, no Uniswap
 * frontend, no aggregator: if the pools are live, the swap works.
 *
 * Same-chain only. ERC-20 sources approve exactly the input to the router
 * (`approvalAddress`); the engine handles that leg.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_SLIPPAGE_BPS = 50;
/** The router itself enforces amountOutMinimum and the deadline, and preflight
 *  re-quotes the exact route before broadcast — so the quote may outlive an
 *  approval being mined (an Ethereum approve + head wait took >30 s live). */
const DEFAULT_TTL_MS = 300_000;
const DEFAULT_DEADLINE_S = 600;
/** Least gas one v3 pool swap can use (cold pool storage + two token transfers cost far more); a quoter figure
 *  under this per pool does not measure the swap. */
const MIN_POOL_GAS = 20_000n;
/** The pool's price bounds the router swaps to when no limit is set (TickMath MIN_SQRT_RATIO + 1, MAX_SQRT_RATIO - 1).
 *  A quote that leaves a pool at one of them ran the pool dry: it is a partial fill of a smaller input, not a quote for
 *  this one (matrix v8, Ink: 0.01 ETH "quoted" 1 raw USDC out of a pool holding 168). */
const SQRT_PRICE_FLOOR = 4295128740n;
const SQRT_PRICE_CEIL = 1461446703485210103287273052203988822378723970341n;
const PARTIAL_FILL = "pool liquidity runs out before the full amount (partial fill)";

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
]);

/** A quoter result's output, the pool price(s) it leaves behind and its gas figure, for either quote shape. */
function decodeQuote(single: boolean, raw: Hex): {out: bigint; drained: boolean; gas: bigint} {
  const [out, after, , gas] = decodeFunctionResult({abi: QUOTER_ABI, functionName: single ? "quoteExactInputSingle" : "quoteExactInput", data: raw}) as readonly [bigint, bigint | readonly bigint[], unknown, bigint];
  const prices = typeof after === "bigint" ? [after] : after;
  return {out, gas, drained: prices.length === 0 || prices.some((p) => p <= SQRT_PRICE_FLOOR || p >= SQRT_PRICE_CEIL)};
}

export interface UniswapProviderConfig {
  enabled?: boolean;
  /** JSON-RPC endpoints per EVM chain id, tried in order. A chain without one is not offered. */
  rpcUrls: Readonly<Record<number, readonly string[]>>;
  /** Slippage when the caller names none (bps). Default 50. */
  defaultSlippageBps?: number;
  /** Local quote lifetime (must cover an approval being mined). Default 5 min. */
  quoteTtlMs?: number;
  /** Seconds the router accepts the swap after the quote (multicall deadline). Default 600. */
  deadlineSeconds?: number;
  /** Override the deployments (tests, new chains). Still verified on-chain before use. */
  deployments?: Readonly<Record<number, UniswapDeployment>>;
  /**
   * End a native-input swap with `refundETH()`, so `value` the pool did not take goes back to the sender in the same
   * transaction. Default false: clients pinned to `uniswapVerifyQuote` before 0.4.2 refuse the extra leg, so a server
   * turns this on only once the apps it serves verify with ≥ 0.4.2.
   */
  refundNativeInput?: boolean;
}

interface Route {
  /** Human description for the review / logs. */
  label: string;
  /** The pool fee(s) the route pays — already inside the quoted output. */
  poolFee: string;
  single?: {fee: number};
  path?: Hex;
}

type RpcCall = {method: string; params: unknown[]};

/** Largest JSON-RPC batch sent to one node (X Layer's public RPCs refuse more than 10). */
const RPC_BATCH_MAX = 10;

export function uniswapProvider(config: UniswapProviderConfig): CrossChainProvider {
  const deployments = config.deployments ?? UNISWAP_V3;
  const slippageDefault = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const deadlineS = config.deadlineSeconds ?? DEFAULT_DEADLINE_S;
  const refundNative = config.refundNativeInput === true;
  if (!Number.isInteger(slippageDefault) || slippageDefault <= 0 || slippageDefault >= 5_000) throw new Error("uniswap: defaultSlippageBps must be 1..4999");
  const verified = new Map<number, Promise<void>>();

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return deployments[id] && config.rpcUrls[id]?.length ? id : null;
  };

  /**
   * JSON-RPC batch with endpoint failover; each slot is the result or null (reverted / errored).
   * Sent in chunks of RPC_BATCH_MAX: some public nodes cap a batch (X Layer's at 10 calls).
   */
  async function rpc(chainId: number, calls: RpcCall[], signal?: AbortSignal): Promise<(unknown | null)[]> {
    if (calls.length <= RPC_BATCH_MAX) return rpcBatch(chainId, calls, signal);
    const chunks: RpcCall[][] = [];
    for (let i = 0; i < calls.length; i += RPC_BATCH_MAX) chunks.push(calls.slice(i, i + RPC_BATCH_MAX));
    return (await Promise.all(chunks.map((c) => rpcBatch(chainId, c, signal)))).flat();
  }

  async function rpcBatch(chainId: number, calls: RpcCall[], signal?: AbortSignal): Promise<(unknown | null)[]> {
    let lastErr: unknown;
    for (const url of config.rpcUrls[chainId] ?? []) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {"content-type": "application/json"},
          body: JSON.stringify(calls.map((c, id) => ({jsonrpc: "2.0", id, ...c}))),
          signal: signal ?? timeoutSignal(12_000),
        });
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}`);
          const info = httpRefusal(res.status, res.headers?.get?.("retry-after"));
          throw info ? withReason(error, info) : error;
        }
        const body = (await res.json()) as {id: number; result?: unknown; error?: unknown}[] | {error?: {message?: string}};
        if (!Array.isArray(body)) throw new Error(body.error?.message ?? "batch refused");
        const out: (unknown | null)[] = calls.map(() => null);
        for (const r of body) if (typeof r.id === "number" && r.id < out.length && r.error === undefined) out[r.id] = r.result ?? null;
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    const error = new Error(`uniswap: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
    // Every endpoint failed: the last one's own classification (a 429, a rejected key), else unavailable — never the caller's abort.
    throw signal?.aborted ? error : withReason(error, refusalOf(lastErr) ?? "upstream_unavailable");
  }

  const call = (to: string, data: Hex): RpcCall => ({method: "eth_call", params: [{to, data}, "latest"]});

  /** The pinned addresses still describe one deployment (router + quoter agree on factory and WETH). */
  function verifyDeployment(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      const d = deployments[chainId]!;
      p = (async () => {
        const f = encodeFunctionData({abi: ROUTER_ABI, functionName: "factory"});
        const w = encodeFunctionData({abi: ROUTER_ABI, functionName: "WETH9"});
        const [rf, rw, qf, qw] = await rpc(chainId, [call(d.router, f), call(d.router, w), call(d.quoter, f), call(d.quoter, w)]);
        const addr = (r: unknown) => (typeof r === "string" && r.length >= 42 ? getAddress(`0x${r.slice(-40)}`) : null);
        const wrapped = d.nativeWrap === false ? getAddress(ZERO) : getAddress(d.weth);
        const ok = [rf, qf].every((r) => addr(r) === getAddress(d.factory)) && addr(rw) === wrapped && addr(qw) === wrapped;
        if (!ok) throw refusal("vault_mismatch", `uniswap: the router/quoter on chain ${chainId} do not match the pinned deployment — refusing`);
      })();
      p.catch(() => verified.delete(chainId));
      verified.set(chainId, p);
    }
    return p;
  }

  /** Every candidate route for tokenIn → tokenOut on this chain. */
  function routes(chainId: number, caip2: string, tokenIn: Hex, tokenOut: Hex): Route[] {
    const d = deployments[chainId]!;
    const out: Route[] = FEE_TIERS.map((fee) => ({label: `direct ${fee / 10_000}%`, poolFee: `${fee / 10_000}%`, single: {fee}}));
    const mids = new Set<string>();
    for (const sym of HOP_SYMBOLS) {
      const mid = sym === "WETH" ? d.weth : ccAsset(caip2, sym)?.contract;
      if (!mid || !/^0x[0-9a-fA-F]{40}$/.test(mid)) continue;
      const m = getAddress(mid);
      if (m === getAddress(tokenIn) || m === getAddress(tokenOut) || mids.has(m)) continue;
      mids.add(m);
      for (const f1 of [100, 500, 3000]) {
        for (const f2 of [100, 500, 3000]) {
          out.push({label: `via ${sym} ${f1 / 10_000}% → ${f2 / 10_000}%`, poolFee: `${f1 / 10_000}% + ${f2 / 10_000}%`, path: encodePacked(["address", "uint24", "address", "uint24", "address"], [tokenIn, f1, m, f2, tokenOut])});
        }
      }
    }
    return out;
  }

  return {
    name: "uniswap",
    describeActivity: (tx, ctx) => describeUniswapActivity(tx, ctx, config.deployments ?? UNISWAP_V3),
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      return from.chain === to.chain && chainIdOf(from.chain) !== null;
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string, info?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        params.onRefusal?.(`uniswap: ${why}`, typeof info === "string" ? {reason: info} : info);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only", "unsupported_pair");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no Uniswap v3 deployment or RPC for ${params.sourceChain}`, "unsupported_pair");
      const d = deployments[chainId]!;
      const src = sourceAssetOf(params);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`, "unsupported_pair");
      const nativeIn = !src.contract;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if ((nativeIn || nativeOut) && d.nativeWrap === false) return refuse("this chain's router has no wrapped native — swap the coin's ERC-20 instead", "unsupported_pair");
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address", "unsupported_pair");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address", "recipient_mismatch");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const tokenIn = getAddress(nativeIn ? d.weth : src.contract!);
      const tokenOut = getAddress(nativeOut ? d.weth : params.destToken);
      if (tokenIn === tokenOut) return refuse(nativeIn || nativeOut ? "that is a wrap/unwrap, not a swap" : "same token in and out", "unsupported_pair");

      try {
        await verifyDeployment(chainId);
        const candidates = routes(chainId, params.sourceChain, tokenIn, tokenOut);
        const results = await rpc(
          chainId,
          candidates.map((r) =>
            call(
              d.quoter,
              r.single
                ? encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{tokenIn, tokenOut, amountIn, fee: r.single.fee, sqrtPriceLimitX96: 0n}]})
                : encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInput", args: [r.path!, amountIn]}),
            ),
          ),
          signal,
        );
        let best: {route: Route; out: bigint; gas: bigint} | null = null;
        let partial = false;
        results.forEach((raw, i) => {
          if (typeof raw !== "string" || raw === "0x") return;
          const r = candidates[i]!;
          try {
            const {out, drained, gas} = decodeQuote(!!r.single, raw as Hex);
            if (out <= 0n) return;
            if (drained) {
              partial = true;
              return;
            }
            if (!best || out > best.out) best = {route: r, out, gas};
          } catch {
            /* a malformed slot is just not a candidate */
          }
        });
        if (!best) return refuse(partial ? PARTIAL_FILL : "no Uniswap v3 pool route for this pair and amount", partial ? "insufficient_liquidity" : "no_route");
        const {route, out, gas} = best as {route: Route; out: bigint; gas: bigint};

        // Price impact (SDK-127): a probe 1/1000 the size on the same route gives the pool's
        // marginal rate; the full-size rate's shortfall against it is the impact. Pool fees
        // are paid on both sides, so they cancel. Informational — the Oct 16 run swapped
        // 16.78 USDT into 0.0099 USDT0 through an empty pool and nothing said a word.
        let priceImpactBps: number | undefined;
        const probeIn = amountIn / 1000n;
        if (probeIn > 0n) {
          try {
            const [raw] = await rpc(
              chainId,
              [call(d.quoter, route.single
                ? encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{tokenIn, tokenOut, amountIn: probeIn, fee: route.single.fee, sqrtPriceLimitX96: 0n}]})
                : encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInput", args: [route.path!, probeIn]}))],
              signal,
            );
            if (typeof raw === "string" && raw !== "0x") {
              const [probeOut] = decodeFunctionResult({abi: QUOTER_ABI, functionName: route.single ? "quoteExactInputSingle" : "quoteExactInput", data: raw as Hex}) as readonly [bigint];
              if (probeOut > 0n) {
                const ratioBps = (out * probeIn * 10_000n) / (probeOut * amountIn); // (out/amountIn) ÷ (probeOut/probeIn), in bps
                priceImpactBps = Math.max(0, bigintToNumber(10_000n - ratioBps));
              }
            }
          } catch {
            /* the quote stands; impact is information, not a gate */
          }
        }

        const bps = params.slippageBps ?? slippageDefault;
        const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
        if (minOut <= 0n) return refuse(`the minimum output rounds to 0 (quoted ${out} at ${bps} bps slippage) — the amount is too small for this pool`, "amount_too_small");
        if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
          return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`, "price_check_failed");
        }
        const recipient = getAddress(params.destAddress);
        const swapTo = nativeOut ? ADDRESS_THIS : recipient;
        const swap = route.single
          ? encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{tokenIn, tokenOut, fee: route.single.fee, recipient: swapTo as Hex, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n}]})
          : encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInput", args: [{path: route.path!, recipient: swapTo as Hex, amountIn, amountOutMinimum: minOut}]});
        const legs: Hex[] = [swap];
        if (nativeOut) legs.push(encodeFunctionData({abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [minOut, recipient]}));
        // The router wraps only what the pool takes: `value` it did not spend would stay in the router for anyone to
        // sweep. refundETH() pays it back to the sender in the same transaction (nothing to send on a full fill). Opt-in
        // (`refundNativeInput`) until every pinned client accepts the leg; the preflight partial-fill check and the
        // minimum already make an unspent remainder revert rather than stay behind.
        const refund = nativeIn && refundNative;
        if (refund) legs.push(encodeFunctionData({abi: ROUTER_ABI, functionName: "refundETH"}));
        const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineS);
        const data = encodeFunctionData({abi: ROUTER_ABI, functionName: "multicall", args: [deadline, legs]});
        // Quoter gas covers the pool hops; the router's own overhead and an unwrap ride on top. A figure no real pool
        // swap can cost (0 from a quoter that does not measure gas) is no figure: the limit is then left to the
        // wallet, which estimates the exact call with headroom right before broadcast, as for THORChain and Chainflip.
        // A limit derived from it would be the bare overhead, and the swap would run out of gas on chain.
        const pools = route.single ? 1n : BigInt((route.path!.length - 42) / 46);
        const gasLimit = gas >= MIN_POOL_GAS * pools ? (gas * 3n) / 2n + 120_000n + (nativeOut ? 40_000n : 0n) + (refund ? 10_000n : 0n) : undefined;

        return {
          provider: "uniswap",
          intentId: `uniswap:${chainId}`,
          depositAddress: "",
          depositMemo: null,
          txRequest: {
            to: d.router,
            data,
            value: nativeIn ? amountIn.toString() : "0",
            chainId,
            ...(gasLimit !== undefined ? {gasLimit: gasLimit.toString()} : {}),
            ...(nativeIn ? {} : {approvalAddress: d.router}),
          },
          sourceAmount: amountIn.toString(),
          destAmount: out.toString(),
          minDestAmount: minOut.toString(),
          feeUsd: 0,
          etaSeconds: 15,
          reliability: 0.98,
          validUntilMs: Date.now() + ttl,
          providerData: {
            route: route.label,
            poolFee: route.poolFee,
            router: d.router,
            tokenIn,
            tokenOut,
            amountIn: amountIn.toString(),
            minOut: minOut.toString(),
            ...(route.single ? {fee: String(route.single.fee)} : {path: route.path!}),
            ...(priceImpactBps !== undefined ? {priceImpactBps: String(priceImpactBps)} : {}),
          },
        };
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^uniswap: /, "") : String(e), refusalOf(e));
      }
    },

    /**
     * Right before broadcast (after any approval): re-quote the SAME route on
     * chain. If the pool now pays less than the signed minimum, the swap would
     * only revert and burn gas — refuse it here with the reason instead. A pool
     * that no longer holds enough for the whole input (it would fill part of it)
     * is refused the same way.
     */
    async preflightDeposit(quote: Quote): Promise<void> {
      const chainId = Number(quote.intentId.split(":")[1]);
      const d = deployments[chainId];
      const pd = quote.providerData ?? {};
      if (!d || !pd.amountIn || !pd.minOut || !pd.tokenIn || !pd.tokenOut) return;
      const data = pd.fee
        ? encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{tokenIn: pd.tokenIn as Hex, tokenOut: pd.tokenOut as Hex, amountIn: BigInt(pd.amountIn), fee: Number(pd.fee), sqrtPriceLimitX96: 0n}]})
        : encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInput", args: [pd.path as Hex, BigInt(pd.amountIn)]});
      const [raw] = await rpc(chainId, [call(d.quoter, data)]);
      if (typeof raw !== "string" || raw === "0x") throw refusal("no_route", "uniswap: the pool no longer quotes this route — refresh and try again");
      let quoted: ReturnType<typeof decodeQuote>;
      try {
        quoted = decodeQuote(!!pd.fee, raw as Hex);
      } catch (e) {
        throw e instanceof Error ? withReason(e, "upstream_unavailable") : e; // the node answered in another shape
      }
      const {out, drained} = quoted;
      if (drained) throw refusal("insufficient_liquidity", `uniswap: ${PARTIAL_FILL} — the pool can no longer take this swap. Nothing was sent; refresh the quote.`);
      if (out < BigInt(pd.minOut)) {
        throw refusal("price_check_failed", `uniswap: price moved — the pool now pays ${out}, under your minimum ${pd.minOut}. Nothing was sent; refresh the quote.`);
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw refusal("policy_refused", "swap2: Uniswap quote has no transaction request");
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
      if (!deployments[chainId] || !config.rpcUrls[chainId]?.length) return {state: "pending"};
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
