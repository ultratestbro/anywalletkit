/**
 * KyberSwap MetaAggregationRouterV2 — the only contract a KyberSwap quote may settle through. This file pins the
 * router and its executor per chain and checks the transaction KyberSwap's build endpoint encoded against the request
 * before anything is approved or sent.
 *
 * The router itself guarantees only that the input comes from the caller and that `dstReceiver` gains at least
 * `minReturnAmount` of `dstToken`; the receiver, the tokens, the minimum, the fee receivers and the flags are all
 * the calldata's (KyberSwap's build endpoint encodes whatever `routeSummary` it is sent, fee entries included).
 * So the calldata is decoded strictly, re-encoded byte for byte, and every field that can move value is compared
 * with the request. The route inside `targetData` is opaque; the router reverts below the minimum.
 */
import type {Quote, QuoteParams, RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {refusalNotes, refusalOf, withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";

/** MetaAggregationRouterV2 — the same address on every chain KyberSwap serves (docs.kyberswap.com, contracts). */
export const KYBER_ROUTER_V2 = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
/** AggregationExecutorProxy — the `callTarget` of every swap the build endpoint encodes. */
export const KYBER_EXECUTOR = "0x8F10B468b06c6FD214B65F87778827F7D113f996";
/** KSAggregationRouterV3: deployed on part of the chains, never returned by the API so far. Refused until decoded. */
export const KYBER_ROUTER_V3 = "0x6868d319c8c9a78f7d39dc3602c5c917315132d7";
/** The router's native-coin sentinel; this SDK uses the zero address. */
export const KYBER_NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * Router build on a chain. `generic`: the 2022 build (18.6 KB) with `swapGeneric` and an owner-managed whitelist — its
 * owner can make the router call any whitelisted contract, so an allowance left on it is exposed to that owner.
 * `lite`: the later build (13.7 KB) without `swapGeneric` and without the whitelist. Both share `swap()`.
 * Read on-chain 2026-11-24 (`eth_getCode`, selectors in the bytecode, `owner()`; how-to-project/kyber-data).
 */
export type KyberRouterBuild = "generic" | "lite";

/**
 * Every chain this module quotes on: KyberSwap's `supported-chains` list (active, plus Arc "new" and Elysium
 * "provisional") intersected with the SDK's EVM catalog, each with the router and executor code checked on-chain.
 * `slug` is the API's path segment (a chain id there is a 404).
 */
export const KYBER_CHAINS: Readonly<Record<number, {slug: string; name: string; build: KyberRouterBuild}>> = Object.freeze({
  1: {slug: "ethereum", name: "Ethereum", build: "generic"},
  8453: {slug: "base", name: "Base", build: "generic"},
  56: {slug: "bsc", name: "BNB Smart Chain", build: "generic"},
  42161: {slug: "arbitrum", name: "Arbitrum", build: "generic"},
  10: {slug: "optimism", name: "Optimism", build: "generic"},
  137: {slug: "polygon", name: "Polygon", build: "generic"},
  43114: {slug: "avalanche", name: "Avalanche", build: "generic"},
  59144: {slug: "linea", name: "Linea", build: "generic"},
  146: {slug: "sonic", name: "Sonic", build: "lite"},
  80094: {slug: "berachain", name: "Berachain", build: "lite"},
  130: {slug: "unichain", name: "Unichain", build: "lite"},
  999: {slug: "hyperevm", name: "HyperEVM", build: "lite"},
  9745: {slug: "plasma", name: "Plasma", build: "lite"},
  143: {slug: "monad", name: "Monad", build: "lite"},
  4326: {slug: "megaeth", name: "MegaETH", build: "lite"},
  4663: {slug: "robinhood", name: "Robinhood Chain", build: "lite"},
  5042: {slug: "arc", name: "Arc", build: "lite"},
  99901: {slug: "elysium", name: "Elysium", build: "lite"},
});

/** The chain entry for an id, never an inherited property. */
export function kyberChain(chainId: number): (typeof KYBER_CHAINS)[number] | undefined {
  return Object.prototype.hasOwnProperty.call(KYBER_CHAINS, chainId) ? KYBER_CHAINS[chainId] : undefined;
}

/**
 * Whether a swap may take or pay the chain's native coin: only where the token catalog lists one. Arc's gas token is
 * USDC with 18-decimal native accounting, listed only through its 6-decimal ERC-20 interface, so a native leg there
 * would carry amounts 10^12 off the catalog's USDC; it is refused and the ERC-20 swaps instead.
 */
export function kyberNativeSwaps(chainId: number): boolean {
  return !!ccAssetByToken(`eip155:${chainId}`, ZERO);
}

/** `swap(SwapExecutionParams)` — the one router entry point this module accepts. */
export const KYBER_ROUTER_ABI = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable returns (uint256 returnAmount, uint256 gasUsed)",
]);
export const KYBER_SWAP_SELECTOR = "0xe21fd0e9";
/** Router entry points that are refused by name: `swapGeneric` (owner-whitelisted arbitrary call) and `swapSimpleMode` (no minimum check). */
export const KYBER_REFUSED_SELECTORS: Readonly<Record<string, string>> = Object.freeze({
  "0x59e50fed": "swapGeneric",
  "0x8af033fb": "swapSimpleMode",
});
/**
 * The only flag bit accepted: `0x200`, set on every swap the build endpoint encodes (not one of the V2 source's named
 * flags; its meaning is not documented). Partial fill (0x01), extra value (0x02), claim (0x04), burns (0x08/0x10),
 * simple mode (0x20), fee on output (0x40), fee in bps (0x80) and approve-fund (0x100) are refused, as is any other bit.
 */
export const KYBER_FLAGS_ALLOWED = 0x200n;

export class KyberTransactionError extends Error {
  constructor(message: string) {
    super(`kyberswap: ${message}`);
    this.name = "KyberTransactionError";
  }
}
const fail = (message: string, reason: Swap2RefusalReason): KyberTransactionError => withReason(new KyberTransactionError(message), reason);
const notes = refusalNotes();

export interface ExpectedKyberSwap {
  chainId: number;
  /** ERC-20 address, or the zero address for the native coin. */
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  /** Who must receive the output (the request's recipient). */
  receiver: string;
  /** The least `minReturnAmount` the calldata may name: the quote's minimum (and the caller's floor). */
  minAmountOut: bigint;
}

export interface EncodedTx {
  to: string;
  value: bigint;
  data: string;
}

export interface DecodedKyberSwap {
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
}

const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a: string, b: string): boolean => isAddr(a) && isAddr(b) && a.toLowerCase() === b.toLowerCase();
const routerToken = (t: string): string => (same(t, ZERO) ? KYBER_NATIVE : t);
/** The calldata may be a megabyte from an untrusted source: names in refusals are addresses only. */
const named = (a: unknown): string => (isAddr(a) ? a : "something that is not an address");
/** At most this much calldata is decoded (a routed swap is a few KB). */
const MAX_CALLDATA_BYTES = 64 * 1024;

/** Refuses (throws {@link KyberTransactionError}) unless `tx` is exactly the swap the wallet asked for. */
export function checkKyberTransaction(tx: EncodedTx, expected: ExpectedKyberSwap): DecodedKyberSwap {
  const chain = kyberChain(expected.chainId);
  if (!chain) throw fail(`chain ${expected.chainId} has no pinned KyberSwap router`, "unsupported_pair");
  if (same(tx.to, KYBER_ROUTER_V3)) throw fail("Kyber router V3 not supported yet", "policy_refused");
  if (!same(tx.to, KYBER_ROUTER_V2)) throw fail(`the transaction targets ${named(tx.to)}, not the KyberSwap router on ${chain.name}`, "vault_mismatch");
  if (!isAddr(expected.receiver) || same(expected.receiver, ZERO) || same(expected.receiver, KYBER_ROUTER_V2) || same(expected.receiver, KYBER_EXECUTOR)) {
    throw fail("invalid receiver", "recipient_mismatch");
  }
  const nativeIn = same(expected.tokenIn, ZERO), nativeOut = same(expected.tokenOut, ZERO);
  if ((nativeIn || nativeOut) && !kyberNativeSwaps(expected.chainId)) throw fail(`the native coin on ${chain.name} is not a catalog asset here; swap its ERC-20 instead`, "unsupported_pair");
  if (same(expected.tokenIn, expected.tokenOut)) throw fail("same token in and out", "unsupported_pair");
  if (expected.amountIn <= 0n || expected.minAmountOut <= 0n) throw fail("invalid quote amounts", "price_check_failed");
  if (typeof tx.data !== "string" || !/^0x(?:[0-9a-fA-F]{2}){4,}$/.test(tx.data)) throw fail("malformed calldata", "policy_refused");
  if (tx.data.length > 2 + 2 * MAX_CALLDATA_BYTES) throw fail("calldata is larger than any routed swap", "policy_refused");
  const selector = tx.data.slice(0, 10).toLowerCase();
  const refused = Object.prototype.hasOwnProperty.call(KYBER_REFUSED_SELECTORS, selector) ? KYBER_REFUSED_SELECTORS[selector] : undefined;
  if (refused) throw fail(`the transaction calls ${refused}, which this module never uses`, "policy_refused");
  if (selector !== KYBER_SWAP_SELECTOR) throw fail("not a router swap() call", "policy_refused");

  let x: {callTarget: string; approveTarget: string; targetData: Hex; desc: {srcToken: string; dstToken: string; srcReceivers: readonly string[]; srcAmounts: readonly bigint[]; feeReceivers: readonly string[]; feeAmounts: readonly bigint[]; dstReceiver: string; amount: bigint; minReturnAmount: bigint; flags: bigint; permit: Hex}; clientData: Hex};
  try {
    const call = decodeFunctionData({abi: KYBER_ROUTER_ABI, data: tx.data as Hex});
    x = call.args[0] as typeof x;
    // Strict: the calldata must be exactly the canonical encoding of what was decoded (no trailing bytes, no odd offsets or padding).
    const again = encodeFunctionData({abi: KYBER_ROUTER_ABI, functionName: "swap", args: [x as never]});
    if (again.toLowerCase() !== tx.data.toLowerCase()) throw new Error("non-canonical");
  } catch {
    throw fail("the calldata is not a canonical router swap() encoding", "policy_refused");
  }
  const d = x.desc;
  if (!same(x.callTarget, KYBER_EXECUTOR)) throw fail(`the swap runs through ${named(x.callTarget)}, not the pinned KyberSwap executor`, "vault_mismatch");
  if (!same(x.approveTarget, ZERO)) throw fail("the swap asks the router to approve another contract", "policy_refused");
  if (!same(d.srcToken, routerToken(expected.tokenIn)) || !same(d.dstToken, routerToken(expected.tokenOut))) throw fail("calldata swaps other tokens than requested", "policy_refused");
  if (d.amount !== expected.amountIn) throw fail(`calldata spends ${d.amount}, not ${expected.amountIn}`, "price_check_failed");
  if (d.srcReceivers.length !== d.srcAmounts.length) throw fail("malformed input split", "policy_refused");
  if (nativeIn) {
    if (d.srcReceivers.length !== 0) throw fail("a native-coin swap must not split the input", "policy_refused");
    if (tx.value !== expected.amountIn) throw fail("native value does not match the input", "price_check_failed");
  } else {
    if (tx.value !== 0n) throw fail("a token swap must not send the native coin", "price_check_failed");
    const total = d.srcAmounts.reduce((s, a) => s + a, 0n);
    if (total !== expected.amountIn) throw fail(`the input split adds up to ${total}, not ${expected.amountIn}`, "price_check_failed");
  }
  if (same(d.dstReceiver, ZERO)) throw fail("the swap names no receiver", "recipient_mismatch");
  if (!same(d.dstReceiver, expected.receiver)) throw fail(`calldata pays ${named(d.dstReceiver)}, not ${expected.receiver}`, "recipient_mismatch");
  if (d.minReturnAmount <= 0n) throw fail("the swap names no minimum", "price_check_failed");
  if (d.minReturnAmount < expected.minAmountOut) throw fail(`calldata guarantees ${d.minReturnAmount}, under the quoted minimum ${expected.minAmountOut}`, "price_check_failed");
  if (d.feeReceivers.length !== 0 || d.feeAmounts.length !== 0) throw fail("calldata pays a fee receiver — this module charges none", "policy_refused");
  if ((d.flags & ~KYBER_FLAGS_ALLOWED) !== 0n) throw fail(`calldata sets router flags ${d.flags.toString(16).slice(0, 16)} (only 0x200 is accepted)`, "policy_refused");
  if (d.permit !== "0x") throw fail("calldata carries a permit", "policy_refused");
  return {srcToken: d.srcToken, dstToken: d.dstToken, dstReceiver: d.dstReceiver, amount: d.amount, minReturnAmount: d.minReturnAmount, flags: d.flags};
}

/**
 * The minimum KyberSwap's build encodes for `amountOut` at `bps` slippage: the expected output less the slippage,
 * rounded down, less one more unit — the build endpoint always lands exactly one base unit under the plain
 * `floor(amountOut × (10000 − bps) / 10000)` (18 chains, 2026-11-24). The quote shows this value, so the dry quote,
 * the build and the check agree to the unit.
 */
export function kyberMinimum(amountOut: bigint, bps: number): bigint {
  const m = (amountOut * BigInt(10_000 - bps)) / 10_000n - 1n;
  return m > 0n ? m : 0n;
}

/**
 * The slippage to ask KyberSwap for so that its minimum — one unit under the plain floor ({@link kyberMinimum}) — still
 * meets the engine's floor for the slippage the user chose, `floor(amountOut × (10000 − bps) / 10000)`. One basis point
 * less for most outputs; more for a tiny output (a $1 WBTC buy is a few thousand units, where 1 bps is under one unit).
 * Null when no positive slippage does (an output too small to carry a minimum).
 */
export function kyberApiSlippage(amountOut: bigint, bps: number): number | null {
  const floor = (amountOut * BigInt(10_000 - bps)) / 10_000n;
  for (let b = bps - 1; b >= 1; b--) if (kyberMinimum(amountOut, b) >= floor && kyberMinimum(amountOut, b) > 0n) return b;
  return null;
}

const chainIdOf = (caip2: string): number => (/^eip155:[0-9]+$/.test(caip2) ? Number(caip2.slice(7)) : NaN);

/**
 * The app's own check of a KyberSwap quote (behind `remoteProvider`, or on any quote): one chain, the exact input,
 * a minimum at or under the expected output and at or above the caller's floor; an execution quote's transaction must
 * pass {@link checkKyberTransaction} against this app's request. A dry quote carries no transaction. The reason it fails, or null.
 */
export function kyberVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  if (params.sourceChain !== params.destChain) return notes.note("same-chain swaps only", "unsupported_pair");
  try {
    const chainId = chainIdOf(params.sourceChain);
    if (!kyberChain(chainId)) return notes.note(`no pinned KyberSwap router on ${params.sourceChain}`, "unsupported_pair");
    const src = sourceAssetOf(params);
    if (!src) return notes.note(`unknown source token ${params.sourceToken}`, "unsupported_pair");
    if (quote.sourceAmount !== params.amountIn) return notes.note("the quote prices another amount", "price_check_failed");
    const min = BigInt(quote.minDestAmount), out = BigInt(quote.destAmount);
    if (min <= 0n || min > out) return notes.note("invalid quote amounts", "price_check_failed");
    if (params.minAmountOut !== undefined && min < BigInt(params.minAmountOut)) return notes.note("the quote's minimum is under the floor", "price_check_failed");
    // The minimum is the expected output less the requested slippage, never more slippage than asked for.
    const bps = params.slippageBps;
    if (bps !== undefined && Number.isInteger(bps) && bps >= 0 && bps < 10_000 && min < kyberMinimum(out, bps)) {
      return notes.note("the quote's minimum allows more slippage than requested", "price_check_failed");
    }
    const tx = quote.txRequest;
    if (!tx) return params.dry === false ? notes.note("the quote carries no router transaction", "policy_refused") : null;
    if (!tx.to || !tx.data) return notes.note("the quote carries no router transaction", "policy_refused");
    if (tx.approvalAddress !== undefined && !same(tx.approvalAddress, KYBER_ROUTER_V2)) return notes.note("the quote asks to approve another spender", "vault_mismatch");
    checkKyberTransaction({to: tx.to, data: tx.data, value: BigInt(tx.value ?? "0")}, {
      chainId,
      tokenIn: src.contract ? getAddress(src.contract) : ZERO,
      tokenOut: /^0x0+$/.test(params.destToken) ? ZERO : getAddress(params.destToken),
      amountIn: BigInt(params.amountIn),
      receiver: getAddress(params.destAddress),
      minAmountOut: min,
    });
    return null;
  } catch (e) {
    const text = e instanceof Error ? e.message.replace(/^kyberswap: /, "") : String(e);
    const info = refusalOf(e);
    return info ? notes.note(text, info) : text;
  }
}

function routerFor(chain: string): readonly string[] {
  return kyberChain(chainIdOf(chain)) ? [KYBER_ROUTER_V2] : [];
}

/**
 * The provider's `exactAllowanceOnly` (protocol-swap2-core): true on the chains whose router is the `generic` build —
 * `swapGeneric` behind an owner-managed executor whitelist, so the router's owner (a single key on all but Linea) could
 * make it spend an allowance left on it. The engine then approves exactly the input and revokes it when the swap does
 * not spend it, whatever the app's `allowanceReuse` / `revokeUnspentApproval` say. False on the `lite` chains; true
 * for a chain this module does not know (fail closed).
 */
export function kyberExactAllowanceOnly(chain: string): boolean {
  return kyberChain(chainIdOf(chain))?.build !== "lite";
}

/**
 * The router a KyberSwap swap calls and approves, and {@link kyberVerifyQuote}: the app's side of
 * `remoteProvider({name: "kyberswap", baseUrl, ...kyberPins})`, so a backend's quote is checked against the pinned
 * router and the app's own request, never against itself.
 */
export const kyberPins: RemotePins = Object.freeze({
  callTargets: routerFor,
  spenders: routerFor,
  exactAllowanceOnly: kyberExactAllowanceOnly,
  verifyQuote: kyberVerifyQuote,
  reasonOf: (refusal: string) => notes.reasonOf(refusal),
});
