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
import type {Quote, QuoteParams, RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {refusalNotes, refusalOf, withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
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
/** A {@link FyndTransactionError} tagged with its refusal reason (class, name and text unchanged). */
const fail = (message: string, reason: Swap2RefusalReason): FyndTransactionError => withReason(new FyndTransactionError(message), reason);
/** The reasons of the texts {@link fyndVerifyQuote} returned, for `fyndPins.reasonOf`. */
const notes = refusalNotes();

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
  if (!chain) throw fail(`chain ${expected.chainId} has no pinned Tycho router`, "unsupported_pair");
  // `tx.to` is the API's: named in the refusal only when it is an address (scan 2026-10-27 modules, F34).
  if (!sameAddress(tx.to, chain.router)) throw fail(`the transaction targets ${/^0x[0-9a-fA-F]{40}$/.test(tx.to) ? tx.to : "something that is not an address"}, not the Tycho router on ${chain.name}`, "vault_mismatch");
  if (sameAddress(expected.receiver, ZERO) || sameAddress(expected.receiver, chain.router)) throw fail("invalid receiver", "recipient_mismatch");
  if (expected.amountIn <= 0n || expected.minAmountOut <= 0n || expected.minAmountOut > expected.expectedAmountOut) {
    throw fail("invalid quote amounts", "price_check_failed");
  }
  const nativeIn = sameAddress(expected.tokenIn, ZERO);
  if (tx.value !== (nativeIn ? expected.amountIn : 0n)) throw fail("native value does not match the input", "price_check_failed");
  if (!/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(tx.data)) throw fail("malformed calldata", "policy_refused");

  let call: ReturnType<typeof decodeFunctionData<typeof TYCHO_ROUTER_ABI>>;
  try {
    call = decodeFunctionData({abi: TYCHO_ROUTER_ABI, data: tx.data as Hex});
  } catch {
    throw fail("not a plain singleSwap / sequentialSwap / splitSwap call (Permit2 and vault variants are not used)", "policy_refused");
  }
  const a = call.args;
  const [amountIn, tokenIn, tokenOut, expectedAmountOut, minAmountOut] = a;
  const isSplit = call.functionName === "splitSwap";
  const receiver = (isSplit ? a[6] : a[5]) as string;
  const fee = (isSplit ? a[7] : a[6]) as {clientFeeBps: number; clientFeeReceiver: string; maxClientContribution: bigint; deadline: bigint; clientSignature: string};
  const swaps = (isSplit ? a[8] : a[7]) as string;
  if (amountIn !== expected.amountIn) throw fail(`calldata spends ${amountIn}, not ${expected.amountIn}`, "price_check_failed");
  if (!sameAddress(tokenIn, routerToken(expected.tokenIn)) || !sameAddress(tokenOut, routerToken(expected.tokenOut))) {
    throw fail("calldata swaps other tokens than requested", "policy_refused");
  }
  if (!sameAddress(receiver, expected.receiver)) throw fail(`calldata pays ${receiver}, not ${expected.receiver}`, "recipient_mismatch");
  if (expectedAmountOut !== expected.expectedAmountOut || minAmountOut !== expected.minAmountOut) {
    throw fail("calldata amounts do not match the quote", "price_check_failed");
  }
  if (fee.clientFeeBps !== 0 || fee.maxClientContribution !== 0n || !sameAddress(fee.clientFeeReceiver, ZERO)) {
    throw fail("calldata carries client-fee parameters — this module charges none", "policy_refused");
  }
  if (swaps === "0x" || (isSplit && (a[5] as bigint) < 2n)) throw fail("empty or invalid route", "policy_refused");
  return {method: call.functionName};
}

/**
 * {@link checkFyndTransaction} on a remote quote, against the request this app sent: the pinned
 * router, one chain, the exact input, the requested tokens, the app's recipient, the quoted minimum and
 * no client fee. The reason it fails, or null.
 */
export function fyndVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  // Fynd swaps on one chain; a source-chain swap must not answer a cross-chain request (reaudit 2026-10-30, #3).
  if (params.sourceChain !== params.destChain) return notes.note("same-chain swaps only", "unsupported_pair");
  try {
    const chainId = /^eip155:[0-9]+$/.test(params.sourceChain) ? Number(params.sourceChain.slice(7)) : NaN;
    const src = sourceAssetOf(params);
    if (!src) return notes.note(`unknown source token ${params.sourceToken}`, "unsupported_pair");
    const tx = quote.txRequest;
    if (!tx?.to || !tx.data) return notes.note("the quote carries no router transaction", "policy_refused");
    checkFyndTransaction({to: tx.to, data: tx.data, value: BigInt(tx.value ?? "0")}, {
      chainId,
      tokenIn: src.contract ? getAddress(src.contract) : ZERO,
      tokenOut: /^0x0+$/.test(params.destToken) ? ZERO : getAddress(params.destToken),
      amountIn: BigInt(params.amountIn),
      receiver: getAddress(params.destAddress),
      expectedAmountOut: BigInt(quote.providerData?.gross ?? "0"),
      minAmountOut: BigInt(quote.minDestAmount),
    });
    return null;
  } catch (e) {
    const text = e instanceof Error ? e.message.replace(/^fynd: /, "") : String(e);
    // checkFyndTransaction's refusals are classified; a request or quote that does not parse is not.
    const info = refusalOf(e);
    return info ? notes.note(text, info) : text;
  }
}

/**
 * The Tycho router a Fynd swap calls and approves on a chain, and {@link fyndVerifyQuote} — the
 * app's side of `remoteProvider({name: "fynd", baseUrl, ...fyndPins})`, so a backend's quote is
 * checked against these routers and the app's own request, never against itself (scan 2026-10-27
 * modules, F9). `reasonOf` classifies the texts `fyndVerifyQuote` returned, so the remote stub's refusal carries a reason.
 */
export const fyndPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => fyndRouterFor(chain),
  spenders: (chain: string): readonly string[] => fyndRouterFor(chain),
  verifyQuote: fyndVerifyQuote,
  reasonOf: (refusal: string) => notes.reasonOf(refusal),
});
function fyndRouterFor(chain: string): readonly string[] {
  const id = /^eip155:[0-9]+$/.test(chain) ? Number(chain.slice(7)) : NaN;
  const c = Object.prototype.hasOwnProperty.call(FYND_CHAINS, id) ? FYND_CHAINS[id] : undefined;
  return c ? [c.router] : [];
}
