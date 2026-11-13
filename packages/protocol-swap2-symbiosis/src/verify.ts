import {decodeFunctionData, encodeFunctionData, getAddress, isAddress, parseAbi, type Abi, type Hex} from "viem";
import {bigintToNumber} from "@anywalletkit/core";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {sourceAssetOf, tonRawAddress} from "@anywalletkit/protocol-swap2-core/util";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {refusalOf, withReason, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {Slice, parseBoc, snakeHex, type TonCell} from "./boc.js";
import {
  SYMBIOSIS_AGGREGATORS, SYMBIOSIS_CHAINS, SYMBIOSIS_HOST, SYMBIOSIS_HOST_CHAIN_ID, SYMBIOSIS_REVERTER, SYMBIOSIS_TON_CHAIN_ID, SYMBIOSIS_TON_PORTAL_RAW,
  SYMBIOSIS_UNWRAPPERS, SYMBIOSIS_V2_ROUTERS,
  account20, gatewayAddress, symbiosisChain, symbiosisToken, tronToEvm, validAddress, type SymbiosisChain,
} from "./config.js";
import {SYMBIOSIS_HOST_META_ROUTER, SYMBIOSIS_POOLS, SYMBIOSIS_SYNTHS} from "./pools.js";
import {notes, noted} from "./reasons.js";

/**
 * What a Symbiosis source transaction is allowed to be — checked on the device, from the bytes the
 * wallet is about to sign, against the user's own request. Nothing here trusts the API: a response
 * that fails any check is refused before a quote is shown and again right before signing.
 *
 * A source transaction is always ONE call (EVM, Tron) or ONE jetton transfer (TON):
 *
 *   gateway.metaRoute({amount, nativeIn, approvedTokens, firstDexRouter + firstSwapCalldata,
 *                      relayRecipient: Portal, otherSideCalldata})
 *     └ Portal.metaSynthesize({rtoken, amount, syntCaller, chain2address, revertableAddress,
 *                              receiveSide / oppositeBridge / chainID: the host chain, swapTokens,
 *                              secondDexRouter + secondSwapCalldata: MulticallRouter.multicall(pool swaps),
 *                              finalReceiveSide + finalCalldata})
 *         └ Synthesis.metaBurnSyntheticToken({sToken, chainID, chain2address, receiveSide, oppositeBridge,
 *                                             finalReceiveSide + finalCallData: a swap on the destination, …})
 *           or Synthesis.burnSyntheticTokenTON(stoken, …, chain2address: the TON recipient, chainID, …)
 *
 * Every level is decoded and must re-encode to the same bytes (one reading only), and every place a
 * contract writes a running amount into the next call (`finalOffset`, the multicall's `offset[]`) must be
 * the amount word of the function it patches. BOUND to the request — a mismatch is a refusal:
 *
 *   - the contract called is the chain's pinned MetaRouterGateway, and it is `metaRoute`; `amount` is the
 *     sell amount, `nativeIn` and the transaction value match a native / token sale, the first approved
 *     token is the sell token;
 *   - before the bridge there is nothing, the wrap of the native coin by the bridged token's own
 *     contract, or ONE swap on an allow-listed router (1inch AggregationRouterV6, KyberSwap
 *     MetaAggregationRouterV2, or the chain's pinned Uniswap-V2-style router) decoded to: sell token and amount in, the bridged token out
 *     to the chain's pinned MetaRouter, no partial fill, a minimum not below 90% of the amount the
 *     bridge request states. Any other router or function is refused;
 *   - the relay recipient is the chain's pinned Portal and the call it gets is `metaSynthesize` naming
 *     the pinned host-chain Synthesis and Bridge, the host chain id, the user as `syntCaller`, and only
 *     the user's own addresses (or Symbiosis' revert service, where the API always writes it) as
 *     `chain2address` / `revertableAddress`;
 *   - the bridged token has a pinned synthetic token on the host chain, and it is `swapTokens[0]`;
 *   - the host-chain swap is `multicall` on the pinned MulticallRouter whose every step is `swap` on a
 *     pinned Symbiosis pool, between the pool's pinned tokens at the named indexes, paid to the
 *     MulticallRouter, with the running amount written into `dx`; the path is the swap token list and
 *     the result goes to the pinned host-chain MetaRouter. The bridged amount stated is not below 90%
 *     of the last pool minimum (like-asset pools), so the stated amounts hang together;
 *   - the final host-chain call is `metaBurnSyntheticToken` / `burnSyntheticTokenTON` burning exactly the
 *     token the pools pay out, which must be the pinned synthetic of a token ON THE DESTINATION chain,
 *     naming the destination chain id, its pinned Portal and Bridge and the user's address as receiver;
 *   - after the bridge there is either nothing — then the released token is the quoted token and the
 *     last pool minimum less the relayers' fee is not below the quote's minimum — or Symbiosis' pinned
 *     Unwrapper paying the native coin to the recipient (same minimum rule), or ONE swap on an
 *     allow-listed router decoded to: the released token in, the quoted token out to the recipient,
 *     no partial fill, a minimum not below the quote's minimum. Anything else is refused.
 *
 * STILL TRUSTED (see the README, "What is still trusted"):
 *   - inside an aggregator swap, the executor payload: which venues it trades on. What holds is the
 *     router's own guarantee — it reverts unless the receiver's balance of the output token grew by
 *     at least the decoded minimum (both routers are non-upgradable, source-verified contracts);
 *   - the price of a swap before the bridge: its minimum is tied to the amounts the API states, which
 *     are tied to the route's final minimum only as like-for-like assets, not to a market price;
 *   - the relayers' fees (`stableBridgingFee`) and Symbiosis' own contracts, relayers and pools;
 *   - the pinned tables themselves (`config.ts`, `pools.ts`): read from the chain, re-checked by
 *     `scripts/verify-live.mjs` and `scripts/build-pins.mjs --check`.
 */

const ABI = parseAbi([
  "struct MetaRouteTransaction { bytes firstSwapCalldata; bytes secondSwapCalldata; address[] approvedTokens; address firstDexRouter; address secondDexRouter; uint256 amount; bool nativeIn; address relayRecipient; bytes otherSideCalldata; }",
  "function metaRoute(MetaRouteTransaction t) payable",
  "struct MetaSynthesizeTransaction { uint256 stableBridgingFee; uint256 amount; address rtoken; address chain2address; address receiveSide; address oppositeBridge; address syntCaller; uint256 chainID; address[] swapTokens; address secondDexRouter; bytes secondSwapCalldata; address finalReceiveSide; bytes finalCalldata; uint256 finalOffset; address revertableAddress; bytes32 clientID; }",
  "function metaSynthesize(MetaSynthesizeTransaction t)",
  "struct MetaBurnTransaction { uint256 stableBridgingFee; uint256 amount; bytes32 crossChainID; address syntCaller; address finalReceiveSide; address sToken; bytes finalCallData; uint256 finalOffset; address chain2address; address receiveSide; address oppositeBridge; address revertableAddress; uint256 chainID; bytes32 clientID; }",
  "struct TonAddress { int8 workchain; bytes32 address_hash; }",
  "function metaBurnSyntheticToken(MetaBurnTransaction t)",
  "function burnSyntheticTokenTON(uint256 stableBridgingFee,address stoken,uint256 amount,bytes32 crossChainID,TonAddress chain2address,address receiveSide,address oppositeBridge,address revertableAddress,uint256 chainID,bytes32 clientID)",
  "function multicall(uint256 amountIn,bytes[] calldatas,address[] receiveSides,address[] path,uint256[] offsets,address to)",
]);
/** A Symbiosis pool's `swap(tokenIndexFrom, tokenIndexTo, dx, minDy, to, deadline)`. */
const POOL_ABI = parseAbi(["function swap(uint256 tokenIndexFrom,uint256 tokenIndexTo,uint256 dx,uint256 minDy,address to,uint256 deadline)"]);
/** 1inch AggregationRouterV6 `swap(executor, desc, data)`. */
const ONE_INCH_ABI = parseAbi([
  "struct SwapDescription { address srcToken; address dstToken; address srcReceiver; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; }",
  "function swap(address executor, SwapDescription desc, bytes data) payable",
]);
/** KyberSwap MetaAggregationRouterV2 `swap(execution)`. */
const KYBER_ABI = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable",
]);

/**
 * A V2 router's exact-input swaps. `…ForETH`: the router requires the last path entry to be the
 * wrapped native token and sends the coin to `to`. `swapExactETHForTokens`: the amount sold is the
 * value sent with the call and the router requires the first path entry to be the wrapped token.
 */
const V2_ABI = parseAbi([
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
]);
/** Symbiosis' Unwrapper. */
const UNWRAP_ABI = parseAbi(["function unwrap(uint256 amountIn,address to)"]);

/** `metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))` — the only function a source transaction calls. */
export const SYMBIOSIS_META_ROUTE_SELECTOR = "0xa11b1198";
export const SYMBIOSIS_META_ROUTE_SIGNATURE = "metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))";
const SEL_META_SYNTHESIZE = "0xce654c17";
const SEL_META_BURN = "0xe66bb550";
const SEL_BURN_TON = "0x41fabd12";
/** `multicall(uint256,bytes[],address[],address[],uint256[],address)` on the host chain's MulticallRouter. */
const SEL_MULTICALL = "0x1e859a05";
/** `swap(uint256,uint256,uint256,uint256,address,uint256)` of a Symbiosis pool. */
const SEL_POOL_SWAP = "0x8f6bdeaa";
/** 1inch AggregationRouterV6 `swap`. */
const SEL_ONE_INCH_SWAP = "0x07ed2379";
/** KyberSwap MetaAggregationRouterV2 `swap`. */
const SEL_KYBER_SWAP = "0xe21fd0e9";
const SEL_V2_TOKENS = "0x38ed1739";
const SEL_V2_ETH = "0x18cbafe5";
const SEL_V2_FROM_ETH = "0x7ff36ab5";
const SEL_UNWRAP = "0x7647691d";
/** `amountIn` is the first argument of both V2 swaps and of `unwrap`: its word ends at byte 36. */
const FIRST_WORD_END = 36n;
const MAX_V2_PATH = 4;
/** Where a pool swap's `dx` ends inside its calldata (selector + three words): the multicall writes the running amount there. */
const POOL_OFFSET = 100n;
/** How both aggregators spell a chain's native coin. */
const AGGREGATOR_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
/** KyberSwap flags that leave "the receiver gets at least the minimum or the call reverts" intact: claim, simple mode, approve-fund and the unused 0x200 bit. */
const KYBER_FLAGS_ALLOWED = 0x04n | 0x20n | 0x100n | 0x200n;
/** A swap before the bridge must promise at least this share of the amount the bridge request states; the same share ties that amount to the last pool minimum. */
const CONSISTENCY_BPS = 9_000n;
const MAX_POOL_STEPS = 4;
/** `deposit()` of a wrapped-native contract. */
const SEL_WRAP = "0xd0e30db0";
/** Where the bridged amount sits in every burn call: after the selector and three words. */
const FINAL_OFFSET = 100n;
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = `0x${"0".repeat(64)}`;

/** Jetton `transfer` (TEP-74). */
const OP_JETTON_TRANSFER = 0x0f8a7ea5n;
/** The TON Portal's `metaSynthesize` request, carried as the transfer's forward payload. */
const OP_TON_META_SYNTHESIZE = 0x5e7d9020n;
/** The most TON a jetton transfer of this module may attach (the engine holds the same ceiling by default). */
export const SYMBIOSIS_TON_VALUE_CEILING = 1_000_000_000n;

/** The user's request, in the terms the calldata is checked against. */
export interface SymbiosisRequest {
  source: SymbiosisChain;
  dest: SymbiosisChain;
  /** The user's address on the source chain (the sender of the source transaction). */
  sender: string;
  /** The user's address on the destination chain. */
  recipient: string;
  /** The sell token's contract in the source chain's own spelling; null for the native coin. */
  sellToken: string | null;
  /** The buy token as Symbiosis' contracts name it on the destination (20 bytes, lowercase); null for the native coin. */
  destToken: string | null;
  amountIn: bigint;
  /**
   * The user's own EVM address that stands in for them on the host chain when the source is not an
   * EVM chain (it receives the synthetic tokens if the last leg is reverted); null when none applies.
   */
  fallbackReceiver: string | null;
}

/** An aggregator router a route may swap on, by the name reported on the quote. */
export type SymbiosisAggregator = "1inch-v6" | "kyberswap-v2" | "uniswap-v2";
/** What may follow the bridge on the destination: a decoded swap, or Symbiosis' Unwrapper paying out the native coin. */
export type SymbiosisDestCall = SymbiosisAggregator | "unwrap";

/** What a check found beyond "bound": the parts of the route that rest on a third party's contract or on Symbiosis' service. */
export interface SymbiosisBound {
  /**
   * The route swaps on the source chain before bridging, on this allow-listed aggregator router. Tokens,
   * amount, receiver and minimum of that swap are bound; the venues it trades on are the aggregator's.
   */
  sourceSwap: SymbiosisAggregator | null;
  /** The same for a swap on the destination chain after bridging. */
  destSwap: SymbiosisDestCall | null;
  /** `revertableAddress` of the bridge request is Symbiosis' revert service, not the user. */
  serviceReverts: boolean;
}

export interface SymbiosisVerifyOptions {
  /** The user's own EVM address for non-EVM sources whose destination is not an EVM chain (Tron ↔ TON). */
  fallbackReceiver?: string;
}

class Refusal extends Error {}
/** Throws the refusal, its text as it reads, classified (`Swap2RefusalReason`). */
const refuse = (reason: string, why: Swap2RefusalReason): never => { throw withReason(new Refusal(reason), why); };
const lower = (a: string) => a.toLowerCase();
const same = (a: string, b: string | null | undefined) => typeof b === "string" && lower(a) === lower(b);

/**
 * The request a `QuoteParams` describes, or the reason it cannot be served. The sender is
 * `refundAddress` (the engine passes the account's own address there).
 */
export function symbiosisRequest(params: QuoteParams, options: SymbiosisVerifyOptions = {}): SymbiosisRequest | string {
  const source = symbiosisChain(params.sourceChain);
  const dest = symbiosisChain(params.destChain);
  if (!source || !dest) return noted("unsupported chain", "unsupported_pair");
  if (source === dest) return noted("same-chain swaps are not served", "unsupported_pair");
  if (dest.family === "bitcoin") return noted("Bitcoin is not a destination", "unsupported_pair");
  if (typeof params.amountIn !== "string" || !/^\d+$/.test(params.amountIn) || BigInt(params.amountIn) <= 0n) return "amount must be a positive integer string";
  const asset = sourceAssetOf(params);
  if (!asset) return noted(`unknown source token ${params.sourceToken}`, "unsupported_pair");
  const buy = ccAssetByToken(params.destChain, params.destToken);
  if (!buy) return noted(`destination token ${params.destToken} is not in the catalog`, "unsupported_pair");
  const out = symbiosisToken(dest, buy.contract);
  if (!out) return noted("malformed destination token", "unsupported_pair");
  const sender = params.refundAddress ?? "";
  if (!validAddress(source, sender)) return noted(`the sender is not a ${source.name} address`, "recipient_mismatch");
  if (!validAddress(dest, params.destAddress)) return noted(`the recipient is not a ${dest.name} address`, "recipient_mismatch");
  let fallbackReceiver: string | null = null;
  if (source.family !== "evm") {
    const own = dest.family === "evm" ? params.destAddress : options.fallbackReceiver;
    if (!own || !isAddress(own) || same(own, ZERO)) return noted("a non-EVM source to a non-EVM destination needs the user's own EVM address (fallbackReceiver)", "unsupported_pair");
    fallbackReceiver = getAddress(own);
  }
  return {
    source, dest, sender, recipient: params.destAddress, sellToken: asset.contract ?? null, destToken: out.address === "" ? null : lower(out.address),
    amountIn: BigInt(params.amountIn), fallbackReceiver,
  };
}

/** The 20-byte addresses that are the user's own on Symbiosis' host chain. */
function ownSet(r: SymbiosisRequest): string[] {
  const out: string[] = [];
  const add = (a: string | null) => { if (a && !out.includes(lower(a))) out.push(lower(a)); };
  add(account20(r.source, r.sender));
  add(account20(r.dest, r.recipient));
  add(r.fallbackReceiver);
  return out;
}

/**
 * Decodes `data` as `name` of `abi` and requires the bytes to be exactly the canonical encoding of
 * what was decoded — one reading only, so a contract cannot read a field from somewhere this decoder
 * did not look.
 */
function decode(abi: Abi, data: string, selector: string, name: string, what: string = name): readonly unknown[] {
  if (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data)) refuse(`${what}: not hex calldata`, "policy_refused");
  if (lower(data.slice(0, 10)) !== selector) refuse(`${what}: unexpected function ${data.slice(0, 10)}`, "policy_refused");
  let decoded: {functionName: string; args?: readonly unknown[]};
  try {
    decoded = decodeFunctionData({abi, data: data as Hex}) as {functionName: string; args?: readonly unknown[]};
  } catch {
    return refuse(`${what}: calldata does not decode`, "policy_refused");
  }
  if (decoded.functionName !== name) refuse(`${what}: unexpected function ${decoded.functionName}`, "policy_refused");
  let again: string;
  try {
    again = encodeFunctionData({abi, functionName: decoded.functionName, args: decoded.args});
  } catch {
    return refuse(`${what}: calldata does not re-encode`, "policy_refused");
  }
  if (lower(again) !== lower(data)) refuse(`${what}: calldata is not canonically encoded`, "policy_refused");
  return decoded.args ?? [];
}

interface MetaRoute {
  firstSwapCalldata: string; secondSwapCalldata: string; approvedTokens: readonly string[]; firstDexRouter: string; secondDexRouter: string;
  amount: bigint; nativeIn: boolean; relayRecipient: string; otherSideCalldata: string;
}
interface MetaSynthesize {
  stableBridgingFee: bigint; amount: bigint; rtoken: string; chain2address: string; receiveSide: string; oppositeBridge: string; syntCaller: string;
  chainID: bigint; swapTokens: readonly string[]; secondDexRouter: string; secondSwapCalldata: string; finalReceiveSide: string; finalCalldata: string;
  finalOffset: bigint; revertableAddress: string; clientID: string;
}
interface MetaBurn {
  stableBridgingFee: bigint; amount: bigint; crossChainID: string; syntCaller: string; finalReceiveSide: string; sToken: string; finalCallData: string;
  finalOffset: bigint; chain2address: string; receiveSide: string; oppositeBridge: string; revertableAddress: string; chainID: bigint; clientID: string;
}
interface OneInchDesc {srcToken: string; dstToken: string; srcReceiver: string; dstReceiver: string; amount: bigint; minReturnAmount: bigint; flags: bigint}
interface KyberDesc {
  srcToken: string; dstToken: string; srcReceivers: readonly string[]; srcAmounts: readonly bigint[]; feeReceivers: readonly string[]; feeAmounts: readonly bigint[];
  dstReceiver: string; amount: bigint; minReturnAmount: bigint; flags: bigint; permit: string;
}
interface KyberExecution {callTarget: string; approveTarget: string; targetData: string; desc: KyberDesc; clientData: string}

/** What an aggregator swap is, in the terms every caller checks. */
interface AggregatorSwap {
  router: SymbiosisAggregator;
  srcToken: string;
  dstToken: string;
  dstReceiver: string;
  /** null: the amount is the value sent with the call (a native sale on a V2 router), not an argument. */
  amount: bigint | null;
  minReturnAmount: bigint;
  /** Where the `amount` word ENDS inside the calldata — the offset a contract must name to write the running amount into it; null when there is no such word. */
  amountOffset: bigint | null;
}

/** The byte position where the single 32-byte word in which two encodings differ ends; refuses anything else. */
function patchedWordEnd(a: string, b: string, what: string): bigint {
  if (a.length !== b.length) return refuse(`${what}: the amount does not sit in one fixed word`, "policy_refused");
  let at = -1;
  for (let i = 10; i < a.length; i += 64) {
    if (a.slice(i, i + 64) !== b.slice(i, i + 64)) {
      if (at !== -1) return refuse(`${what}: the amount is written in more than one place`, "policy_refused");
      at = i;
    }
  }
  if (at === -1) return refuse(`${what}: the amount word was not found`, "policy_refused");
  return BigInt((at - 2) / 2 + 32);
}

/**
 * A call to an allow-listed aggregator router, decoded as far as its router ABI goes: the one
 * `swap` function of 1inch AggregationRouterV6 or KyberSwap MetaAggregationRouterV2, with nothing
 * set that weakens "the receiver gets at least the minimum of the output token, or the call reverts".
 * Any other target or function is refused. `chain` must be an EVM chain both routers are deployed on.
 */
function decodeAggregatorSwap(chain: SymbiosisChain, target: string, data: string, what: string): AggregatorSwap {
  if (chain.family !== "evm") refuse(`${what}: no aggregator router is allow-listed on ${chain.name}`, "vault_mismatch");
  if (same(target, SYMBIOSIS_AGGREGATORS.oneInchV6)) {
    const [, d] = decode(ONE_INCH_ABI, data, SEL_ONE_INCH_SWAP, "swap", what) as [string, OneInchDesc, string];
    if (d.flags !== 0n) refuse(`${what}: the 1inch swap sets flags ${d.flags} (partial fill, extra value or Permit2 are not accepted)`, "policy_refused");
    if (d.minReturnAmount <= 0n) refuse(`${what}: the swap names no minimum`, "price_check_failed");
    return {router: "1inch-v6", srcToken: d.srcToken, dstToken: d.dstToken, dstReceiver: d.dstReceiver, amount: d.amount, minReturnAmount: d.minReturnAmount, amountOffset: 196n};
  }
  if (same(target, SYMBIOSIS_AGGREGATORS.kyberV2)) {
    const [x] = decode(KYBER_ABI, data, SEL_KYBER_SWAP, "swap", what) as [KyberExecution];
    const d = x.desc;
    if ((d.flags & ~KYBER_FLAGS_ALLOWED) !== 0n) refuse(`${what}: the KyberSwap swap sets flags ${d.flags} (partial fill, extra value, burns or a fee on the output are not accepted)`, "policy_refused");
    if (d.feeReceivers.length !== 0 || d.feeAmounts.length !== 0) refuse(`${what}: the KyberSwap swap pays a fee receiver`, "policy_refused");
    if (d.permit !== "0x") refuse(`${what}: the KyberSwap swap carries a permit`, "policy_refused");
    if (d.minReturnAmount <= 0n) refuse(`${what}: the swap names no minimum`, "price_check_failed");
    if (d.srcReceivers.length !== d.srcAmounts.length) refuse(`${what}: malformed KyberSwap receivers`, "policy_refused");
    // The router writes nothing itself; whoever patches the running amount in must hit `desc.amount` exactly.
    const flipped = encodeFunctionData({abi: KYBER_ABI, functionName: "swap", args: [{...x, desc: {...d, amount: d.amount ^ ((1n << 256n) - 1n)}}] as never});
    return {router: "kyberswap-v2", srcToken: d.srcToken, dstToken: d.dstToken, dstReceiver: d.dstReceiver, amount: d.amount, minReturnAmount: d.minReturnAmount, amountOffset: patchedWordEnd(lower(data), lower(flipped), what)};
  }
  const v2 = SYMBIOSIS_V2_ROUTERS[chain.id];
  if (v2 && same(target, v2)) {
    const selector = lower(String(data).slice(0, 10));
    if (selector === SEL_V2_FROM_ETH) {
      const [least, route, payTo] = decode(V2_ABI, data, selector, "swapExactETHForTokens", what) as [bigint, readonly string[], string, bigint];
      if (route.length < 2 || route.length > MAX_V2_PATH) refuse(`${what}: unexpected swap path`, "policy_refused");
      if (least <= 0n) refuse(`${what}: the swap names no minimum`, "price_check_failed");
      return {router: "uniswap-v2", srcToken: AGGREGATOR_NATIVE, dstToken: route[route.length - 1]!, dstReceiver: payTo, amount: null, minReturnAmount: least, amountOffset: null};
    }
    if (selector !== SEL_V2_TOKENS && selector !== SEL_V2_ETH) refuse(`${what}: unexpected V2 router function ${selector}`, "policy_refused");
    const toNative = selector === SEL_V2_ETH;
    const [amount, min, path, to] = decode(V2_ABI, data, selector, toNative ? "swapExactTokensForETH" : "swapExactTokensForTokens", what) as [bigint, bigint, readonly string[], string, bigint];
    if (path.length < 2 || path.length > MAX_V2_PATH) refuse(`${what}: unexpected swap path`, "policy_refused");
    if (min <= 0n) refuse(`${what}: the swap names no minimum`, "price_check_failed");
    return {router: "uniswap-v2", srcToken: path[0]!, dstToken: toNative ? AGGREGATOR_NATIVE : path[path.length - 1]!, dstReceiver: to, amount, minReturnAmount: min, amountOffset: FIRST_WORD_END};
  }
  return refuse(`${what}: ${target} is not an allow-listed swap router`, "vault_mismatch");
}

const scale18 = (amount: bigint, decimals: number): bigint => amount * 10n ** BigInt(18 - decimals);

/**
 * The host-chain pool route: `MulticallRouter.multicall` whose every step is a `swap` on a pinned
 * Symbiosis pool between the pool's pinned tokens. Returns the minimum the last pool must pay out.
 */
function checkPools(s: Pick<MetaSynthesize, "amount" | "swapTokens" | "secondDexRouter" | "secondSwapCalldata">): bigint {
  if (!same(s.secondDexRouter, SYMBIOSIS_HOST.multicallRouter)) refuse(`the host-chain swap calls ${s.secondDexRouter}, not the pinned MulticallRouter`, "vault_mismatch");
  const [amountIn, calls, receiveSides, path, offsets, to] =
    decode(ABI, s.secondSwapCalldata, SEL_MULTICALL, "multicall") as [bigint, readonly string[], readonly string[], readonly string[], readonly bigint[], string];
  const n = calls.length;
  if (n < 1 || n > MAX_POOL_STEPS || receiveSides.length !== n || offsets.length !== n || path.length !== n + 1) refuse("the host-chain swap has a malformed step list", "policy_refused");
  if (amountIn !== s.amount) refuse("the host-chain swap is sized for another amount than the bridge request", "policy_refused");
  if (!same(to, SYMBIOSIS_HOST_META_ROUTER)) refuse(`the host-chain swap pays ${to}, not the pinned host-chain MetaRouter`, "vault_mismatch");
  if (s.swapTokens.length !== 2 || !same(path[0]!, s.swapTokens[0]) || !same(path[n]!, s.swapTokens[1])) refuse("the host-chain swap path is not the bridge request's token pair", "policy_refused");
  let minDy = 0n;
  for (let i = 0; i < n; i++) {
    const pool = SYMBIOSIS_POOLS[lower(receiveSides[i]!)];
    if (!pool) refuse(`host-chain swap step ${i + 1} calls ${receiveSides[i]}, not a pinned Symbiosis pool`, "vault_mismatch");
    const [from, into, , min, payTo] = decode(POOL_ABI, calls[i]!, SEL_POOL_SWAP, "swap", `host-chain swap step ${i + 1}`) as [bigint, bigint, bigint, bigint, string, bigint];
    if (offsets[i] !== POOL_OFFSET) refuse(`host-chain swap step ${i + 1} writes the running amount at ${offsets[i]}, not into the swap amount`, "policy_refused");
    if (from >= BigInt(pool!.length) || into >= BigInt(pool!.length) || from === into) refuse(`host-chain swap step ${i + 1} names a token index the pool does not have`, "policy_refused");
    const a = pool![bigintToNumber(from)];
    const b = pool![bigintToNumber(into)];
    if (!a || !b || !same(a, path[i]) || !same(b, path[i + 1])) refuse(`host-chain swap step ${i + 1} does not trade the path's tokens`, "policy_refused");
    if (!same(payTo, SYMBIOSIS_HOST.multicallRouter)) refuse(`host-chain swap step ${i + 1} pays ${payTo}, not the MulticallRouter`, "vault_mismatch");
    if (min <= 0n) refuse(`host-chain swap step ${i + 1} names no minimum`, "price_check_failed");
    minDy = min;
  }
  // Like-asset pools: the amount the request states must be in line with the minimum it promises.
  const first = SYMBIOSIS_SYNTHS[lower(path[0]!)];
  const last = SYMBIOSIS_SYNTHS[lower(path[n]!)];
  if (!first || !last) return refuse("the host-chain swap moves a token that is not a pinned synthetic token", "policy_refused");
  if (scale18(s.amount, first.decimals) * 10_000n < scale18(minDy, last.decimals) * CONSISTENCY_BPS) refuse("the bridge request states an amount far below the minimum its pool swap demands", "price_check_failed");
  return minDy;
}

/**
 * The last call of a route — the burn on the host chain that names what leaves, where to, and what
 * happens on the destination. `burned` is the token the pools pay out, `poolMin` the least of it.
 */
function checkFinalCall(r: SymbiosisRequest, data: string, own: readonly string[], burned: string, poolMin: bigint, minOut: bigint): {destSwap: SymbiosisDestCall | null; serviceReverts: boolean} {
  const selector = lower(String(data).slice(0, 10));
  const revert = (a: string): boolean => {
    if (own.includes(lower(a))) return false;
    if (same(a, SYMBIOSIS_REVERTER)) return true;
    return refuse(`the burn names ${a} as the address that may revert it — neither the user nor Symbiosis' revert service`, "recipient_mismatch");
  };
  const synth = SYMBIOSIS_SYNTHS[lower(burned)];
  if (!synth || synth.chain !== r.dest.id) return refuse(`the route burns ${burned}, which is not a pinned synthetic of a ${r.dest.name} token`, "policy_refused");
  /** Nothing follows on the destination: the released token is the output, the pools' minimum less the relayers' fee is the least of it. */
  const direct = (fee: bigint): void => {
    if (r.destToken === null || !same(synth.real, r.destToken)) refuse("the route releases another token than the one quoted", "price_check_failed");
    if (poolMin - fee < minOut) refuse(`the route guarantees ${poolMin - fee}, below the quoted minimum ${minOut}`, "price_check_failed");
  };
  if (r.dest.family === "ton") {
    if (selector !== SEL_BURN_TON) refuse(`a TON destination must end in burnSyntheticTokenTON, got ${selector}`, "policy_refused");
    const [fee, stoken, , , to, receiveSide, oppositeBridge, revertable, chainID] =
      decode(ABI, data, SEL_BURN_TON, "burnSyntheticTokenTON") as [bigint, string, bigint, string, {workchain: number; address_hash: string}, string, string, string, bigint];
    if (!same(stoken, burned)) refuse("the burn names another token than the one the pools pay out", "policy_refused");
    if (chainID !== BigInt(SYMBIOSIS_TON_CHAIN_ID)) refuse(`the burn names chain ${chainID}, not TON`, "recipient_mismatch");
    const want = tonRawAddress(r.recipient);
    if (!want || `${to.workchain}:${lower(to.address_hash).slice(2)}` !== want) refuse("the burn pays a TON address that is not the recipient", "recipient_mismatch");
    if (!same(receiveSide, ZERO) || !same(oppositeBridge, ZERO)) refuse("the TON burn names an unexpected receive side or bridge", "vault_mismatch");
    direct(fee);
    return {destSwap: null, serviceReverts: revert(revertable)};
  }
  if (r.dest.family !== "evm" && r.dest.family !== "tron") refuse(`${r.dest.name} is not a destination`, "unsupported_pair");
  const recipient = account20(r.dest, r.recipient);
  if (!recipient || !r.dest.portal || !r.dest.bridge) return refuse(`no pinned deployment on ${r.dest.name}`, "unsupported_pair");
  // Plain `burnSyntheticToken` is not accepted: the MetaRouter writes the cross-chain id over a word
  // that is the receiver in that function.
  if (selector !== SEL_META_BURN) refuse(`the route does not end in metaBurnSyntheticToken (${selector})`, "policy_refused");
  const [b] = decode(ABI, data, SEL_META_BURN, "metaBurnSyntheticToken") as [MetaBurn];
  if (!same(b.sToken, burned)) refuse("the burn names another token than the one the pools pay out", "policy_refused");
  if (b.chainID !== BigInt(r.dest.id)) refuse(`the burn names chain ${b.chainID}, not ${r.dest.name}`, "recipient_mismatch");
  if (!same(b.chain2address, recipient)) refuse(`the burn pays ${b.chain2address}, not the recipient`, "recipient_mismatch");
  if (!same(b.receiveSide, r.dest.portal)) refuse(`the burn releases through ${b.receiveSide}, not the pinned ${r.dest.name} Portal`, "vault_mismatch");
  if (!same(b.oppositeBridge, r.dest.bridge)) refuse(`the burn names bridge ${b.oppositeBridge}, not the pinned ${r.dest.name} Bridge`, "vault_mismatch");
  if (!own.includes(lower(b.syntCaller))) refuse(`the burn is made on behalf of ${b.syntCaller}, not the user`, "recipient_mismatch");
  const serviceReverts = revert(b.revertableAddress);
  if (b.finalCallData === "0x") {
    if (!same(b.finalReceiveSide, ZERO) || b.finalOffset !== 0n) refuse("the burn names a destination call target without a call", "policy_refused");
    direct(b.stableBridgingFee);
    return {destSwap: null, serviceReverts};
  }
  // A call on the destination gets the released token approved in full: only Symbiosis' own Unwrapper
  // paying the recipient, or a decoded swap on an allow-listed router.
  const unwrapper = SYMBIOSIS_UNWRAPPERS[r.dest.id];
  if (unwrapper && same(b.finalReceiveSide, unwrapper.unwrapper)) {
    const [, to] = decode(UNWRAP_ABI, b.finalCallData, SEL_UNWRAP, "unwrap", "destination unwrap") as [bigint, string];
    if (r.destToken !== null) refuse("the route unwraps to the native coin, which is not the token quoted", "price_check_failed");
    if (!same(synth.real, unwrapper.wrapped)) refuse("the route unwraps a token that is not the chain's wrapped native token", "policy_refused");
    if (!same(to, recipient)) refuse(`the unwrap pays ${to}, not the recipient`, "recipient_mismatch");
    if (b.finalOffset !== FIRST_WORD_END) refuse(`the unwrap gets the released amount written at ${b.finalOffset}, not into its amount`, "policy_refused");
    if (poolMin - b.stableBridgingFee < minOut) refuse(`the route guarantees ${poolMin - b.stableBridgingFee}, below the quoted minimum ${minOut}`, "price_check_failed");
    return {destSwap: "unwrap", serviceReverts};
  }
  const swap = decodeAggregatorSwap(r.dest, b.finalReceiveSide, b.finalCallData, "destination swap");
  if (!same(swap.srcToken, synth.real)) refuse("the destination swap sells another token than the one released", "policy_refused");
  if (!same(swap.dstToken, r.destToken ?? AGGREGATOR_NATIVE)) refuse("the destination swap buys another token than the one quoted", "price_check_failed");
  if (!same(swap.dstReceiver, recipient)) refuse(`the destination swap pays ${swap.dstReceiver}, not the recipient`, "recipient_mismatch");
  if (swap.minReturnAmount < minOut) refuse(`the destination swap guarantees ${swap.minReturnAmount}, below the quoted minimum ${minOut}`, "price_check_failed");
  if (swap.amountOffset === null || b.finalOffset !== swap.amountOffset) refuse(`the destination swap gets the released amount written at ${b.finalOffset}, not into its amount`, "policy_refused");
  return {destSwap: swap.router, serviceReverts};
}

/**
 * The bridge request (`metaSynthesize` fields) against the request — shared by the EVM / Tron
 * calldata and the TON cell. `rtoken` is the bridged token as the source chain's contracts name it.
 */
function checkSynthesize(r: SymbiosisRequest, s: Omit<MetaSynthesize, "syntCaller" | "clientID">, own: readonly string[], minOut: bigint): {destSwap: SymbiosisDestCall | null; serviceReverts: boolean} {
  if (s.chainID !== BigInt(SYMBIOSIS_HOST_CHAIN_ID)) refuse(`the bridge request targets chain ${s.chainID}, not Symbiosis' host chain`, "vault_mismatch");
  if (!same(s.receiveSide, SYMBIOSIS_HOST.synthesis) || !same(s.finalReceiveSide, SYMBIOSIS_HOST.synthesis)) refuse("the bridge request does not name the pinned host-chain Synthesis", "vault_mismatch");
  if (!same(s.oppositeBridge, SYMBIOSIS_HOST.bridge)) refuse("the bridge request does not name the pinned host-chain Bridge", "vault_mismatch");
  if (!own.includes(lower(s.chain2address))) refuse(`the bridge request credits ${s.chain2address} on the host chain, not one of the user's addresses`, "recipient_mismatch");
  let serviceReverts = false;
  if (!own.includes(lower(s.revertableAddress))) {
    if (!same(s.revertableAddress, SYMBIOSIS_REVERTER)) refuse(`the bridge request lets ${s.revertableAddress} revert it — neither the user nor Symbiosis' revert service`, "recipient_mismatch");
    serviceReverts = true;
  }
  if (s.amount <= s.stableBridgingFee) refuse("the bridge request's fee takes the whole amount", "amount_too_small");
  const minted = s.swapTokens.length > 0 ? SYMBIOSIS_SYNTHS[lower(s.swapTokens[0]!)] : undefined;
  if (!minted || minted.chain !== r.source.id || !same(minted.real, s.rtoken)) refuse("the bridge request does not start from the pinned synthetic of the bridged token", "policy_refused");
  // Two different chains never share a synthetic token, so a route without a pool swap cannot reach the destination.
  if (s.secondSwapCalldata === "0x") refuse("the bridge request carries no host-chain pool swap", "policy_refused");
  const poolMin = checkPools(s);
  if (s.finalOffset !== FINAL_OFFSET) refuse(`unexpected amount offset ${s.finalOffset} in the final call`, "policy_refused");
  const final = checkFinalCall(r, s.finalCalldata, own, s.swapTokens[1]!, poolMin, minOut);
  return {destSwap: final.destSwap, serviceReverts: serviceReverts || final.serviceReverts};
}

/**
 * An EVM or Tron source call against the request. `to` in the chain's own spelling (EVM hex / Tron
 * base58), `data` = selector ‖ ABI parameters, `value` in the smallest unit; `minOut` is the least
 * of the buy token the quote promises. Throws with the reason.
 */
export function checkSymbiosisCall(r: SymbiosisRequest, call: {to: string; data: string; value: string}, minOut: bigint): SymbiosisBound {
  if (r.source.family !== "evm" && r.source.family !== "tron") refuse(`${r.source.name} sources are not contract calls`, "unsupported_pair");
  if (minOut <= 0n) refuse("the quote names no minimum", "price_check_failed");
  const gateway = r.source.gateway;
  const sender = account20(r.source, r.sender);
  if (!gateway || !r.source.portal || !r.source.executor || !sender) return refuse(`no pinned deployment on ${r.source.name}`, "unsupported_pair");
  const to = r.source.family === "tron" ? tronToEvm(call.to) : typeof call.to === "string" && isAddress(call.to, {strict: false}) ? call.to : null;
  if (!to || !same(to, gateway)) refuse(`the transaction calls ${call.to}, not the pinned ${r.source.name} MetaRouterGateway`, "vault_mismatch");
  if (typeof call.value !== "string" || !/^\d+$/.test(call.value)) refuse("the transaction value is not a number", "policy_refused");
  const native = r.sellToken === null;
  const sell = native ? ZERO : account20(r.source, r.sellToken!);
  if (!sell) return refuse("the sell token is not a contract address", "unsupported_pair");
  if (BigInt(call.value) !== (native ? r.amountIn : 0n)) refuse(`the transaction attaches ${call.value}, expected ${native ? r.amountIn : 0n}`, "policy_refused");

  const [t] = decode(ABI, call.data, SYMBIOSIS_META_ROUTE_SELECTOR, "metaRoute") as [MetaRoute];
  if (t.amount !== r.amountIn) refuse(`the call sells ${t.amount}, not ${r.amountIn}`, "policy_refused");
  if (t.nativeIn !== native) refuse("the call's native flag does not match the sell token", "policy_refused");
  if (t.approvedTokens.length < 1 || t.approvedTokens.length > 2) refuse("unexpected token list", "policy_refused");
  if (!same(t.approvedTokens[0]!, sell)) refuse(`the call sells token ${t.approvedTokens[0]}, not the requested one`, "policy_refused");
  // The MetaRouter skips the second swap when its calldata is empty; the router named beside it is then never called.
  if (t.secondSwapCalldata !== "0x") refuse("the call carries a second source-chain swap", "policy_refused");
  if (!same(t.relayRecipient, r.source.portal)) refuse(`the call hands the funds to ${t.relayRecipient}, not the pinned ${r.source.name} Portal`, "vault_mismatch");

  const [s] = decode(ABI, t.otherSideCalldata, SEL_META_SYNTHESIZE, "metaSynthesize") as [MetaSynthesize];
  const bridged = t.approvedTokens[t.approvedTokens.length - 1]!;
  if (!same(s.rtoken, bridged)) refuse("the bridged token is not the last approved token", "policy_refused");
  if (same(s.rtoken, ZERO)) refuse("the bridged token is the zero address", "policy_refused");
  if (!same(s.syntCaller, sender)) refuse(`the bridge request is made on behalf of ${s.syntCaller}, not the sender`, "recipient_mismatch");

  // What happens before the bridge: nothing, the wrap of the native coin by the bridged token's own
  // contract, or one decoded swap on an allow-listed aggregator router. Nothing else.
  let sourceSwap: SymbiosisAggregator | null = null;
  if (t.firstSwapCalldata === "0x") {
    if (native) refuse("a native sale without a wrap step", "policy_refused");
    if (!same(t.firstDexRouter, ZERO)) refuse("a source swap target without a call", "policy_refused");
    // The API names the sell token twice when nothing is swapped.
    if (!same(s.rtoken, sell)) refuse("no source swap, yet the bridged token is not the sell token", "policy_refused");
    if (s.amount !== r.amountIn) refuse(`the bridge request moves ${s.amount}, not ${r.amountIn}`, "policy_refused");
  } else if (native && lower(t.firstSwapCalldata) === SEL_WRAP) {
    if (!same(t.firstDexRouter, s.rtoken)) refuse("the wrap step does not call the bridged token", "vault_mismatch");
    if (s.amount !== r.amountIn) refuse(`the bridge request moves ${s.amount}, not ${r.amountIn}`, "policy_refused");
  } else {
    if (t.approvedTokens.length !== 2) refuse("a source swap without the token it buys", "policy_refused");
    const swap = decodeAggregatorSwap(r.source, t.firstDexRouter, t.firstSwapCalldata, "source swap");
    if (!same(swap.srcToken, native ? AGGREGATOR_NATIVE : sell)) refuse("the source swap sells another token than the one requested", "policy_refused");
    // A native sale on a V2 router has no amount argument: it sells the value sent, which is the sell amount (checked above).
    if (swap.amount !== null && swap.amount !== r.amountIn) refuse(`the source swap sells ${swap.amount}, not ${r.amountIn}`, "policy_refused");
    if (!same(swap.dstToken, s.rtoken) || same(s.rtoken, sell)) refuse("the source swap does not buy the bridged token", "policy_refused");
    if (!same(swap.dstReceiver, r.source.executor)) refuse(`the source swap pays ${swap.dstReceiver}, not the pinned ${r.source.name} MetaRouter`, "vault_mismatch");
    if (swap.minReturnAmount * 10_000n < s.amount * CONSISTENCY_BPS) refuse("the source swap's minimum is far below the amount the bridge request states", "price_check_failed");
    sourceSwap = swap.router;
  }
  const rest = checkSynthesize(r, s, ownSet(r), minOut);
  return {sourceSwap, ...rest};
}

const hexAddress = (s: Slice): string => `0x${s.hex(20)}`;

/**
 * A TON source message against the request: ONE jetton transfer of the sell amount to the pinned
 * TON Portal, whose forward payload is the bridge request. `to` (the sender's own jetton wallet) is
 * not checked here — the engine compares it with the wallet the account derives for the jetton.
 * Throws with the reason.
 */
export function checkSymbiosisTonMessage(r: SymbiosisRequest, msg: {to: string; value: string; bodyBoc: string}, minOut: bigint): SymbiosisBound {
  if (r.source.family !== "ton") refuse("not a TON source", "unsupported_pair");
  if (minOut <= 0n) refuse("the quote names no minimum", "price_check_failed");
  if (r.sellToken === null) refuse("native TON sources are not served", "unsupported_pair");
  const master = tonRawAddress(r.sellToken!);
  const sender = tonRawAddress(r.sender);
  const rtoken = symbiosisToken(r.source, r.sellToken)?.address;
  if (!master || !sender || !rtoken) return refuse("malformed TON address in the request", "unsupported_pair");
  if (!tonRawAddress(msg.to)) refuse("the message is not addressed to a TON account", "policy_refused");
  if (typeof msg.value !== "string" || !/^\d+$/.test(msg.value)) refuse("the attached value is not a number", "policy_refused");
  const value = BigInt(msg.value);
  if (value <= 0n || value > SYMBIOSIS_TON_VALUE_CEILING) refuse(`the message attaches ${value} nanotons, above the ${SYMBIOSIS_TON_VALUE_CEILING} ceiling`, "policy_refused");
  const own = ownSet(r);
  let root: TonCell;
  try { root = parseBoc(msg.bodyBoc); } catch (e) { return refuse(`the message body does not parse: ${(e as Error).message}`, "policy_refused"); }
  try {
    const body = new Slice(root);
    if (body.uint(32) !== OP_JETTON_TRANSFER) refuse("the message is not a jetton transfer", "policy_refused");
    body.uint(64); // query id
    const amount = body.coins();
    if (amount !== r.amountIn) refuse(`the transfer moves ${amount}, not ${r.amountIn}`, "policy_refused");
    if (body.address() !== SYMBIOSIS_TON_PORTAL_RAW) refuse("the transfer does not go to the pinned TON Portal", "vault_mismatch");
    if (body.address() !== sender) refuse("the transfer's excess does not return to the sender", "recipient_mismatch");
    if (body.bool()) refuse("the transfer carries a custom payload", "policy_refused");
    const forwardTon = body.coins();
    if (forwardTon >= value) refuse("the transfer forwards more TON than the message attaches", "policy_refused");
    if (!body.bool()) refuse("the bridge request is not carried in a reference", "policy_refused");
    const request = new Slice(body.nextRef());
    body.end();

    if (request.uint(32) !== OP_TON_META_SYNTHESIZE) refuse("the forward payload is not a Symbiosis bridge request", "policy_refused");
    const head = new Slice(request.nextRef());
    const sides = new Slice(request.nextRef());
    const tail = new Slice(request.nextRef());
    request.end();

    const stableBridgingFee = head.coins(); // the relayers' fee — not bound beyond "less than the amount"
    if (head.address() !== master) refuse("the bridge request names a jetton that is not the sell token", "policy_refused");
    if (head.coins() !== r.amountIn) refuse("the bridge request moves an amount that is not the sell amount", "policy_refused");
    const chain2address = hexAddress(head);
    head.end();

    const receiveSide = hexAddress(sides);
    const oppositeBridge = hexAddress(sides);
    const chainID = sides.uint(256);
    const finalReceiveSide = hexAddress(sides);
    sides.end();

    const finalOffset = tail.uint(256);
    const revertableAddress = hexAddress(tail);
    const finalLength = tail.uint(64);
    const secondDexRouter = hexAddress(tail);
    const secondLength = tail.uint(64);
    const swapTokens = tail.nextRef();
    const finalCell = tail.nextRef();
    const secondCell = tail.nextRef();
    tail.end();
    if (swapTokens.bits % 160 !== 0 || swapTokens.bits > 320 || swapTokens.refs.length !== 0) refuse("malformed swap token list", "policy_refused");
    const tokens = new Slice(swapTokens);
    const swapList: string[] = [];
    for (let i = 0; i < swapTokens.bits / 160; i++) swapList.push(hexAddress(tokens));
    if (finalLength > 16_384n || secondLength > 65_536n) refuse("oversized calldata in the bridge request", "policy_refused");
    const finalCalldata = `0x${snakeHex(finalCell, bigintToNumber(finalLength))}`;
    const secondSwapCalldata = `0x${snakeHex(secondCell, bigintToNumber(secondLength))}`;

    const rest = checkSynthesize(r, {
      stableBridgingFee, amount: r.amountIn, rtoken, swapTokens: swapList, chain2address, receiveSide, oppositeBridge, chainID, finalReceiveSide, finalOffset, revertableAddress,
      secondDexRouter, secondSwapCalldata, finalCalldata,
    }, own, minOut);
    return {sourceSwap: null, ...rest};
  } catch (e) {
    if (e instanceof Refusal) throw e;
    return refuse(`the message body is not a Symbiosis bridge request: ${(e as Error).message}`, "policy_refused");
  }
}

/** The least of the buy token a quote promises — what the route's own minimums are held to. */
function quotedMinimum(quote: Quote): bigint {
  const m = quote.minDestAmount;
  if (typeof m !== "string" || !/^\d+$/.test(m) || BigInt(m) <= 0n) return refuse("the quote names no minimum", "price_check_failed");
  return BigInt(m);
}

const reason = (e: unknown): string => `symbiosis: ${e instanceof Error ? e.message : String(e)}`;

/** The check a route's bytes get, by source family; the reason it fails, or what it could not bind. */
function checkRoute(r: SymbiosisRequest, tx: {to?: string; data?: string; value?: string; bodyBoc?: string; approvalAddress?: string; chainId?: number}, minOut: bigint): SymbiosisBound {
  if (r.source.family === "ton") {
    if (tx.data !== undefined || tx.approvalAddress !== undefined) refuse("a TON source carries no calldata or approval", "policy_refused");
    if (tx.bodyBoc === undefined) refuse("a TON source needs a message body", "policy_refused");
    return checkSymbiosisTonMessage(r, {to: tx.to ?? "", value: tx.value ?? "0", bodyBoc: tx.bodyBoc!}, minOut);
  }
  if (r.source.family !== "evm" && r.source.family !== "tron") refuse(`${r.source.name} sources carry nothing this module can check`, "recipient_unverifiable");
  if (tx.bodyBoc !== undefined) refuse("unexpected message body", "policy_refused");
  if (tx.chainId !== r.source.id) refuse(`the transaction is for chain ${String(tx.chainId)}, not ${r.source.name}`, "policy_refused");
  const gateway = gatewayAddress(r.source)!;
  if (r.sellToken === null) {
    if (tx.approvalAddress !== undefined) refuse("a native sale asks for an approval", "policy_refused");
  } else if (tx.approvalAddress === undefined || lower(tx.approvalAddress) !== lower(gateway)) {
    // Tron base58 is case-sensitive; the gateway spelling is produced locally, so equality after lowercasing is exact enough for both.
    refuse(`the approval names ${String(tx.approvalAddress)}, not the pinned ${r.source.name} MetaRouterGateway`, "vault_mismatch");
  }
  if (r.source.family === "tron" && tx.approvalAddress !== undefined && tx.approvalAddress !== gateway) refuse("the approval does not name the pinned Tron MetaRouterGateway", "vault_mismatch");
  return checkSymbiosisCall(r, {to: tx.to ?? "", data: tx.data ?? "", value: tx.value ?? "0"}, minOut);
}

/** The TON message a quote carries (`providerData`), as a build. */
export function symbiosisTonMessage(quote: Quote): {to: string; value: string; bodyBoc: string} | null {
  const d = quote.providerData ?? {};
  return typeof d.tonTo === "string" && typeof d.tonValue === "string" && typeof d.tonBody === "string" ? {to: d.tonTo, value: d.tonValue, bodyBoc: d.tonBody} : null;
}

/**
 * What a quote's transaction is, read against the user's own request and the quote's own minimum:
 * what the route rests on beyond the checks (`bound`; null for a Bitcoin source, where nothing can
 * be checked), or the reason the quote is refused.
 */
export function symbiosisInspectQuote(params: QuoteParams, quote: Quote, options: SymbiosisVerifyOptions = {}): {bound: SymbiosisBound | null} | {refusal: string} {
  try {
    const r = symbiosisRequest(params, options);
    if (typeof r === "string") return {refusal: noted(`symbiosis: ${r}`, notes.reasonOf(r))};
    if (quote.sourceAmount !== params.amountIn) return {refusal: noted("symbiosis: the quote is for a different amount", "policy_refused")};
    if (r.source.family === "bitcoin") {
      // A deposit address the backend names: nothing on the device says whose it is.
      return quote.txRequest === undefined && quote.depositAddress !== "" && symbiosisTonMessage(quote) === null
        ? {bound: null}
        : {refusal: noted("symbiosis: a Bitcoin source is a deposit-address route", "policy_refused")};
    }
    if (r.source.family === "ton") {
      const msg = symbiosisTonMessage(quote);
      if (!msg || quote.txRequest !== undefined || quote.depositAddress !== "") return {refusal: noted("symbiosis: a TON source carries one jetton transfer", "policy_refused")};
      return {bound: checkRoute(r, msg, quotedMinimum(quote))};
    }
    const tx = quote.txRequest;
    if (!tx || quote.depositAddress !== "") return {refusal: noted("symbiosis: the quote carries no transaction", "policy_refused")};
    if (tx.serializedTx !== undefined) return {refusal: noted("symbiosis: unexpected serialized transaction", "policy_refused")};
    return {bound: checkRoute(r, tx, quotedMinimum(quote))};
  } catch (e) {
    return {refusal: noted(reason(e), refusalOf(e))};
  }
}

/**
 * A quote's transaction against the user's own request — the reason it fails, or null. The same
 * check the local provider runs before it returns a quote; an app that gets Symbiosis quotes from a
 * backend runs it through `symbiosisPins` (`remoteProvider`).
 */
export function symbiosisVerifyQuote(params: QuoteParams, quote: Quote, options: SymbiosisVerifyOptions = {}): string | null {
  const r = symbiosisInspectQuote(params, quote, options);
  return "refusal" in r ? r.refusal : null;
}

/** A built source transaction against the user's own request — the reason it fails, or null. */
export function symbiosisVerifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams, options: SymbiosisVerifyOptions = {}): string | null {
  try {
    if (!params) return noted("symbiosis: the build cannot be checked without the request", "policy_refused");
    const r = symbiosisRequest(params, options);
    if (typeof r === "string") return noted(`symbiosis: ${r}`, notes.reasonOf(r));
    if (symbiosisChain(tx.chain) !== r.source) return noted("symbiosis: the build is for another chain", "policy_refused");
    if (tx.serializedTx !== undefined || tx.stateInitBoc !== undefined || tx.typedData !== undefined || tx.memo != null) return noted("symbiosis: the build carries a part this route never has", "policy_refused");
    if (r.source.family === "bitcoin") {
      return tx.data === undefined && tx.bodyBoc === undefined && tx.to === quote.depositAddress && tx.to !== "" ? null : noted("symbiosis: a Bitcoin source pays the quote's deposit address", "vault_mismatch");
    }
    checkRoute(r, tx, quotedMinimum(quote));
    return null;
  } catch (e) {
    return noted(reason(e), refusalOf(e));
  }
}

/**
 * The pins an app hands `remoteProvider` for a backend-run Symbiosis: the gateway is the only call
 * target and the only spender on every EVM chain, and every quote and build is checked on the device
 * against the request. `fallbackReceiver` is needed only for Tron ↔ TON; `btcSource` opens the
 * deposit-address route a Bitcoin source is (nothing on the device can verify that address).
 */
export function symbiosisPinsFor(options: SymbiosisVerifyOptions & {btcSource?: boolean} = {}): RemotePins {
  const targets = (chain: string): readonly string[] => {
    const c = SYMBIOSIS_CHAINS[chain];
    return c?.family === "evm" && c.gateway ? [getAddress(c.gateway)] : [];
  };
  return {
    callTargets: targets,
    spenders: targets,
    verifyQuote: (params, quote) => symbiosisVerifyQuote(params, quote, options),
    verifyBuild: (quote, tx, params) => symbiosisVerifyBuild(quote, tx, params, options),
    // The reason of each text verifyQuote / verifyBuild returned (remoteProvider puts it on its refusal).
    reasonOf: notes.reasonOf,
    ...(options.btcSource ? {depositAddressRoutes: true} : {}),
  };
}

export const symbiosisPins: RemotePins = symbiosisPinsFor();
