import {decodeFunctionResult, encodeFunctionData, encodePacked, getAddress, parseAbi, type Hex} from "viem";
import {describeUniswapActivity} from "./activity.js";
import {ccAsset, ccAssetByToken, resolveAsset} from "@anywalletkit/swap2-assets";
import {evmRef, isEvm, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {refusal, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ADDRESS_THIS, FEE_TIERS, HOP_SYMBOLS, ROUTER_ABI, UNISWAP_V3, type UniswapDeployment} from "./addresses.js";
import {bigintToNumber} from "@anywalletkit/core";
import {MIN_CALLS_PER_SECOND, QUOTE_WAIT_MAX_MS, isUnsupportedMethod, shortOfFunds, uniswapRpc, type RpcCall, type RpcSlot, type SlotOptions} from "./rpc.js";
import {KNOWN_EXECUTION_GAS_CAP, KNOWN_TX_GAS_CAP, boundGasLimit, gasBoundsOf, hopsOf, impactRefusalText, probeImpactBps, spotImpactNetOfFeesBps, spotValueLossBps, validMaxImpactBps} from "./impact.js";
import {UNISWAP_V4, V4_NATIVE, uniswapV4DeploymentOf, type UniswapV4Deployment} from "./v4/addresses.js";
import {UNISWAP_V4_POOLS} from "./v4pools/index.js";
import {v4ServedDeployment, v4ServesFlow} from "./v4/serve.js";
import {UNISWAP_V4_POOL_KEYS} from "./v4/listed.js";
import {discoverV4Pools, type V4BlockTag, type V4EthCall} from "./v4/discover.js";
import {buildV4Routes, decodeV4QuoteAnswer, multicallBatch, quoteCallDataOfKeys, quoteV4Routes, rankedV4Candidates, v4ProbeImpactBps, v4SpotLossBps, type V4CallBatch, type V4CallOutcome, type V4GasBound, type V4QuoteResult} from "./v4/quote.js";
import {checkedHooklessKey, checkedMaxFeePips, checkedV4ExtraPools} from "./v4/pool.js";
import {encodeV4Swap} from "./v4/encode.js";
import {V4_DEFAULT_DEADLINE_SECONDS, uniswapV4ReasonOf, uniswapV4VerifyQuote, v4DeploymentProblem, v4DeploymentReads, v4HopTokens, v4PreflightCall, v4StorageOverride, v4StrandedRecipient, v4StrandedRecipientText, type UniswapV4Mode} from "./v4/verify.js";
import {classifyV4Revert} from "./v4/errors.js";
import type {V4PoolKey} from "./v4/pool.js";

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
 *
 * Uniswap v4 (opt-in, `v4: "native-in"` or `"all"`; UNISWAP-V4-RESEARCH §5): the input is also quoted on the chain's
 * pinned hookless v4 pools (the shipped per-chain list, read through Multicall3 on the pinned StateView, plus the V4Quoter)
 * and executed through the pinned Universal Router 2.1.2 — `execute(0x10, [V4_SWAP([swap, SETTLE, TAKE])], deadline)`:
 * the exact input settled, the whole output taken to the recipient. A native-coin input calls the router with
 * `value = amountIn`; a token input (`"all"`) goes through Uniswap's SwapProxy — `SwapProxy.execute(pinned router, token,
 * amountIn, 0x10, [same input], deadline)` with `value = 0` and an exact approval of the SwapProxy — and may end in the
 * native coin (`TAKE(address(0), recipient, 0)`, paid by the PoolManager). v3 and v4 candidates are ranked together by
 * output; the impact gate (`maxPriceImpactBps`) applies to the winner. A token input is simulated with its approval from
 * the sender before the quote is returned (no approval is ever asked for a swap that would revert). Off by default: with
 * v4 off every quote is the v3 quote 0.4.x returned. With `venueRoutes: "both"` the two venues also reach the app as two
 * candidates (`getQuotes`: `routeId` "v3" and "v4", from the same ranking pass), each built and checked on its own.
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
/**
 * Gas a v4 swap through the Universal Router spends besides the pools the V4Quoter measures: the intrinsic cost, the
 * calldata, `execute`, the PoolManager unlock, SETTLE and TAKE. Live on Monad (2026-11-25): a single pool 158,710 gas
 * against a quoter figure of 49,492; two pools 216,036 against 86,591 (UNISWAP-V4-RESEARCH §3.3, §2.1). The quote's limit
 * is information for the review (the engine sends the account's own estimate, `ownGasEstimate`); it also feeds the gas
 * bound, which refuses a swap that could never be mined.
 */
const V4_ROUTER_GAS = 150_000n;
/**
 * What the SwapProxy adds on top of a router call (token input): the proxy call, the token's `transferFrom` of the input
 * into the router (cold allowance and balance slots) and the router settling that ERC-20 with the PoolManager instead of
 * native value. Measured live on 2026-11-26 as the account's own `eth_estimateGas` of the exact call less the quoter's
 * pool gas: Monad 700 USDC → AUSD 229,698 (estimate 278,580), → MON 192,186 (257,666); Base 1,000 USDC → ETH 123,055
 * (162,027) — all under the 290,000 the router and the proxy are given together.
 */
const V4_PROXY_GAS = 140_000n;
/**
 * Gas named on the v4 reads (the Multicall3 aggregates of StateView and V4Quoter calls) where a chain's RPCs give an
 * `eth_call` without `gas` less than one transaction may spend. Monad: 8.1M by default on all four endpoints (measured
 * 2026-11-26), against its 30M per-transaction cap — inside an aggregate a two-hop quote through a sparse pool (USDC →
 * USDT0 → AUSD, 18.4M gas) starved even on its own and refused the whole quote, while with 30M named it answers.
 * Elsewhere the default (600M on the tested nodes) already exceeds every per-transaction cap.
 */
const V4_READ_GAS: Readonly<Record<number, bigint>> = Object.freeze({143: 30_000_000n});
/**
 * A node's answer to an `eth_call` with gas named that says the gas was not given in full — its own `eth_call` gas cap
 * ("gas required exceeds allowance", "exceeds the RPC gas cap"…), or a block gas limit below it. Such an answer is no
 * fact about the call: a quoter call read again at the chain's per-transaction bound refuses on it.
 */
const NODE_GAS_CAP_TEXT = /allowance|gas cap|gas limit too high|exceeds (?:the )?block gas limit|intrinsic gas/i;
/** How long a chain whose RPC does not serve `eth_simulateV1` is remembered so (ms): later quotes go straight to the
 *  fallbacks; then it is asked again (an endpoint may start serving it). */
const NO_SIMULATE_V1_TTL_MS = 10 * 60_000;
/**
 * Most v4 candidates built for one quote (review R2-2): when the best v4 route's build is refused for a reason of its own
 * (the simulation of that route reverts, the module's own check, the gas bound), the next one is built — up to this many
 * — before the quote falls back to v3. A reason that holds for every v4 build of the quote (the RPC cannot simulate, the
 * approval fails) goes straight to v3.
 */
const V4_MAX_BUILDS = 3;
/** Most storage keys tried as a token's allowance slot (from its access list), and most slots kept. */
const MAX_SLOT_CANDIDATES = 16;
const MAX_CACHED_SLOTS = 256;

/**
 * How far a refusal of the token-input check (`v4TokenSwapCheck`) reaches (review R2-2): "trade" — the quote is refused:
 * no route can do this swap (the wallet holds less than the input, the recipient cannot take the native coin), or a read
 * of the check went unanswered (review R3-1, below); "route" — that v4 route's pools fail the simulated swap
 * (`V4TooLittleReceived`, `CurrencyNotSettled`, `NotEnoughLiquidity`, `PoolNotInitialized`…), so the next v4 candidate
 * may still build. Unmarked: a fact that every v4 build of the quote shares — the endpoint cannot simulate (a method or a
 * state override it does not serve, an answer in another shape), the approval or the token's pull into the SwapProxy
 * fails — and the quote falls back to v3 (whose spender is another contract).
 */
const V4_CHECK_SCOPE = new WeakMap<object, "trade" | "route">();
/** The reasons `classifyV4Revert` gives a revert of the route's own pools (a moved price, a partial fill, a pool not
 *  initialised, a hop swapping zero): the next v4 candidate may build. */
const ROUTE_REVERTS: ReadonlySet<Swap2RefusalReason> = new Set<Swap2RefusalReason>(["price_check_failed", "insufficient_liquidity", "no_route", "amount_too_small"]);
const scoped = (e: Error, scope: "trade" | "route"): Error => {
  V4_CHECK_SCOPE.set(e, scope);
  return e;
};
/**
 * A read of the token-input check that no endpoint answered after the retries — a rate limit, a node error, an HTTP
 * failure of every endpoint — refuses the quote with the node's reason (decision 5: a failed read refuses, it never
 * yields a worse candidate; review R3-1: one `-32007` on the allowance read made Monad 700 USDC → AUSD quote v3's 1.13
 * AUSD instead of v4's 700.08, and 20,000 USDC 1.13 instead of 20,002.93). The caller retries; the v3 fallback is kept for
 * facts about the endpoint and the token ({@link endpointFact}, a revert, an answer in another shape).
 */
const unanswered = (e: unknown): Error => scoped(e instanceof Error ? e : new Error(String(e)), "trade");
/** JSON-RPC "invalid params": the node does not take the request as sent (a state override, `eth_simulateV1`'s shape). */
const INVALID_PARAMS = -32602;
/**
 * A slot without an answer that is a fact about the endpoint, not a failed attempt: a method it does not serve
 * (`isUnsupportedMethod`: `eth_simulateV1` on Monad, `eth_createAccessList` on some gateways) or params it refuses
 * (`-32602`: a node that takes no state override). The same on every attempt and for every v4 build of the quote.
 */
const endpointFact = (s: RpcSlot | undefined): boolean => isUnsupportedMethod(s) || (!!s && "failed" in s && s.error?.code === INVALID_PARAMS);

/** The ERC-20 reads and the approval the SwapProxy flow simulates. */
const ERC20_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);
/**
 * The executor installed as the sender's code by a state override when no allowance slot verifies (§6.6, the general
 * fallback): with calldata it `DELEGATECALL`s the chain's Multicall3 (so `aggregate3`'s calls run with `msg.sender` = the
 * sender); with none it accepts the value sent and stops — the native output the PoolManager pays the sender. (Multicall3's
 * own code has no `receive`: installed directly it made every token → native simulation revert `NativeTransferFailed`,
 * live on Base and Monad 2026-11-26.) 61 bytes, written here from the opcodes:
 * `CALLDATASIZE ISZERO PUSH1 59 JUMPI · CALLDATACOPY(0, 0, size) · DELEGATECALL(gas, Multicall3, 0, size, 0, 0) ·
 * RETURNDATACOPY(0, 0, rsize) · success ? RETURN(0, rsize) : REVERT(0, rsize) · 59: STOP`.
 */
const EXECUTOR_CODE: Hex = "0x3615603b573660006000376000600036600073ca11bde05977b3631167028862be2a173976ca115af43d600060003e6036573d6000fd5b3d6000f35b00";
/** Multicall3's `aggregate3`, run in the sender's context by {@link EXECUTOR_CODE}. */
const MC3_ABI = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);

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

/** The reason of a refusal's classification (a bare reason, or the `reason` of an info). */
const reasonOfInfo = (info: Swap2RefusalReason | Swap2RefusalInfo | undefined): Swap2RefusalReason => (info === undefined ? "policy_refused" : typeof info === "string" ? info : info.reason);

/** An own entry of a per-chain table (never a prototype property). */
const ownKey = <T,>(rec: Readonly<Record<number, T>>, id: number): T | undefined => (Object.prototype.hasOwnProperty.call(rec, id) ? rec[id] : undefined);

/**
 * The most gas any one transaction on the chain may spend, where the module knows it as a fixed number: the
 * per-transaction gasLimit cap (`KNOWN_TX_GAS_CAP`), else the execution cap (`KNOWN_EXECUTION_GAS_CAP`, Arbitrum Nitro
 * and Robinhood Chain: 32M — the gasLimit may be larger by the L1 component, execution never). A V4Quoter call still
 * without revert data with this much gas named can never run in a transaction there (LIVE-1; review R3-2: without the
 * execution cap such a call refused the whole quote on Arbitrum, v3 included).
 */
function v4ReadBoundOf(chainId: number): bigint | undefined {
  return ownKey(KNOWN_TX_GAS_CAP, chainId) ?? ownKey(KNOWN_EXECUTION_GAS_CAP, chainId);
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
  /**
   * Seconds the router accepts the swap after the quote (the v3 multicall deadline). Default 600. A v4 swap's deadline is
   * at most 600 s ahead whatever this says (`min(deadlineSeconds, 600)`): that is the bound every app's `uniswapPins`
   * holds a v4 quote to (UNISWAP-V4-RESEARCH §6.5 row 6), and a larger one would have every app on the shipped pins
   * refuse the v4 quote — Uniswap lost on every pair v4 wins, while v3 kept quoting.
   */
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
  /**
   * Uniswap v4 (UNISWAP-V4-RESEARCH §5). "off" (the default): v3 only, every quote exactly as before. "native-in": a
   * native-coin input is also quoted on the chain's pinned v4 deployment — hookless pools only (an empty hook allowlist),
   * from the shipped per-chain list (`./v4pools`) plus `v4ExtraPools`, fee ≤ `v4MaxFeePips` — and executed through the
   * pinned Universal Router 2.1.2 with `value = amountIn` and no approval. "all": also a token input (into a token or the
   * native coin), through Uniswap's SwapProxy — the source token (catalog tokens only) approved to the chain's pinned
   * SwapProxy for exactly the input, `value = 0`; with the sender known (an execution quote) the approval and the swap are
   * simulated together before the quote is returned (`eth_simulateV1`; where the RPC does not serve it, as on Monad, the
   * swap is `eth_call`ed with the allowance set by a state override, or run by an executor installed as the sender's code
   * — never skipped; nothing simulable refuses). v3 and v4 are ranked together by output. A chain is quoted on v4 only
   * with a pool list (shipped or `v4ExtraPools`), never where the pins say `quotable: false` (HyperEVM); a native leg
   * never where the native coin is an ERC-20 (Celo, Arc). A failed discovery or quote read refuses the quote
   * (`rate_limited` / `upstream_unavailable`); it never quotes from fewer pools. A v4 deployment that does not match its
   * pins on chain (the router or, for token input, the SwapProxy) switches that v4 flow off on that chain, never v3.
   *
   * Rollout: apps on pins before 0.5.0 drop a Universal Router or SwapProxy quote (their `uniswapPins` call targets and
   * spenders are SwapRouter02 only), and one refused quote is Uniswap lost on that pair — a server turns v4 on only once
   * every app it serves has bumped.
   */
  v4?: UniswapV4Mode;
  /** Override the v4 deployments (tests, new chains). Still verified on chain before use (linkage and router codehash). */
  v4Deployments?: Readonly<Record<number, UniswapV4Deployment>>;
  /** The integrator's own v4 pools per chain: hookless only, PoolId recomputed; a hooked, malformed or above-10% key throws here. */
  v4ExtraPools?: Readonly<Record<number, readonly V4PoolKey[]>>;
  /** Highest LP fee a v4 pool on the route may charge, in pips (an integer 1..100000; default 100000 = 10%). */
  v4MaxFeePips?: number;
  /** v4 wins only when it pays more than v3 by more than this many bps (an integer 0..10000; default 0: the best output wins). */
  v4MinEdgeBps?: number;
  /**
   * How the two venues reach the app when v4 is on. `"best"` (the default): one quote per request — v3 and v4 ranked
   * together, the larger output returned (`v4MinEdgeBps`); no `getQuotes`, no `routeId`, every request and answer as
   * without this option.
   *
   * `"both"` (needs `v4: "native-in"` or `"all"`; with v4 off the provider throws when it is made): the provider also
   * implements `getQuotes`, which returns up to two candidates from one ranking pass (the reads of a `"best"` quote, at
   * the same block, plus the losing venue's own probe and checks) — `routeId: "v3"`, the best v3 route, and
   * `routeId: "v4"`, the best v4 route — each built and
   * checked exactly as it would be had it won: the impact gate (`maxPriceImpactBps`), the gas bound, the module's own
   * strict v4 check and the token-input simulation apply to each one. One venue refusing never drops the other; with
   * both refused the list is empty and `onRefusal` hears why (on a chain without Uniswap v3, v4's reason alone). A
   * venue left out because its reads failed while the other's candidate goes out, or because its deployment does not
   * match its pins (v3's too), is named through `onV4Warning`. The v4 candidate keeps the `v4RankedPools` provenance
   * rule: a route over pools outside the ranked set (grid, extra, newer-list pools) only where v3 has no route — where
   * v3 could not be read, such a route is refused with that read's reason.
   * `getQuote` without a `routeId` returns the `"best"` winner, now naming its route (`"v3"` or `"v4"`); with
   * `routeId: "v3"` it quotes v3 alone, with `"v4"` v4 alone (v3 is read only for that provenance rule) — never the
   * other venue in its place; any other `routeId` is refused (`policy_refused`). A router shows each candidate as its
   * own row; the app labels rows from `routeId` and executes a pick with `using("uniswap", routeId)` — a live request
   * without a `routeId` is the `"best"` pass, which can refuse where a row was shown (see the README).
   */
  venueRoutes?: "best" | "both";
  /**
   * Which v4 routes may win over a v3 route (§6.5 row 9, pool provenance). An app on `uniswapPins` accepts only pools
   * from the shipped list; a pool that the unlisted-token grid found, or one of this provider's `v4ExtraPools`, fails
   * those pins — and since a remote stub gets one quote per pair, a v4 route through it that beat v3 would cost the app
   * the v3 quote it used to get.
   * - `"listed"` (the default): only routes over shipped-list pools are ranked against v3. A route through a grid or an
   *   extra pool is returned only when v3 has no route for the pair (nothing the app had is lost then).
   * - `"extra"`: `v4ExtraPools` pools rank as listed ones — for a server whose apps pin
   *   `uniswapPinsWith({v4ExtraPools})` with the same pools; grid routes still only when v3 has none.
   * - `"all"`: every route ranked by output — a provider running in the app itself (its own check is the one that
   *   counts, and it accepts the pools its own discovery read on chain).
   *
   * "Shipped-list pools" means the pools of every list this module has shipped for the chain: a rebuilt list marks each
   * pool it adds with its build block (`since`, see {@link v4RankedListBlock}), and such a pool ranks against v3 only once
   * `v4RankedListBlock` covers it — an app on an older release does not pin it yet (review R2-1).
   */
  v4RankedPools?: "listed" | "extra" | "all";
  /**
   * Per chain, the build block of the oldest pool list among the apps this server serves — the `block` of
   * `UNISWAP_V4_POOLS[chain]` in the oldest release they run. A shipped-list pool that a later list added (its `since`
   * above this block, or any `since` when the chain has no entry) is ranked like a grid pool: returned only when v3 has
   * no route for the pair, since an app on the older list refuses it ("not in the pinned pool list") and a stub gets one
   * quote per pair. Unset (the default): only the pools of the chain's first shipped list rank against v3. Raise it per
   * chain once every app has bumped. Ignored with `v4RankedPools: "all"`.
   */
  v4RankedListBlock?: Readonly<Record<number, number>>;
  /**
   * Called when v4 is set aside on a quote that still goes out (§6.5 row 15, "refuse + alert"): the chain's v4 deployment
   * does not match its pins (the router's code or linkage, or with `v4: "all"` the SwapProxy's — `reason:
   * "vault_mismatch"`; v4, or its token input, is off on that chain for the quote, v3 untouched), or the best v4 route's
   * build was refused for a reason of the build and the quote fell back to another route (the build's reason). Also
   * called on a deployment mismatch that leaves the chain without a route (the quote's `onRefusal` hears that refusal
   * too). With `venueRoutes: "both"`, also when one venue's candidate is left out because its reads failed (the node's
   * reason: `rate_limited`, `upstream_unavailable`, `stale_node`, `key_rejected`, or unclassified as
   * `upstream_unavailable`) while the other venue's candidate goes out — v3's too: the row then shown alone is the only
   * Uniswap offer, and a retry may bring the other back; never for a request the caller aborted. And on every
   * venue-routes pass that finds the chain's v3 router or quoter not matching its pins (`reason: "vault_mismatch"`: v3
   * is off on that chain for the pass, v4 untouched; a `"best"` quote refuses the request through `onRefusal`
   * instead). It is the operator's alert, not the caller's refusal:
   * `onRefusal` is first-wins and dropped by the handlers when a quote stands, so a note there would hide the real reason
   * or go nowhere. A throw (or a rejected promise) is ignored.
   */
  onV4Warning?: (text: string, info: {chainId: number; reason: Swap2RefusalReason}) => void;
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

/** What one v4 deployment check found: the router flow (native input) and the SwapProxy flow (token input) usable. */
interface V4DeploymentState {
  native: boolean;
  token: boolean;
  /** What does not match, when a flow is off: the router's problem, else the SwapProxy's. */
  problem?: string;
}

/** What one v4 build came to: a quote, or a refusal that is the trade's (final), that route's own, or the quote's. */
type V4Build =
  | {quote: Quote}
  | {refused: string; info?: Swap2RefusalReason | Swap2RefusalInfo; scope: "trade" | "route" | "quote"};

/** The route selectors of `venueRoutes: "both"` (`Quote.routeId` / `QuoteParams.routeId`): the venue a quote runs on. */
export type UniswapRouteId = "v3" | "v4";
const ROUTE_IDS: readonly UniswapRouteId[] = ["v3", "v4"];
/**
 * A venue's answer in a venue-routes pass: its quote, or why it has none (the text without "uniswap: "; `alerted`: the
 * operator already heard it through `onV4Warning`).
 */
type VenueAnswer = {quote: Quote} | {refused: string; info?: Swap2RefusalReason | Swap2RefusalInfo; alerted?: true};
type VenueRefusal = Extract<VenueAnswer, {refused: string}>;
/** What a venue-routes pass quotes: one venue, or both. */
type VenuePick = UniswapRouteId | "both";
/** Each venue a pass was asked for, answered. */
type VenueQuotes = Partial<Record<UniswapRouteId, VenueAnswer>>;
/** Reasons that say only that a venue has nothing here: with both venues refused, another venue's reason is the one reported. */
const SOFT_REASONS: ReadonlySet<Swap2RefusalReason> = new Set<Swap2RefusalReason>(["no_route", "unsupported_pair"]);
/**
 * Reasons that say a venue's reads failed — the node, not the trade: a venue left out for one while the other venue's
 * candidate goes out is named to the operator (review LIVE-VR-1); a retry may bring it back.
 */
const READ_FAILURES: ReadonlySet<Swap2RefusalReason> = new Set<Swap2RefusalReason>(["rate_limited", "upstream_unavailable", "stale_node", "key_rejected"]);

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
  const v4Mode: UniswapV4Mode = config.v4 ?? "off";
  if (v4Mode !== "off" && v4Mode !== "native-in" && v4Mode !== "all") throw new Error('uniswap: v4 must be "off", "native-in" or "all"');
  const venueRoutes = config.venueRoutes ?? "best";
  if (venueRoutes !== "best" && venueRoutes !== "both") throw new Error('uniswap: venueRoutes must be "best" or "both"');
  if (venueRoutes === "both" && v4Mode === "off") throw new Error('uniswap: venueRoutes "both" needs v4 "native-in" or "all" (with v4 off there is one venue)');
  const v4Deployments = config.v4Deployments ?? UNISWAP_V4;
  const v4MaxFee = checkedMaxFeePips(config.v4MaxFeePips);
  const v4MinEdge = config.v4MinEdgeBps ?? 0;
  if (!Number.isInteger(v4MinEdge) || v4MinEdge < 0 || v4MinEdge > 10_000) throw new Error("uniswap: v4MinEdgeBps must be an integer 0..10000");
  const v4Ranked = config.v4RankedPools ?? "listed";
  if (v4Ranked !== "listed" && v4Ranked !== "extra" && v4Ranked !== "all") throw new Error('uniswap: v4RankedPools must be "listed", "extra" or "all"');
  const v4RankedBlock: Record<number, number> = {};
  for (const [id, block] of Object.entries(config.v4RankedListBlock ?? {})) {
    const n = /^[0-9]+$/.test(id) ? Number(id) : NaN;
    if (!Number.isSafeInteger(n) || !Number.isSafeInteger(block) || block < 0) throw new Error(`uniswap: v4RankedListBlock[${id}] must be a block number (an integer ≥ 0)`);
    v4RankedBlock[n] = block;
  }
  /** Per chain, the shipped-list pools an app on an older list may not pin (`since` above `v4RankedListBlock`). */
  const newerListed = new Map<number, ReadonlySet<string>>();
  const newerListedOf = (chainId: number): ReadonlySet<string> => {
    let ids = newerListed.get(chainId);
    if (!ids) {
      const upTo = ownKey(v4RankedBlock, chainId);
      ids = new Set((ownKey(UNISWAP_V4_POOLS, chainId)?.pools ?? []).filter((p) => p.since !== undefined && (upTo === undefined || p.since > upTo)).map((p) => p.id.toLowerCase()));
      newerListed.set(chainId, ids);
    }
    return ids;
  };
  /** A v4 swap's deadline: never further ahead than the shipped pins accept (see `deadlineSeconds`). */
  const v4DeadlineS = Math.min(deadlineS, V4_DEFAULT_DEADLINE_SECONDS);
  /** `v4ExtraPools`, checked once with the pins' own parser: a configuration error is never skipped silently, and a key
   *  the apps' `uniswapPinsWith` would refuse (`"0x8f"`, `" 143"`) is refused here too. */
  const v4Extra = checkedV4ExtraPools(config.v4ExtraPools);
  const v4Verified = new Map<number, Promise<V4DeploymentState>>();
  /** Chains whose RPC answered `eth_simulateV1` with "not served", until when (ms). */
  const noSimulateV1 = new Map<number, number>();
  /** A token's verified `allowance[owner][spender]` storage slot (the Monad fallback). */
  const allowanceSlots = new Map<string, Hex>();

  /** The chain's v4 deployment when this provider quotes v4 there (see `v4`), else undefined. Pool provenance (§6.5
   *  row 9): only where the app can check the pools — the shipped list or the integrator's own. */
  const v4Of = (id: number): UniswapV4Deployment | undefined => v4ServedDeployment(id, v4Mode, v4Deployments, v4Extra);
  /** `rpcCallsPerSecond`: quotes numbered as they begin, for their turns. */
  let quotesBegun = 0;

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return (deployments[id] || v4Of(id)) && config.rpcUrls[id]?.length ? id : null;
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

  /**
   * The chain's v4 pins still describe one deployment (§6.5 row 15, once per chain while it holds): `poolManager()` of
   * the Universal Router, the V4Quoter and the StateView is the pinned PoolManager, and the router's runtime code hashes to
   * the pinned 2.1.2 build; with `v4: "all"` the SwapProxy's runtime code hashes to its pinned build too. A mismatch turns
   * that flow off on that chain for this quote — the router's, both v4 flows; the SwapProxy's, token input only; v3 is
   * not touched — and the check runs again on the next one; a read the node did not answer throws, classified.
   */
  function verifyV4Deployment(chainId: number, d4: UniswapV4Deployment): Promise<V4DeploymentState> {
    let p = v4Verified.get(chainId);
    if (!p) {
      const proxy = v4Mode === "all";
      p = (async () => {
        const answers = await rpc(chainId, v4DeploymentReads(d4, {swapProxy: proxy}), "items");
        const router = v4DeploymentProblem(d4, answers.slice(0, 4), {swapProxy: false});
        const swapProxy = proxy && router === null ? v4DeploymentProblem(d4, answers, {swapProxy: true}) : null;
        const problem = router ?? swapProxy;
        return {native: router === null, token: proxy && router === null && swapProxy === null, ...(problem !== null ? {problem} : {})};
      })();
      const self = p;
      const forget = () => { if (v4Verified.get(chainId) === self) v4Verified.delete(chainId); };
      p.then((ok) => { if (!ok.native || (proxy && !ok.token)) forget(); }, forget);
      v4Verified.set(chainId, p);
    }
    return p;
  }

  /**
   * One `eth_call` for the v4 discovery and quote reads, retried as `all` (a call the node did not answer is retried, then
   * refused classified — never read as "no pool"). A revert of the read itself (a Multicall3 aggregate out of gas) throws
   * with the node's text, so the quote batcher can split it.
   */
  const v4EthCall = (chainId: number, signal?: AbortSignal): V4EthCall => async (c, tag) => {
    const gas = ownKey(V4_READ_GAS, chainId);
    const read: RpcCall = {method: "eth_call", params: [{to: c.to, data: c.data, ...(gas !== undefined ? {gas: `0x${gas.toString(16)}`} : {})}, tag]};
    const [s] = await net.slots(chainId, [read], "all", signal);
    if (!s) throw refusal("upstream_unavailable", `uniswap v4: no RPC answered on chain ${chainId}`);
    if ("failed" in s) throw s.failed;
    if (!s.ok) throw withReason(new Error(`uniswap v4: a read reverted on chain ${chainId} (${s.revert.message.slice(0, 160)})`), "upstream_unavailable");
    if (typeof s.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(s.result)) throw refusal("upstream_unavailable", `uniswap v4: the RPC on chain ${chainId} answered a read in another shape — refusing`);
    return s.result as Hex;
  };

  /** A currency's catalog symbol on the chain (route labels), else its address. */
  const symbolOf = (chainId: number, currency: Hex): string => ccAssetByToken(`eip155:${chainId}`, /^0x0{40}$/.test(currency) ? "" : currency)?.symbol ?? getAddress(currency);

  /**
   * The v4 candidates for `currencyIn` (address(0) = the native coin) into `currencyOut` at `block`: the listed (and
   * extra) pools of the pair set — direct, and through each hop currency the verifier accepts — read in one Multicall3
   * aggregate; the unlisted-token grid only for a currency the list does not know; every route on the V4Quoter. Any
   * failed read throws (classified).
   */
  async function quoteV4(chainId: number, d4: UniswapV4Deployment, currencyIn: Hex, currencyOut: Hex, amountIn: bigint, block: V4BlockTag, signal?: AbortSignal): Promise<V4QuoteResult & {batch: V4CallBatch; gridPools: V4PoolKey[]}> {
    const ethCall = v4EthCall(chainId, signal);
    const into = getAddress(currencyIn);
    const out = getAddress(currencyOut);
    const hubs = [...v4HopTokens(chainId, d4)].filter((h) => h !== into && h !== out) as Hex[];
    const discovery = await discoverV4Pools({
      stateView: d4.stateView, currencyIn: into, currencyOut: out, hubs, list: ownKey(UNISWAP_V4_POOLS, chainId), extraPools: ownKey(v4Extra, chainId), maxFeePips: v4MaxFee, blockTag: block,
    }, ethCall);
    const routes = buildV4Routes({currencyIn: into, currencyOut: out, pools: discovery.pools, hubs, hubName: (h) => symbolOf(chainId, h)});
    const batch = multicallBatch(ethCall, block);
    const q = await quoteV4Routes({quoter: d4.quoter, routes, amountIn, gasBound: v4GasBound(chainId, block, signal)}, batch);
    return {...q, batch, gridPools: discovery.pools.filter((p) => p.source === "grid").map((p) => p.key)};
  }

  /**
   * LIVE-1 (§6.5 row 17): a V4Quoter call that came back without revert data even alone in its aggregate is read once
   * more, straight to the quoter, with exactly the chain's per-transaction gas cap named. Still without revert data, the
   * route needs more gas than any transaction on the chain may have — it can never be mined, so it is not a candidate
   * (counted as `providerData.v4Unexecutable`). Only where that bound is known ({@link v4ReadBoundOf}: 2^24 / 2^25 /
   * Monad's 30M per transaction, Arbitrum Nitro's 32M of execution — below the eth_call gas the nodes serve): elsewhere
   * the bound is the block gas limit, which a node's own eth_call gas cap may lie under, so such a call still refuses the
   * quote. A call the node did not answer, or answered as a gas cap of its own, refuses — never "too much gas".
   */
  function v4GasBound(chainId: number, block: V4BlockTag, signal?: AbortSignal): V4GasBound | undefined {
    const cap = v4ReadBoundOf(chainId);
    if (cap === undefined) return undefined;
    return {
      cap,
      calls: async (cs) => {
        const slots = await net.slots(chainId, cs.map((c): RpcCall => ({method: "eth_call", params: [{to: c.to, data: c.data, gas: `0x${cap.toString(16)}`}, block]})), "all", signal);
        if (slots.length !== cs.length) throw refusal("upstream_unavailable", `uniswap v4: ${slots.length} answers for ${cs.length} quoter calls on chain ${chainId} — refusing`);
        return slots.map((s): V4CallOutcome => {
          if ("failed" in s) throw s.failed;
          if (s.ok) {
            if (typeof s.result !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(s.result)) throw refusal("upstream_unavailable", `uniswap v4: the RPC on chain ${chainId} answered a quoter call in another shape — refusing`);
            return {ok: true, data: s.result as Hex};
          }
          if (NODE_GAS_CAP_TEXT.test(s.revert.message)) throw refusal("upstream_unavailable", `uniswap v4: the RPC on chain ${chainId} did not give a quoter call the chain's ${cap} gas (${s.revert.message.slice(0, 120)}) — refusing rather than ranking fewer routes`);
          const data = s.revert.data;
          return {ok: false, revert: typeof data === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(data) ? (data as Hex) : "0x"};
        });
      },
    };
  }

  /**
   * Right before signing a v4 swap: the same route re-quoted on the V4Quoter (a partial fill or an output under the
   * signed minimum refuses it), then an `eth_call` of the exact transaction from the quote's sender at `latest` (§6.6:
   * native input needs no approval, so a plain call covers it; a token input runs after the engine's approval, so the
   * SwapProxy's `transferFrom` spends the real allowance; a revert is decoded and mapped). No answer refuses — never a
   * pass.
   */
  async function preflightV4(chainId: number, quote: Quote, tx: UnsignedTx | undefined): Promise<void> {
    const pd = quote.providerData ?? {};
    const d4 = v4Mode === "off" ? undefined : uniswapV4DeploymentOf(chainId, v4Deployments);
    if (!d4) throw refusal("policy_refused", "uniswap: a Uniswap v4 quote, but v4 is off here — refresh the quote");
    if (!pd.amountIn || !pd.minOut || !pd.poolKeys || !/^[0-9]+$/.test(pd.amountIn) || !/^[0-9]+$/.test(pd.minOut)) throw refusal("policy_refused", "uniswap: the v4 quote carries no route to check — refresh and try again");
    // The input currency names the flow: address(0) calls the router with value; a token goes through the SwapProxy.
    const currencyIn = pd.currencyIn ?? "";
    if (!/^0x[0-9a-fA-F]{40}$/.test(currencyIn)) throw refusal("policy_refused", "uniswap: the v4 quote names no input currency — refresh the quote");
    const nativeIn = /^0x0{40}$/.test(currencyIn);
    if (!nativeIn && v4Mode !== "all") throw refusal("policy_refused", "uniswap: a Uniswap v4 token-input quote, but v4 token input is off here — refresh the quote");
    let keys: V4PoolKey[];
    try {
      const raw = JSON.parse(pd.poolKeys) as unknown;
      if (!Array.isArray(raw)) throw new Error("not a list");
      keys = raw.map((k) => checkedHooklessKey(k as V4PoolKey, v4MaxFee));
    } catch (e) {
      throw refusal("policy_refused", `uniswap: the v4 quote's pools do not parse (${e instanceof Error ? e.message : String(e)}) — refresh the quote`);
    }
    const t = tx ?? {to: quote.txRequest?.to ?? "", data: quote.txRequest?.data, value: quote.txRequest?.value ?? "0"};
    const target = nativeIn ? d4.universalRouter : d4.swapProxy;
    if (!t.to || !/^0x[0-9a-fA-F]{40}$/.test(t.to) || getAddress(t.to) !== getAddress(target)) throw refusal("vault_mismatch", `uniswap: the v4 swap calls ${t.to || "nothing"}, not the pinned ${nativeIn ? "Universal Router" : "SwapProxy"} on chain ${chainId}`);
    if (!t.data || !/^0x[0-9a-fA-F]*$/.test(t.data) || !/^[0-9]+$/.test(String(t.value ?? "0"))) throw refusal("policy_refused", "uniswap: the v4 swap carries no calldata or value to check");
    if (!pd.sender || !/^0x[0-9a-fA-F]{40}$/.test(pd.sender)) throw refusal("policy_refused", "uniswap: the v4 quote names no sender to dry-run the swap from — refresh the quote");

    let quoteData: Hex;
    try {
      quoteData = quoteCallDataOfKeys(getAddress(currencyIn), keys, BigInt(pd.amountIn));
    } catch (e) {
      throw refusal("policy_refused", `uniswap: the v4 quote's route does not hold together (${e instanceof Error ? e.message : String(e)})`);
    }
    // The same gas the quote's reads named (Monad: its RPCs give an eth_call 8.1M unless told, and a route the quote
    // priced at up to 30M would starve here and refuse a swap that runs).
    const readGas = ownKey(V4_READ_GAS, chainId);
    const [q] = await net.slots(chainId, [{method: "eth_call", params: [{to: d4.quoter, data: quoteData, ...(readGas !== undefined ? {gas: `0x${readGas.toString(16)}`} : {})}, "latest"]}], "items");
    if (!q || "failed" in q) throw q && "failed" in q ? q.failed : refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId}`);
    if (!q.ok) {
      const c = classifyV4Revert(q.revert.data);
      throw refusal(c.reason, `uniswap: ${c.text} — the pool can no longer take this swap. Nothing was sent; refresh the quote.`);
    }
    let out: bigint;
    try {
      out = decodeV4QuoteAnswer(q.result as Hex).amountOut;
    } catch (e) {
      throw e instanceof Error ? withReason(e, "upstream_unavailable") : e; // the node answered in another shape
    }
    if (out < BigInt(pd.minOut)) throw refusal("price_check_failed", `uniswap: price moved — the pool now pays ${out}, under your minimum ${pd.minOut}. Nothing was sent; refresh the quote.`);

    const value = String(t.value ?? "0");
    const dry = v4PreflightCall({to: t.to, data: t.data, value}, pd.sender);
    // The node refusing the dry-run for the sender's balance ("insufficient funds for transfer", revm's OutOfFunds) is an
    // answer about the wallet: not retried, and refused as such — never as an RPC outage (review R3-3 / LIVE3-1). Any
    // other failure is retried as before.
    let [r] = await net.slots(chainId, [dry], "none").catch((e: unknown): RpcSlot[] => [{ok: false, failed: e instanceof Error ? e : new Error(String(e))}]);
    if (r && "failed" in r && shortOfFunds(r) === undefined) [r] = await net.slots(chainId, [dry], "items");
    const short = shortOfFunds(r);
    if (short !== undefined) {
      const sender = getAddress(pd.sender);
      throw refusal("simulation_failed", nativeIn
        ? `uniswap: the wallet ${sender} holds less than the ${value} (base units of the native coin) this swap sends — the node refused the dry-run (${short}). Nothing was sent; lower the amount or top up the wallet.`
        : `uniswap: the node refused the dry-run from ${sender} for the wallet's balance (${short}). Nothing was sent; check the balance and refresh the quote.`);
    }
    if (!r || "failed" in r) throw r && "failed" in r ? r.failed : refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId}`);
    if (!r.ok) {
      const c = classifyV4Revert(r.revert.data);
      throw refusal(c.reason, `uniswap: ${c.text} (the swap was dry-run from ${getAddress(pd.sender)}). Nothing was sent; refresh the quote.`);
    }
  }

  /** A uint256 answer (a balance, an allowance), or undefined when the node answered in another shape. */
  const uintWord = (r: unknown): bigint | undefined => (typeof r === "string" && /^0x[0-9a-fA-F]{64}$/.test(r) ? BigInt(r) : undefined);
  /** The caller's abort is never read as an RPC fact (a fallback, a refusal reason): it is thrown as it came. */
  const rethrowAbort = (e: unknown, signal?: AbortSignal): void => { if (signal?.aborted) throw e; };

  /**
   * A v4 token input, before the quote goes out — so before any approval is asked for (UNISWAP-V4-RESEARCH §6.6,
   * decision 9): the exact SwapProxy call is simulated from the sender together with its approval.
   * - The sender's balance of the input and its allowance to the SwapProxy are read first. A balance under the input
   *   refuses: the swap would revert after the user paid for the approval.
   * - An allowance that already covers the input: the exact call is `eth_call`ed from the sender at latest.
   * - Otherwise `eth_simulateV1` runs `[approve(0) when an allowance stands, approve(amountIn), swap]` as one block.
   * - Where the RPC does not serve `eth_simulateV1` (Monad, every RPC): the token's `allowance[sender][SwapProxy]` slot —
   *   from `eth_createAccessList`, verified by reading the allowance back under the override — is set to the input by a
   *   `stateDiff`, and the exact call is `eth_call`ed from the bare account (its real code kept: EIP-7702 and smart
   *   accounts unchanged). With no slot that verifies, a small executor ({@link EXECUTOR_CODE}) is installed as the
   *   sender's code by an override and runs approve → swap through Multicall3 in one `eth_call`, `msg.sender` = the
   *   sender, the native output accepted.
   * - Nothing simulable refuses: the check is never skipped. A revert is decoded and mapped as the preflight's is.
   * - A read no endpoint answered after the retries (balance, allowance, access list, slot read-back, the swap's
   *   `eth_call`, the executor's) refuses the quote with the node's reason (`V4_CHECK_SCOPE` "trade", review R3-1); a
   *   method or an override the endpoint does not take is a fact about it and leaves the fallbacks, then v3.
   * Returns how the swap was simulated (`providerData.simulated`).
   */
  async function v4TokenSwapCheck(chainId: number, d4: UniswapV4Deployment, sender: Hex, token: Hex, amount: bigint, tx: {to: Hex; data: Hex}, signal?: AbortSignal): Promise<string> {
    const spender = getAddress(d4.swapProxy);
    const allowanceData = encodeFunctionData({abi: ERC20_ABI, functionName: "allowance", args: [sender, spender]});
    const approveData = (n: bigint) => encodeFunctionData({abi: ERC20_ABI, functionName: "approve", args: [spender, n]});
    const noted = (what: string) => `uniswap: ${what}. Nothing was approved; refresh the quote.`;
    const reverted = (data: unknown, how: string): never => {
      const c = classifyV4Revert(data);
      // A recipient that cannot take the native coin (NativeTransferFailed) refuses any route; a pool's revert is this
      // route's; anything else (the token's own pull, the deadline) is shared by every v4 build of the quote.
      const err = refusal(c.reason, noted(`${c.text} (the approval and the swap were simulated ${how} from ${sender})`));
      throw c.reason === "recipient_mismatch" ? scoped(err, "trade") : ROUTE_REVERTS.has(c.reason) ? scoped(err, "route") : err;
    };
    /** A slot without an answer as the error it throws: the quote's refusal ({@link unanswered}), unless it is a fact
     *  about the endpoint ({@link endpointFact}: the check falls back to v3 with it). */
    const failure = (s: RpcSlot | undefined): Error => {
      if (s && "failed" in s) return endpointFact(s) ? s.failed : unanswered(s.failed);
      return unanswered(refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId}`));
    };
    /** The check's reads: a batch no endpoint answered (under "items", an HTTP failure of every endpoint is thrown) is
     *  unanswered too; the caller's abort is thrown as it came. */
    const slots = (calls: RpcCall[], policy: "all" | "items"): Promise<RpcSlot[]> => net.slots(chainId, calls, policy, signal).catch((e: unknown): never => {
      rethrowAbort(e, signal);
      throw unanswered(e);
    });
    const value = (s: RpcSlot | undefined, what: string): bigint => {
      if (!s || "failed" in s) throw failure(s);
      if (!s.ok) throw refusal("upstream_unavailable", `uniswap: the input token's ${what} read reverted on chain ${chainId} — refusing`);
      const v = uintWord(s.result);
      if (v === undefined) throw refusal("upstream_unavailable", `uniswap: the RPC on chain ${chainId} answered the input token's ${what} in another shape — refusing`);
      return v;
    };
    /** An eth_call that must succeed: a revert is mapped, no answer refuses. */
    const mustRun = (s: RpcSlot | undefined, how: string): void => {
      if (!s || "failed" in s) throw failure(s);
      if (!s.ok) reverted(s.revert.data, how);
    };
    const swapCall = (stateOverride?: Record<string, unknown>) => v4PreflightCall({to: tx.to, data: tx.data, value: "0"}, sender, stateOverride ? {stateOverride} : {});

    const [b, a] = await slots([call(token, encodeFunctionData({abi: ERC20_ABI, functionName: "balanceOf", args: [sender]})), call(token, allowanceData)], "all");
    const balance = value(b, "balance");
    const allowance = value(a, "allowance");
    if (balance < amount) throw scoped(refusal("simulation_failed", noted(`the wallet holds ${balance} of the input, less than the ${amount} it sells — the swap would revert`)), "trade");
    if (allowance >= amount) {
      const [r] = await slots([swapCall()], "items");
      mustRun(r, "(the allowance already in place)");
      return "swap";
    }

    // eth_simulateV1: the approval and the swap as one simulated block.
    const until = noSimulateV1.get(chainId);
    if (until === undefined || Date.now() >= until) {
      noSimulateV1.delete(chainId);
      const step = (data: Hex, to: Hex) => ({from: sender, to, data, value: "0x0"});
      const calls = [...(allowance > 0n ? [step(approveData(0n), token)] : []), step(approveData(amount), token), step(tx.data, tx.to)];
      const sim: RpcCall = {method: "eth_simulateV1", params: [{blockStateCalls: [{calls}], validation: false}, "latest"]};
      const once = (policy: "none" | "items") => net.slots(chainId, [sim], policy, signal).then(([x]) => x, (e: unknown): RpcSlot => {
        rethrowAbort(e, signal);
        return {ok: false, failed: e instanceof Error ? e : new Error(String(e))};
      });
      let s = await once("none");
      if (s && "failed" in s && !endpointFact(s)) s = await once("items"); // a transient failure is retried
      if (s?.ok) {
        type SimCall = {status?: unknown; returnData?: unknown; error?: {data?: unknown}};
        const out = Array.isArray(s.result) ? (s.result[0] as {calls?: unknown} | undefined)?.calls : undefined;
        if (!Array.isArray(out) || out.length !== calls.length || out.some((c) => !c || typeof c !== "object")) {
          throw refusal("upstream_unavailable", noted(`the approve + swap simulation on chain ${chainId} came back in another shape`));
        }
        const steps = out as SimCall[];
        if (steps.slice(0, -1).some((c) => c.status !== "0x1")) throw refusal("simulation_failed", noted("the input token's approval of the SwapProxy fails in simulation"));
        const swap = steps[steps.length - 1]!;
        if (swap.status === "0x1") return "approve+swap";
        if (swap.status !== "0x0") throw refusal("upstream_unavailable", noted(`the approve + swap simulation on chain ${chainId} came back in another shape`));
        return reverted(typeof swap.returnData === "string" && swap.returnData.length > 2 ? swap.returnData : swap.error?.data, "with eth_simulateV1");
      }
      if (endpointFact(s)) noSimulateV1.set(chainId, Date.now() + NO_SIMULATE_V1_TTL_MS);
      // Any other failure falls through to the fallbacks too: they are simulations as well, never a skip.
    }

    // No eth_simulateV1: the allowance slot by stateDiff, the account's own code kept. allowanceSlotOf throws only for a
    // read no endpoint answered (an endpoint that serves no access list or takes no override gives null).
    const slot = await allowanceSlotOf(chainId, token, sender, spender, allowanceData, amount, signal).catch((e: unknown): never => {
      rethrowAbort(e, signal);
      throw unanswered(e);
    });
    if (slot) {
      const [r] = await slots([swapCall(v4StorageOverride(token, slot, amount))], "items");
      mustRun(r, "with the allowance set by a state override");
      return "approve+swap (allowance override)";
    }

    // Last: the executor as the sender's code, approve → swap through Multicall3 in one eth_call.
    const plan = encodeFunctionData({abi: MC3_ABI, functionName: "aggregate3", args: [[
      ...(allowance > 0n ? [{target: token, allowFailure: false, callData: approveData(0n)}] : []),
      {target: token, allowFailure: false, callData: approveData(amount)},
      {target: tx.to, allowFailure: true, callData: tx.data},
    ]]});
    const [r] = await slots([{method: "eth_call", params: [{from: sender, to: sender, data: plan, value: "0x0"}, "latest", {[sender]: {code: EXECUTOR_CODE}}]}], "items");
    if (!r || "failed" in r) throw failure(r);
    if (!r.ok) throw refusal("simulation_failed", noted("the input token's approval of the SwapProxy fails in simulation"));
    let results: readonly {success: boolean; returnData: Hex}[];
    try {
      results = decodeFunctionResult({abi: MC3_ABI, functionName: "aggregate3", data: r.result as Hex});
    } catch {
      throw refusal("upstream_unavailable", noted(`the approve + swap simulation on chain ${chainId} came back in another shape`));
    }
    const last = results[results.length - 1];
    if (!last || results.length !== (allowance > 0n ? 3 : 2)) throw refusal("upstream_unavailable", noted(`the approve + swap simulation on chain ${chainId} came back in another shape`));
    if (!last.success) return reverted(last.returnData, "by an executor installed as the account's code");
    return "approve+swap (executor override)";
  }

  /**
   * The storage slot of `token`'s `allowance[owner][spender]`, verified: the keys `eth_createAccessList` names for the
   * token's own storage while reading the allowance, each set to `amount` by a `stateDiff`, the one that makes the
   * allowance read back exactly `amount` (cached). Null when none does (a token whose allowance is not one plain word),
   * or when the node does not serve the access list or take the override ({@link endpointFact}). Throws only for a read
   * no endpoint answered (the caller refuses the quote on it) and for the caller's abort.
   */
  async function allowanceSlotOf(chainId: number, token: Hex, owner: Hex, spender: Hex, data: Hex, amount: bigint, signal?: AbortSignal): Promise<Hex | null> {
    const key = `${chainId}:${token}:${owner}:${spender}`.toLowerCase();
    const hit = allowanceSlots.get(key);
    if (hit) return hit;
    const list1: RpcCall = {method: "eth_createAccessList", params: [{from: owner, to: token, data}, "latest"]};
    let [al] = await net.slots(chainId, [list1], "none", signal).catch((e: unknown): RpcSlot[] => {
      rethrowAbort(e, signal);
      return [{ok: false, failed: e instanceof Error ? e : new Error(String(e))}];
    });
    if (al && "failed" in al && !endpointFact(al)) [al] = await net.slots(chainId, [list1], "items", signal); // a transient failure is retried
    if (!al || "failed" in al) {
      if (endpointFact(al)) return null;
      throw al && "failed" in al ? al.failed : refusal("upstream_unavailable", `uniswap: no RPC answered on chain ${chainId}`);
    }
    if (!al.ok) return null;
    const list = (al.result as {accessList?: unknown} | null)?.accessList;
    const keys = new Set<string>();
    for (const e of Array.isArray(list) ? list : []) {
      const entry = e as {address?: unknown; storageKeys?: unknown};
      if (typeof entry.address !== "string" || entry.address.toLowerCase() !== token.toLowerCase() || !Array.isArray(entry.storageKeys)) continue;
      for (const k of entry.storageKeys) if (typeof k === "string" && /^0x[0-9a-fA-F]{64}$/.test(k)) keys.add(k.toLowerCase());
    }
    const candidates = [...keys].slice(0, MAX_SLOT_CANDIDATES) as Hex[];
    if (!candidates.length) return null;
    const answers = await net.slots(chainId, candidates.map((k) => ({method: "eth_call", params: [{to: token, data}, "latest", v4StorageOverride(token, k, amount)]})), "items", signal);
    const at = answers.findIndex((s) => s.ok && uintWord(s.result) === amount);
    if (at < 0) {
      const failed = answers.find((s): s is Extract<RpcSlot, {failed: Error}> => "failed" in s && !endpointFact(s));
      if (failed) throw failed.failed; // the node did not answer: never read as "no slot"
      return null;
    }
    if (allowanceSlots.size >= MAX_CACHED_SLOTS) allowanceSlots.delete(allowanceSlots.keys().next().value!);
    allowanceSlots.set(key, candidates[at]!);
    return candidates[at]!;
  }

  /**
   * One quote pass: "best", today's ranked winner (a Quote, or null with the refusal passed to `params.onRefusal`); or a
   * venue pick ("v3", "v4", "both": `venueRoutes: "both"`), each venue answered on its own (null when the request
   * itself is refused, before any venue is read — the refusal passed to `params.onRefusal`).
   */
  async function run(params: QuoteParams, signal: AbortSignal | undefined, pick: "best"): Promise<Quote | null>;
  async function run(params: QuoteParams, signal: AbortSignal | undefined, pick: VenuePick): Promise<VenueQuotes | null>;
  async function run(params: QuoteParams, signal: AbortSignal | undefined, pick: "best" | VenuePick): Promise<Quote | VenueQuotes | null> {
    const refuse = (why: string, info?: Swap2RefusalReason | Swap2RefusalInfo): null => {
      params.onRefusal?.(`uniswap: ${why}`, typeof info === "string" ? {reason: info} : info);
      return null;
    };
    if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
    if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only", "unsupported_pair");
    const chainId = chainIdOf(params.sourceChain);
    if (chainId === null) return refuse(v4Mode === "off" ? `no Uniswap v3 deployment or RPC for ${params.sourceChain}` : `no Uniswap v3 or v4 deployment or RPC for ${params.sourceChain}`, "unsupported_pair");
    // v3 (undefined on a chain only v4 serves) and v4 (undefined unless this provider quotes v4 there).
    const d3 = deployments[chainId] as UniswapDeployment | undefined;
    const d = d3 as UniswapDeployment; // read on the v3 paths only, which run only when d3 is set
    const d4 = v4Of(chainId);
    const src = sourceAssetOf(params);
    if (!src) return refuse(`unknown source token ${params.sourceToken}`, "unsupported_pair");
    const nativeIn = !src.contract;
    const nativeOut = /^0x0+$/.test(params.destToken);
    if (!d3) {
      if (v4Mode !== "all" && !nativeIn) return refuse("Uniswap v4 takes a native-coin input only on this chain (it has no Uniswap v3 deployment)", "unsupported_pair");
      if (nativeIn && nativeOut) return refuse("native in and out is not a swap", "unsupported_pair");
      if (!v4ServesFlow(d4!, v4Mode, nativeIn, nativeOut)) return refuse("this chain's native coin is an ERC-20 — swap that instead", "unsupported_pair");
    } else if ((nativeIn || nativeOut) && d.nativeWrap === false) return refuse("this chain's router has no wrapped native — swap the coin's ERC-20 instead", "unsupported_pair");
    if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address", "unsupported_pair");
    if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address", "recipient_mismatch");
    // A recipient the chain's v4 pins name as a sink (a router sentinel, the zero address, a pinned Uniswap v4
    // contract): output paid there is stranded whichever venue pays it — a verdict on the trade, refused before any
    // read, never quoted on v3 instead (review LIVE3-2). With v4 off, as 0.4.11.
    if (d4 && v4StrandedRecipient(d4, params.destAddress)) return refuse(v4StrandedRecipientText(params.destAddress), "recipient_mismatch");
    let amountIn: bigint;
    try {
      amountIn = BigInt(params.amountIn);
    } catch {
      return refuse("amount is not an integer");
    }
    if (amountIn <= 0n) return refuse("amount must be positive");
    // A native leg reaches here only where a wrapped native exists (v3's, or a v4 chain serving native flows).
    const wrapped = (d3 ? d3.weth : d4?.weth) ?? ZERO;
    const tokenIn = getAddress(nativeIn ? wrapped : src.contract!);
    const tokenOut = getAddress(nativeOut ? wrapped : params.destToken);
    if (tokenIn === tokenOut) return refuse(nativeIn || nativeOut ? "that is a wrap/unwrap, not a swap" : "same token in and out", "unsupported_pair");
    // v4 quotes a native input into an ERC-20 ("native-in" and "all"), and with "all" a catalog token input into a
    // token or the native coin (the SwapProxy only carries catalog tokens: one with transfer callbacks could re-enter
    // the router while the input rests in it unlocked, UNISWAP-V4-RESEARCH §2 R2).
    const v4In = d4 !== undefined && v4ServesFlow(d4, v4Mode, nativeIn, nativeOut) && (nativeIn || !!resolveAsset(params.sourceChain, params.sourceToken)) ? d4 : undefined;
    const currencyIn4 = nativeIn ? (V4_NATIVE as Hex) : tokenIn;
    const currencyOut4 = nativeOut ? (V4_NATIVE as Hex) : tokenOut;
    if (!d3 && !v4In) return refuse("the Uniswap v4 SwapProxy takes catalog tokens only (this chain has no Uniswap v3 deployment)", "unsupported_pair");

    // rpcCallsPerSecond: no batch of this quote goes later than QUOTE_WAIT_MAX_MS after it began (U0-LIVE-1), and its
    // turns come before those of quotes that began after it.
    const turns: SlotOptions = perSecond === undefined ? {} : {waitUntil: Date.now() + QUOTE_WAIT_MAX_MS, quote: ++quotesBegun};

    /** The operator's alert (`onV4Warning`): never the caller's refusal, never a reason to fail the quote. */
    const warn = (text: string, reason: Swap2RefusalReason): void => {
      try {
        const r = config.onV4Warning?.(`uniswap: ${text}`, {chainId: chainId!, reason}) as unknown;
        if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(undefined, () => {});
      } catch {
        /* diagnostics only */
      }
    };

    /**
     * One v4 candidate as a quote: the impact measures (and the gate, when set), the minimum, the router call (directly
     * for a native input, through the SwapProxy for a token), the gas bound, and this module's own strict check of what
     * it built (UNISWAP-V4-RESEARCH §6.5, "on the server after build") — a build its own verifier refuses is never
     * returned. A token input with a known sender is then simulated with its approval (`v4TokenSwapCheck`): a swap that
     * would revert is refused before anyone is asked to approve it.
     *
     * A refusal says how far it reaches (review R2-2): the trade's verdicts — the impact gate, a minimum that rounds to
     * 0, the caller's floor, a wallet short of the input, a recipient that cannot take the native coin — hold for any
     * route and refuse the quote ("trade"); a refusal of this build — its simulated swap reverts, the module's own
     * check, the encoder, the gas bound — leaves the next candidate ("route"); a check that cannot run for this quote
     * (the endpoint cannot simulate the approval and the swap, the approval fails) leaves v3 ("quote"). v4 being on
     * never costs the pair the v3 route it had. A read of that check no endpoint answered is not such a fact: it refuses
     * the quote with the node's reason, as every other failed read of the quote does (decision 5, review R3-1) — never
     * the v3 quote in its place.
     */
    const finishV4 = async (chainId: number, d4: UniswapV4Deployment, v4: NonNullable<Awaited<ReturnType<typeof quoteV4>>>, winner: NonNullable<V4QuoteResult["best"]>, currencyIn: Hex, currencyOut: Hex, amountIn: bigint, gated: boolean, gasRead: BlockGasRead, unexecutable: number, signal?: AbortSignal): Promise<V4Build> => {
      const no = (text: string, info: Swap2RefusalReason | Swap2RefusalInfo | undefined, scope: "trade" | "route" | "quote"): V4Build => ({refused: text, ...(info !== undefined ? {info} : {}), scope});
      const {route, amountOut: out, gasEstimate: gas} = winner;
      // The same two measures as v3: the 1/1000 probe on the same route (`priceImpactBps`, fees excluded) and the
      // value lost against the pools' mid prices read at the discovery block (fees included). The probe's transient
      // errors are retried; spot comes from the reads discovery already made, so it is always measured when the mid
      // output does not round to zero.
      const probe = await v4ProbeImpactBps({quoter: d4.quoter, route, amountIn, amountOut: out}, v4.batch);
      let priceImpactBps: number | undefined = probe;
      let valueLossBps: number | undefined;
      if (gated) {
        const limit = maxImpact!;
        const spot = v4SpotLossBps(route, amountIn, out);
        if (spot === undefined) {
          if (probe !== undefined && probe >= limit) return no(impactRefusalText(probe, limit, route.label), "insufficient_liquidity", "trade");
          return no("could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again", "upstream_unavailable", "trade");
        }
        priceImpactBps = probe;
        valueLossBps = spot;
        const loss = probe === undefined ? spot : Math.max(probe, spot);
        if (loss >= limit) return no(impactRefusalText(loss, limit, route.label), "insufficient_liquidity", "trade");
      }

      const bps = params.slippageBps ?? slippageDefault;
      const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
      if (minOut <= 0n) return no(`the minimum output rounds to 0 (quoted ${out} at ${bps} bps slippage) — the amount is too small for this pool`, "amount_too_small", "trade");
      if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
        return no(`floor breach (min=${minOut} < floor=${params.minAmountOut})`, "price_check_failed", "trade");
      }
      const recipient = getAddress(params.destAddress);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + v4DeadlineS);
      const keys = route.hops.map((h) => h.pool.key);
      let enc: ReturnType<typeof encodeV4Swap>;
      try {
        enc = encodeV4Swap({chainId, currencyIn, currencyOut, pools: keys, amountIn, amountOutMinimum: minOut, recipient, deadline}, v4Deployments);
      } catch (e) {
        return no(e instanceof Error ? e.message.replace(/^uniswap v4: /, "") : String(e), "policy_refused", "route");
      }

      // Quoter gas covers the pools only; the router call (intrinsic, calldata, unlock, SETTLE, TAKE) rides on top, and
      // for a token input the SwapProxy and its transferFrom into the router. The same bound as v3: a need above the
      // chain's per-transaction cap or block gas limit can never be mined (such candidates are ranked out before this).
      const pools = BigInt(route.hops.length);
      const overhead = V4_ROUTER_GAS + (enc.flow === "swap-proxy" ? V4_PROXY_GAS : 0n);
      let gasLimit: bigint | undefined;
      if (gas >= MIN_POOL_GAS * pools) {
        const bounded = boundGasLimit(gas + overhead, (gas * 3n) / 2n + overhead, gasBoundsOf(chainId, await blockGasLimit(gasRead, signal)));
        if ("refuse" in bounded) {
          return no(`the swap needs ${bounded.refuse.need} gas, more than chain ${chainId} takes in one transaction (${bounded.refuse.cap}) — its pools are too thin for this amount`, "insufficient_liquidity", "route");
        }
        gasLimit = bounded.gasLimit;
      }
      const sender = typeof params.sender === "string" && /^0x[0-9a-fA-F]{40}$/.test(params.sender) ? getAddress(params.sender) : undefined;
      const quote: Quote = {
        provider: "uniswap",
        intentId: `uniswap:${chainId}`,
        depositAddress: "",
        depositMemo: null,
        txRequest: {
          to: enc.to,
          data: enc.data,
          value: enc.value.toString(),
          chainId,
          ...(gasLimit !== undefined ? {gasLimit: gasLimit.toString()} : {}),
          ...(enc.approvalAddress !== undefined ? {approvalAddress: enc.approvalAddress} : {}),
        },
        sourceAmount: amountIn.toString(),
        destAmount: out.toString(),
        minDestAmount: minOut.toString(),
        feeUsd: 0,
        etaSeconds: 15,
        reliability: 0.98,
        validUntilMs: Date.now() + ttl,
        providerData: {
          venue: "v4",
          route: route.label,
          poolFee: route.poolFee,
          router: enc.router,
          currencyIn: getAddress(currencyIn),
          currencyOut,
          amountIn: amountIn.toString(),
          minOut: minOut.toString(),
          poolKeys: JSON.stringify(keys),
          path: [route.currencyIn, ...route.hops.map((h) => h.currencyOut)].map((c) => getAddress(c)).join(">"),
          ...(priceImpactBps !== undefined ? {priceImpactBps: String(priceImpactBps)} : {}),
          ...(valueLossBps !== undefined ? {valueLossBps: String(valueLossBps)} : {}),
          ...(sender !== undefined ? {sender} : {}),
          ...(unexecutable > 0 ? {v4Unexecutable: String(unexecutable)} : {}),
        },
      };
      // The app's pins check the same quote with the shipped list alone (plus the extra pools they pin themselves); here
      // the pools this quote's own discovery read on chain through the unlisted-token grid count too (UNISWAP-V4-RESEARCH
      // §5.3). Such a route reaches this point against a v3 route only with `v4RankedPools: "all"`; by default only when
      // v3 had no route — an app's pins may refuse it then, and it had nothing to lose.
      const own = ownKey(v4Extra, chainId) ?? [];
      const problem = uniswapV4VerifyQuote(params, quote, {
        deployments: v4Deployments, v4: v4Mode, pools: UNISWAP_V4_POOL_KEYS, extraPools: {[chainId]: [...own, ...v4.gridPools]}, maxFeePips: v4MaxFee, deadlineSeconds: v4DeadlineS,
      });
      if (problem) return no(`the v4 swap fails this module's own check — ${problem}`, uniswapV4ReasonOf(problem) ?? "policy_refused", "route");
      if (enc.flow === "swap-proxy") {
        // Before any approval: the exact call with its approval, simulated from the sender. A quote without a sender (a
        // price quote: nothing will be approved on it) says so; preflightDeposit dry-runs it again before signing.
        if (sender === undefined) quote.providerData!.simulated = "none";
        else {
          try {
            quote.providerData!.simulated = await v4TokenSwapCheck(chainId, d4, sender, getAddress(currencyIn), amountIn, {to: enc.to, data: enc.data}, signal);
          } catch (e) {
            rethrowAbort(e, signal);
            const err = e instanceof Error ? e : new Error(String(e));
            return no(err.message.replace(/^uniswap: /, ""), refusalOf(err) ?? "simulation_failed", V4_CHECK_SCOPE.get(err) ?? "quote");
          }
        }
      }
      return {quote};
    };

    /** A v3 route the QuoterV2 priced for the whole input: its output and the quoter's gas figure. */
    type V3Best = {route: Route; out: bigint; gas: bigint};
    /** A pass's v4 reads, answered: the candidates, the batcher they were read with, the grid pools discovery found. */
    type V4Read = Awaited<ReturnType<typeof quoteV4>>;
    type V4Refused = Extract<V4Build, {refused: string}>;
    type V4Ranked = NonNullable<V4QuoteResult["best"]>;

    /**
     * Every v3 candidate route on the QuoterV2 at `block`, in one batch: the best full fill, and whether a candidate ran
     * its pool dry (a partial fill). Under "all" a call the node did not answer is retried, then thrown (classified).
     */
    const readV3 = async (block: string, policy: "items" | "all"): Promise<{best: V3Best | null; partial: boolean}> => {
      const candidates = routes(chainId, params.sourceChain, tokenIn, tokenOut);
      const gated = maxImpact !== undefined;
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
        policy,
        signal,
        {...turns, accept},
      );
      let best: V3Best | null = null;
      let partial = false;
      for (let i = 0; i < results.length; i++) {
        const raw = results[i];
        const q = typeof raw === "string" && raw !== "0x" ? decoded.get(i) : undefined; // a revert (null) or unset's "0x": no candidate
        if (!q || q.out <= 0n) continue;
        if (q.drained) {
          partial = true;
          continue;
        }
        if (!best || q.out > best.out) best = {route: candidates[i]!, out: q.out, gas: q.gas};
      }
      return {best, partial};
    };

    /**
     * The v3 quote for its best route at `block`: the impact measures (and the gate, when set), the minimum, the router
     * call and the gas bound. A refusal is returned (the trade's verdict for this venue); a read that failed throws.
     * `v4Unexecutable`: the v4 candidates ranked out for gas, carried as information ("best" passes only).
     */
    const buildV3 = async (pick: V3Best, block: string, gasRead: BlockGasRead, v4Unexecutable: number): Promise<VenueAnswer> => {
      const no3 = (refused: string, info: Swap2RefusalReason | Swap2RefusalInfo): VenueAnswer => ({refused, info});
      const {route, out, gas} = pick;

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
        // is never the better offer (a venue-routes pass gates each venue's own best route, the row the app shows for
        // it). The measure is the larger of the probe and the spot value loss: the probe alone
        // can be absent (tiny amounts, a failed read) or blind (a pool parked past an empty range reads 342 bps while
        // the trade loses 98.7%, UNISWAP-V4-RESEARCH §7.2). So spot must be measured: when its reads fail the quote is
        // refused (fail closed) — at the limit already on the probe alone, else as the RPC's failure; an unmeasured
        // probe leaves spot to decide.
        const m = await measureImpact(chainId, d, route, tokenIn, tokenOut, amountIn, out, block as Hex, signal, turns);
        if ("spotFailure" in m) {
          if (m.probe !== undefined && m.probe >= maxImpact) return no3(impactRefusalText(m.probe, maxImpact, route.label), "insufficient_liquidity");
          return no3("could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again", refusalOf(m.probeFailure ?? m.spotFailure) ?? "upstream_unavailable");
        }
        priceImpactBps = m.probe;
        valueLossBps = m.spot;
        const loss = m.probe === undefined ? m.spot : Math.max(m.probe, m.spot);
        if (loss >= maxImpact) {
          // The gate goes by the loss with the pools' fees in it; the text names what got it there. Thin pools when
          // the price impact alone (the probe, or spot net of fees) reaches the limit, else the route's own fees.
          const thin = (m.probe ?? 0) >= maxImpact || m.spotNet >= maxImpact;
          return no3(impactRefusalText(loss, maxImpact, route.label, thin ? undefined : route.poolFee), "insufficient_liquidity");
        }
      }

      const bps = params.slippageBps ?? slippageDefault;
      const minOut = (out * BigInt(10_000 - bps)) / 10_000n;
      if (minOut <= 0n) return no3(`the minimum output rounds to 0 (quoted ${out} at ${bps} bps slippage) — the amount is too small for this pool`, "amount_too_small");
      if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) {
        return no3(`floor breach (min=${minOut} < floor=${params.minAmountOut})`, "price_check_failed");
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
          return no3(`the swap needs ${bounded.refuse.need} gas, more than chain ${chainId} takes in one transaction (${bounded.refuse.cap}) — its pools are too thin for this amount`, "insufficient_liquidity");
        }
        gasLimit = bounded.gasLimit;
      }

      return {quote: {
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
          ...(v4Unexecutable > 0 ? {v4Unexecutable: String(v4Unexecutable)} : {}),
        },
      }};
    };

    /**
     * The v4 candidates a transaction on the chain can carry, ranked by output, with how many were ranked out for gas and
     * the cap that did it. A candidate whose gas need is above the chain's bound can never be mined: ranked out before
     * ranking (as LIVE-1 ranks out a route no transaction can carry), so it never displaces a route that can (review
     * R2-2). `restrict`: only pools an app's pins can check compete (`v4RankedPools`, `v4RankedListBlock`).
     */
    const rankV4 = async (v4: V4Read, restrict: boolean, gasRead: BlockGasRead): Promise<{ranked: V4Ranked[]; gasOut: number; gasCap: bigint | undefined}> => {
      const bounds = gasBoundsOf(chainId, await blockGasLimit(gasRead, signal));
      const overhead = V4_ROUTER_GAS + (nativeIn ? 0n : V4_PROXY_GAS);
      let gasCap: bigint | undefined = v4ReadBoundOf(chainId);
      const minable = (c: {route: {hops: readonly unknown[]}; gasEstimate: bigint}): boolean => {
        const g = c.gasEstimate;
        if (g < MIN_POOL_GAS * BigInt(c.route.hops.length)) return true; // no gas figure: the wallet's own estimate decides
        const bounded = boundGasLimit(g + overhead, (g * 3n) / 2n + overhead, bounds);
        if ("refuse" in bounded) gasCap = bounded.refuse.cap;
        return !("refuse" in bounded);
      };
      const gasOut = rankedV4Candidates(v4.candidates).filter((c) => !minable(c)).length;
      const newer = newerListedOf(chainId);
      const ranked = restrict
        ? rankedV4Candidates(v4.candidates, (p) => (p.source === "listed" && !newer.has(p.id.toLowerCase())) || (v4Ranked === "extra" && p.source === "extra"), minable)
        : rankedV4Candidates(v4.candidates, undefined, minable);
      return {ranked, gasOut, gasCap};
    };

    /**
     * The first of the ranked v4 candidates (at most V4_MAX_BUILDS) whose build stands (`finishV4`). `beats` (a "best"
     * pass: v4 must pay more than v3 by more than `v4MinEdgeBps`) stops at the first that does not. The trade's verdict
     * ends it (`trade`); a refusal of that build moves to the next, one shared by every v4 build of the quote stops;
     * `setAside` is then the best route's own reason.
     */
    const buildV4 = async (v4: V4Read, ranked: readonly V4Ranked[], unexecutable: number, gated: boolean, gasRead: BlockGasRead, beats?: (out: bigint) => boolean): Promise<{quote: Quote} | {trade: V4Refused} | {setAside?: V4Refused}> => {
      let setAside: V4Refused | undefined;
      for (const pick of ranked.slice(0, V4_MAX_BUILDS)) {
        if (beats && !beats(pick.amountOut)) break;
        const built = await finishV4(chainId, v4In!, v4, pick, currencyIn4, currencyOut4, amountIn, gated, gasRead, unexecutable, signal);
        if ("quote" in built) {
          if (setAside) warn(`the best Uniswap v4 route on chain ${chainId} was set aside (${setAside.refused}) — quoted another v4 route`, reasonOfInfo(setAside.info));
          return {quote: built.quote};
        }
        if (built.scope === "trade") return {trade: built};
        setAside ??= built; // the best route's reason is the one reported
        if (built.scope === "quote") break;
      }
      return setAside ? {setAside} : {};
    };

    /** A refusal as a venue's answer. */
    const venueNo = (refused: string, info?: Swap2RefusalReason | Swap2RefusalInfo): VenueRefusal => ({refused, ...(info !== undefined ? {info} : {})});
    const venueFailed = (e: unknown): VenueRefusal => venueNo(e instanceof Error ? e.message.replace(/^uniswap: /, "") : String(e), refusalOf(e));

    /**
     * The v4 candidate of a venue-routes pass: the best route the chain can mine and the provenance rule lets stand
     * (`v3Route`: v3 has a route for the pair, or may have — then only the ranked pools compete, as in a "best" pass),
     * built exactly as a winning one is — or why there is none. `v3Unread`: why v3 may have a route — its reads failed
     * (the deployment check or the quotes); routes only over pools outside the ranked set are then refused with that
     * failure, which a retry can clear, never as "no route" (review F1).
     */
    const v4Candidate = async (v4: V4Read, v3Route: boolean, gated: boolean, gasRead: BlockGasRead, v3Unread: VenueRefusal | undefined): Promise<VenueAnswer> => {
      const restrict = v3Route && v4Ranked !== "all";
      let gasOut = 0;
      let gasCap: bigint | undefined = v4ReadBoundOf(chainId);
      let outside = false;
      if (v4.candidates.some((c) => c.outcome === "quoted")) {
        const r = await rankV4(v4, restrict, gasRead);
        gasOut = r.gasOut;
        gasCap = r.gasCap;
        const built = await buildV4(v4, r.ranked, v4.unexecutable + gasOut, gated, gasRead);
        if ("quote" in built) return built;
        if ("trade" in built) return venueNo(built.trade.refused, built.trade.info);
        if (built.setAside) {
          warn(`the best Uniswap v4 route on chain ${chainId} was set aside (${built.setAside.refused}) — no v4 route is offered`, reasonOfInfo(built.setAside.info));
          return {...venueNo(built.setAside.refused, built.setAside.info), alerted: true};
        }
        // Routes the chain can mine, all through pools outside the ranked set: not offered next to v3's.
        outside = restrict && r.ranked.length === 0 && rankedV4Candidates(v4.candidates).length > gasOut;
      }
      if (outside && v3Unread) {
        // Whether v3 has a route is unknown, so whether these routes may stand is too: refused for the read that failed.
        return venueNo(`the only Uniswap v4 routes for this pair go through pools outside the ranked pool lists (v4RankedPools), which stand only where Uniswap v3 has no route — and v3 could not be read: ${v3Unread.refused}`, v3Unread.info);
      }
      if (outside) return venueNo("the only Uniswap v4 routes for this pair go through pools outside the ranked pool lists (v4RankedPools) — not offered next to the v3 route", "no_route");
      if (!v4.partial && v4.unexecutable + gasOut > 0) return venueNo(`every Uniswap v4 route for this pair and amount needs more gas than one transaction on chain ${chainId} may have (${String(gasCap)}) — its pools are too thin for this amount`, "insufficient_liquidity");
      return v4.partial ? venueNo(PARTIAL_FILL, "insufficient_liquidity") : venueNo("no Uniswap v4 pool route for this pair and amount", "no_route");
    };

    /** The reads and builds of a venue-routes pass (`venuePass`, below): each venue asked for, answered. */
    const venueReads = async (pick: VenuePick): Promise<VenueQuotes> => {
      const out: VenueQuotes = {};
      const wantV3 = pick === "v3" || (pick === "both" && d3 !== undefined);
      const wantV4 = pick !== "v3";
      if (pick === "v3" && !d3) out.v3 = venueNo(`no Uniswap v3 deployment on chain ${chainId}`, "unsupported_pair");
      if (wantV4 && !v4In) {
        out.v4 = venueNo(!d4 ? `Uniswap v4 is not quoted on chain ${chainId}`
          : !v4ServesFlow(d4, v4Mode, nativeIn, nativeOut) ? (!nativeIn && v4Mode === "native-in" ? 'Uniswap v4 takes a native-coin input only here (v4: "native-in")' : "this chain's native coin is an ERC-20 on Uniswap v4 — swap that instead")
          : "the Uniswap v4 SwapProxy takes catalog tokens only", "unsupported_pair");
      }
      const v4Asked = wantV4 && v4In !== undefined;
      const readsV3 = d3 !== undefined && (wantV3 || (v4Asked && v4Ranked !== "all"));
      if (!readsV3 && !v4Asked) return out;
      try {
        const settled = <T,>(p: Promise<T>): Promise<{ok: T} | {error: unknown}> => p.then((ok) => ({ok}), (error: unknown) => ({error}));
        const [c3, c4] = await Promise.all([readsV3 ? settled(verifyDeployment(chainId)) : undefined, v4Asked ? settled(verifyV4Deployment(chainId, v4In!)) : undefined]);
        let v3Known = readsV3;
        /** Why v3 could not be read (its deployment check or its quotes failed), asked for or not: the v4 provenance rule's unknown. */
        let v3Unread: VenueRefusal | undefined;
        if (c3 && "error" in c3) {
          v3Unread = venueFailed(c3.error);
          if (v3Unread.info !== undefined && reasonOfInfo(v3Unread.info) === "vault_mismatch") {
            // §6.5 row 15 for v3 as for v4: refuse + alert. v3 is off on this chain for the pass while the v4 candidate
            // may go out, so onRefusal may never hear it (review R2-C1); a "best" pass refuses the whole quote instead.
            warn(`Uniswap v3 is off on chain ${chainId}: the deployment does not match its pins (the router or quoter does not answer the pinned factory and wrapped native)`, "vault_mismatch");
            v3Unread = {...v3Unread, alerted: true};
          }
          if (wantV3) out.v3 = v3Unread;
          v3Known = false;
        }
        let v4Ready = false;
        if (c4 && "error" in c4) out.v4 = venueFailed(c4.error);
        else if (c4) {
          const ok = c4.ok;
          v4Ready = nativeIn ? ok.native : ok.token;
          if (!v4Ready) {
            // §6.5 row 15: refuse + alert. v4 (or its token input) is off on this chain for this quote; v3 is not touched.
            warn(`Uniswap v4 ${nativeIn || !ok.native ? "" : "token input "}is off on chain ${chainId}: the deployment does not match its pins (${ok.problem ?? "the check got no answer"})`, "vault_mismatch");
            out.v4 = {...venueNo(`the Uniswap v4 deployment on chain ${chainId} does not match its pins — refusing`, "vault_mismatch"), alerted: true};
          }
        }
        const needV3 = v3Known && (wantV3 || v4Ready);
        if (!needV3 && !v4Ready) return out;
        const gasRead = blockGasRead(chainId); // alongside the quotes; optional (it never fails or holds the quote)
        const gated = maxImpact !== undefined;
        const block = gated ? await pinBlock(chainId, signal, turns) : "latest";
        const v4Run = v4Ready ? quoteV4(chainId, v4In!, currencyIn4, currencyOut4, amountIn, block as V4BlockTag, signal) : undefined;
        v4Run?.catch(() => {});
        let v3: {best: V3Best | null; partial: boolean} | undefined;
        if (needV3) {
          try {
            v3 = await readV3(block, "all");
          } catch (e) {
            v3Unread = venueFailed(e);
            if (wantV3) out.v3 = v3Unread;
          }
        }
        let v4: V4Read | undefined;
        if (v4Run) {
          try {
            v4 = await v4Run;
          } catch (e) {
            out.v4 = venueFailed(e);
          }
        }
        const v3Route = d3 !== undefined && (v3 === undefined || v3.best !== null);
        const [a3, a4] = await Promise.all([
          wantV3 && !out.v3 && v3
            ? v3.best
              ? buildV3(v3.best, block, gasRead, 0).catch(venueFailed)
              : Promise.resolve(v3.partial ? venueNo(PARTIAL_FILL, "insufficient_liquidity") : venueNo("no Uniswap v3 pool route for this pair and amount", "no_route"))
            : undefined,
          wantV4 && !out.v4 && v4 ? v4Candidate(v4, v3Route, gated, gasRead, v3Unread).catch(venueFailed) : undefined,
        ]);
        if (a3) out.v3 = a3;
        if (a4) out.v4 = a4;
      } catch (e) {
        const r = venueFailed(e);
        if (wantV3) out.v3 ??= r;
        if (wantV4) out.v4 ??= r;
      }
      return out;
    };

    /**
     * A venue-routes pass (`venueRoutes: "both"`): the reads of a "best" pass — the deployment checks, v3 and v4 at one
     * block (pinned when `maxPriceImpactBps` is set, else "latest"), one batch set — and each venue asked for built on
     * its own, exactly as it would be had it won. A venue that refuses or fails never drops the other. v3 is read for its
     * own quote, and for the v4 candidate's provenance (a v4 route over pools outside the ranked set stands only where v3
     * has no route; v3 unread or unanswered counts as having one). On a chain without Uniswap v3, "both" asks v4 alone:
     * there is no v3 venue to refuse (a picked "v3" is refused `unsupported_pair`; review F2). A venue left out because
     * its reads failed while the other venue's candidate goes out is named to the operator (`onV4Warning`, review
     * LIVE-VR-1): `onRefusal` is not called while a candidate stands. A pass the caller aborted alerts nobody: its reads
     * failed for the abort, not the node, and its result is thrown away (review R2-C3).
     */
    const venuePass = async (pick: VenuePick): Promise<VenueQuotes> => {
      const out = await venueReads(pick);
      if (pick === "both" && !signal?.aborted) {
        for (const [id, other] of [["v3", "v4"], ["v4", "v3"]] as const) {
          const a = out[id];
          const b = out[other];
          if (a === undefined || "quote" in a || a.alerted || b === undefined || !("quote" in b)) continue;
          const reason = a.info === undefined ? undefined : reasonOfInfo(a.info);
          if (reason !== undefined && !READ_FAILURES.has(reason)) continue; // a verdict on the trade there, not a failed read
          warn(`Uniswap ${id} is left out on chain ${chainId}: its reads failed (${a.refused}) — only the ${other} route is offered; a retry may bring the ${id} one back`, reason ?? "upstream_unavailable");
        }
      }
      return out;
    };

    if (pick !== "best") return venuePass(pick);

    try {
      let v4Ready = false;
      if (v4In) {
        const [, ok] = await Promise.all([d3 ? verifyDeployment(chainId) : undefined, verifyV4Deployment(chainId, v4In)]);
        v4Ready = nativeIn ? ok.native : ok.token;
        if (!v4Ready) {
          // §6.5 row 15: refuse + alert. v4 (or its token input) is off on this chain for this quote; v3 is not touched.
          warn(`Uniswap v4 ${nativeIn || !ok.native ? "" : "token input "}is off on chain ${chainId}: the deployment does not match its pins (${ok.problem ?? "the check got no answer"})`, "vault_mismatch");
          if (!d3) return refuse(`the Uniswap v4 deployment on chain ${chainId} does not match its pins — refusing`, "vault_mismatch");
        }
      } else {
        await verifyDeployment(chainId);
      }
      const gasRead = blockGasRead(chainId); // alongside the quotes; optional (it never fails or holds the quote)
      // maxPriceImpactBps set: the candidates, the probe and the mid prices are all read at one block, with retries.
      // Unset: at "latest", as 0.4.11 read them (a call the node did not answer is retried, then refused — never
      // read as "no pool").
      const gated = maxImpact !== undefined;
      const block = gated ? await pinBlock(chainId, signal, turns) : "latest";
      // v4 reads go out alongside the v3 ones, at the same block; any of them failing refuses the quote (never a
      // smaller candidate set). Handled here so a v3 failure first leaves no unhandled rejection behind.
      const v4Run = v4Ready ? quoteV4(chainId, v4In!, currencyIn4, currencyOut4, amountIn, block as V4BlockTag, signal) : undefined;
      v4Run?.catch(() => {});
      // With v4 on, the v3 reads go out alongside v4's and are retried the same way (a 429 under the doubled load is
      // not a missing route); with it off, as 0.4.11 read them.
      const v3Read = d3 ? await readV3(block, gated || v4Run ? "all" : "items") : {best: null, partial: false};
      const best = v3Read.best;
      let partial = v3Read.partial;
      const v4 = v4Run ? await v4Run : undefined;
      // Ranked together by output (v4MinEdgeBps: v4 must pay more than that much over v3); the gate applies to the
      // winner only. Against a v3 route, only a v4 route the apps' pins can check competes (`v4RankedPools`): a route
      // through a grid or an extra pool, or a shipped-list pool an app on an older list lacks (`v4RankedListBlock`),
      // would be refused there and cost them the v3 quote. With no v3 route, the best v4 route stands whatever its
      // pools (nothing is lost).
      /** v4 candidates ranked out because the chain could never mine them (their gas need above its bound). */
      let gasOut = 0;
      /** The gas cap that ranked them out, for the text. */
      let gasCap: bigint | undefined = v4ReadBoundOf(chainId);
      /** The best v4 route's build, when it was refused for a reason of the build (the quote falls back past it). */
      let setAside: V4Refused | undefined;
      if (v4 && v4.candidates.some((c) => c.outcome === "quoted")) {
        const r = await rankV4(v4, !(best === null || v4Ranked === "all"), gasRead);
        gasOut = r.gasOut;
        gasCap = r.gasCap;
        const v3Out = best?.out;
        const built = await buildV4(v4, r.ranked, v4.unexecutable + gasOut, gated, gasRead, v3Out === undefined ? undefined : (o) => o * 10_000n > v3Out * BigInt(10_000 + v4MinEdge));
        if ("quote" in built) return built.quote;
        if ("trade" in built) return refuse(built.trade.refused, built.trade.info);
        setAside = built.setAside;
      }
      if (setAside) {
        if (!best) return refuse(setAside.refused, setAside.info);
        warn(`the best Uniswap v4 route on chain ${chainId} was set aside (${setAside.refused}) — quoted v3`, reasonOfInfo(setAside.info));
      }
      if (v4) partial = partial || v4.partial;
      const tooMuchGas = !partial && v4 !== undefined && v4.unexecutable + gasOut > 0;
      if (!best) {
        if (tooMuchGas) return refuse(`every Uniswap ${d3 ? "v3 and v4 route" : "v4 route"} for this pair and amount is out: the v4 ones need more gas than one transaction on chain ${chainId} may have (${String(gasCap)}) — its pools are too thin for this amount`, "insufficient_liquidity");
        return refuse(partial ? PARTIAL_FILL : v4 ? (d3 ? "no Uniswap v3 or v4 pool route for this pair and amount" : "no Uniswap v4 pool route for this pair and amount") : "no Uniswap v3 pool route for this pair and amount", partial ? "insufficient_liquidity" : "no_route");
      }
      const built3 = await buildV3(best, block, gasRead, v4 !== undefined ? v4.unexecutable + gasOut : 0);
      return "quote" in built3 ? built3.quote : refuse(built3.refused, built3.info);
    } catch (e) {
      return refuse(e instanceof Error ? e.message.replace(/^uniswap: /, "") : String(e), refusalOf(e));
    }
  }

  /** A venue's refusal, passed to the caller's `onRefusal`. */
  const refuseWith = (params: QuoteParams, a: VenueRefusal): null => {
    params.onRefusal?.(`uniswap: ${a.refused}`, typeof a.info === "string" ? {reason: a.info} : a.info);
    return null;
  };
  /** A quote naming the venue it runs on. */
  const routed = (q: Quote, routeId: UniswapRouteId): Quote => ({...q, routeId});

  /**
   * `getQuote` with `venueRoutes: "both"`: without a `routeId`, the "best" pass's winner naming its route; with `"v3"` or
   * `"v4"`, that venue alone — never the other in its place; any other selector is refused.
   */
  async function venueQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
    const id = params.routeId;
    if (id === undefined) {
      const q = await run(params, signal, "best");
      return q && routed(q, q.providerData?.venue === "v4" ? "v4" : "v3");
    }
    if (id !== "v3" && id !== "v4") return refuseWith(params, {refused: `unknown route '${String(id).slice(0, 40)}' — this provider's routes are "v3" and "v4"`, info: "policy_refused"});
    const out = await run(params, signal, id);
    if (!out) return null; // the request itself was refused (onRefusal heard it)
    const a = out[id] ?? {refused: `no Uniswap ${id} quote`, info: "no_route"};
    return "quote" in a ? routed(a.quote, id) : refuseWith(params, a);
  }

  /**
   * `getQuotes` with `venueRoutes: "both"`: the v3 and v4 candidates of one pass. With both refused, an empty list and
   * one refusal naming both venues' reasons (classified as the first one that says more than "no route here"); on a
   * chain without Uniswap v3, v4's alone.
   */
  async function venueCandidates(params: QuoteParams, signal?: AbortSignal): Promise<Quote[]> {
    if (params.routeId !== undefined) {
      const q = await venueQuote(params, signal);
      return q ? [q] : [];
    }
    const out = await run(params, signal, "both");
    if (!out) return [];
    const quotes: Quote[] = [];
    const refused: [UniswapRouteId, VenueRefusal][] = [];
    for (const id of ROUTE_IDS) {
      const a = out[id];
      if (!a) continue;
      if ("quote" in a) quotes.push(routed(a.quote, id));
      else refused.push([id, a]);
    }
    if (quotes.length === 0 && refused.length > 0) {
      const lead = refused.find(([, a]) => a.info !== undefined && !SOFT_REASONS.has(reasonOfInfo(a.info))) ?? refused[0]!;
      refuseWith(params, {refused: refused.map(([id, a]) => `${id}: ${a.refused}`).join("; "), ...(lead[1].info !== undefined ? {info: lead[1].info} : {})});
    }
    return quotes;
  }

  /**
   * A quote that names its route (`venueRoutes: "both"`) is built and dry-run only on that venue: `"v3"` is a
   * SwapRouter02 call (no `providerData.venue`), `"v4"` a call to the chain's pinned Universal Router or SwapProxy
   * (`venue: "v4"`). Another selector, or a route whose call is the other venue's, is refused. A quote without one is
   * checked as before.
   */
  function checkRoute(quote: Quote, to: string | undefined): void {
    const id = quote.routeId;
    if (id === undefined) return;
    if (id !== "v3" && id !== "v4") throw refusal("policy_refused", `uniswap: the quote names an unknown route (${String(id).slice(0, 40)}) — refusing`);
    const chainId = Number(quote.intentId.split(":")[1]);
    const target = typeof to === "string" && /^0x[0-9a-fA-F]{40}$/.test(to) ? getAddress(to) : undefined;
    const venue = quote.providerData?.venue;
    let ok: boolean;
    if (id === "v3") {
      const d = ownKey(deployments, chainId);
      ok = venue === undefined && d !== undefined && target === getAddress(d.router);
    } else {
      const d4 = uniswapV4DeploymentOf(chainId, v4Deployments);
      ok = venue === "v4" && d4 !== undefined && (target === getAddress(d4.universalRouter) || target === getAddress(d4.swapProxy));
    }
    if (!ok) {
      throw refusal("vault_mismatch", `uniswap: the quote's '${id}' route calls ${to || "nothing"}${venue !== undefined ? ` (venue ${String(venue).slice(0, 20)})` : ""}, not ${id === "v3" ? "the pinned SwapRouter02" : "the pinned Universal Router 2.1.2 or SwapProxy"} on chain ${chainId} — refusing`);
    }
  }

  return {
    name: "uniswap",
    describeActivity: (tx, ctx) => describeUniswapActivity(tx, ctx, config.deployments ?? UNISWAP_V3, v4Deployments),
    supportsSameChain: true,
    // The engine sends every Uniswap call with the account's own estimate of that exact call, dry-run right before the
    // broadcast — never the quoted gasLimit (decision 7, UNISWAP-V4-RESEARCH §2.1: Monad charges the gas limit, not the gas
    // used, and a v3 quote there carries 16.3M). The quoted limit stays as information and for the gas bound, which
    // still refuses a swap no block could mine.
    ownGasEstimate: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      return from.chain === to.chain && chainIdOf(from.chain) !== null;
    },

    getQuote: (params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> => (venueRoutes === "best" ? run(params, signal, "best") : venueQuote(params, signal)),
    // `venueRoutes: "both"` only: with "best" the provider has no `getQuotes` (one quote per request, as before).
    ...(venueRoutes === "both" ? {getQuotes: (params: QuoteParams, signal?: AbortSignal): Promise<Quote[]> => venueCandidates(params, signal)} : {}),

    /**
     * Right before broadcast (after any approval): re-quote the SAME route on
     * chain. If the pool now pays less than the signed minimum, the swap would
     * only revert and burn gas — refuse it here with the reason instead. A pool
     * that no longer holds enough for the whole input (it would fill part of it)
     * is refused the same way. A v4 quote (`providerData.venue = "v4"`) is re-quoted on the V4Quoter and its exact
     * transaction dry-run from the sender (see `preflightV4`). A quote naming its route (`venueRoutes: "both"`) is
     * first held to it (`checkRoute`).
     */
    async preflightDeposit(quote: Quote, tx?: UnsignedTx): Promise<void> {
      const chainId = Number(quote.intentId.split(":")[1]);
      checkRoute(quote, tx?.to ?? quote.txRequest?.to);
      const pd = quote.providerData ?? {};
      if (pd.venue === "v4") return preflightV4(chainId, quote, tx);
      if (pd.venue !== undefined) throw refusal("policy_refused", `uniswap: the quote names an unknown venue (${String(pd.venue).slice(0, 20)}) — refusing`);
      const d = deployments[chainId];
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
      checkRoute(quote, tx.to);
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
      if ((!deployments[chainId] && !uniswapV4DeploymentOf(chainId, v4Deployments)) || !config.rpcUrls[chainId]?.length) return {state: "pending"};
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
