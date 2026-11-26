// A small fake Monad node for the review round-2 tests (U1/U2 R2): the v3 deployment check and QuoterV2, the v4
// deployment check (its router and SwapProxy code hashed into an overridden pin, same addresses as the shipped table),
// the discovery through Multicall3 on the StateView (every pool of the shipped Monad list initialized and live), the
// V4Quoter (single-pool routes only: each pool the test prices pays its own figure, every other route reverts
// PoolNotInitialized), and the token-input check (balanceOf / allowance, eth_simulateV1 of approve + swap).
// Modelled on the R1 provenance test's node. Every request is kept.
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, getAddress, keccak256, parseAbi, type Hex} from "viem";
import {UNISWAP_V3} from "../src/addresses.js";
import {SWAP_PROXY_ABI, UNISWAP_V4, V4_EXACT_IN_SINGLE_ABI, V4_SWAP_INPUT_ABI} from "../src/v4/addresses.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {poolIdOf} from "../src/v4/pool.js";
import {V4_QUOTER_ABI} from "../src/v4/quote.js";
import {UNISWAP_V4_POOLS} from "../src/v4pools/index.js";

export const CHAIN = 143;
export const D3 = UNISWAP_V3[CHAIN]!;
export const ROUTER_CODE: Hex = "0x60806040526000805500fe";
export const PROXY_CODE: Hex = "0x6080604052600180550000fe";
/** The shipped Monad pins with the fake node's code hashed in: the same addresses, so the app's shipped pins still apply. */
export const V4 = {...UNISWAP_V4, [CHAIN]: {...UNISWAP_V4[CHAIN]!, routerCodehash: keccak256(ROUTER_CODE), swapProxyCodehash: keccak256(PROXY_CODE)}};
export const D4 = V4[CHAIN]!;
export const NATIVE = "0x0000000000000000000000000000000000000000" as const;
export const AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
export const USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
export const ME = getAddress("0x4444444444444444444444444444444444444444");
export const RPC = {[CHAIN]: ["https://monad.fake"]};

const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const STATE_VIEW = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const V3_QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const uint = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const Q96 = 1n << 96n;
/** The fees of a shipped list's pools (Monad's by default), by PoolId: each reads initialized and live. */
const LISTED_FEE = (chainId: number = CHAIN): Map<string, number> => new Map(UNISWAP_V4_POOLS[chainId]!.pools.map((p) => [p.id.toLowerCase(), p.fee]));
/** The shipped v4 pins with the fake node's router and SwapProxy code hashed into the row of `chainId` (same addresses). */
export const v4PinsFor = (chainId: number) => ({...UNISWAP_V4, [chainId]: {...UNISWAP_V4[chainId]!, routerCodehash: keccak256(ROUTER_CODE), swapProxyCodehash: keccak256(PROXY_CODE)}});

type Answer = {result: unknown} | {error: {code: number; message: string; data?: Hex}};
const REVERT: Answer = {error: {code: 3, message: "execution reverted", data: "0x"}};
/** V4TooLittleReceived(min, received) wrapped in the router's ExecutionFailed(0, …). */
const ERR = parseAbi(["error ExecutionFailed(uint256 commandIndex, bytes message)", "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)"]);
export const TOO_LITTLE: Hex = encodeErrorResult({abi: ERR, errorName: "ExecutionFailed", args: [0n, encodeErrorResult({abi: ERR, errorName: "V4TooLittleReceived", args: [10n ** 30n, 1n]})]});

/** A pool the V4Quoter prices on its single-pool route: `out` for the full amount (pro rata below it), `gas` per call. */
export interface PricedPool {
  out: bigint;
  gas: bigint;
}

export interface FakeNodeOptions {
  /** The chain the node serves (default Monad, 143): its v3 row, its v4 row of {@link v4PinsFor} and its shipped list. */
  chainId?: number | undefined;
  /** The amount `out` figures are for (pro rata for the probe). */
  amount: bigint;
  /** v3's direct route for tokenOut at a fee: its output for `amount` (none: v3 has no route). */
  v3?: {tokenOut: string; fee: number; out: bigint} | undefined;
  /** Priced v4 pools by PoolId. */
  v4: ReadonlyMap<string, PricedPool>;
  /** The router's runtime code (default ROUTER_CODE, which the pin hashes): another one is a deployment mismatch. */
  routerCode?: Hex | undefined;
  /** `poolManager()` of the router, the quoter and the StateView reverts (a linkage mismatch). */
  linkageReverts?: boolean | undefined;
  /** The token-input check: the sender's balance (default plenty) and the simulated swap's outcome per pool route. */
  balance?: bigint | undefined;
  /** The PoolIds whose simulated swap reverts V4TooLittleReceived (eth_simulateV1). */
  simulateReverts?: ReadonlySet<string> | undefined;
  /** The PoolIds whose V4Quoter call fails without revert data, in an aggregate and alone (a route needing more gas
   *  than the call was given: LIVE-1). */
  emptyQuotes?: ReadonlySet<string> | undefined;
}

/** The PoolId of the single pool a SwapProxy (or router) call's V4_SWAP input swaps through, if it is a single-pool one. */
function poolOfSwap(data: Hex): string | undefined {
  try {
    const d = decodeFunctionData({abi: SWAP_PROXY_ABI, data});
    const inputs = d.args[4] as readonly Hex[];
    const [, ps] = decodeAbiParameters(V4_SWAP_INPUT_ABI, inputs[0]!) as readonly [Hex, readonly Hex[]];
    const [p] = decodeAbiParameters(V4_EXACT_IN_SINGLE_ABI, ps[0]!) as readonly [{poolKey: {currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex}}];
    return poolIdOf(p.poolKey).toLowerCase();
  } catch {
    return undefined;
  }
}

export function fakeNode(o: FakeNodeOptions) {
  const chainId = o.chainId ?? CHAIN;
  const D3 = UNISWAP_V3[chainId]!;
  const D4 = v4PinsFor(chainId)[chainId]!;
  const listed = LISTED_FEE(chainId);
  const seen: {method: string; to?: string; data?: string; gas?: string}[] = [];
  const stateView = (data: Hex): {success: boolean; returnData: Hex} => {
    const d = decodeFunctionData({abi: STATE_VIEW, data});
    const fee = listed.get((d.args[0] as Hex).toLowerCase());
    if (d.functionName === "getSlot0") return {success: true, returnData: encodeFunctionResult({abi: STATE_VIEW, functionName: "getSlot0", result: fee === undefined ? [0n, 0, 0, 0] : [Q96, 0, 0, fee]})};
    return {success: true, returnData: encodeFunctionResult({abi: STATE_VIEW, functionName: "getLiquidity", result: fee === undefined ? 0n : 10n ** 24n})};
  };
  const v4Quote = (data: Hex): {success: boolean; returnData: Hex} => {
    const d = decodeFunctionData({abi: V4_QUOTER_ABI, data});
    if (d.functionName === "quoteExactInputSingle") {
      const p = d.args[0] as {poolKey: {currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex}; exactAmount: bigint};
      if (o.emptyQuotes?.has(poolIdOf(p.poolKey).toLowerCase())) return {success: false, returnData: "0x"};
      const priced = o.v4.get(poolIdOf(p.poolKey).toLowerCase());
      if (priced) return {success: true, returnData: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [(priced.out * p.exactAmount) / o.amount, priced.gas])};
    }
    return {success: false, returnData: "0x486aa307"}; // PoolNotInitialized(): no candidate
  };
  const answer = (method: string, params: unknown[]): Answer => {
    if (method === "eth_blockNumber") return {result: "0x77998f3"};
    if (method === "eth_getBlockByNumber") return {result: {number: "0x77998f3", gasLimit: "0xbebc200"}};
    if (method === "eth_getCode") {
      const at = getAddress(String(params[0]));
      return {result: at === getAddress(D4.universalRouter) ? (o.routerCode ?? ROUTER_CODE) : at === getAddress(D4.swapProxy) ? PROXY_CODE : "0x"};
    }
    if (method === "eth_simulateV1") {
      const calls = (params[0] as {blockStateCalls: [{calls: {to: string; data: Hex}[]}]}).blockStateCalls[0].calls;
      seen.push({method});
      return {result: [{calls: calls.map((c, i) => {
        if (i < calls.length - 1) return {status: "0x1", returnData: uint(1n)};
        const pool = poolOfSwap(c.data);
        return pool && o.simulateReverts?.has(pool) ? {status: "0x0", returnData: TOO_LITTLE} : {status: "0x1", returnData: "0x"};
      })}]};
    }
    if (method !== "eth_call") return {error: {code: -32601, message: "method not found"}};
    const c = params[0] as {to: string; data: Hex; gas?: string};
    const to = getAddress(c.to);
    const sel = c.data.slice(0, 10);
    seen.push({method, to, data: c.data, ...(c.gas !== undefined ? {gas: c.gas} : {})});
    // v3 deployment check: factory() / WETH9() of the router and the quoter.
    if ((to === getAddress(D3.router) || to === getAddress(D3.quoter)) && sel === "0xc45a0155") return {result: word(D3.factory)};
    if ((to === getAddress(D3.router) || to === getAddress(D3.quoter)) && sel === "0x4aa4a4fc") return {result: word(D3.weth)};
    // v4 linkage: poolManager() of the router, the quoter and the StateView.
    if (sel === "0xdc4c90d3") return o.linkageReverts ? REVERT : {result: word(D4.poolManager)};
    // The token-input check's reads.
    if (sel === "0x70a08231") return {result: uint(o.balance ?? 10n ** 30n)};
    if (sel === "0xdd62ed3e") return {result: uint(0n)};
    if (to === getAddress(D3.quoter)) {
      const d = decodeFunctionData({abi: V3_QUOTER, data: c.data});
      if (o.v3 && d.functionName === "quoteExactInputSingle") {
        const p = d.args[0] as {tokenOut: Hex; amountIn: bigint; fee: number};
        if (getAddress(p.tokenOut) === getAddress(o.v3.tokenOut) && p.fee === o.v3.fee) return {result: encodeFunctionResult({abi: V3_QUOTER, functionName: "quoteExactInputSingle", result: [(o.v3.out * p.amountIn) / o.amount, Q96, 1, 110_000n]})};
      }
      return REVERT;
    }
    if (to === getAddress(D4.quoter)) return REVERT;
    if (to === getAddress(MULTICALL3)) {
      const calls = decodeFunctionData({abi: MC3, data: c.data}).args[0];
      const results = calls.map((x) => (getAddress(x.target) === getAddress(D4.stateView) ? stateView(x.callData) : getAddress(x.target) === getAddress(D4.quoter) ? v4Quote(x.callData) : {success: false, returnData: "0x" as Hex}));
      return {result: encodeFunctionResult({abi: MC3, functionName: "aggregate3", result: results})};
    }
    return REVERT;
  };
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]} | {id: number; method: string; params: unknown[]}[];
    const batch = Array.isArray(body) ? body : [body];
    const out = batch.map((r) => ({jsonrpc: "2.0", id: r.id, ...answer(r.method, r.params)}));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
  }) as typeof fetch;
  return {fetch: f, seen};
}
