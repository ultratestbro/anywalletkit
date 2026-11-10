/**
 * The device-side check of a Relay order and of the deposit that funds it.
 *
 * A Relay deposit is `depositNative(depositor, id)` / `depositErc20(depositor, token, amount, id)` on the chain's
 * RelayDepository: the calldata names no recipient, no destination and no minimum — only `id`, the hash of an order
 * that lives off chain. Signing such a deposit is safe exactly when the device holds the order behind the id and that
 * order says what the user asked for. {@link verifyRelayOrder} establishes that, from nothing but the user's own
 * request, the pins in `config.ts`, and the bytes the API (or an app's proxy — equally untrusted) returned:
 *
 *  1. the order is the documented shape, one input, one output payment, no destination calls, no order-level fees;
 *  2. its content is the request: recipient, destination chain and token, a minimum no lower than the caller's, a
 *     deadline one order lifetime away, the input chain / token / amount, refunds only to the user;
 *  3. its solver is the pinned one and the solver signed this very id;
 *  4. the id recomputed here (EIP-712 `hashStruct`) is the id in the calldata;
 *  5. the transaction is a known deposit call on the pinned depository, depositing exactly the order's input from the
 *     user's own address — and is byte-for-byte the call this module would build itself.
 *
 * Every refusal is a {@link RelayRefusal} with its own code. Nothing here is asynchronous and nothing reads the
 * network, so the same function runs at quote time, again right before signing, and on the client of a remote
 * provider (`relayPins.verifyQuote`).
 */
import {encodeFunctionData, parseAbi, type Hex} from "viem";
import type {Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {
  RELAY_CLOCK_SKEW_S, RELAY_DEPOSIT_ERC20, RELAY_DEPOSIT_ERC20_ALLOWANCE, RELAY_DEPOSIT_NATIVE, RELAY_MAX_ORDER_AGE_S,
  RELAY_NATIVE, RELAY_ORDER_LIFETIME_S, RELAY_ORDER_VERSION, RELAY_SOLVERS, relayChain, type RelayChain,
} from "./config.js";
import {RelayRefusal, parseRelayOrder, relayOrderId, relayOrderSigner, type RelayOrder} from "./order.js";

const DEPOSITORY_ABI = parseAbi([
  "function depositNative(address depositor, bytes32 id) payable",
  "function depositErc20(address depositor, address token, uint256 amount, bytes32 id)",
]);

/** Widest slippage a request may ask for. */
export const RELAY_MAX_SLIPPAGE_BPS = 5_000;
/**
 * The slippage this module asks Relay for, and holds the order to, when the caller names none (Relay's own default
 * on 2026-11-10). Without it the answering side would choose how far the minimum may sit under the expected amount.
 */
export const RELAY_DEFAULT_SLIPPAGE_BPS = 200;

/** A direct deposit used ~33k (native) and ~76k (ERC-20) gas in Relay's own estimates (2026-11-10). */
export const RELAY_GAS_FLOOR_NATIVE = 90_000n;
export const RELAY_GAS_FLOOR_ERC20 = 180_000n;
/** Chains that meter gas differently (Mantle, zkSync) estimate far higher; an estimate is taken up to this. */
export const RELAY_GAS_CAP = 60_000_000n;
/** The longest a quote may claim to live: the provider's own upper bound plus the tolerated clock difference. */
export const RELAY_MAX_QUOTE_LIFE_MS = 300_000 + RELAY_CLOCK_SKEW_S * 1000;

export {relayClearOrder} from "./cleared.js";
import {relayClearOrder} from "./cleared.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const U256_MAX = (1n << 256n) - 1n;

/** What the user asked for — the only thing an order is compared against. Addresses in any casing. */
export interface RelayRequest {
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
  /** The account that signs the deposit: the `depositor` argument and the origin-chain refund recipient. */
  depositor: string;
  /** Who receives the output. */
  recipient: string;
  /** The caller's own floor on the output, base units. */
  minAmountOut?: bigint;
  /** The slippage the caller asked for: the order's minimum may sit at most this far under its expected amount. */
  slippageBps?: number;
  /** The clock (ms) deadlines are judged against; defaults to `Date.now()`. */
  nowMs?: number;
}

/** `protocol.v2` of a quote response, as received. */
export interface RelayProtocolData {
  orderId?: unknown;
  hubType?: unknown;
  orderData?: unknown;
  orderSignature?: unknown;
  paymentDetails?: unknown;
}

/** The deposit transaction under check: what the API proposed, or what is about to be signed. */
export interface RelayDepositTx {
  to?: unknown;
  data?: unknown;
  value?: unknown;
  chainId?: unknown;
}

/** A deposit this module built: the only bytes a Relay quote ever carries. */
export interface RelayDeposit {
  to: string;
  data: Hex;
  /** Wei, decimal. */
  value: string;
  chainId: number;
  /** ERC-20 input: the spender to approve for exactly the input amount — the pinned depository. */
  approvalAddress?: string;
}

export interface VerifiedRelayOrder {
  order: RelayOrder;
  /** The order id, recomputed. */
  id: Hex;
  /** The deposit built here from the pins and the order. */
  deposit: RelayDeposit;
  /** `expectedAmount` of the single output payment. */
  expectedAmount: bigint;
  /** `minimumAmount` of the single output payment: the least the solver may pay for the order to count as filled. */
  minimumAmount: bigint;
  source: RelayChain;
  dest: RelayChain;
}

const lower = (s: string): string => s.toLowerCase();
const isNative = (token: string): boolean => lower(token) === RELAY_NATIVE;

/** The deposit call for an order: built from pinned and verified values only. */
export function buildRelayDeposit(source: RelayChain, depositor: string, token: string, amount: bigint, id: Hex): RelayDeposit {
  if (!ADDRESS.test(depositor) || /^0x0{40}$/.test(depositor)) throw new RelayRefusal("request-invalid", "the depositor is not an address");
  if (!ADDRESS.test(token)) throw new RelayRefusal("request-invalid", "the input token is not an address");
  if (amount <= 0n || amount > U256_MAX) throw new RelayRefusal("request-invalid", "the amount is not a positive integer");
  if (!/^0x[0-9a-f]{64}$/.test(id)) throw new RelayRefusal("order-id-mismatch", "the order id is not 32 bytes");
  if (isNative(token)) {
    return {
      to: source.depository,
      data: encodeFunctionData({abi: DEPOSITORY_ABI, functionName: "depositNative", args: [lower(depositor) as Hex, id]}),
      value: amount.toString(10),
      chainId: source.chainId,
    };
  }
  return {
    to: source.depository,
    data: encodeFunctionData({abi: DEPOSITORY_ABI, functionName: "depositErc20", args: [lower(depositor) as Hex, lower(token) as Hex, amount, id]}),
    value: "0",
    chainId: source.chainId,
    approvalAddress: source.depository,
  };
}

function checkRequest(r: RelayRequest): {source: RelayChain; dest: RelayChain; nowS: number} {
  const invalid = (what: string): never => { throw new RelayRefusal("request-invalid", what); };
  if (r === null || typeof r !== "object") invalid("no request to check the order against");
  const source = relayChain(r.sourceChain);
  const dest = relayChain(r.destChain);
  if (!source) throw new RelayRefusal("chain-unsupported", `source chain ${String(r.sourceChain)} is not a pinned Relay chain`);
  if (!dest) throw new RelayRefusal("chain-unsupported", `destination chain ${String(r.destChain)} is not a pinned Relay chain`);
  if (source === dest) throw new RelayRefusal("chain-unsupported", "source and destination are the same chain");
  for (const [what, v] of [["input token", r.sourceToken], ["output token", r.destToken], ["depositor", r.depositor], ["recipient", r.recipient]] as const) {
    if (typeof v !== "string" || !ADDRESS.test(v)) invalid(`the ${what} is not an address`);
  }
  if (/^0x0{40}$/.test(r.depositor)) invalid("the depositor is the zero address");
  if (/^0x0{40}$/.test(r.recipient)) invalid("the recipient is the zero address");
  if (typeof r.amount !== "bigint" || r.amount <= 0n || r.amount > U256_MAX) invalid("the amount is not a positive integer");
  if (r.minAmountOut !== undefined && (typeof r.minAmountOut !== "bigint" || r.minAmountOut < 0n)) invalid("the output floor is not an unsigned integer");
  if (r.slippageBps !== undefined && (!Number.isInteger(r.slippageBps) || r.slippageBps < 0 || r.slippageBps > RELAY_MAX_SLIPPAGE_BPS)) {
    invalid(`slippage must be a whole number of basis points up to ${RELAY_MAX_SLIPPAGE_BPS}`);
  }
  const nowMs = r.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || nowMs <= 0) invalid("the clock is not a time");
  return {source, dest, nowS: Math.floor(nowMs / 1000)};
}

/** Twenty raw bytes equal to an address. `bytes` fields are lowercased by the parser. */
const isAddr = (bytes: Hex, addr: string): boolean => bytes.length === 42 && bytes === lower(addr);

function checkDeadline(code: "output-deadline" | "refund-deadline", what: string, deadline: number, nowS: number): void {
  const left = deadline - nowS;
  if (left > RELAY_ORDER_LIFETIME_S + RELAY_CLOCK_SKEW_S) {
    throw new RelayRefusal(code, `${what} is ${left} s away, past the ${RELAY_ORDER_LIFETIME_S} s an order lives`);
  }
  if (left < RELAY_ORDER_LIFETIME_S - RELAY_MAX_ORDER_AGE_S) {
    throw new RelayRefusal(code, `${what} is ${left} s away: the order is older than ${RELAY_MAX_ORDER_AGE_S} s or already past it`);
  }
}

/** A 32-byte calldata word that is a left-padded address. */
function wordAddress(word: string): string | null {
  return /^0{24}/.test(word) ? `0x${word.slice(24)}` : null;
}

/** Where the deposit goes: the pinned depository of the source chain, and nothing else. Checked before the order is read. */
function checkDepositTarget(tx: RelayDepositTx, source: RelayChain): void {
  if (tx === null || typeof tx !== "object") throw new RelayRefusal("tx-calldata", "there is no deposit transaction");
  if (tx.chainId !== source.chainId) {
    throw new RelayRefusal("tx-chain", `the deposit is for chain ${String(tx.chainId)}, not ${source.chainId}`);
  }
  if (typeof tx.to !== "string" || !ADDRESS.test(tx.to) || lower(tx.to) !== source.depository) {
    throw new RelayRefusal("tx-target", `the deposit calls ${String(tx.to)}, not the ${source.name} depository ${source.depository} — routes that first swap on the source chain go through a router and are not signed by this module`);
  }
}

function checkDepositTx(tx: RelayDepositTx, source: RelayChain, request: RelayRequest, order: RelayOrder, id: Hex): void {
  checkDepositTarget(tx, source);
  if (typeof tx.data !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(tx.data) || tx.data.length < 10) {
    throw new RelayRefusal("tx-calldata", "the deposit has no calldata");
  }
  const data = lower(tx.data);
  const selector = data.slice(0, 10);
  const input = order.inputs[0]!.payment;
  const native = isNative(input.currency);
  if (selector === RELAY_DEPOSIT_ERC20_ALLOWANCE) {
    throw new RelayRefusal("tx-selector", "the deposit uses depositErc20 without an amount, which takes the whole allowance");
  }
  if (selector !== RELAY_DEPOSIT_NATIVE && selector !== RELAY_DEPOSIT_ERC20) {
    throw new RelayRefusal("tx-selector", `the deposit calls ${selector}, not a known deposit function`);
  }
  if ((selector === RELAY_DEPOSIT_NATIVE) !== native) {
    throw new RelayRefusal("tx-selector", `the deposit calls ${native ? "depositErc20" : "depositNative"} for an order whose input is ${native ? "the native coin" : "a token"}`);
  }
  const words = native ? 2 : 4;
  if (data.length !== 10 + 64 * words) {
    throw new RelayRefusal("tx-calldata", `the deposit calldata is ${(data.length - 2) / 2} bytes, not ${4 + 32 * words}`);
  }
  const word = (i: number): string => data.slice(10 + 64 * i, 74 + 64 * i);
  const depositor = wordAddress(word(0));
  if (depositor === null) throw new RelayRefusal("tx-calldata", "the depositor argument is not a padded address");
  if (depositor !== lower(request.depositor)) {
    throw new RelayRefusal("tx-depositor", `the deposit is credited to ${depositor}, not to the sender ${lower(request.depositor)}`);
  }
  if (!native) {
    const token = wordAddress(word(1));
    if (token === null) throw new RelayRefusal("tx-calldata", "the token argument is not a padded address");
    if (token !== input.currency) throw new RelayRefusal("tx-token", `the deposit moves ${token}, the order's input is ${input.currency}`);
    const amount = BigInt(`0x${word(2)}`);
    if (amount !== input.amount) throw new RelayRefusal("tx-amount", `the deposit moves ${amount}, the order's input is ${input.amount}`);
  }
  const txId = `0x${word(native ? 1 : 3)}`;
  if (txId !== id) throw new RelayRefusal("tx-id", `the deposit names order ${txId}, the order received hashes to ${id}`);
  const value = typeof tx.value === "string" && /^(?:0|[1-9]\d{0,77})$/.test(tx.value) ? BigInt(tx.value) : null;
  const wantValue = native ? input.amount : 0n;
  if (value === null || value !== wantValue) {
    throw new RelayRefusal("tx-value", `the deposit sends ${String(tx.value)} wei, it must send ${wantValue}`);
  }
}

/**
 * Check an order against the user's request and — when given — a deposit transaction against the order. Returns the
 * parsed order, its id and the deposit this module builds for it; throws {@link RelayRefusal} otherwise.
 *
 * `deposit` is what the API proposed (at quote time) or what is about to be signed (before signing). Without it the
 * order alone is checked and the caller uses the returned `deposit`.
 */
export function verifyRelayOrder(request: RelayRequest, protocol: RelayProtocolData | null | undefined, deposit?: RelayDepositTx): VerifiedRelayOrder {
  const {source, dest, nowS} = checkRequest(request);
  // A deposit that does not call the pinned depository is refused for that, whatever order comes with it.
  if (deposit !== undefined) checkDepositTarget(deposit, source);

  // The envelope.
  if (protocol === null || typeof protocol !== "object") {
    throw new RelayRefusal("protocol-data-missing", "the quote carries no order (protocol.v2) — nothing to check the deposit against");
  }
  if (protocol.orderData === undefined || protocol.orderData === null) {
    throw new RelayRefusal("protocol-data-missing", "the quote carries no order data — nothing to check the deposit against");
  }
  if (protocol.hubType !== "onchain") {
    throw new RelayRefusal("hub-type", `the order settles through a "${String(protocol.hubType)}" hub, only "onchain" is read`);
  }
  const order = parseRelayOrder(protocol.orderData);

  // The shape.
  if (order.version !== RELAY_ORDER_VERSION) throw new RelayRefusal("order-version", `order version "${order.version}" is not ${RELAY_ORDER_VERSION}`);
  if (order.inputs.length !== 1) throw new RelayRefusal("order-inputs", `the order has ${order.inputs.length} inputs, exactly one is signed for`);
  if (order.output.payments.length !== 1) throw new RelayRefusal("order-payments", `the order pays ${order.output.payments.length} outputs, exactly one is accepted`);
  if (order.output.calls.length !== 0) throw new RelayRefusal("order-calls", "the order runs calls on the destination — only plain payments are accepted");
  if (order.fees.length !== 0) throw new RelayRefusal("order-fees", "the order carries order-level fees, which this module does not show and does not accept");
  const input = order.inputs[0]!;
  const pay = order.output.payments[0]!;
  if (input.payment.weight === 0n) throw new RelayRefusal("input-weight", "the order's input has zero weight");

  // The solver.
  if (!RELAY_SOLVERS.some((s) => s.address === order.solver && s.chainId === order.solverChainId)) {
    throw new RelayRefusal("solver-not-pinned", `solver ${order.solver} on "${order.solverChainId}" is not a pinned Relay solver`);
  }

  // The output: who is paid, where, in what, and at least how much.
  if (order.output.chainId !== dest.slug) throw new RelayRefusal("output-chain", `the order pays on "${order.output.chainId}", the request is for ${dest.name} ("${dest.slug}")`);
  if (!isAddr(pay.recipient, request.recipient)) throw new RelayRefusal("output-recipient", `the order pays ${pay.recipient}, not the recipient ${lower(request.recipient)}`);
  if (!isAddr(pay.currency, request.destToken)) throw new RelayRefusal("output-currency", `the order pays in ${pay.currency}, the request is for ${lower(request.destToken)}`);
  if (pay.minimumAmount <= 0n) throw new RelayRefusal("output-minimum", "the order's minimum output is zero");
  if (request.minAmountOut !== undefined && pay.minimumAmount < request.minAmountOut) {
    throw new RelayRefusal("output-minimum", `the order's minimum output ${pay.minimumAmount} is under the caller's floor ${request.minAmountOut}`);
  }
  if (pay.expectedAmount < pay.minimumAmount) throw new RelayRefusal("output-expected", `the order expects ${pay.expectedAmount}, less than its own minimum ${pay.minimumAmount}`);
  const slippage = BigInt(request.slippageBps ?? RELAY_DEFAULT_SLIPPAGE_BPS);
  const floor = (pay.expectedAmount * (10_000n - slippage)) / 10_000n;
  if (pay.minimumAmount < floor) {
    throw new RelayRefusal("output-minimum", `the order's minimum output ${pay.minimumAmount} is more than ${slippage} bps under its expected ${pay.expectedAmount}`);
  }
  checkDeadline("output-deadline", "the output deadline", order.output.deadline, nowS);

  // The input: exactly what is sent.
  if (input.payment.chainId !== source.slug) throw new RelayRefusal("input-chain", `the order is funded on "${input.payment.chainId}", the request sends on ${source.name} ("${source.slug}")`);
  if (!isAddr(input.payment.currency, request.sourceToken)) throw new RelayRefusal("input-currency", `the order is funded in ${input.payment.currency}, the request sends ${lower(request.sourceToken)}`);
  if (input.payment.amount !== request.amount) throw new RelayRefusal("input-amount", `the order is funded with ${input.payment.amount}, the request sends ${request.amount}`);

  // Refunds: on the source chain back to the sender in the token sent; on the destination to the recipient or the
  // sender; nowhere else. An unfilled order must have a way back on the source chain.
  let originRefund = false;
  for (const refund of input.refunds) {
    if (refund.chainId === source.slug) {
      if (!isAddr(refund.recipient, request.depositor)) throw new RelayRefusal("refund-recipient", `a source-chain refund goes to ${refund.recipient}, not the sender ${lower(request.depositor)}`);
      if (refund.currency !== input.payment.currency) throw new RelayRefusal("refund-currency", `a source-chain refund is in ${refund.currency}, not the token sent`);
      originRefund = true;
    } else if (refund.chainId === dest.slug) {
      if (!isAddr(refund.recipient, request.recipient) && !isAddr(refund.recipient, request.depositor)) {
        throw new RelayRefusal("refund-recipient", `a destination-chain refund goes to ${refund.recipient}, neither the recipient nor the sender`);
      }
      if (refund.currency.length !== 42) throw new RelayRefusal("refund-currency", "a destination-chain refund names no token");
    } else {
      throw new RelayRefusal("refund-chain", `a refund is payable on "${refund.chainId}", neither the source nor the destination chain`);
    }
    checkDeadline("refund-deadline", "a refund deadline", refund.deadline, nowS);
  }
  if (!originRefund) throw new RelayRefusal("refund-missing", "the order has no refund to the sender on the source chain");

  // The id and who signed it.
  const id = relayOrderId(order);
  if (typeof protocol.orderId !== "string" || lower(protocol.orderId) !== id) {
    throw new RelayRefusal("order-id-mismatch", `the quote names order ${String(protocol.orderId)}, the order data hashes to ${id}`);
  }
  const signer = relayOrderSigner(id, protocol.orderSignature);
  if (signer === null || signer !== order.solver) {
    throw new RelayRefusal("signature-invalid", signer === null ? "the order signature is not a valid signature" : `the order is signed by ${signer}, not by its solver ${order.solver}`);
  }

  // What the API says the payment is: it must describe the same deposit.
  const pd = protocol.paymentDetails as {chainId?: unknown; depository?: unknown; currency?: unknown; amount?: unknown} | null | undefined;
  if (pd === null || typeof pd !== "object") throw new RelayRefusal("payment-details", "the quote has no payment details");
  if (pd.chainId !== source.slug || typeof pd.depository !== "string" || lower(pd.depository) !== source.depository
    || typeof pd.currency !== "string" || lower(pd.currency) !== input.payment.currency
    || typeof pd.amount !== "string" || pd.amount !== input.payment.amount.toString(10)) {
    throw new RelayRefusal("payment-details", "the quote's payment details do not describe the order's input on the pinned depository");
  }

  const built = buildRelayDeposit(source, request.depositor, input.payment.currency, input.payment.amount, id);
  if (deposit !== undefined) {
    checkDepositTx(deposit, source, request, order, id);
    // Whatever the field checks above let through, the bytes signed are the bytes built here.
    if (lower(deposit.data as string) !== built.data || lower(deposit.to as string) !== built.to || deposit.value !== built.value) {
      throw new RelayRefusal("tx-calldata", "the deposit is not the call this module builds for the order");
    }
  }
  return {order, id, deposit: built, expectedAmount: pay.expectedAmount, minimumAmount: pay.minimumAmount, source, dest};
}

/** A refusal's text for a caller that wants a string (`onRefusal`, remote pins); rethrows anything else. */
export function relayRefusalReason(err: unknown): string {
  if (err instanceof RelayRefusal) return err.message;
  throw err;
}

/**
 * The request a `QuoteParams` describes, for the verifier. `dry` fills a missing address with `placeholder` (pricing
 * only). The sender is `refundAddress` — the engine sets it to the account that signs.
 */
export function relayRequestOf(params: QuoteParams, opts: {placeholder?: string; nowMs?: number} = {}): RelayRequest {
  const invalid = (what: string): never => { throw new RelayRefusal("request-invalid", what); };
  if (params.flex) invalid("the amount is sealed into the order (no flexible deposits)");
  if (!relayChain(params.sourceChain)) throw new RelayRefusal("chain-unsupported", `source chain ${params.sourceChain} is not a pinned Relay chain`);
  if (!relayChain(params.destChain)) throw new RelayRefusal("chain-unsupported", `destination chain ${params.destChain} is not a pinned Relay chain`);
  if (params.sourceChain === params.destChain) throw new RelayRefusal("chain-unsupported", "same-chain swaps are not served through the depository");
  let sourceToken: string;
  if (typeof params.sourceToken === "string" && ADDRESS.test(params.sourceToken)) sourceToken = params.sourceToken;
  else {
    const asset = sourceAssetOf(params);
    if (!asset) invalid(`source token ${String(params.sourceToken)} is not known on ${params.sourceChain}`);
    sourceToken = asset!.contract ?? RELAY_NATIVE;
    if (!ADDRESS.test(sourceToken)) invalid(`source token ${String(params.sourceToken)} has no EVM contract`);
  }
  if (typeof params.destToken !== "string" || !ADDRESS.test(params.destToken)) invalid("the destination token must be an EVM address (zero for the native coin)");
  if (typeof params.amountIn !== "string" || !/^[1-9]\d{0,77}$/.test(params.amountIn)) invalid("amount must be a positive base-unit integer");
  if (params.minAmountOut !== undefined && !/^(?:0|[1-9]\d{0,77})$/.test(params.minAmountOut)) invalid("the output floor must be a base-unit integer");
  const recipient = params.destAddress || opts.placeholder || "";
  if (!recipient) invalid("a live quote needs a recipient");
  if (!ADDRESS.test(recipient)) invalid("the recipient must be an EVM address");
  const depositor = params.refundAddress || opts.placeholder || "";
  if (!depositor) invalid("a live quote needs the sender's address (refundAddress)");
  if (!ADDRESS.test(depositor)) invalid("the sender's address must be an EVM address");
  return {
    sourceChain: params.sourceChain,
    destChain: params.destChain,
    sourceToken,
    destToken: params.destToken,
    amount: BigInt(params.amountIn),
    depositor,
    recipient,
    ...(params.minAmountOut !== undefined ? {minAmountOut: BigInt(params.minAmountOut)} : {}),
    ...(params.slippageBps !== undefined ? {slippageBps: params.slippageBps} : {}),
    ...(opts.nowMs !== undefined ? {nowMs: opts.nowMs} : {}),
  };
}

/** The order a quote of this provider carries (`providerData`), back in the form the verifier reads. */
export function relayProtocolOf(quote: Quote): RelayProtocolData | null {
  const pd = quote.providerData;
  if (!pd || typeof pd.orderData !== "string") return null;
  let orderData: unknown;
  let paymentDetails: unknown;
  try {
    orderData = JSON.parse(pd.orderData);
    paymentDetails = typeof pd.paymentDetails === "string" ? JSON.parse(pd.paymentDetails) : undefined;
  } catch {
    return null;
  }
  return {orderId: pd.orderId, hubType: pd.hubType, orderData, orderSignature: pd.orderSignature, paymentDetails};
}

/**
 * A quote of this provider against the request it answers: the order it carries is verified, its transaction is
 * that order's deposit, its approval names the pinned depository, and the amounts it shows are the order's. Throws
 * {@link RelayRefusal}. Used on the client of a remote provider and again before signing.
 */
export function checkRelayQuote(request: RelayRequest, quote: Quote, tx?: RelayDepositTx & {approvalAddress?: unknown}): VerifiedRelayOrder {
  if (quote === null || typeof quote !== "object" || quote.provider !== "relay") throw new RelayRefusal("quote-shape", "not a Relay quote");
  const t = tx ?? quote.txRequest;
  if (!t) throw new RelayRefusal("quote-shape", "the quote has no transaction");
  if (quote.depositAddress) throw new RelayRefusal("quote-shape", "a Relay quote pays the depository through its calldata, never a deposit address");
  if ((quote.txRequest as {serializedTx?: unknown; nativeFee?: unknown} | undefined)?.serializedTx !== undefined || (quote.txRequest as {nativeFee?: unknown} | undefined)?.nativeFee !== undefined) {
    throw new RelayRefusal("quote-shape", "a Relay deposit carries no extra native fee and no serialized transaction");
  }
  const v = verifyRelayOrder(request, relayProtocolOf(quote), t);
  const approval = (t as {approvalAddress?: unknown}).approvalAddress;
  if (v.deposit.approvalAddress === undefined ? approval !== undefined && approval !== "" : typeof approval !== "string" || lower(approval) !== v.deposit.approvalAddress) {
    throw new RelayRefusal("quote-approval", `the quote approves ${String(approval)}, the order needs ${v.deposit.approvalAddress ?? "no approval"}`);
  }
  if (quote.sourceAmount !== request.amount.toString(10) || quote.minDestAmount !== v.minimumAmount.toString(10) || quote.destAmount !== v.expectedAmount.toString(10)) {
    throw new RelayRefusal("quote-amounts", "the amounts the quote shows are not the order's");
  }
  // Gas is the one number of the call that no order binds: held to the band this module itself would set, so a
  // backend can neither starve the deposit (a paid revert) nor name an absurd limit. Absent = the wallet estimates.
  const gas = (t as {gasLimit?: unknown}).gasLimit;
  if (gas !== undefined) {
    const floor = v.deposit.approvalAddress === undefined ? RELAY_GAS_FLOOR_NATIVE : RELAY_GAS_FLOOR_ERC20;
    if (typeof gas !== "string" || !/^[1-9]\d{0,10}$/.test(gas) || BigInt(gas) < floor || BigInt(gas) > RELAY_GAS_CAP) {
      throw new RelayRefusal("quote-gas", `the gas limit ${String(gas).slice(0, 40)} is outside ${floor}–${RELAY_GAS_CAP}`);
    }
  }
  const now = request.nowMs ?? Date.now();
  if (typeof quote.validUntilMs !== "number" || !Number.isFinite(quote.validUntilMs) || quote.validUntilMs > now + RELAY_MAX_QUOTE_LIFE_MS) {
    throw new RelayRefusal("quote-expiry", "the quote claims to live longer than a Relay quote may");
  }
  if (typeof quote.intentId !== "string" || quote.intentId !== `relay:${String(quote.providerData?.requestId)}` || !/^relay:0x[0-9a-f]{64}$/.test(quote.intentId)) {
    throw new RelayRefusal("quote-shape", "the quote's id is not its Relay request id");
  }
  return v;
}

/** `RemotePins.verifyQuote`: the reason a remote Relay quote fails against the user's own request, or null. */
export function relayVerifyQuote(params: QuoteParams, quote: Quote): string | null {
  try {
    checkRelayQuote(relayRequestOf(params), quote);
    return null;
  } catch (err) {
    return relayRefusalReason(err);
  }
}

/** `RemotePins.verifyBuild`: a remote build must be the quote's own (verified) transaction, and is verified again. */
export function relayVerifyBuild(quote: Quote, tx: UnsignedTx, params?: QuoteParams): string | null {
  try {
    if (!params) throw new RelayRefusal("request-invalid", "the request this quote answered is not known on this side — quote again");
    if (tx.chain !== params.sourceChain) throw new RelayRefusal("tx-chain", `the build is for ${tx.chain}, not ${params.sourceChain}`);
    if (tx.serializedTx !== undefined || tx.memo !== undefined || tx.typedData !== undefined || tx.bodyBoc !== undefined) {
      throw new RelayRefusal("quote-shape", "a Relay deposit is one EVM call");
    }
    const v = checkRelayQuote(relayRequestOf(params), quote, tx);
    // The remote path has no client-side step after this one: an order is built for once.
    relayClearOrder(v.id, "build");
    return null;
  } catch (err) {
    return relayRefusalReason(err);
  }
}

/**
 * The app's pins for a remote Relay provider (`remoteProvider({name: "relay", ...relayPins})`): the only contract a
 * build may call or approve is the chain's depository, and every quote and build is verified on the client against
 * the user's own request.
 */
export const relayPins: RemotePins = Object.freeze({
  callTargets: (chain: string): readonly string[] => { const c = relayChain(chain); return c ? [c.depository] : []; },
  spenders: (chain: string): readonly string[] => { const c = relayChain(chain); return c ? [c.depository] : []; },
  verifyQuote: relayVerifyQuote,
  verifyBuild: relayVerifyBuild,
});
