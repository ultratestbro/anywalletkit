import {decodeFunctionResult, encodeFunctionData, encodePacked, getAddress, parseAbi, type Hex} from "viem";
import {describeUniswapActivity} from "./activity.js";
import {ccAsset} from "@forgewallet/swap2-assets";
import {evmRef, isEvm, timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";
import {ADDRESS_THIS, FEE_TIERS, HOP_SYMBOLS, UNISWAP_V3, type UniswapDeployment} from "./addresses.js";

/**
 * Uniswap v3, straight from the contracts — the permissionless swap venue.
 *
 * Quote: QuoterV2 via `eth_call` (one JSON-RPC batch: every fee tier direct,
 * plus two-hop routes through WETH / USDC / USDT). Execution: SwapRouter02
 * `multicall(deadline, …)` — `exactInputSingle` or `exactInput`, native input
 * wrapped by the router (`value`), native output kept in the router and paid
 * out with `unwrapWETH9(min, recipient)`. No API key, no Uniswap frontend, no
 * aggregator: if the pools are live, the swap works.
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

const QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
]);
const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function factory() view returns (address)",
  "function WETH9() view returns (address)",
]);

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
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {id: number; result?: unknown; error?: unknown}[] | {error?: {message?: string}};
        if (!Array.isArray(body)) throw new Error(body.error?.message ?? "batch refused");
        const out: (unknown | null)[] = calls.map(() => null);
        for (const r of body) if (typeof r.id === "number" && r.id < out.length && r.error === undefined) out[r.id] = r.result ?? null;
        return out;
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(`uniswap: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
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
        const ok =
          [rf, qf].every((r) => addr(r) === getAddress(d.factory)) &&
          addr(rw) === wrapped &&
          (d.quoterWeth === false || addr(qw) === wrapped);
        if (!ok) throw new Error(`uniswap: the router/quoter on chain ${chainId} do not match the pinned deployment — refusing`);
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
      const refuse = (why: string): null => {
        params.onRefusal?.(`uniswap: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`no Uniswap v3 deployment or RPC for ${params.sourceChain}`);
      const d = deployments[chainId]!;
      const src = ccAsset(params.sourceChain, params.sourceToken);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`);
      const nativeIn = !src.contract;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if ((nativeIn || nativeOut) && d.nativeWrap === false) return refuse("this chain's router has no wrapped native — swap the coin's ERC-20 instead");
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const tokenIn = getAddress(nativeIn ? d.weth : src.contract!);
      const tokenOut = getAddress(nativeOut ? d.weth : params.destToken);
      if (tokenIn === tokenOut) return refuse(nativeIn || nativeOut ? "that is a wrap/unwrap, not a swap" : "same token in and out");

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
        results.forEach((raw, i) => {
          if (typeof raw !== "string" || raw === "0x") return;
          const r = candidates[i]!;
          try {
            const [out, , , gas] = decodeFunctionResult({abi: QUOTER_ABI, functionName: r.single ? "quoteExactInputSingle" : "quoteExactInput", data: raw as Hex}) as readonly [bigint, unknown, unknown, bigint];
            if (out > 0n && (!best || out > best.out)) best = {route: r, out, gas};
          } catch {
            /* a malformed slot is just not a candidate */
          }
        });
        if (!best) return refuse("no Uniswap v3 pool route for this pair and amount");
        const {route, out, gas} = best as {route: Route; out: bigint; gas: bigint};

        const bps = params.slippageBps ?? slippageDefault;
        const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
        if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
          return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`);
        }
        const recipient = getAddress(params.destAddress);
        const swapTo = nativeOut ? ADDRESS_THIS : recipient;
        const swap = route.single
          ? encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInputSingle", args: [{tokenIn, tokenOut, fee: route.single.fee, recipient: swapTo as Hex, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n}]})
          : encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInput", args: [{path: route.path!, recipient: swapTo as Hex, amountIn, amountOutMinimum: minOut}]});
        const legs: Hex[] = [swap];
        if (nativeOut) legs.push(encodeFunctionData({abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [minOut, recipient]}));
        const deadline = BigInt(Math.floor(Date.now() / 1000) + deadlineS);
        const data = encodeFunctionData({abi: ROUTER_ABI, functionName: "multicall", args: [deadline, legs]});
        // Quoter gas covers the pool hops; the router's own overhead and an unwrap ride on top.
        const gasLimit = (gas * 3n) / 2n + 120_000n + (nativeOut ? 40_000n : 0n);

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
            gasLimit: gasLimit.toString(),
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
          },
        };
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^uniswap: /, "") : String(e));
      }
    },

    /**
     * Right before broadcast (after any approval): re-quote the SAME route on
     * chain. If the pool now pays less than the signed minimum, the swap would
     * only revert and burn gas — refuse it here with the reason instead.
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
      if (typeof raw !== "string" || raw === "0x") throw new Error("uniswap: the pool no longer quotes this route — refresh and try again");
      const [out] = decodeFunctionResult({abi: QUOTER_ABI, functionName: pd.fee ? "quoteExactInputSingle" : "quoteExactInput", data: raw as Hex}) as readonly [bigint];
      if (out < BigInt(pd.minOut)) {
        throw new Error(`uniswap: price moved — the pool now pays ${out}, under your minimum ${pd.minOut}. Nothing was sent; refresh the quote.`);
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw new Error("swap2: Uniswap quote has no transaction request");
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
