/**
 * The deposit, built on the device.
 *
 * A quote source (the Across API V5 adapter, still to come) only supplies NUMBERS: how much the deposit asks relayers
 * to pay, the quote time, the fill deadline and the exclusivity terms. Everything that decides where the money goes —
 * the SpokePool, the depositor, the recipient, the tokens, the destination chain, the message — comes from the user's
 * request and the pins in `config.ts`. {@link buildAcrossDeposit} encodes the call from those and runs
 * {@link verifyAcrossDeposit} on its own result before handing it out, so a deposit leaves this file only in the shape
 * the verifier signs.
 */
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {ACROSS_NATIVE} from "./config.js";
import {encodeAcrossDeposit} from "./deposit.js";
import {AcrossRefusal} from "./refusal.js";
import {ACROSS_MAX_QUOTE_LIFE_MS, acrossIntentId, checkAcrossRequest, verifyAcrossDeposit, type AcrossRequest, type VerifiedAcrossDeposit} from "./verify.js";

/**
 * What a quote source must say about one Across transfer, normalized from whatever it answers. Integers that can
 * exceed 2^53 are canonical decimal strings (no sign, no leading zeros); times are unix seconds. Tokens are named as
 * in the request — the ERC-20 contract, or the zero address for the native coin — never as the deposit names them.
 */
export interface NormalizedAcrossQuote {
  /** EVM chain id the deposit is sent on. */
  sourceChainId: number;
  /** EVM chain id the output is paid on. */
  destinationChainId: number;
  /** Input token: ERC-20 contract, or the zero address for the native coin. */
  inputToken: string;
  /** Output token: ERC-20 contract, or the zero address for the native coin. */
  outputToken: string;
  /** Exact input, base units (decimal string). */
  inputAmount: string;
  /**
   * What the deposit asks relayers to pay the recipient, base units (decimal string). A relayer pays exactly this, so
   * it is both the expected and the guaranteed output of the transfer.
   */
  outputAmount: string;
  /** The quote source's own estimate of what arrives, when it gives one (display only, never above what is signed for). */
  expectedOutputAmount?: string;
  /** The deposit's `quoteTimestamp` (unix seconds). The SpokePool accepts it for 3600 s. */
  quoteTimestamp: number;
  /** The deposit's `fillDeadline` (unix seconds, destination chain). Unfilled by then, the deposit is refunded. */
  fillDeadline: number;
  /** The relayer that alone may fill until the exclusivity ends; the zero address for none. */
  exclusiveRelayer: string;
  /** 0 (no exclusivity), an offset in seconds up to one year from the deposit's block, or a unix timestamp above that. */
  exclusivityParameter: number;
  /** Expected time from deposit to fill, seconds (display only). */
  expectedFillTimeSec: number;
  /** When the quote source stops standing by the numbers (unix ms), when it says. */
  expiresAtMs?: number;
  /** The quote source's breakdown of input − output (display only; must add up to it when given). */
  fees?: AcrossFeeBreakdown;
  /** The quote source's own id for the transfer (Across API V5 `orderId`), kept for its status endpoint. */
  orderId?: string;
}

/** Fees of one transfer, in base units of the input token. */
export interface AcrossFeeBreakdown {
  /** input − output. */
  total: string;
  /** Relayer capital fee, when itemized. */
  relayerCapital?: string;
  /** Destination gas the relayer is paid for, when itemized (in input-token units). */
  destinationGas?: string;
  /** LP fee, when itemized. */
  lp?: string;
  /** The total in USD, when the quote source prices it (display only). */
  totalUsd?: number;
}

const UINT = /^(?:0|[1-9]\d{0,77})$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const U32_MAX = 0xffff_ffff;

function checkNormalized(request: AcrossRequest, q: NormalizedAcrossQuote, sourceChainId: number, destChainId: number): void {
  const bad = (what: string): never => { throw new AcrossRefusal("quote-normalized", `the quote ${what}`, "upstream_unavailable"); };
  if (q === null || typeof q !== "object") bad("is missing");
  if (q.sourceChainId !== sourceChainId || q.destinationChainId !== destChainId) {
    throw new AcrossRefusal("quote-normalized", `the quote is for ${String(q.sourceChainId)} → ${String(q.destinationChainId)}, the request for ${sourceChainId} → ${destChainId}`, "policy_refused");
  }
  for (const [k, v] of [["input token", q.inputToken], ["output token", q.outputToken], ["exclusive relayer", q.exclusiveRelayer]] as const) {
    if (typeof v !== "string" || !ADDRESS.test(v)) bad(`names a ${k} that is not an address`);
  }
  if (q.inputToken.toLowerCase() !== request.sourceToken.toLowerCase() || q.outputToken.toLowerCase() !== request.destToken.toLowerCase()) {
    throw new AcrossRefusal("quote-normalized", "the quote is for other tokens than the request", "policy_refused");
  }
  for (const [k, v] of [["input amount", q.inputAmount], ["output amount", q.outputAmount]] as const) {
    if (typeof v !== "string" || !UINT.test(v)) bad(`states an ${k} that is not a base-unit integer`);
  }
  if (BigInt(q.inputAmount) !== request.amount) throw new AcrossRefusal("quote-normalized", `the quote sends ${q.inputAmount}, the request ${request.amount}`, "policy_refused");
  if (q.expectedOutputAmount !== undefined && (typeof q.expectedOutputAmount !== "string" || !UINT.test(q.expectedOutputAmount))) bad("states an expected output that is not a base-unit integer");
  for (const [k, v] of [["quote time", q.quoteTimestamp], ["fill deadline", q.fillDeadline], ["exclusivity", q.exclusivityParameter]] as const) {
    if (!Number.isInteger(v) || v < 0 || v > U32_MAX) bad(`states a ${k} that is not a uint32`);
  }
  if (!Number.isFinite(q.expectedFillTimeSec) || q.expectedFillTimeSec < 0) bad("states no fill time");
  if (q.expiresAtMs !== undefined && (!Number.isFinite(q.expiresAtMs) || q.expiresAtMs <= 0)) bad("states an expiry that is not a time");
  if (q.orderId !== undefined && (typeof q.orderId !== "string" || !/^[\x21-\x7e]{1,128}$/.test(q.orderId))) bad("carries an order id that is not printable");
  const f = q.fees;
  if (f !== undefined) {
    if (f === null || typeof f !== "object" || typeof f.total !== "string" || !UINT.test(f.total)) bad("itemizes fees without a total");
    for (const v of [f.relayerCapital, f.destinationGas, f.lp]) if (v !== undefined && (typeof v !== "string" || !UINT.test(v))) bad("itemizes a fee that is not a base-unit integer");
    if (f.totalUsd !== undefined && (!Number.isFinite(f.totalUsd) || f.totalUsd < 0)) bad("prices its fees in a number that is not a price");
    if (BigInt(q.outputAmount) <= BigInt(q.inputAmount) && BigInt(f.total) !== BigInt(q.inputAmount) - BigInt(q.outputAmount)) {
      throw new AcrossRefusal("quote-normalized", "the quote's fee total is not its input minus its output", "price_check_failed");
    }
  }
}

/**
 * The deposit for a request and a quote's numbers, built from the pins and verified ({@link verifyAcrossDeposit}) before
 * it is returned. Throws {@link AcrossRefusal}.
 */
export function buildAcrossDeposit(request: AcrossRequest, quote: NormalizedAcrossQuote): VerifiedAcrossDeposit {
  // The route first: it is what the quote's chains and tokens are compared with.
  const {route} = checkAcrossRequest(request);
  const src = route.input.chain;
  const dst = route.output.chain;
  checkNormalized(request, quote, src.chainId, dst.chainId);
  const data = encodeAcrossDeposit({
    depositor: request.depositor.toLowerCase(),
    recipient: request.recipient.toLowerCase(),
    inputToken: route.input.token,
    outputToken: route.output.token,
    inputAmount: request.amount,
    outputAmount: BigInt(quote.outputAmount),
    destinationChainId: BigInt(dst.chainId),
    exclusiveRelayer: quote.exclusiveRelayer.toLowerCase(),
    quoteTimestamp: quote.quoteTimestamp,
    fillDeadline: quote.fillDeadline,
    exclusivityParameter: quote.exclusivityParameter,
    message: "0x",
  });
  return verifyAcrossDeposit(request, {
    to: src.spokePool,
    data,
    value: route.input.native ? request.amount.toString(10) : "0",
    chainId: src.chainId,
    ...(route.input.native ? {} : {approvalAddress: src.spokePool}),
  });
}

/** Options for {@link acrossQuoteOf}. */
export interface AcrossQuoteOptions {
  /** Local lifetime of the quote, ms (default 60 s, at most 5 min). */
  quoteTtlMs?: number;
  /** The quote was priced for a placeholder address: never built or signed. */
  placeholder?: boolean;
  /** Reliability hint for the router, 0..1 (default 0.97). */
  reliability?: number;
}

/**
 * A swap2 `Quote` for a request and a quote source's numbers: the deposit is built here (and verified), the amounts it
 * shows are the deposit's, and `providerData` seals the request and the numbers so the same deposit can be rebuilt and
 * checked again before a build and a signature.
 */
export function acrossQuoteOf(request: AcrossRequest, quote: NormalizedAcrossQuote, opts: AcrossQuoteOptions = {}): Quote {
  const v = buildAcrossDeposit(request, quote);
  const ttl = opts.quoteTtlMs ?? 60_000;
  if (!Number.isInteger(ttl) || ttl <= 0 || ttl > 300_000) throw new AcrossRefusal("request-invalid", "quoteTtlMs must be an integer between 1 and 300000");
  const now = request.nowMs ?? Date.now();
  const validUntilMs = Math.min(now + ttl, now + ACROSS_MAX_QUOTE_LIFE_MS, quote.expiresAtMs ?? Number.POSITIVE_INFINITY);
  const reliability = opts.reliability ?? 0.97;
  const nativeIn = v.route.input.native;
  const feeToken = nativeIn ? ACROSS_NATIVE : v.route.input.token;
  const fee = v.fee.toString(10);
  return {
    provider: "across",
    intentId: acrossIntentId(v.route.input.chain.chainId, v.route.output.chain.chainId, v.deposit.data),
    depositAddress: "",
    depositMemo: null,
    txRequest: {
      to: v.deposit.to,
      data: v.deposit.data,
      value: v.deposit.value,
      chainId: v.deposit.chainId,
      ...(v.deposit.approvalAddress ? {approvalAddress: v.deposit.approvalAddress} : {}),
    },
    sourceAmount: v.args.inputAmount.toString(10),
    destAmount: v.args.outputAmount.toString(10),
    minDestAmount: v.args.outputAmount.toString(10),
    destDecimals: v.route.output.decimals,
    feeUsd: quote.fees?.totalUsd ?? 0,
    fees: v.fee > 0n ? [{type: "protocol", amount: fee, token: feeToken, included: true, description: "Across relayer and LP fee"}] : [],
    etaSeconds: Math.min(Math.max(Math.ceil(quote.expectedFillTimeSec), 1), 86_400),
    reliability: Number.isFinite(reliability) && reliability >= 0 && reliability <= 1 ? reliability : 0.97,
    validUntilMs,
    providerData: {
      sourceChain: request.sourceChain,
      destChain: request.destChain,
      sourceToken: request.sourceToken.toLowerCase(),
      destToken: request.destToken.toLowerCase(),
      amount: request.amount.toString(10),
      depositor: request.depositor.toLowerCase(),
      recipient: request.recipient.toLowerCase(),
      outputAmount: v.args.outputAmount.toString(10),
      quoteTimestamp: String(v.args.quoteTimestamp),
      fillDeadline: String(v.args.fillDeadline),
      exclusiveRelayer: v.args.exclusiveRelayer,
      exclusivityParameter: String(v.args.exclusivityParameter),
      ...(request.minAmountOut !== undefined ? {minAmountOut: request.minAmountOut.toString(10)} : {}),
      ...(request.maxFeeBps !== undefined ? {maxFeeBps: String(request.maxFeeBps)} : {}),
      ...(quote.expectedOutputAmount !== undefined ? {expectedOutputAmount: quote.expectedOutputAmount} : {}),
      ...(quote.orderId !== undefined ? {orderId: quote.orderId} : {}),
      ...(opts.placeholder ? {placeholder: "1"} : {}),
    },
  };
}
