/**
 * The device-side check of an Across deposit.
 *
 * An Across deposit is one call, `deposit(...)` on the source chain's SpokePool, and unlike an order-hash deposit its
 * calldata says everything: who is refunded (`depositor`), who is paid (`recipient`), in which token and how much on
 * which chain (`outputToken`, `outputAmount`, `destinationChainId`), by when (`fillDeadline`), and what runs on arrival
 * (`message`). Relayers pay the recipient `outputAmount` of `outputToken` on the destination out of their own funds and
 * are repaid from the deposit; an unfilled deposit is refunded to `depositor` on the source chain after the fill
 * deadline. The SpokePool itself checks almost none of it — no route list, no token pairing, `depositor` not bound
 * to the sender (SpokePool.sol `_depositV3`) — so {@link verifyAcrossDeposit} holds every field to the user's own
 * request and to the pins in `config.ts`, with nothing but the transaction about to be signed:
 *
 *  1. the call is `deposit` on the pinned SpokePool of the source chain, for that chain id, in its canonical encoding;
 *  2. `depositor` is the account that signs and `recipient` the user's recipient; the destination is the requested
 *     pinned chain;
 *  3. the input is the pinned token for the request (the wrapped native token, with exactly the amount as value, for
 *     the native coin; value 0 and an approval of the SpokePool for an ERC-20), exactly the requested amount;
 *  4. the output is the same asset on the destination (the wrapped native token for the native coin, which the
 *     destination SpokePool unwraps for an EOA), at least the caller's floor, and the fee it leaves (input − output)
 *     between a floor relayers can be paid with and the cap — a deposit asking relayers for all of its input or more
 *     is never filled;
 *  5. the message is empty — the Across V5 witness prefix refused by name — so the tokens land on the recipient and
 *     nothing runs;
 *  6. the deadlines are ones the SpokePool accepts and a relayer can still meet, wherever the deposit lands: a quote
 *     time no older than its on-chain buffer allows (with a margin to land); a fill deadline no further from the quote
 *     time than an Across quote puts it (so an unfilled deposit holds the funds no longer than that before its
 *     refund), and still a fill window away from the last moment the SpokePool takes the deposit (the quote time +
 *     3600 s: nothing on chain refuses a deposit that lands after its own fill deadline); an exclusivity window that
 *     ends well before the fill deadline even then.
 *
 * Every refusal is an {@link AcrossRefusal} with its own code. Nothing here is asynchronous and nothing reads the
 * network, so the same function runs when a quote is built, again right before signing, and on the client of a
 * remote provider (`acrossPins.verifyQuote` / `verifyBuild`).
 */
import {keccak256, type Hex} from "viem";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {refusalNotes, refusalOf, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {
  ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S, ACROSS_FILL_DEADLINE_BUFFER_S, ACROSS_MAX_EXCLUSIVITY_PERIOD_S, ACROSS_NATIVE,
  ACROSS_SPEED_UP_DOMAIN, ACROSS_SPEED_UP_TYPE, ACROSS_V5_MESSAGE_PREFIX, acrossChain, acrossRouteOf, type AcrossRoute,
} from "./config.js";
import {decodeAcrossDeposit, type AcrossDepositArgs} from "./deposit.js";
import {AcrossRefusal} from "./refusal.js";

/** The fee cap when the caller names none: input − output at most 10 % of the input. */
export const ACROSS_DEFAULT_MAX_FEE_BPS = 1_000;
/** The widest fee cap a request may ask for (the Across API's own default `maxFee.bps`). */
export const ACROSS_MAX_FEE_BPS_LIMIT = 5_000;
/** Tolerated difference between the device clock and the chains'. */
export const ACROSS_CLOCK_SKEW_S = 120;
/**
 * Time a deposit is given to land after this check. The quote time must leave at least this much of its on-chain
 * buffer (`depositQuoteTimeBuffer`, 3600 s), or the deposit reverts on the way.
 */
export const ACROSS_LANDING_WINDOW_S = 300;
/** The fill deadline must leave relayers at least this long, counted from the last moment the deposit can land. */
export const ACROSS_MIN_FILL_WINDOW_S = 1_800;
/**
 * The furthest a fill deadline may sit from the quote time: two hours, as Across's API puts it on every quote
 * (`fillDeadline = quoteTimestamp + 7200` on every V4 quote and API deposit read 2026-11-14), and ten minutes of margin.
 * An unfilled deposit holds the funds until then, and its refund comes after (Across's settlement bundles).
 */
export const ACROSS_MAX_FILL_WINDOW_S = 7_800;
/**
 * The smallest fee a deposit may leave relayers, in millionths of the input (10 = 0.1 bps). A relayer pays the output
 * from its own funds and its gas, so a deposit that leaves nothing (or dust) is not filled and waits for a refund —
 * while its output, the whole input, would win any comparison of routes. Across's own capital fee alone was 1 bps on
 * every quote read 2026-11-14 (0.996 bps on WETH Ethereum → Base), ten times this floor.
 */
export const ACROSS_MIN_FEE_PPM = 10;
/** Longest exclusivity accepted, counted from now: one relayer alone may fill for at most an hour. */
export const ACROSS_MAX_EXCLUSIVITY_S = 3_600;
/** Exclusivity must end at least this long before the fill deadline, so that any relayer can still fill. */
export const ACROSS_MIN_OPEN_FILL_S = 600;
/** A direct deposit used ~85k gas in Across's own estimate (2026-11-14); a gas limit under this is a paid revert. */
export const ACROSS_GAS_FLOOR = 90_000n;
/** Chains that meter gas differently (zkSync) estimate far higher; a stated limit is taken up to this. */
export const ACROSS_GAS_CAP = 60_000_000n;
/** The longest a quote may claim to live: five minutes plus the clock difference. */
export const ACROSS_MAX_QUOTE_LIFE_MS = 300_000 + ACROSS_CLOCK_SKEW_S * 1000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;
const U256_MAX = (1n << 256n) - 1n;
const UINT = /^(?:0|[1-9]\d{0,77})$/;

/** What the user asked for — the only thing a deposit is compared against. Addresses in any casing. */
export interface AcrossRequest {
  /** CAIP-2 of the chain the deposit is sent on. */
  sourceChain: string;
  /** CAIP-2 of the chain the output is paid on. */
  destChain: string;
  /** Input token contract; the zero address is the native coin. */
  sourceToken: string;
  /** Output token contract; the zero address is the native coin. */
  destToken: string;
  /** Exact input, base units. */
  amount: bigint;
  /** The account that signs the deposit: its `depositor` (refunds, and the only key that can sign a speed-up). */
  depositor: string;
  /** Who receives the output. */
  recipient: string;
  /** The caller's own floor on the output, base units. */
  minAmountOut?: bigint;
  /** Fee cap in bps of the input (default {@link ACROSS_DEFAULT_MAX_FEE_BPS}). */
  maxFeeBps?: number;
  /** The clock (ms) deadlines are judged against; defaults to `Date.now()`. */
  nowMs?: number;
}

/** The deposit transaction under check: what is about to be signed, or what a quote carries. */
export interface AcrossDepositTx {
  to?: unknown;
  data?: unknown;
  value?: unknown;
  chainId?: unknown;
  approvalAddress?: unknown;
}

/** A deposit that passed the checks: the only shape of call this module signs. */
export interface AcrossDeposit {
  /** The pinned SpokePool, lowercase. */
  to: string;
  /** The canonical calldata, lowercase. */
  data: Hex;
  /** Wei, decimal: the input amount for the native coin, else "0". */
  value: string;
  chainId: number;
  /** ERC-20 input: the spender to approve for exactly the input amount — the pinned SpokePool. */
  approvalAddress?: string;
}

export interface VerifiedAcrossDeposit {
  route: AcrossRoute;
  args: AcrossDepositArgs;
  deposit: AcrossDeposit;
  /** input − output, in the input token's base units (both sides have the same decimals). */
  fee: bigint;
}

const lower = (s: string): string => s.toLowerCase();

/** A request that passed {@link checkAcrossRequest}: its route, the clock it is judged by, its fee cap. */
export interface CheckedAcrossRequest {
  route: AcrossRoute;
  nowS: number;
  maxFeeBps: number;
}

/** The request's own sanity and its route (pinned chains, same asset); throws {@link AcrossRefusal}. */
export function checkAcrossRequest(r: AcrossRequest): CheckedAcrossRequest {
  // A malformed request is the caller's own bug and carries no reason; the zero-address parties and the route are refusals.
  const invalid = (what: string, reason?: Swap2RefusalReason): never => { throw new AcrossRefusal("request-invalid", what, reason); };
  if (r === null || typeof r !== "object") invalid("no request to check the deposit against");
  for (const [what, v] of [["input token", r.sourceToken], ["output token", r.destToken], ["depositor", r.depositor], ["recipient", r.recipient]] as const) {
    if (typeof v !== "string" || !ADDRESS.test(v)) invalid(`the ${what} is not an address`);
  }
  const route = acrossRouteOf(r.sourceChain, r.sourceToken, r.destChain, r.destToken);
  if ("code" in route) throw new AcrossRefusal(route.code, route.detail, "unsupported_pair");
  if (ZERO.test(r.depositor)) invalid("the depositor is the zero address", "recipient_mismatch");
  if (ZERO.test(r.recipient)) invalid("the recipient is the zero address", "recipient_mismatch");
  if (typeof r.amount !== "bigint" || r.amount <= 0n || r.amount > U256_MAX) invalid("the amount is not a positive integer");
  if (r.minAmountOut !== undefined && (typeof r.minAmountOut !== "bigint" || r.minAmountOut < 0n || r.minAmountOut > U256_MAX)) invalid("the output floor is not an unsigned integer");
  const maxFeeBps = r.maxFeeBps ?? ACROSS_DEFAULT_MAX_FEE_BPS;
  if (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > ACROSS_MAX_FEE_BPS_LIMIT) {
    invalid(`the fee cap must be a whole number of basis points up to ${ACROSS_MAX_FEE_BPS_LIMIT}`, "policy_refused");
  }
  const nowMs = r.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs <= 0) invalid("the clock is not a time");
  return {route, nowS: Math.floor(nowMs / 1000), maxFeeBps};
}

/** Where the deposit goes: the pinned SpokePool of the source chain, and nothing else. Checked before the calldata is read. */
function checkTarget(tx: AcrossDepositTx, route: AcrossRoute): void {
  if (tx === null || typeof tx !== "object") throw new AcrossRefusal("tx-shape", "there is no deposit transaction", "policy_refused");
  const src = route.input.chain;
  if (tx.chainId !== src.chainId) throw new AcrossRefusal("tx-chain", `the deposit is for chain ${String(tx.chainId)}, not ${src.name} (${src.chainId})`, "vault_mismatch");
  if (typeof tx.to !== "string" || !ADDRESS.test(tx.to) || lower(tx.to) !== src.spokePool) {
    throw new AcrossRefusal("tx-target", `the deposit calls ${String(tx.to)}, not the ${src.name} SpokePool ${src.spokePool} — periphery, swap and CCTP / OFT routes are not signed by this module`, "vault_mismatch");
  }
}

/**
 * The exclusivity rules: a relayer named exactly when a window is, a window of at most an hour, and one that ends well
 * before the fill deadline even for a deposit that lands as late as the SpokePool takes it.
 */
function checkExclusivity(a: AcrossDepositArgs, nowS: number): void {
  const named = !ZERO.test(a.exclusiveRelayer);
  if (named !== (a.exclusivityParameter !== 0)) {
    throw new AcrossRefusal("tx-exclusivity", named ? "the deposit names an exclusive relayer without an exclusivity window" : "the deposit sets an exclusivity window without a relayer (it reverts)", "policy_refused");
  }
  if (!named) return;
  // Up to `MAX_EXCLUSIVITY_PERIOD_SECONDS` the parameter is an offset from the block the deposit lands in; above it, a
  // timestamp. An offset is that long alone wherever the deposit lands; a timestamp is counted from now, with the
  // landing window.
  const p = a.exclusivityParameter;
  const offset = p <= ACROSS_MAX_EXCLUSIVITY_PERIOD_S;
  const alone = offset ? p : p - nowS;
  if (alone > ACROSS_MAX_EXCLUSIVITY_S + (offset ? 0 : ACROSS_LANDING_WINDOW_S)) {
    throw new AcrossRefusal("tx-exclusivity", `the deposit gives one relayer ${alone} s alone, more than ${ACROSS_MAX_EXCLUSIVITY_S} s`, "policy_refused");
  }
  // The latest an offset can end: the SpokePool takes the deposit until its quote time is `depositQuoteTimeBuffer` old
  // (SpokePool.sol `_depositV3`), and the window runs from that block.
  const lastLanding = Math.min(a.quoteTimestamp + ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S, a.fillDeadline);
  const endsBy = offset ? lastLanding + p : p;
  if (endsBy > a.fillDeadline - ACROSS_MIN_OPEN_FILL_S) {
    throw new AcrossRefusal("tx-exclusivity", `the exclusivity window can end ${a.fillDeadline - endsBy} s before the fill deadline, less than the ${ACROSS_MIN_OPEN_FILL_S} s any relayer needs`, "policy_refused");
  }
}

/**
 * The deadlines: what the SpokePool accepts, with room for the deposit to land and for a relayer to fill wherever it
 * lands, and no longer a hold on the funds than an Across quote sets.
 */
function checkDeadlines(a: AcrossDepositArgs, nowS: number): void {
  const age = nowS - a.quoteTimestamp;
  if (age < -ACROSS_CLOCK_SKEW_S) throw new AcrossRefusal("tx-quote-time", `the quote time is ${-age} s in the future (the deposit reverts)`, "policy_refused");
  if (age > ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S - ACROSS_LANDING_WINDOW_S) {
    throw new AcrossRefusal("tx-quote-time", `the quote time is ${age} s old: the SpokePool takes at most ${ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S} s, with ${ACROSS_LANDING_WINDOW_S} s kept to land`, "quote_expired");
  }
  const left = a.fillDeadline - nowS;
  if (left > ACROSS_FILL_DEADLINE_BUFFER_S - ACROSS_CLOCK_SKEW_S) {
    throw new AcrossRefusal("tx-fill-deadline", `the fill deadline is ${left} s away, past the ${ACROSS_FILL_DEADLINE_BUFFER_S} s the SpokePool allows`, "policy_refused");
  }
  const window = a.fillDeadline - a.quoteTimestamp;
  if (window > ACROSS_MAX_FILL_WINDOW_S) {
    throw new AcrossRefusal("tx-fill-deadline", `the fill deadline is ${window} s after the quote time, more than the ${ACROSS_MAX_FILL_WINDOW_S} s an Across quote gives — unfilled, the deposit would hold the funds that long before its refund`, "policy_refused");
  }
  if (left < ACROSS_MIN_FILL_WINDOW_S) {
    throw new AcrossRefusal("tx-fill-deadline", `the fill deadline is ${left} s away, under the ${ACROSS_MIN_FILL_WINDOW_S} s a relayer is given — the deposit would expire into a refund`, "quote_expired");
  }
  // `_depositV3` has no lower bound on the fill deadline: a deposit that waits to be mined lands, expired, as late as
  // its quote time + `depositQuoteTimeBuffer`. The deadline must leave a relayer its window even then.
  if (window < ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S + ACROSS_MIN_FILL_WINDOW_S) {
    throw new AcrossRefusal("tx-fill-deadline", `the fill deadline is ${window} s after the quote time: a deposit landing as late as the SpokePool takes it (${ACROSS_DEPOSIT_QUOTE_TIME_BUFFER_S} s) would leave a relayer under ${ACROSS_MIN_FILL_WINDOW_S} s`, "policy_refused");
  }
}

/**
 * Check a deposit transaction against the user's request and the pins. Returns the decoded arguments, the route and
 * the deposit as it will be signed; throws {@link AcrossRefusal} otherwise.
 */
export function verifyAcrossDeposit(request: AcrossRequest, tx: AcrossDepositTx): VerifiedAcrossDeposit {
  const {route, nowS, maxFeeBps} = checkAcrossRequest(request);
  checkTarget(tx, route);
  const a = decodeAcrossDeposit(tx.data);
  const src = route.input.chain;
  const dst = route.output.chain;

  // Who: the deposit is credited (and refunded) to the account that signs, and pays the recipient.
  if (a.depositor !== lower(request.depositor)) {
    throw new AcrossRefusal("tx-depositor", `the deposit is credited to ${a.depositor}, not to the signing account ${lower(request.depositor)} — the depositor is refunded and can redirect the output`, "recipient_mismatch");
  }
  if (a.recipient !== lower(request.recipient)) throw new AcrossRefusal("tx-recipient", `the deposit pays ${a.recipient}, not the recipient ${lower(request.recipient)}`, "recipient_mismatch");
  if (a.destinationChainId !== BigInt(dst.chainId)) {
    throw new AcrossRefusal("tx-destination", `the deposit is for chain ${a.destinationChainId}, not ${dst.name} (${dst.chainId})`, "recipient_mismatch");
  }

  // What goes in: exactly the requested amount of the pinned token.
  if (a.inputToken !== route.input.token) throw new AcrossRefusal("tx-input-token", `the deposit takes ${a.inputToken}, the request sends ${route.input.token}${route.input.native ? " (the wrapped native token, for the native coin)" : ""}`, "policy_refused");
  if (a.inputAmount !== request.amount) throw new AcrossRefusal("tx-input-amount", `the deposit takes ${a.inputAmount}, the request sends ${request.amount}`, "policy_refused");

  // What comes out: the same asset, at least the floor, and less than went in by a fee relayers can be paid with.
  if (a.outputToken !== route.output.token) throw new AcrossRefusal("tx-output-token", `the deposit pays ${a.outputToken} on ${dst.name}, the request is for ${route.output.token}${route.output.native ? " (the wrapped native token, paid out as the native coin)" : ""}`, "price_check_failed");
  if (a.outputAmount <= 0n) throw new AcrossRefusal("tx-output-amount", "the deposit's output is zero", "price_check_failed");
  if (request.minAmountOut !== undefined && a.outputAmount < request.minAmountOut) {
    throw new AcrossRefusal("tx-output-amount", `the deposit pays ${a.outputAmount}, under the caller's floor ${request.minAmountOut}`, "price_check_failed");
  }
  if (a.outputAmount > a.inputAmount) {
    throw new AcrossRefusal("tx-output-amount", `the deposit asks relayers for ${a.outputAmount}, more than its ${a.inputAmount} input — nobody fills it, and the funds wait for a refund`, "price_check_failed");
  }
  const fee = a.inputAmount - a.outputAmount;
  if (fee === 0n) {
    throw new AcrossRefusal("tx-fee", "the deposit leaves relayers no fee — nobody fills it, and the funds wait for a refund", "price_check_failed");
  }
  if (fee * 1_000_000n < a.inputAmount * BigInt(ACROSS_MIN_FEE_PPM)) {
    throw new AcrossRefusal("tx-fee", `the deposit leaves relayers ${fee} of ${a.inputAmount}, under the ${ACROSS_MIN_FEE_PPM}-per-million floor — nobody fills it, and the funds wait for a refund`, "price_check_failed");
  }
  if (fee * 10_000n > a.inputAmount * BigInt(maxFeeBps)) {
    throw new AcrossRefusal("tx-fee", `the deposit leaves ${fee} of ${a.inputAmount} as fees, over the ${maxFeeBps} bps cap`, "price_check_failed");
  }

  // Nothing runs on arrival.
  if (a.message !== "0x") {
    if (a.message.length >= 66 && a.message.slice(0, 66) === ACROSS_V5_MESSAGE_PREFIX) {
      throw new AcrossRefusal("tx-message-v5", "the deposit carries an Across V5 witness message, consumable only through the V5 Gateway", "policy_refused");
    }
    throw new AcrossRefusal("tx-message", `the deposit carries a ${(a.message.length - 2) / 2}-byte message for the destination — only plain transfers are signed`, "policy_refused");
  }

  checkExclusivity(a, nowS);
  checkDeadlines(a, nowS);

  // The money attached: the input itself for the native coin (the SpokePool wraps it), nothing for an ERC-20.
  const value = typeof tx.value === "string" && UINT.test(tx.value) ? BigInt(tx.value) : null;
  const wantValue = route.input.native ? a.inputAmount : 0n;
  if (value === null || value !== wantValue) throw new AcrossRefusal("tx-value", `the deposit sends ${String(tx.value)} wei, it must send ${wantValue}`, "policy_refused");
  const approval = tx.approvalAddress;
  if (route.input.native) {
    if (approval !== undefined && approval !== "") throw new AcrossRefusal("tx-approval", `a native deposit approves nothing, the transaction approves ${String(approval)}`, "vault_mismatch");
  } else if (typeof approval !== "string" || lower(approval) !== src.spokePool) {
    throw new AcrossRefusal("tx-approval", `the deposit approves ${String(approval)}, it must approve the ${src.name} SpokePool ${src.spokePool}`, "vault_mismatch");
  }

  return {
    route,
    args: a,
    deposit: {
      to: src.spokePool,
      data: lower(tx.data as string) as Hex,
      value: wantValue.toString(10),
      chainId: src.chainId,
      ...(route.input.native ? {} : {approvalAddress: src.spokePool}),
    },
    fee,
  };
}

/** The intent id of a deposit: the route and a digest of the exact calldata (`across:<from>:<to>:<16 bytes hex>`). */
export function acrossIntentId(sourceChainId: number, destChainId: number, data: Hex): string {
  return `across:${sourceChainId}:${destChainId}:${keccak256(lower(data) as Hex).slice(2, 34)}`;
}

/** The route an intent id names (a server's `~<tag>` suffix tolerated), or null. */
export function parseAcrossIntentId(intentId: string): {sourceChainId: number; destChainId: number; digest: string} | null {
  if (typeof intentId !== "string") return null;
  const m = /^across:([1-9]\d{0,15}):([1-9]\d{0,15}):([0-9a-f]{32})(?:~[0-9a-f]{32})?$/.exec(intentId);
  if (!m) return null;
  return {sourceChainId: Number(m[1]), destChainId: Number(m[2]), digest: m[3]!};
}

/**
 * True for typed data an Across speed-up signature would be made over (`UpdateDepositDetails`, or Across's `ACROSS-V2`
 * domain). A wallet can run this on any signing request; nothing this module builds is ever typed data.
 */
export function isAcrossSpeedUpTypedData(typedData: unknown): boolean {
  let v: unknown = typedData;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return /UpdateDepositDetails|ACROSS-V2/.test(v as string); }
  }
  if (v === null || typeof v !== "object") return false;
  const t = v as {primaryType?: unknown; types?: unknown; domain?: {name?: unknown} | null};
  if (t.primaryType === ACROSS_SPEED_UP_TYPE) return true;
  if (t.types !== null && typeof t.types === "object" && Object.prototype.hasOwnProperty.call(t.types, ACROSS_SPEED_UP_TYPE)) return true;
  return t.domain !== null && typeof t.domain === "object" && t.domain.name === ACROSS_SPEED_UP_DOMAIN;
}

/** The one shape a transaction to sign may have: an EVM call — never typed data, a memo or a serialized transaction. */
export function checkAcrossTxShape(tx: UnsignedTx): void {
  if (tx.typedData !== undefined) {
    if (isAcrossSpeedUpTypedData(tx.typedData)) throw new AcrossRefusal("speed-up", "the request is an Across speed-up signature, which can redirect a deposit's output — never signed", "policy_refused");
    throw new AcrossRefusal("tx-shape", "an Across deposit is one EVM call, not typed data", "policy_refused");
  }
  if (tx.serializedTx !== undefined || tx.memo !== undefined || tx.bodyBoc !== undefined || tx.stateInitBoc !== undefined || tx.orderExtension !== undefined) {
    throw new AcrossRefusal("tx-shape", "an Across deposit is one EVM call", "policy_refused");
  }
}

/** A refusal's text for a caller that wants a string (`onRefusal`, remote pins); rethrows anything else. */
export function acrossRefusalReason(err: unknown): string {
  if (err instanceof AcrossRefusal) return err.message;
  throw err;
}

/**
 * The request a `QuoteParams` describes, for the verifier. `placeholder` (a dry quote: pricing only) fills a missing
 * address.
 *
 * The depositor is `sender`, the account that signs — set by the engine on every execution quote. Across refunds the
 * depositor, and the depositor alone can sign a speed-up that a relayer fills to another recipient or for less
 * (SpokePool.sol `fillRelayWithUpdatedDeposit`, an EIP-712 or EIP-1271 signature of `relayData.depositor`): a refund
 * address the caller names is never made the depositor, and one other than the signer is refused. A live request
 * without `sender` is refused; a dry one is priced for `refundAddress` (or the placeholder).
 */
export function acrossRequestOf(params: QuoteParams, opts: {placeholder?: string; nowMs?: number; maxFeeBps?: number} = {}): AcrossRequest {
  const invalid = (what: string, reason?: Swap2RefusalReason): never => { throw new AcrossRefusal("request-invalid", what, reason); };
  if (params === null || typeof params !== "object") invalid("no request");
  if (params.flex) invalid("the amount is part of the deposit (no flexible deposits)", "unsupported_pair");
  if (!acrossChain(params.sourceChain)) throw new AcrossRefusal("chain-unsupported", `source chain ${String(params.sourceChain)} is not a pinned Across chain`, "unsupported_pair");
  if (!acrossChain(params.destChain)) throw new AcrossRefusal("chain-unsupported", `destination chain ${String(params.destChain)} is not a pinned Across chain`, "unsupported_pair");
  if (params.sourceChain === params.destChain) throw new AcrossRefusal("chain-unsupported", "same-chain swaps are not served through a SpokePool", "unsupported_pair");
  let sourceToken: string;
  if (typeof params.sourceToken === "string" && ADDRESS.test(params.sourceToken)) sourceToken = params.sourceToken;
  else {
    const asset = sourceAssetOf(params);
    if (!asset) invalid(`source token ${String(params.sourceToken)} is not known on ${params.sourceChain}`, "unsupported_pair");
    sourceToken = asset!.contract ?? ACROSS_NATIVE;
    if (!ADDRESS.test(sourceToken)) invalid(`source token ${String(params.sourceToken)} has no EVM contract`, "unsupported_pair");
  }
  if (typeof params.destToken !== "string" || !ADDRESS.test(params.destToken)) invalid("the destination token must be an EVM address (zero for the native coin)", "unsupported_pair");
  const route = acrossRouteOf(params.sourceChain, sourceToken, params.destChain, params.destToken);
  if ("code" in route) throw new AcrossRefusal(route.code, route.detail, "unsupported_pair");
  if (typeof params.amountIn !== "string" || !/^[1-9]\d{0,77}$/.test(params.amountIn)) invalid("amount must be a positive base-unit integer");
  if (params.minAmountOut !== undefined && !UINT.test(params.minAmountOut)) invalid("the output floor must be a base-unit integer");
  const recipient = params.destAddress || opts.placeholder || "";
  if (!recipient) invalid("a live quote needs a recipient");
  if (!ADDRESS.test(recipient)) invalid("the recipient must be an EVM address");
  const sender = params.sender || "";
  const refund = params.refundAddress || "";
  if (sender && !ADDRESS.test(sender)) invalid("the signing account (sender) must be an EVM address");
  if (refund && !ADDRESS.test(refund)) invalid("the refund address must be an EVM address");
  if (sender && refund && lower(sender) !== lower(refund)) {
    throw new AcrossRefusal("request-invalid", `an Across deposit refunds its depositor, the signing account ${lower(sender)}: refund address ${lower(refund)} is another account, and as the depositor it could also sign a speed-up that re-points the output`, "recipient_mismatch");
  }
  const depositor = sender || (opts.placeholder ? refund || opts.placeholder : "");
  if (!depositor) invalid("a live quote needs the signing account (sender)");
  if (!ADDRESS.test(depositor)) invalid("the depositor must be an EVM address");
  return {
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    sourceToken,
    destToken: params.destToken,
    amount: BigInt(params.amountIn),
    depositor,
    recipient,
    ...(params.minAmountOut !== undefined ? {minAmountOut: BigInt(params.minAmountOut)} : {}),
    ...(opts.maxFeeBps !== undefined ? {maxFeeBps: opts.maxFeeBps} : {}),
    ...(opts.nowMs !== undefined ? {nowMs: opts.nowMs} : {}),
  };
}

/**
 * A quote of this provider against the request it answers: its transaction passes {@link verifyAcrossDeposit}, its id
 * names that very calldata, and the amounts it shows are the deposit's (`outputAmount` is what the recipient gets —
 * a relayer pays exactly that). Throws {@link AcrossRefusal}. Used on the client of a remote provider and again
 * before a build and a signature.
 */
export function checkAcrossQuote(request: AcrossRequest, quote: Quote, tx?: AcrossDepositTx & {gasLimit?: unknown}): VerifiedAcrossDeposit {
  if (quote === null || typeof quote !== "object" || quote.provider !== "across") throw new AcrossRefusal("quote-shape", "not an Across quote", "policy_refused");
  const t = tx ?? quote.txRequest;
  if (!t) throw new AcrossRefusal("quote-shape", "the quote has no transaction", "policy_refused");
  if (quote.depositAddress) throw new AcrossRefusal("quote-shape", "an Across quote pays the SpokePool through its calldata, never a deposit address", "vault_mismatch");
  const extra = quote.txRequest as {serializedTx?: unknown; nativeFee?: unknown} | undefined;
  if (extra?.serializedTx !== undefined || extra?.nativeFee !== undefined) {
    throw new AcrossRefusal("quote-shape", "an Across deposit carries no extra native fee and no serialized transaction", "policy_refused");
  }
  const v = verifyAcrossDeposit(request, t);
  if (quote.sourceAmount !== v.args.inputAmount.toString(10) || quote.minDestAmount !== v.args.outputAmount.toString(10) || quote.destAmount !== v.args.outputAmount.toString(10)) {
    throw new AcrossRefusal("quote-amounts", "the amounts the quote shows are not the deposit's", "price_check_failed");
  }
  // Gas is the one number of the call no argument binds: held to a band, so a backend can neither starve the deposit
  // (a paid revert) nor name an absurd limit. Absent = the wallet estimates.
  const gas = (t as {gasLimit?: unknown}).gasLimit;
  if (gas !== undefined) {
    if (typeof gas !== "string" || !/^[1-9]\d{0,10}$/.test(gas) || BigInt(gas) < ACROSS_GAS_FLOOR || BigInt(gas) > ACROSS_GAS_CAP) {
      throw new AcrossRefusal("quote-gas", `the gas limit ${String(gas).slice(0, 40)} is outside ${ACROSS_GAS_FLOOR}–${ACROSS_GAS_CAP}`, "policy_refused");
    }
  }
  const now = request.nowMs ?? Date.now();
  if (typeof quote.validUntilMs !== "number" || !Number.isFinite(quote.validUntilMs) || quote.validUntilMs > now + ACROSS_MAX_QUOTE_LIFE_MS) {
    throw new AcrossRefusal("quote-expiry", "the quote claims to live longer than an Across quote may", "policy_refused");
  }
  // A server appends its intent token (`<id>~<tag>`); the id before it must name this deposit.
  const intent = parseAcrossIntentId(quote.intentId);
  const want = acrossIntentId(v.route.input.chain.chainId, v.route.output.chain.chainId, v.deposit.data);
  if (!intent || `across:${intent.sourceChainId}:${intent.destChainId}:${intent.digest}` !== want) {
    throw new AcrossRefusal("quote-intent", "the quote's id does not name its deposit", "policy_refused");
  }
  return v;
}

// The reason behind each text the pins return (`acrossPins.reasonOf`), bounded.
const pinNotes = refusalNotes();
/** The refusal's text, its reason noted for `acrossPins.reasonOf`; rethrows anything that is not a refusal. */
function notedReason(err: unknown): string {
  const text = acrossRefusalReason(err);
  const info = refusalOf(err);
  return info ? pinNotes.note(text, info) : text;
}

/** What the pins hold a remote quote to beyond the user's request: the app's own fee cap. */
export interface AcrossPinsOptions {
  /** Fee cap in bps of the input (default {@link ACROSS_DEFAULT_MAX_FEE_BPS}, at most {@link ACROSS_MAX_FEE_BPS_LIMIT}) — the app's, never the server's. */
  maxFeeBps?: number;
}

function verifyQuoteWith(params: QuoteParams, quote: Quote, cap: {maxFeeBps?: number}): string | null {
  try {
    checkAcrossQuote(acrossRequestOf(params, cap), quote);
    return null;
  } catch (err) {
    return notedReason(err);
  }
}

function verifyBuildWith(quote: Quote, tx: UnsignedTx, params: QuoteParams | undefined, cap: {maxFeeBps?: number}): string | null {
  try {
    if (!params) throw new AcrossRefusal("request-invalid", "the request this quote answered is not known on this side — quote again", "policy_refused");
    if (tx.chain !== params.sourceChain) throw new AcrossRefusal("tx-chain", `the build is for ${tx.chain}, not ${params.sourceChain}`, "vault_mismatch");
    checkAcrossTxShape(tx);
    checkAcrossQuote(acrossRequestOf(params, cap), quote, tx);
    return null;
  } catch (err) {
    return notedReason(err);
  }
}

/** `RemotePins.verifyQuote` with the default fee cap: the reason a remote Across quote fails against the user's own request, or null. */
export function acrossVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  return verifyQuoteWith(params, quote, {});
}

/** `RemotePins.verifyBuild` with the default fee cap: a remote build must be the quote's own (verified) transaction, and is verified again. */
export function acrossVerifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): string | null {
  return verifyBuildWith(quote, tx, params, {});
}

/**
 * The app's pins for a remote Across provider (`remoteProvider({name: "across", ...acrossPinsWith({maxFeeBps})})`): the
 * only contract a build may call or approve is the chain's SpokePool, and every quote and build is verified on the
 * client against the user's own request and the app's fee cap — a server's own cap (`acrossProvider({maxFeeBps})`) is
 * not known on this side, so the app states the one it holds remote quotes to. `reasonOf` classifies a text
 * `verifyQuote` / `verifyBuild` returned. Throws a plain `Error` for a cap out of range.
 */
export function acrossPinsWith(opts: AcrossPinsOptions = {}): RemotePins {
  const maxFeeBps = opts.maxFeeBps;
  if (maxFeeBps !== undefined && (!Number.isInteger(maxFeeBps) || maxFeeBps < 0 || maxFeeBps > ACROSS_MAX_FEE_BPS_LIMIT)) {
    throw new Error(`across: maxFeeBps must be an integer between 0 and ${ACROSS_MAX_FEE_BPS_LIMIT}`);
  }
  const cap = Object.freeze(maxFeeBps !== undefined ? {maxFeeBps} : {});
  return Object.freeze({
    callTargets: (chain: string): readonly string[] => { const c = acrossChain(chain); return c ? [c.spokePool] : []; },
    spenders: (chain: string): readonly string[] => { const c = acrossChain(chain); return c ? [c.spokePool] : []; },
    verifyQuote: (params: QuoteParams, quote: Quote): string | null => verifyQuoteWith(params, quote, cap),
    verifyBuild: (quote: Quote, tx: UnsignedTx, params?: QuoteParams): string | null => verifyBuildWith(quote, tx, params, cap),
    reasonOf: pinNotes.reasonOf,
  });
}

/** {@link acrossPinsWith} with the default fee cap (10 %): `remoteProvider({name: "across", ...acrossPins})`. */
export const acrossPins: RemotePins = acrossPinsWith();
