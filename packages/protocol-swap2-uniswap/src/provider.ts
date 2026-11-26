import {decodeFunctionResult, encodeFunctionData, encodePacked, getAddress, parseAbi, type Hex} from "viem";
import {describeUniswapActivity} from "./activity.js";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {evmRef, isEvm, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {refusal, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ADDRESS_THIS, FEE_TIERS, HOP_SYMBOLS, ROUTER_ABI, UNISWAP_V3, type UniswapDeployment} from "./addresses.js";
import {bigintToNumber} from "@anywalletkit/core";
import {uniswapRpc, type RpcCall} from "./rpc.js";
import {boundGasLimit, gasCapOf, hopsOf, impactRefusalText, probeImpactBps, spotValueLossBps, validMaxImpactBps} from "./impact.js";

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
/** The v3 factory's pool lookup and a pool's `slot0()` (its mid price, read for the spot measure of `maxPriceImpactBps`). */
const POOL_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);

/** A quoter result's output, the pool price(s) it leaves behind and its gas figure, for either quote shape. */
function decodeQuote(single: boolean, raw: Hex): {out: bigint; drained: boolean; gas: bigint} {
  const [out, after, , gas] = decodeFunctionResult({abi: QUOTER_ABI, functionName: single ? "quoteExactInputSingle" : "quoteExactInput", data: raw}) as readonly [bigint, bigint | readonly bigint[], unknown, bigint];
  const prices = typeof after === "bigint" ? [after] : after;
  return {out, gas, drained: prices.length === 0 || prices.some((p) => p <= SQRT_PRICE_FLOOR || p >= SQRT_PRICE_CEIL)};
}

/** An address in a 32-byte ABI word (a getPool answer), or null. */
function wordAddress(raw: unknown): Hex | null {
  return typeof raw === "string" && /^0x0{24}[0-9a-fA-F]{40}$/.test(raw) ? getAddress(`0x${raw.slice(26)}`) : null;
}

/** The first 32-byte word of an answer (slot0's sqrtPriceX96, a uint160), or undefined when it is not one. */
function firstWord(raw: unknown): bigint | undefined {
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{64,}$/.test(raw)) return undefined;
  const v = BigInt(raw.slice(0, 66));
  return v > 0n && v < 1n << 160n ? v : undefined;
}

/** A block's `gasLimit`, or undefined when the node did not give one. */
function blockGasLimitOf(block: unknown): bigint | undefined {
  const g = block && typeof block === "object" ? (block as {gasLimit?: unknown}).gasLimit : undefined;
  if (typeof g !== "string" || !/^0x[0-9a-fA-F]{1,32}$/.test(g)) return undefined;
  const v = BigInt(g);
  return v > 0n ? v : undefined;
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
  /**
   * Refuse a quote that loses this many basis points or more of its value to price impact, as `insufficient_liquidity`
   * (an integer 1..10000; a web swap page sets e.g. 500). Unset (the default): nothing is refused for impact, which
   * rides on the quote as information (`providerData.priceImpactBps`) — the wallet warns and the user decides.
   *
   * When set: every candidate is ranked as always and only the best route is gated (a lower-output candidate is never
   * the better offer); every read of the quote is pinned to one block; the measure is the larger of the 1/1000 probe
   * (`priceImpactBps`, fees excluded, transient RPC errors retried) and the spot value loss against the pools'
   * `slot0()` mid prices (fees included, `providerData.valueLossBps`). A probe too small to measure falls back to spot;
   * when neither can be measured the quote is refused — `upstream_unavailable` / `rate_limited` when the RPC did not
   * answer, never a quote with the check skipped. `preflightDeposit` does not apply it: the signed minimum governs there.
   */
  maxPriceImpactBps?: number;
}

interface Route {
  /** Human description for the review / logs. */
  label: string;
  /** The pool fee(s) the route pays — already inside the quoted output. */
  poolFee: string;
  single?: {fee: number};
  path?: Hex;
}

export function uniswapProvider(config: UniswapProviderConfig): CrossChainProvider {
  const deployments = config.deployments ?? UNISWAP_V3;
  const slippageDefault = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const deadlineS = config.deadlineSeconds ?? DEFAULT_DEADLINE_S;
  const refundNative = config.refundNativeInput === true;
  if (!Number.isInteger(slippageDefault) || slippageDefault <= 0 || slippageDefault >= 5_000) throw new Error("uniswap: defaultSlippageBps must be 1..4999");
  const maxImpact = config.maxPriceImpactBps;
  if (maxImpact !== undefined && !validMaxImpactBps(maxImpact)) throw new Error("uniswap: maxPriceImpactBps must be an integer 1..10000");
  const verified = new Map<number, Promise<void>>();
  /** Each verified chain's block gas limit (undefined: the node did not say), read with the deployment check. */
  const blockGasLimits = new Map<number, bigint | undefined>();
  const net = uniswapRpc(config.rpcUrls);

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return deployments[id] && config.rpcUrls[id]?.length ? id : null;
  };

  /** JSON-RPC for the getQuote/preflight paths: a revert is null; a call the node did not answer throws, classified. */
  const rpc = (chainId: number, calls: RpcCall[], policy: "none" | "items" | "all", signal?: AbortSignal) => net.results(chainId, calls, policy, signal);
  const call = (to: string, data: Hex, block: string = "latest"): RpcCall => ({method: "eth_call", params: [{to, data}, block]});

  /**
   * The pinned addresses still describe one deployment (router + quoter agree on factory and WETH). The chain's block
   * gas limit rides in the same batch: a swap whose gas need is above it (or a per-transaction cap) can never be mined.
   */
  function verifyDeployment(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      const d = deployments[chainId]!;
      p = (async () => {
        const f = encodeFunctionData({abi: ROUTER_ABI, functionName: "factory"});
        const w = encodeFunctionData({abi: ROUTER_ABI, functionName: "WETH9"});
        const [rf, rw, qf, qw, block] = await rpc(chainId, [call(d.router, f), call(d.router, w), call(d.quoter, f), call(d.quoter, w), {method: "eth_getBlockByNumber", params: ["latest", false]}], "items");
        const addr = (r: unknown) => (typeof r === "string" && r.length >= 42 ? getAddress(`0x${r.slice(-40)}`) : null);
        const wrapped = d.nativeWrap === false ? getAddress(ZERO) : getAddress(d.weth);
        const ok = [rf, qf].every((r) => addr(r) === getAddress(d.factory)) && addr(rw) === wrapped && addr(qw) === wrapped;
        if (!ok) throw refusal("vault_mismatch", `uniswap: the router/quoter on chain ${chainId} do not match the pinned deployment — refusing`);
        blockGasLimits.set(chainId, blockGasLimitOf(block));
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

  /** The quoter call for `amount` along a route. */
  function quoteData(route: Route, tokenIn: Hex, tokenOut: Hex, amount: bigint): Hex {
    return route.single
      ? encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{tokenIn, tokenOut, amountIn: amount, fee: route.single.fee, sqrtPriceLimitX96: 0n}]})
      : encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInput", args: [route.path!, amount]});
  }

  /** The chain's latest block, normalized: every read of a gated quote is pinned to it. */
  async function pinBlock(chainId: number, signal?: AbortSignal): Promise<Hex> {
    const [n] = await rpc(chainId, [{method: "eth_blockNumber", params: []}], "all", signal);
    if (typeof n !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(n)) throw refusal("upstream_unavailable", `uniswap: the RPC on chain ${chainId} did not name its latest block`);
    return `0x${BigInt(n).toString(16)}`;
  }

  /**
   * The two measures `maxPriceImpactBps` gates on, for the best route, at `block`: the 1/1000 probe (`probe`, as
   * `priceImpactBps`) and the spot value loss against the pools' slot0 mid prices, fees included (`spot`). Transient RPC
   * errors are retried; a measure the RPC could not serve carries its classified error instead (`…Failure`). A probe
   * too small to run, reverted, empty or zero is simply absent: spot decides.
   */
  async function measureImpact(
    chainId: number, d: UniswapDeployment, route: Route, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, out: bigint, block: Hex, signal?: AbortSignal,
  ): Promise<{probe?: number; spot?: number; probeFailure?: Error; spotFailure?: Error}> {
    const m: {probe?: number; spot?: number; probeFailure?: Error; spotFailure?: Error} = {};
    const hops = hopsOf(tokenIn, tokenOut, route.single, route.path);
    const probeIn = amountIn / 1000n;
    const calls = hops.map((h) => call(d.factory, encodeFunctionData({abi: POOL_ABI, functionName: "getPool", args: [h.tokenIn, h.tokenOut, h.fee]}), block));
    if (probeIn > 0n) calls.push(call(d.quoter, quoteData(route, tokenIn, tokenOut, probeIn), block));
    const first = await net.slots(chainId, calls, "all", signal);
    const probe = first[hops.length];
    if (probe && "failed" in probe) m.probeFailure = probe.failed;
    else if (probe?.ok && typeof probe.result === "string" && probe.result !== "0x") {
      try {
        const [probeOut] = decodeFunctionResult({abi: QUOTER_ABI, functionName: route.single ? "quoteExactInputSingle" : "quoteExactInput", data: probe.result as Hex}) as readonly [bigint];
        if (probeOut > 0n) m.probe = probeImpactBps(amountIn, out, probeIn, probeOut);
      } catch (e) {
        m.probeFailure = withReason(e instanceof Error ? e : new Error(String(e)), "upstream_unavailable"); // the node answered in another shape
      }
    }
    const pools: Hex[] = [];
    for (let i = 0; i < hops.length; i++) {
      const s = first[i]!;
      if ("failed" in s) {
        m.spotFailure = s.failed;
        return m;
      }
      const pool = s.ok ? wordAddress(s.result) : null;
      if (!pool || pool === getAddress(ZERO)) return m; // no pool to read a mid price from
      pools.push(pool);
    }
    const slot0 = encodeFunctionData({abi: POOL_ABI, functionName: "slot0"});
    const second = await net.slots(chainId, pools.map((pool) => call(pool, slot0, block)), "all", signal);
    const prices: bigint[] = [];
    for (const s of second) {
      if ("failed" in s) {
        m.spotFailure = s.failed;
        return m;
      }
      const price = s.ok ? firstWord(s.result) : undefined;
      if (price === undefined) return m;
      prices.push(price);
    }
    const spot = spotValueLossBps(hops, prices, amountIn, out);
    if (spot !== undefined) m.spot = spot;
    return m;
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
        // maxPriceImpactBps set: the candidates, the probe and the mid prices are all read at one block, with retries.
        // Unset: at "latest", as 0.4.11 read them (a call the node did not answer is retried, then refused — never
        // read as "no pool").
        const gated = maxImpact !== undefined;
        const block = gated ? await pinBlock(chainId, signal) : "latest";
        const candidates = routes(chainId, params.sourceChain, tokenIn, tokenOut);
        const results = await rpc(
          chainId,
          candidates.map((r) =>
            call(
              d.quoter,
              r.single
                ? encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{tokenIn, tokenOut, amountIn, fee: r.single.fee, sqrtPriceLimitX96: 0n}]})
                : encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInput", args: [r.path!, amountIn]}),
              block,
            ),
          ),
          gated ? "all" : "items",
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
        let valueLossBps: number | undefined;
        const probeIn = amountIn / 1000n;
        if (maxImpact === undefined) {
          if (probeIn > 0n) {
            try {
              const [raw] = await rpc(
                chainId,
                [call(d.quoter, route.single
                  ? encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInputSingle", args: [{tokenIn, tokenOut, amountIn: probeIn, fee: route.single.fee, sqrtPriceLimitX96: 0n}]})
                  : encodeFunctionData({abi: QUOTER_ABI, functionName: "quoteExactInput", args: [route.path!, probeIn]}))],
                "none",
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
        } else {
          // maxPriceImpactBps (cp0x ask 1b): ranked first, so only the best route is gated — a lower-output candidate
          // is never the better offer. The measure is the larger of the probe and the spot value loss: the probe alone
          // can be absent (tiny amounts, a failed read) or blind (a pool parked past an empty range reads 342 bps while
          // the trade loses 98.7%, UNISWAP-V4-RESEARCH §7.2). Nothing measurable is a refusal, never a pass.
          const m = await measureImpact(chainId, d, route, tokenIn, tokenOut, amountIn, out, block as Hex, signal);
          priceImpactBps = m.probe;
          valueLossBps = m.spot;
          const loss = m.probe === undefined ? m.spot : m.spot === undefined ? m.probe : Math.max(m.probe, m.spot);
          if (loss === undefined) {
            const failure = m.probeFailure ?? m.spotFailure;
            return failure
              ? refuse("could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again", refusalOf(failure) ?? "upstream_unavailable")
              : refuse("the route would not quote a smaller amount; its price impact cannot be measured", "insufficient_liquidity");
          }
          if (loss >= maxImpact) return refuse(impactRefusalText(loss, maxImpact, route.label), "insufficient_liquidity");
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
        // The limit is bounded by the chain (always on): a bare need (no headroom) above the per-transaction cap or the
        // block gas limit can never be mined, so it is refused; a padded limit above the cap is clamped to it — never
        // below the need (Monad charges the whole limit even when the swap reverts).
        const pools = route.single ? 1n : BigInt((route.path!.length - 42) / 46);
        const extra = (nativeOut ? 40_000n : 0n) + (refund ? 10_000n : 0n);
        let gasLimit: bigint | undefined;
        if (gas >= MIN_POOL_GAS * pools) {
          const bounded = boundGasLimit(gas + 120_000n + extra, (gas * 3n) / 2n + 120_000n + extra, gasCapOf(chainId, blockGasLimits.get(chainId)));
          if ("refuse" in bounded) {
            return refuse(`the swap needs ${bounded.refuse.need} gas, more than chain ${chainId} takes in one transaction (${bounded.refuse.cap}) — its pools are too thin for this amount`, "insufficient_liquidity");
          }
          gasLimit = bounded.gasLimit;
        }

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
            ...(valueLossBps !== undefined ? {valueLossBps: String(valueLossBps)} : {}),
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
      const [raw] = await rpc(chainId, [call(d.quoter, data)], "items");
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
        const [receipt] = (await rpc(chainId, [{method: "eth_getTransactionReceipt", params: [ref.sourceTxHash]}], "none")) as [{status?: string} | null];
        if (!receipt) return {state: "pending"};
        return receipt.status === "0x1" ? {state: "completed", destTxHash: ref.sourceTxHash} : {state: "failed"};
      } catch {
        return {state: "pending"};
      }
    },
  };
}
