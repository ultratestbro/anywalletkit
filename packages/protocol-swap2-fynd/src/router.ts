/**
 * TychoRouterV3 — the only contract a Fynd quote may settle through (Fynd
 * License §3: every settlement of a Fynd output goes through the router in
 * Propeller Heads' registry). This file pins the router per chain and checks
 * Fynd's encoded transaction against the request before anything is approved
 * or sent: right contract, right method, the exact input, the requested
 * tokens, the user as receiver, the quoted output and minimum, and no client
 * fee. The route inside `swaps` is opaque and is not inspected here — the
 * router itself reverts below `minAmountOut`.
 */
import {decodeFunctionData, getAddress, parseAbi, toFunctionSelector, type Hex} from "viem";

/** Router registry: github.com/propeller-heads/tycho crates/tycho-execution/config/deployment_registry.json (TychoRouterV3, effective 2026-09-01). */
export const FYND_CHAINS: Readonly<Record<number, {slug: string; name: string; router: `0x${string}`}>> = Object.freeze({
  1: {slug: "ethereum", name: "Ethereum", router: "0x1644D2477f809cc2C71bCCFd6Dc9497E3F83210d"},
  8453: {slug: "base", name: "Base", router: "0xAbA5B53b03eAfaD1C5fc8BD5Fc765fC85Bb3de67"},
  42161: {slug: "arbitrum", name: "Arbitrum", router: "0x924F147c50eA59f5180a26031A8b65B2aA1e81Cd"},
  56: {slug: "bsc", name: "BNB Smart Chain", router: "0x7f3D12BBaFb8955E51B3ab9588b34c8ad95BDA4e"},
  137: {slug: "polygon", name: "Polygon", router: "0xbd4e6011F03355C2A377Fd9Af939322A7d0A1bC1"},
  130: {slug: "unichain", name: "Unichain", router: "0xCba5574597Ad00EA250Fd106DAB4Fc7461949635"},
  4663: {slug: "robinhood", name: "Robinhood Chain", router: "0x09215a470bD585E59EB3F4B612fBD2678131fF9e"},
});

/** The router's native-coin sentinel (lib/NativeETH.sol); Fynd's API uses the zero address instead. */
export const ROUTER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

const PARAMS = "uint256 amountIn, address tokenIn, address tokenOut, uint256 expectedAmountOut, uint256 minAmountOut";
const FEE = "(uint32 clientFeeBps, address clientFeeReceiver, uint256 maxClientContribution, uint256 deadline, bytes clientSignature) clientFeeParams";
const PERMIT = "((address token, uint160 amount, uint48 expiration, uint48 nonce) details, address spender, uint256 sigDeadline) permitSingle, bytes signature";

/** The three entry points a wallet swap uses (plain `transferFrom` from the user). */
export const TYCHO_ROUTER_ABI = parseAbi([
  `function singleSwap(${PARAMS}, address receiver, ${FEE}, bytes swapData) payable returns (uint256)`,
  `function sequentialSwap(${PARAMS}, address receiver, ${FEE}, bytes swaps) payable returns (uint256)`,
  `function splitSwap(${PARAMS}, uint256 nTokens, address receiver, ${FEE}, bytes swaps) payable returns (uint256)`,
]);

/** Every swap entry point of the router (Permit2 and vault variants included) — for recognizing history. */
export const TYCHO_ROUTER_SELECTORS: ReadonlySet<string> = new Set(
  [
    `singleSwap(${PARAMS}, address receiver, ${FEE}, bytes swapData)`,
    `sequentialSwap(${PARAMS}, address receiver, ${FEE}, bytes swaps)`,
    `splitSwap(${PARAMS}, uint256 nTokens, address receiver, ${FEE}, bytes swaps)`,
    `singleSwapUsingVault(${PARAMS}, address receiver, ${FEE}, bytes swapData)`,
    `sequentialSwapUsingVault(${PARAMS}, address receiver, ${FEE}, bytes swaps)`,
    `splitSwapUsingVault(${PARAMS}, uint256 nTokens, address receiver, ${FEE}, bytes swaps)`,
    `singleSwapPermit2(${PARAMS}, address receiver, ${FEE}, ${PERMIT}, bytes swapData)`,
    `sequentialSwapPermit2(${PARAMS}, address receiver, ${FEE}, ${PERMIT}, bytes swaps)`,
    `splitSwapPermit2(${PARAMS}, uint256 nTokens, address receiver, ${FEE}, ${PERMIT}, bytes swaps)`,
  ].map((sig) => toFunctionSelector(`function ${sig}`)),
);

export class FyndTransactionError extends Error {
  constructor(message: string) {
    super(`fynd: ${message}`);
    this.name = "FyndTransactionError";
  }
}

export interface ExpectedSwap {
  chainId: number;
  /** ERC-20 address, or the zero address for the native coin. */
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  receiver: string;
  /** Fynd's gross `amount_out` (before the router fee and slippage). */
  expectedAmountOut: bigint;
  /** Fynd's `min_amount_received` — what the router enforces on-chain. */
  minAmountOut: bigint;
}

export interface EncodedTx {
  to: string;
  value: bigint;
  data: string;
}

const sameAddress = (a: string, b: string) => {
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
};
const routerToken = (t: string) => (sameAddress(t, ZERO) ? ROUTER_NATIVE : t);

/** Refuses (throws {@link FyndTransactionError}) unless `tx` is exactly the swap the wallet asked for. */
export function checkFyndTransaction(tx: EncodedTx, expected: ExpectedSwap): {method: "singleSwap" | "sequentialSwap" | "splitSwap"} {
  const chain = FYND_CHAINS[expected.chainId];
  if (!chain) throw new FyndTransactionError(`chain ${expected.chainId} has no pinned Tycho router`);
  if (!sameAddress(tx.to, chain.router)) throw new FyndTransactionError(`the transaction targets ${tx.to}, not the Tycho router on ${chain.name}`);
  if (sameAddress(expected.receiver, ZERO) || sameAddress(expected.receiver, chain.router)) throw new FyndTransactionError("invalid receiver");
  if (expected.amountIn <= 0n || expected.minAmountOut <= 0n || expected.minAmountOut > expected.expectedAmountOut) {
    throw new FyndTransactionError("invalid quote amounts");
  }
  const nativeIn = sameAddress(expected.tokenIn, ZERO);
  if (tx.value !== (nativeIn ? expected.amountIn : 0n)) throw new FyndTransactionError("native value does not match the input");
  if (!/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(tx.data)) throw new FyndTransactionError("malformed calldata");

  let call: ReturnType<typeof decodeFunctionData<typeof TYCHO_ROUTER_ABI>>;
  try {
    call = decodeFunctionData({abi: TYCHO_ROUTER_ABI, data: tx.data as Hex});
  } catch {
    throw new FyndTransactionError("not a plain singleSwap / sequentialSwap / splitSwap call (Permit2 and vault variants are not used)");
  }
  const a = call.args;
  const [amountIn, tokenIn, tokenOut, expectedAmountOut, minAmountOut] = a;
  const isSplit = call.functionName === "splitSwap";
  const receiver = (isSplit ? a[6] : a[5]) as string;
  const fee = (isSplit ? a[7] : a[6]) as {clientFeeBps: number; clientFeeReceiver: string; maxClientContribution: bigint; deadline: bigint; clientSignature: string};
  const swaps = (isSplit ? a[8] : a[7]) as string;
  if (amountIn !== expected.amountIn) throw new FyndTransactionError(`calldata spends ${amountIn}, not ${expected.amountIn}`);
  if (!sameAddress(tokenIn, routerToken(expected.tokenIn)) || !sameAddress(tokenOut, routerToken(expected.tokenOut))) {
    throw new FyndTransactionError("calldata swaps other tokens than requested");
  }
  if (!sameAddress(receiver, expected.receiver)) throw new FyndTransactionError(`calldata pays ${receiver}, not ${expected.receiver}`);
  if (expectedAmountOut !== expected.expectedAmountOut || minAmountOut !== expected.minAmountOut) {
    throw new FyndTransactionError("calldata amounts do not match the quote");
  }
  if (fee.clientFeeBps !== 0 || fee.maxClientContribution !== 0n || !sameAddress(fee.clientFeeReceiver, ZERO)) {
    throw new FyndTransactionError("calldata carries client-fee parameters — this module charges none");
  }
  if (swaps === "0x" || (isSplit && (a[5] as bigint) < 2n)) throw new FyndTransactionError("empty or invalid route");
  return {method: call.functionName};
}
