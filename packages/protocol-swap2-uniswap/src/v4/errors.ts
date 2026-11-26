import {decodeErrorResult, parseAbi, type Hex} from "viem";
import type {Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";

/**
 * The revert errors a v4 quote, a preflight `eth_call` or a build probe can return (selectors from the tagged sources:
 * v4-core `v4.0.0`, v4-periphery `545a5d2`, universal-router `2.1.2`, permit2 `cc56ad0`; checked in tests).
 */
export const V4_ERRORS_ABI = parseAbi([
  // Universal Router
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error TransactionDeadlinePassed()",
  "error LengthMismatch()",
  "error InvalidCommandType(uint256 commandType)",
  "error ContractLocked()",
  "error InvalidEthSender()",
  "error SliceOutOfBounds()",
  "error UnsupportedProtocolError()",
  // V4Router / BaseActionsRouter / DeltaResolver
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error V4TooLittleReceivedPerHop(uint256 hopIndex, uint256 minPrice, uint256 price)",
  "error V4TooLittleReceivedPerHopSingle(uint256 minPrice, uint256 price)",
  "error InvalidHopPriceLength()",
  "error UnsupportedAction(uint256 action)",
  "error InputLengthMismatch()",
  "error DeltaNotPositive(address currency)",
  "error DeltaNotNegative(address currency)",
  "error InsufficientBalance()",
  // PoolManager / Pool / Hooks / CurrencyLibrary
  "error CurrencyNotSettled()",
  "error PoolNotInitialized()",
  "error SwapAmountCannotBeZero()",
  "error PriceLimitAlreadyExceeded(uint160 sqrtPriceCurrentX96, uint160 sqrtPriceLimitX96)",
  "error PriceLimitOutOfBounds(uint160 sqrtPriceLimitX96)",
  "error HookCallFailed()",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
  "error NativeTransferFailed()",
  "error ERC20TransferFailed()",
  // V4Quoter
  "error NotEnoughLiquidity(bytes32 poolId)",
  "error UnexpectedRevertBytes(bytes revertData)",
  "error UnexpectedCallSuccess()",
  // Permit2
  "error AllowanceExpired(uint256 deadline)",
  "error InsufficientAllowance(uint256 amount)",
  // Error(string) and Panic(uint256) are decoded by viem itself.
]);

/** One decoded revert, outermost first; `inner` is the wrapped error (ExecutionFailed's message, WrappedError's
 *  `reason`, UnexpectedRevertBytes' data), decoded the same way; `context` is WrappedError's `details` (the PoolManager's
 *  own error for the failed call: `HookCallFailed`, `NativeTransferFailed`, `ERC20TransferFailed`). */
export interface V4Revert {
  name: string;
  selector: Hex | null;
  args: readonly unknown[];
  inner?: V4Revert;
  context?: V4Revert;
}

const MAX_DEPTH = 4;
const WRAPPERS: Readonly<Record<string, number>> = {ExecutionFailed: 1, WrappedError: 2, UnexpectedRevertBytes: 0};

/** Decodes revert data recursively through the router's, the PoolManager's and the quoter's wrappers. Unknown data
 *  decodes to `{name: "unknown"}`; empty data to `{name: "empty"}`. Never throws. */
export function decodeV4Revert(data: unknown, depth = 0): V4Revert {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) return {name: "unknown", selector: null, args: []};
  if (data.length < 10) return {name: data === "0x" ? "empty" : "unknown", selector: null, args: []};
  const selector = data.slice(0, 10).toLowerCase() as Hex;
  try {
    const r = decodeErrorResult({abi: V4_ERRORS_ABI, data: data as Hex});
    const args = (r.args ?? []) as readonly unknown[];
    const out: V4Revert = {name: r.errorName, selector, args};
    const at = WRAPPERS[r.errorName];
    if (at !== undefined && depth < MAX_DEPTH) {
      out.inner = decodeV4Revert(args[at], depth + 1);
      if (r.errorName === "WrappedError") out.context = decodeV4Revert(args[3], depth + 1);
    }
    return out;
  } catch {
    return {name: "unknown", selector, args: []};
  }
}

/** Every error of a decoded chain, outermost first (each wrapper, then its wrapped error, then its context). */
export function v4RevertChain(r: V4Revert): V4Revert[] {
  const out: V4Revert[] = [];
  const walk = (x: V4Revert | undefined) => {
    if (!x) return;
    out.push(x);
    walk(x.inner);
    walk(x.context);
  };
  walk(r);
  return out;
}

/** The innermost meaningful error: the deepest wrapped error, or a WrappedError's context when its reason is empty or
 *  unknown (a recipient that reverts with no data while the PoolManager pays it native). */
export function innermostV4Revert(r: V4Revert): V4Revert {
  let cur = r;
  for (;;) {
    const next = cur.inner && !(["empty", "unknown"].includes(cur.inner.name) && cur.context) ? cur.inner : cur.context ?? cur.inner;
    if (!next) return cur;
    cur = next;
  }
}

/** The pool a V4Quoter partial fill names — `NotEnoughLiquidity(poolId)`, raw or wrapped in `UnexpectedRevertBytes`
 *  (`BaseV4Quoter.sol:53-57`) — or null for any other revert. */
export function notEnoughLiquidityPoolId(data: unknown): Hex | null {
  const hit = v4RevertChain(decodeV4Revert(data)).find((r) => r.name === "NotEnoughLiquidity");
  return hit ? ((hit.args[0] as Hex).toLowerCase() as Hex) : null;
}

/** What a v4 revert means for a quote or a swap: the refusal reason and a sentence for the user. */
export interface V4RevertClass {
  reason: Swap2RefusalReason;
  text: string;
  /** The innermost error's name ("unknown" / "empty" when it could not be decoded). */
  error: string;
  /** Set for a quoter partial fill. */
  poolId?: Hex;
}

/**
 * Maps a v4 revert to a refusal (UNISWAP-V4-RESEARCH §3.9): a partial fill (`NotEnoughLiquidity`, or strict SETTLE's
 * `CurrencyNotSettled`) is `insufficient_liquidity`; an output under the minimum (`V4TooLittleReceived`) is
 * `price_check_failed`; a recipient that cannot take native (`NativeTransferFailed`, also wrapped by the PoolManager in
 * `WrappedError`) is `recipient_mismatch`; an expired deadline is `quote_expired`; Uniswap's `UnsupportedProtocol`
 * stub is `vault_mismatch`; anything else is `simulation_failed`.
 */
export function classifyV4Revert(data: unknown): V4RevertClass {
  const top = decodeV4Revert(data);
  const chain = v4RevertChain(top);
  const has = (name: string) => chain.find((r) => r.name === name);
  const inner = innermostV4Revert(top);
  const error = inner.name;
  const nel = has("NotEnoughLiquidity");
  if (nel) return {reason: "insufficient_liquidity", text: "pool liquidity runs out before the full amount (partial fill)", error, poolId: (nel.args[0] as Hex).toLowerCase() as Hex};
  if (has("CurrencyNotSettled")) return {reason: "insufficient_liquidity", text: "the pool can no longer take the whole input (the swap would settle only part of it)", error};
  const tlr = has("V4TooLittleReceived");
  if (tlr) return {reason: "price_check_failed", text: `price moved — the pool now pays ${String(tlr.args[1])}, under the minimum ${String(tlr.args[0])}`, error};
  if (has("V4TooLittleReceivedPerHop") || has("V4TooLittleReceivedPerHopSingle")) return {reason: "price_check_failed", text: "a hop pays less than its minimum price", error};
  if (has("NativeTransferFailed")) return {reason: "recipient_mismatch", text: "the recipient cannot receive the native coin", error};
  if (has("TransactionDeadlinePassed")) return {reason: "quote_expired", text: "the swap's deadline has passed", error};
  if (has("UnsupportedProtocolError")) return {reason: "vault_mismatch", text: "the address holds Uniswap's UnsupportedProtocol stub, not the pinned contract", error};
  if (has("PoolNotInitialized")) return {reason: "no_route", text: "the pool is not initialised", error};
  if (has("PriceLimitAlreadyExceeded")) return {reason: "insufficient_liquidity", text: "the pool is parked at its price bound", error};
  if (has("SwapAmountCannotBeZero")) return {reason: "amount_too_small", text: "a hop of the route swaps zero (the amount is too small for this route)", error};
  return {reason: "simulation_failed", text: `the swap reverts in simulation (${error})`, error};
}
