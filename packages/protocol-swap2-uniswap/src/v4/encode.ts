import {concatHex, encodeAbiParameters, encodeFunctionData, getAddress, type Hex} from "viem";
import {
  SWAP_PROXY_ABI,
  UNISWAP_V4,
  UR_ABI,
  UR_COMMANDS,
  V4_ACTION_CONSTANTS,
  V4_ACTIONS,
  V4_EXACT_IN_ABI,
  V4_EXACT_IN_SINGLE_ABI,
  V4_SETTLE_ABI,
  V4_SWAP_INPUT_ABI,
  V4_TAKE_ABI,
  uniswapV4DeploymentOf,
  type UniswapV4Deployment,
} from "./addresses.js";
import {V4_MAX_LP_FEE, isNativeCurrency, normalizeV4PoolKey, otherCurrency, sortCurrencies, v4PoolKeyProblem, type V4PoolKey} from "./pool.js";

/** Most pools one v4 route crosses (single, or two hops). */
export const V4_MAX_HOPS = 2;
const UINT128_MAX = (1n << 128n) - 1n;
const UINT256_MAX = (1n << 256n) - 1n;

/** One v4 swap to encode: exact input, one or two hookless pools in route order. */
export interface V4SwapRequest {
  chainId: number;
  /** The input currency; `address(0)` for the native coin (paid as `value`, settled by the PoolManager). */
  currencyIn: `0x${string}`;
  /** The output currency; `address(0)` for the native coin (paid by the PoolManager straight to the recipient). */
  currencyOut: `0x${string}`;
  /** The pools the route crosses, from `currencyIn` to `currencyOut` (one or two). */
  pools: readonly V4PoolKey[];
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** The explicit payout address (never a router sentinel). */
  recipient: `0x${string}`;
  /** Unix seconds; the router reverts `TransactionDeadlinePassed` after it. */
  deadline: bigint;
}

/** The encoded swap: the call, its value and (token input) the spender to approve for exactly `amountIn`. */
export interface V4EncodedSwap {
  /** "native-in": the pinned Universal Router, `value = amountIn`. "swap-proxy": the pinned SwapProxy, `value = 0`. */
  flow: "native-in" | "swap-proxy";
  to: `0x${string}`;
  data: Hex;
  value: bigint;
  /** Token input only: the SwapProxy, approved for exactly `amountIn` (the engine's exact approve → call → revoke). */
  approvalAddress?: `0x${string}`;
  /** The pinned Universal Router that executes the swap (the call target, or the SwapProxy's `router` argument). */
  router: `0x${string}`;
  /** The `V4_SWAP` input, `abi.encode(bytes actions, bytes[] params)`. */
  v4Input: Hex;
}

/** A path hop as `SWAP_EXACT_IN` writes it (`PathKey`, hookless, empty hookData). */
export interface V4PathHop {
  intermediateCurrency: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
  hookData: Hex;
}

/** The `PathKey[]` of a route: hop i's intermediate is the pool's other currency; the last one is the output. Throws
 *  when a pool does not hold the running currency (the route is not continuous). */
export function v4PathOf(currencyIn: string, pools: readonly V4PoolKey[]): V4PathHop[] {
  let cur = getAddress(currencyIn);
  return pools.map((key, i) => {
    const next = otherCurrency(key, cur);
    if (!next) throw new Error(`uniswap v4: pool ${i + 1} of the route does not hold ${cur}`);
    cur = next;
    return {intermediateCurrency: next, fee: key.fee, tickSpacing: key.tickSpacing, hooks: getAddress(key.hooks), hookData: "0x"};
  });
}

/** The pool keys a `PathKey[]` crosses from `currencyIn` (hop i's pool = sort(currency_i, intermediate_i)). */
export function v4PoolsOfPath(currencyIn: string, path: readonly {intermediateCurrency: string; fee: number; tickSpacing: number; hooks: string}[]): V4PoolKey[] {
  let cur = getAddress(currencyIn);
  return path.map((hop) => {
    const [currency0, currency1] = sortCurrencies(cur, hop.intermediateCurrency);
    cur = getAddress(hop.intermediateCurrency);
    return {currency0, currency1, fee: hop.fee, tickSpacing: hop.tickSpacing, hooks: getAddress(hop.hooks)};
  });
}

/**
 * The `V4_SWAP` input for an exact-input swap: actions `[SWAP_EXACT_IN_SINGLE (one pool) | SWAP_EXACT_IN (two pools),
 * SETTLE, TAKE]` in the UR 2.1.x layout — `minHopPriceX36 = 0 / []`, `hookData = 0x` —, `SETTLE(currencyIn, amountIn,
 * payerIsUser = false)` (exact: a partial fill reverts `CurrencyNotSettled` instead of leaving input in the router) and
 * `TAKE(currencyOut, recipient, 0)` (the whole output to the explicit recipient).
 */
export function encodeV4SwapInput(req: Omit<V4SwapRequest, "chainId" | "deadline">): Hex {
  const currencyIn = getAddress(req.currencyIn);
  const currencyOut = getAddress(req.currencyOut);
  const pools = req.pools.map(normalizeV4PoolKey);
  let swapAction: number;
  let swapParams: Hex;
  if (pools.length === 1) {
    const poolKey = pools[0]!;
    swapAction = V4_ACTIONS.SWAP_EXACT_IN_SINGLE;
    swapParams = encodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, [{
      poolKey,
      zeroForOne: poolKey.currency0 === currencyIn,
      amountIn: req.amountIn,
      amountOutMinimum: req.amountOutMinimum,
      minHopPriceX36: 0n,
      hookData: "0x",
    }]);
  } else {
    swapAction = V4_ACTIONS.SWAP_EXACT_IN;
    swapParams = encodeAbiParameters(V4_EXACT_IN_ABI, [{
      currencyIn,
      path: v4PathOf(currencyIn, pools),
      minHopPriceX36: [],
      amountIn: req.amountIn,
      amountOutMinimum: req.amountOutMinimum,
    }]);
  }
  const settle = encodeAbiParameters(V4_SETTLE_ABI, [currencyIn, req.amountIn, false]);
  const take = encodeAbiParameters(V4_TAKE_ABI, [currencyOut, getAddress(req.recipient), V4_ACTION_CONSTANTS.OPEN_DELTA]);
  const actions = concatHex([byteHex(swapAction), byteHex(V4_ACTIONS.SETTLE), byteHex(V4_ACTIONS.TAKE)]);
  return encodeAbiParameters(V4_SWAP_INPUT_ABI, [actions, [swapParams, settle, take]]);
}

/**
 * Encodes a v4 exact-input swap for the chain's pinned Universal Router 2.1.2 (UNISWAP-V4-RESEARCH §3.10, §5.2):
 *
 * - native input: `UR.execute(0x10, [V4_SWAP], deadline)` with `value = amountIn`, no approval;
 * - token input (SwapProxy, flow S): `SwapProxy.execute(pinned UR, tokenIn, amountIn, 0x10, [V4_SWAP], deadline)` with
 *   `value = 0` and `approvalAddress = SwapProxy` (exactly `amountIn`); a native output is `TAKE(address(0), …)`.
 *
 * Throws for a request it would never send: an unpinned chain, a hooked or malformed pool, a discontinuous route, more
 * than two pools, native in and out, native on a chain whose native coin is an ERC-20, zero or oversized amounts, or a
 * sentinel / zero recipient.
 */
export function encodeV4Swap(req: V4SwapRequest, deployments: Readonly<Record<number, UniswapV4Deployment>> = UNISWAP_V4): V4EncodedSwap {
  const d = uniswapV4DeploymentOf(req.chainId, deployments);
  if (!d) throw new Error(`uniswap v4: no pinned deployment on chain ${req.chainId}`);
  const currencyIn = getAddress(req.currencyIn);
  const currencyOut = getAddress(req.currencyOut);
  const nativeIn = isNativeCurrency(currencyIn);
  const nativeOut = isNativeCurrency(currencyOut);
  if (currencyIn === currencyOut) throw new Error("uniswap v4: same currency in and out");
  if (nativeIn && nativeOut) throw new Error("uniswap v4: native in and out is not a swap");
  if ((nativeIn || nativeOut) && d.nativeWrap === false) throw new Error(`uniswap v4: the native coin on chain ${req.chainId} is an ERC-20 — swap that instead`);
  if (req.pools.length < 1 || req.pools.length > V4_MAX_HOPS) throw new Error(`uniswap v4: a route crosses 1–${V4_MAX_HOPS} pools, not ${req.pools.length}`);
  for (const key of req.pools) {
    const problem = v4PoolKeyProblem(key, V4_MAX_LP_FEE);
    if (problem) throw new Error(`uniswap v4: ${problem}`);
  }
  const path = v4PathOf(currencyIn, req.pools);
  if (path[path.length - 1]!.intermediateCurrency !== currencyOut) throw new Error("uniswap v4: the route does not end in the output currency");
  if (req.amountIn <= 0n || req.amountIn > UINT128_MAX) throw new Error("uniswap v4: amountIn must be in (0, 2^128)");
  if (req.amountOutMinimum <= 0n || req.amountOutMinimum > UINT128_MAX) throw new Error("uniswap v4: amountOutMinimum must be in (0, 2^128)");
  if (req.deadline <= 0n || req.deadline > UINT256_MAX) throw new Error("uniswap v4: deadline out of range");
  const recipient = getAddress(req.recipient);
  if (BigInt(recipient) <= 2n) throw new Error("uniswap v4: the recipient must be an explicit address, not a router sentinel");

  const v4Input = encodeV4SwapInput({currencyIn, currencyOut, pools: req.pools, amountIn: req.amountIn, amountOutMinimum: req.amountOutMinimum, recipient});
  const commands = byteHex(UR_COMMANDS.V4_SWAP);
  const router = getAddress(d.universalRouter);
  if (nativeIn) {
    return {
      flow: "native-in",
      to: router,
      data: encodeFunctionData({abi: UR_ABI, functionName: "execute", args: [commands, [v4Input], req.deadline]}),
      value: req.amountIn,
      router,
      v4Input,
    };
  }
  const swapProxy = getAddress(d.swapProxy);
  return {
    flow: "swap-proxy",
    to: swapProxy,
    data: encodeFunctionData({abi: SWAP_PROXY_ABI, functionName: "execute", args: [router, currencyIn, req.amountIn, commands, [v4Input], req.deadline]}),
    value: 0n,
    approvalAddress: swapProxy,
    router,
    v4Input,
  };
}

function byteHex(b: number): Hex {
  return `0x${b.toString(16).padStart(2, "0")}`;
}
