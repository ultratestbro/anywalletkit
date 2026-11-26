import {decodeFunctionResult, encodeFunctionData, encodePacked, getAddress, parseAbi, type Hex} from "viem";
import {describeUniswapActivity} from "./activity.js";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {evmRef, isEvm, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {refusal, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ADDRESS_THIS, FEE_TIERS, HOP_SYMBOLS, ROUTER_ABI, UNISWAP_V3, type UniswapDeployment} from "./addresses.js";
import {bigintToNumber} from "@anywalletkit/core";
import {MIN_CALLS_PER_SECOND, QUOTE_WAIT_MAX_MS, uniswapRpc, type RpcCall, type SlotOptions} from "./rpc.js";
import {boundGasLimit, gasBoundsOf, hopsOf, impactRefusalText, probeImpactBps, spotImpactNetOfFeesBps, spotValueLossBps, validMaxImpactBps} from "./impact.js";

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
/** How long a chain's block gas limit is trusted before it is read again (ms); a read that failed, for less. */
const BLOCK_GAS_TTL_MS = 10 * 60_000;
const BLOCK_GAS_RETRY_MS = 60_000;
/**
 * How long a block gas limit read before stays in use while the reads after it are pending or fail (ms): a quote never
 * waits for a re-read when an answer is in hand (U0-LIVE-5), and a value older than this is dropped, so a wrong
 * answer does not stay for good when the node stops serving the method.
 */
const BLOCK_GAS_STALE_MS = 60 * 60_000;
/**
 * How long after a block read starts a quote waits for it (ms). The read goes out alongside the quote's own reads, so a
 * healthy node has answered long before; past this, a quote uses the known caps alone (the "node did not say" path)
 * and the read goes on in the background to fill the cache — a node that stalls on the method never holds quotes.
 */
const BLOCK_GAS_WAIT_MS = 1_500;

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
   * Refuse a quote that loses this many basis points or more of its value to price impact and pool fees, as
   * `insufficient_liquidity` (an integer 1..10000; a web swap page sets e.g. 500). Unset (the default): nothing is
   * refused for impact, which rides on the quote as information (`providerData.priceImpactBps`, when the probe could be
   * measured) — the wallet warns and the user decides.
   *
   * When set: every candidate is ranked as always and only the best route is gated (a lower-output candidate is never
   * the better offer); every read of the quote is pinned to one block; the measure is the larger of the 1/1000 probe
   * (`priceImpactBps`, fees excluded, transient RPC errors retried) and the spot value loss against the pools'
   * `slot0()` mid prices (fees included, `providerData.valueLossBps`). The fees count: a limit at or under the route's
   * pool fee (100 on a 1% pool, 60 on two 0.3% pools) refuses that route however deep its pools are — the text then
   * names the fees ("loses 1.0% of the value to price impact and pool fees — the route's fees (1%) bring it to the
   * limit; …") instead of thin pools. A probe too small to run, reverted, empty or unanswered after the retries leaves
   * spot to decide. Spot must be measured (the probe alone is blind to a pool parked past an empty range): when its
   * reads go unanswered after the retries, or come back reverted, zero or in another shape, the quote is refused —
   * `rate_limited` / `upstream_unavailable` (as `insufficient_liquidity` when the probe alone already reaches the
   * limit), never a quote with the check skipped. `preflightDeposit` does not apply it: the signed minimum governs there.
   */
  maxPriceImpactBps?: number;
  /**
   * Most JSON-RPC calls sent to one endpoint in any one second, across every quote, check and read of this provider (an
   * integer ≥ 13, MIN_CALLS_PER_SECOND: the least that carries one quote; a server sets the good-item rate its keyed
   * endpoint serves — QuickNode answered 50 calls a second on Monad and `-32007` the rest, UNISWAP-V4-RESEARCH §5.3).
   * Batches then carry at most 10 calls and wait for their turn on their endpoint, counted at the moment each batch
   * went; turns go to the quote that began first (its later reads before newer quotes' first ones), then first come first
   * served. A batch that would wait more than 4 s, or go later than 5 s after its quote began, is sent to the next
   * endpoint instead, and with none left refused as `rate_limited`: a quote is refused by then rather than run past the
   * router's 8 s. Unset (the default): no limit, every batch goes at once as in 0.4.11 — what the node rate-limits is
   * retried, then refused.
   */
  rpcCallsPerSecond?: number;
}

/**
 * A chain's block gas read: kept until `until`; a quote waits for it until `waitUntil`; `limit` once `done` (if any).
 * `last` is the newest good answer before it (read at `lastAt`): used, without waiting, while this read is pending or
 * when it failed.
 */
interface BlockGasRead {
  until: number;
  readonly waitUntil: number;
  done: boolean;
  limit?: bigint;
  readonly last?: bigint;
  readonly lastAt?: number;
  readAt?: number;
  read: Promise<void>;
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
  const perSecond = config.rpcCallsPerSecond;
  if (perSecond !== undefined && !(typeof perSecond === "number" && Number.isInteger(perSecond) && perSecond >= MIN_CALLS_PER_SECOND)) {
    throw new Error(`uniswap: rpcCallsPerSecond must be an integer ≥ ${MIN_CALLS_PER_SECOND} (the least that carries one quote)`);
  }
  const verified = new Map<number, Promise<void>>();
  /** Each chain's block gas read: until when it holds, until when a quote waits for it, and its answer once in. */
  const blockGas = new Map<number, BlockGasRead>();
  const net = uniswapRpc(config.rpcUrls, perSecond === undefined ? {} : {callsPerSecond: perSecond});
  /** `rpcCallsPerSecond`: quotes numbered as they begin, for their turns. */
  let quotesBegun = 0;

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return deployments[id] && config.rpcUrls[id]?.length ? id : null;
  };

  /** JSON-RPC for the getQuote/preflight paths: a revert is null; a call the node did not answer throws, classified. */
  const rpc = (chainId: number, calls: RpcCall[], policy: "none" | "items" | "all", signal?: AbortSignal, options?: SlotOptions) => net.results(chainId, calls, policy, signal, options);
  const call = (to: string, data: Hex, block: string = "latest"): RpcCall => ({method: "eth_call", params: [{to, data}, block]});

  /** The pinned addresses still describe one deployment (router + quoter agree on factory and WETH). */
  function verifyDeployment(chainId: number): Promise<void> {
    let p = verified.get(chainId);
    if (!p) {
      const d = deployments[chainId]!;
      p = (async () => {
        const f = encodeFunctionData({abi: ROUTER_ABI, functionName: "factory"});
        const w = encodeFunctionData({abi: ROUTER_ABI, functionName: "WETH9"});
        const [rf, rw, qf, qw] = await rpc(chainId, [call(d.router, f), call(d.router, w), call(d.quoter, f), call(d.quoter, w)], "items");
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

  /**
   * The chain's block gas read, for the gas bound: a transaction whose gasLimit is above the block's is invalid. Read on
   * its own (`eth_getBlockByNumber("latest", false)`, one pass over the endpoints, never the caller's abort) and kept for
   * BLOCK_GAS_TTL_MS, so a wrong or stale answer does not stay. Optional: a node that does not serve it, errs, or answers
   * without a gasLimit leaves undefined — only the known caps then apply — and never fails a quote; a failed read is
   * tried again after BLOCK_GAS_RETRY_MS. The newest good answer stays in use while a re-read is pending or failed, for
   * at most BLOCK_GAS_STALE_MS after it was read.
   */
  function blockGasRead(chainId: number): BlockGasRead {
    const now = Date.now();
    const hit = blockGas.get(chainId);
    if (hit && now < hit.until) return hit;
    const prior = hit?.limit !== undefined ? {last: hit.limit, lastAt: hit.readAt!} : hit?.last !== undefined ? {last: hit.last, lastAt: hit.lastAt!} : {};
    const entry: BlockGasRead = {until: now + BLOCK_GAS_TTL_MS, waitUntil: now + BLOCK_GAS_WAIT_MS, done: false, ...prior, read: Promise.resolve()};
    entry.read = net.slots(chainId, [{method: "eth_getBlockByNumber", params: ["latest", false]}], "none").then(
      ([s]) => (s && s.ok ? blockGasLimitOf(s.result) : undefined),
      () => undefined,
    ).then((limit) => {
      entry.done = true;
      if (limit === undefined) entry.until = Math.min(entry.until, now + BLOCK_GAS_RETRY_MS);
      else {
        entry.limit = limit;
        entry.readAt = now;
      }
    });
    blockGas.set(chainId, entry);
    return entry;
  }

  /**
   * The block gas limit one quote goes by: the read's answer when it is in; else the newest good answer before it
   * (still fresh), at once; else it waits at most until the read's `waitUntil`, and never past the caller's abort —
   * then undefined (the known caps alone), the read going on.
   */
  function blockGasLimit(entry: BlockGasRead, signal?: AbortSignal): Promise<bigint | undefined> {
    const last = entry.last !== undefined && Date.now() - entry.lastAt! <= BLOCK_GAS_STALE_MS ? entry.last : undefined;
    if (entry.done) return Promise.resolve(entry.limit ?? last);
    if (last !== undefined) return Promise.resolve(last);
    const left = entry.waitUntil - Date.now();
    if (left <= 0 || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.("abort", finish);
        resolve(entry.done ? entry.limit : undefined);
      };
      const timer = setTimeout(finish, left);
      signal?.addEventListener?.("abort", finish, {once: true});
      void entry.read.then(finish);
    });
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
  async function pinBlock(chainId: number, signal: AbortSignal | undefined, o: SlotOptions): Promise<Hex> {
    const [n] = await rpc(chainId, [{method: "eth_blockNumber", params: []}], "all", signal, o);
    if (typeof n !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(n)) throw refusal("upstream_unavailable", `uniswap: the RPC on chain ${chainId} did not name its latest block`);
    return `0x${BigInt(n).toString(16)}`;
  }

  /**
   * The two measures `maxPriceImpactBps` gates on, for the best route, at `block`: the 1/1000 probe (`probe`, as
   * `priceImpactBps`) and the spot value loss against the pools' slot0 mid prices, fees included (`spot`). Transient RPC
   * errors are retried. A probe too small to run, reverted, empty or zero is simply absent (spot decides); one the RPC
   * could not serve carries its classified error (`probeFailure`). Spot is always measured or failed (`spotFailure`):
   * the quoter just priced this route at `block`, so each hop's pool exists there — a pool lookup or slot0 read that is
   * unanswered, reverted, zero or in another shape is the node's fault, never "no pool".
   */
  async function measureImpact(
    chainId: number, d: UniswapDeployment, route: Route, tokenIn: Hex, tokenOut: Hex, amountIn: bigint, out: bigint, block: Hex, signal: AbortSignal | undefined, o: SlotOptions,
  ): Promise<{probe?: number; probeFailure?: Error} & ({spot: number; spotNet: number} | {spotFailure: Error})> {
    const hops = hopsOf(tokenIn, tokenOut, route.single, route.path);
    const probeIn = amountIn / 1000n;
    const calls = hops.map((h) => call(d.factory, encodeFunctionData({abi: POOL_ABI, functionName: "getPool", args: [h.tokenIn, h.tokenOut, h.fee]}), block));
    if (probeIn > 0n) calls.push(call(d.quoter, quoteData(route, tokenIn, tokenOut, probeIn), block));
    const first = await net.slots(chainId, calls, "all", signal, o);
    const m: {probe?: number; probeFailure?: Error} = {};
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
    const odd = (what: string) => ({...m, spotFailure: refusal("upstream_unavailable", `uniswap: the RPC on chain ${chainId} answered ${what} for a pool the quoter priced`)});
    const pools: Hex[] = [];
    for (let i = 0; i < hops.length; i++) {
      const s = first[i]!;
      if ("failed" in s) return {...m, spotFailure: s.failed};
      const pool = s.ok ? wordAddress(s.result) : null;
      if (!pool || pool === getAddress(ZERO)) return odd(s.ok ? "a pool lookup with no pool address" : "a reverted pool lookup");
      pools.push(pool);
    }
    const slot0 = encodeFunctionData({abi: POOL_ABI, functionName: "slot0"});
    const second = await net.slots(chainId, pools.map((pool) => call(pool, slot0, block)), "all", signal, o);
    const prices: bigint[] = [];
    for (const s of second) {
      if ("failed" in s) return {...m, spotFailure: s.failed};
      const price = s.ok ? firstWord(s.result) : undefined;
      if (price === undefined) return odd(s.ok ? "a slot0() with no price" : "a reverted slot0()");
      prices.push(price);
    }
    const spot = spotValueLossBps(hops, prices, amountIn, out);
    const spotNet = spotImpactNetOfFeesBps(hops, prices, amountIn, out);
    return spot === undefined || spotNet === undefined ? odd("mid prices that give no value loss") : {...m, spot, spotNet};
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

      // rpcCallsPerSecond: no batch of this quote goes later than QUOTE_WAIT_MAX_MS after it began (U0-LIVE-1), and its
      // turns come before those of quotes that began after it.
      const turns: SlotOptions = perSecond === undefined ? {} : {waitUntil: Date.now() + QUOTE_WAIT_MAX_MS, quote: ++quotesBegun};
      try {
        await verifyDeployment(chainId);
        const gasRead = blockGasRead(chainId); // alongside the quotes; optional (it never fails or holds the quote)
        // maxPriceImpactBps set: the candidates, the probe and the mid prices are all read at one block, with retries.
        // Unset: at "latest", as 0.4.11 read them (a call the node did not answer is retried, then refused — never
        // read as "no pool").
        const gated = maxImpact !== undefined;
        const block = gated ? await pinBlock(chainId, signal, turns) : "latest";
        const candidates = routes(chainId, params.sourceChain, tokenIn, tokenOut);
        /**
         * Each candidate's decoded answer. An answer QuoterV2 never gives — it answers four words or reverts — is no
         * answer (retried, then upstream_unavailable), never "not a candidate": the best pool would drop out silently
         * and a worse route win (U0-SEC-R3-2). An empty `"0x"` too with maxPriceImpactBps set; unset, it stays "no
         * candidate", as 0.4.11 read it.
         */
        const decoded = new Map<number, ReturnType<typeof decodeQuote>>();
        const accept = (raw: unknown, i: number): boolean => {
          if (raw === "0x") return !gated;
          if (typeof raw !== "string" || !/^0x[0-9a-fA-F]*$/.test(raw)) return false;
          try {
            decoded.set(i, decodeQuote(!!candidates[i]!.single, raw as Hex));
            return true;
          } catch {
            return false;
          }
        };
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
          {...turns, accept},
        );
        let best: {route: Route; out: bigint; gas: bigint} | null = null;
        let partial = false;
        results.forEach((raw, i) => {
          const q = typeof raw === "string" && raw !== "0x" ? decoded.get(i) : undefined; // a revert (null) or unset's "0x": no candidate
          if (!q || q.out <= 0n) return;
          if (q.drained) {
            partial = true;
            return;
          }
          if (!best || q.out > best.out) best = {route: candidates[i]!, out: q.out, gas: q.gas};
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
                turns,
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
          // the trade loses 98.7%, UNISWAP-V4-RESEARCH §7.2). So spot must be measured: when its reads fail the quote is
          // refused (fail closed) — at the limit already on the probe alone, else as the RPC's failure; an unmeasured
          // probe leaves spot to decide.
          const m = await measureImpact(chainId, d, route, tokenIn, tokenOut, amountIn, out, block as Hex, signal, turns);
          if ("spotFailure" in m) {
            if (m.probe !== undefined && m.probe >= maxImpact) return refuse(impactRefusalText(m.probe, maxImpact, route.label), "insufficient_liquidity");
            return refuse("could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again", refusalOf(m.probeFailure ?? m.spotFailure) ?? "upstream_unavailable");
          }
          priceImpactBps = m.probe;
          valueLossBps = m.spot;
          const loss = m.probe === undefined ? m.spot : Math.max(m.probe, m.spot);
          if (loss >= maxImpact) {
            // The gate goes by the loss with the pools' fees in it; the text names what got it there. Thin pools when
            // the price impact alone (the probe, or spot net of fees) reaches the limit, else the route's own fees.
            const thin = (m.probe ?? 0) >= maxImpact || m.spotNet >= maxImpact;
            return refuse(impactRefusalText(loss, maxImpact, route.label, thin ? undefined : route.poolFee), "insufficient_liquidity");
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
        // The limit is bounded by the chain (always on): a need (the bare need + 5% for EIP-150's 63/64 forwarding)
        // above the per-transaction cap, the block gas limit (less what the block spends first: OP-stack's 1M-gas
        // L1-info deposit) or Nitro's execution cap can never complete, so it is
        // refused; a padded limit above the gasLimit cap is clamped to it — never below the need (Monad charges the
        // whole limit even when the swap reverts).
        const pools = route.single ? 1n : BigInt((route.path!.length - 42) / 46);
        const extra = (nativeOut ? 40_000n : 0n) + (refund ? 10_000n : 0n);
        let gasLimit: bigint | undefined;
        if (gas >= MIN_POOL_GAS * pools) {
          const bounded = boundGasLimit(gas + 120_000n + extra, (gas * 3n) / 2n + 120_000n + extra, gasBoundsOf(chainId, await blockGasLimit(gasRead, signal)));
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
