// CS-13: every refusal this module raises carries a stable `reason` next to its text, and the text is unchanged.
// Everything below runs the module's real code paths; only `fetch` is replaced.
import type {Hex} from "viem";
import {generatePrivateKey, privateKeyToAccount} from "viem/accounts";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SWAP2_REFUSAL_REASONS, Swap2QuoteError, refusal, refusalOf, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {forgetClearedOrders} from "../src/cleared.js";
import {RELAY_DEPOSIT_NATIVE, RELAY_MAX_ORDER_AGE_S, RELAY_ORDER_LIFETIME_S, RELAY_ORDER_VERSION, relayChain} from "../src/config.js";
import {RelayRefusal} from "../src/order.js";
import {RelaySwap2Protocol} from "../src/protocol.js";
import {relayProvider, type RelayClearedStore} from "../src/provider.js";
import {buildRelayDeposit, checkRelayQuote, relayClearOrder, relayPins, verifyRelayOrder} from "../src/verify.js";
import {depositOf, loadQuote, protoOf, requestOf as fixtureRequest, type QuoteFixture} from "./fixtures.js";

const OTHER = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "user.arb-usdc_base-usdc"; // Arbitrum USDC → Base USDC, an ERC-20 deposit
const ETH = "user.op-eth_base-eth"; // OP ETH → Base ETH, a native deposit
const ARB = relayChain("eip155:42161")!;
const BASE = relayChain("eip155:8453")!;
// A key made for this run signs the USDC order's own id: a valid signature, by someone other than its solver.
const STRANGER = privateKeyToAccount(generatePrivateKey());
const STRANGER_SIG = await STRANGER.signMessage({message: {raw: protoOf(loadQuote(USDC)).orderId as Hex}});

/** Every reason a test below saw, checked against the union at the end. */
const seen = new Set<Swap2RefusalReason>();

interface Heard {text: string; info: Swap2RefusalInfo | undefined}
function paramsOf(f: QuoteFixture, over: Partial<QuoteParams> = {}): QuoteParams & {heard: Heard[]} {
  const heard: Heard[] = [];
  return {
    sourceChain: f.request.sourceChain, destChain: f.request.destChain, sourceToken: f.request.sourceToken, destToken: f.request.destToken,
    amountIn: f.request.amount, destAddress: f.request.recipient, refundAddress: f.request.depositor, dry: false,
    onRefusal: (text, info) => heard.push({text, info}), heard, ...over,
  };
}
function serve(body: unknown, status = 200, headers: Record<string, string> = {}, calls: string[] = []): typeof fetch {
  return (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {status, headers});
  }) as typeof fetch;
}
const at = (f: QuoteFixture, plusMs = 0) => vi.setSystemTime(f.request.nowMs + plusMs);

/** One refusal heard through `onRefusal`: exactly this text, classified as `info` (undefined: not classified). */
function expectHeard(params: {heard: Heard[]}, text: string, info: Swap2RefusalInfo | undefined): void {
  expect(params.heard).toHaveLength(1);
  expect(params.heard[0]!.text).toBe(text);
  expect(params.heard[0]!.info).toEqual(info);
  if (info) seen.add(info.reason);
}
/** A thrown refusal: exactly this text and this reason; a RelayRefusal stays one. */
function expectThrown(err: unknown, text: string, reason: Swap2RefusalReason | undefined, relay = true): void {
  expect(err).toBeInstanceOf(Error);
  expect((err as Error).message).toBe(text);
  if (relay) {
    expect(err).toBeInstanceOf(RelayRefusal);
    expect((err as Error).name).toBe("RelayRefusal");
  }
  expect(refusalOf(err)?.reason).toBe(reason);
  if (reason) seen.add(reason);
}
async function caught(p: Promise<unknown> | (() => unknown)): Promise<unknown> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

/** A live quote for a fixture, its response edited first. */
async function quoted(name: string, over: Partial<QuoteParams> = {}, edit: (f: QuoteFixture) => void = () => undefined, fetchImpl?: typeof fetch) {
  const f = loadQuote(name);
  edit(f);
  at(f);
  const calls: string[] = [];
  const provider = relayProvider({fetchImpl: fetchImpl ?? serve(f.response, 200, {}, calls)});
  const params = paramsOf(f, over);
  const quote = await provider.getQuote(params);
  return {f, provider, params, quote, calls};
}
async function built(name: string) {
  const q = await quoted(name);
  expect(q.quote).not.toBeNull();
  const tx = await q.provider.buildDeposit(q.quote!);
  return {...q, quote: q.quote!, tx};
}

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); forgetClearedOrders(); });
afterEach(() => { vi.useRealTimers(); });

describe("getQuote: Relay's HTTP answer", () => {
  const run = async (fetchImpl: typeof fetch, signal?: AbortSignal) => {
    const f = loadQuote(USDC);
    at(f);
    const params = paramsOf(f);
    expect(await relayProvider({fetchImpl}).getQuote(params, signal)).toBeNull();
    return params;
  };

  it("429 with Retry-After is rate_limited, with the wait and the status", async () => {
    expectHeard(await run(serve("Too Many Requests", 429, {"retry-after": "7"})), "relay: no quote — HTTP 429", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000});
    expectHeard(await run(serve({message: "Rate limit exceeded"}, 429, {"retry-after": "2"})), "relay: no quote — Rate limit exceeded", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 2000});
    expectHeard(await run(serve("", 429)), "relay: no quote — HTTP 429", {reason: "rate_limited", httpStatus: 429});
  });
  it("401 / 403 is key_rejected", async () => {
    expectHeard(await run(serve({message: "Invalid API key"}, 401)), "relay: no quote — Invalid API key", {reason: "key_rejected", httpStatus: 401});
    expectHeard(await run(serve("<html>Forbidden</html>", 403)), "relay: no quote — HTTP 403", {reason: "key_rejected", httpStatus: 403});
    expectHeard(await run(serve({message: "Unauthorized", errorCode: "UNAUTHORIZED"}, 401)), "relay: no quote — UNAUTHORIZED: Unauthorized", {reason: "key_rejected", httpStatus: 401});
  });
  it("5xx is upstream_unavailable with the status", async () => {
    expectHeard(await run(serve("<html>", 502)), "relay: no quote — HTTP 502", {reason: "upstream_unavailable", httpStatus: 502});
    expectHeard(await run(serve({message: "Service Unavailable"}, 503)), "relay: no quote — Service Unavailable", {reason: "upstream_unavailable", httpStatus: 503});
  });
  it("a non-JSON answer at any other status is an answer of another shape", async () => {
    expectHeard(await run(serve("<html>Not Found</html>", 404)), "relay: no quote — HTTP 404", {reason: "upstream_unavailable", httpStatus: 404});
  });

  it.each<[string, number, Swap2RefusalReason]>([
    ["AMOUNT_TOO_LOW", 400, "amount_too_small"],
    ["AMOUNT_TOO_HIGH", 400, "amount_too_large"],
    ["INVALID_RECIPIENT", 400, "recipient_mismatch"],
    ["NO_QUOTES", 400, "no_route"],
    ["NO_SWAP_ROUTES_FOUND", 400, "no_route"],
    ["INSUFFICIENT_LIQUIDITY", 400, "insufficient_liquidity"],
    ["CHAIN_DISABLED", 400, "chain_halted"],
    ["ROUTE_TEMPORARILY_RESTRICTED", 400, "chain_halted"],
    ["UNSUPPORTED_ROUTE", 400, "unsupported_pair"],
    ["UNSUPPORTED_CURRENCY", 400, "unsupported_pair"],
    ["SWAP_IMPACT_TOO_HIGH", 400, "price_check_failed"],
    // Relay's own code wins over the status.
    ["NO_QUOTES", 500, "no_route"],
    // A code this module does not know, and keys of Object.prototype, are a quote Relay does not have.
    ["SOMETHING_NEW", 400, "no_route"],
    ["constructor", 400, "no_route"],
    ["__proto__", 422, "no_route"],
  ])("errorCode %s at %i is %s", async (code, status, reason) => {
    const params = await run(serve({message: "Swap output amount is too small to cover fees", errorCode: code}, status));
    expectHeard(params, `relay: no quote — ${code}: Swap output amount is too small to cover fees`, {reason});
  });
  it.each<[string, number, Swap2RefusalInfo]>([
    // Relay's own failures keep the status they came with, whatever it was.
    ["SWAP_QUOTE_FAILED", 503, {reason: "upstream_unavailable", httpStatus: 503}],
    ["SWAP_QUOTE_FAILED", 400, {reason: "upstream_unavailable", httpStatus: 400}],
    ["REQUEST_TIMED_OUT", 400, {reason: "upstream_unavailable", httpStatus: 400}],
    ["RPC_HTTP_ERROR", 400, {reason: "upstream_unavailable", httpStatus: 400}],
    ["PRICE_FETCH_FAILED", 503, {reason: "upstream_unavailable", httpStatus: 503}],
    ["SERVICE_UNAVAILABLE", 503, {reason: "upstream_unavailable", httpStatus: 503}],
    ["UNAUTHORIZED_QUOTE", 400, {reason: "key_rejected", httpStatus: 400}],
    ["UNAUTHORIZED_QUOTE", 401, {reason: "key_rejected", httpStatus: 401}],
  ])("errorCode %s at %i carries the status", async (code, status, info) => {
    const params = await run(serve({message: "try again", errorCode: code}, status));
    expectHeard(params, `relay: no quote — ${code}: try again`, info);
  });
  it("a 429 wins over any code and keeps its wait", async () => {
    expectHeard(await run(serve({message: "slow down", errorCode: "ROUTE_TEMPORARILY_RESTRICTED"}, 429, {"retry-after": "4"})), "relay: no quote — ROUTE_TEMPORARILY_RESTRICTED: slow down", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 4000});
    expectHeard(await run(serve({message: "slow down", errorCode: "NO_QUOTES"}, 429)), "relay: no quote — NO_QUOTES: slow down", {reason: "rate_limited", httpStatus: 429});
  });
  it("a JSON refusal without a code is no_route", async () => {
    expectHeard(await run(serve({}, 400)), "relay: no quote — HTTP 400", {reason: "no_route"});
  });
  it("a body cut off by the caller's own abort is not classified; a status already received still is", async () => {
    const cutOff = (status: number, ctrl: AbortController): typeof fetch => (async () => {
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode("{\"steps\":"));
          ctrl.signal.addEventListener("abort", () => c.error(new DOMException("This operation was aborted", "AbortError")));
        },
      });
      setTimeout(() => ctrl.abort(), 5);
      return new Response(body, {status});
    }) as typeof fetch;
    for (const [status, text, info] of [
      [200, "relay: the quote response is not JSON", undefined],
      [400, "relay: no quote — HTTP 400", undefined],
      [503, "relay: no quote — HTTP 503", {reason: "upstream_unavailable", httpStatus: 503}],
    ] as const) {
      const ctrl = new AbortController();
      expectHeard(await run(cutOff(status, ctrl), ctrl.signal), text, info);
    }
  });

  it("a 200 that is not JSON, or too large to read, is upstream_unavailable", async () => {
    expectHeard(await run(serve("not json")), "relay: the quote response is not JSON", {reason: "upstream_unavailable"});
    expectHeard(await run(serve(`"${"x".repeat(600 * 1024)}"`)), "relay: the quote response is not JSON", {reason: "upstream_unavailable"});
    expectHeard(await run(serve("7")), "relay: the quote response is not JSON", {reason: "upstream_unavailable"});
  });
  it("a network failure or this module's own timeout is upstream_unavailable", async () => {
    expectHeard(await run((async () => { throw new TypeError("fetch failed"); }) as typeof fetch), "relay: quote request failed — fetch failed", {reason: "upstream_unavailable"});
    const timedOut = (async () => { throw new DOMException("The operation was aborted due to timeout", "TimeoutError"); }) as typeof fetch;
    expectHeard(await run(timedOut), "relay: quote request failed — The operation was aborted due to timeout", {reason: "upstream_unavailable"});
    // With a caller's signal that did not fire, the module's own timeout is still Relay's failure.
    expectHeard(await run(timedOut, new AbortController().signal), "relay: quote request failed — The operation was aborted due to timeout", {reason: "upstream_unavailable"});
  });
  it("the caller's own abort is not upstream_unavailable", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error("aborted by the caller");
      return new Response("{}");
    }) as typeof fetch;
    expectHeard(await run(fetchImpl, ctrl.signal), "relay: quote request failed — aborted by the caller", undefined);
  });
  it("a classification the app's own fetch put on its error survives", async () => {
    const fetchImpl = (async () => { throw refusal("rate_limited", "proxy: slow down", {retryAfterMs: 3000, httpStatus: 429}); }) as typeof fetch;
    expectHeard(await run(fetchImpl), "relay: quote request failed — proxy: slow down", {reason: "rate_limited", retryAfterMs: 3000, httpStatus: 429});
  });
});

describe("getQuote: the request", () => {
  it.each<[string, Partial<QuoteParams>, string]>([
    ["a non-EVM source", {sourceChain: "solana:mainnet"}, "relay: source chain solana:mainnet is not a pinned Relay chain [chain-unsupported]"],
    ["a chain Relay does not serve", {destChain: "eip155:14"}, "relay: destination chain eip155:14 is not a pinned Relay chain [chain-unsupported]"],
    ["the same chain", {destChain: "eip155:42161"}, "relay: same-chain swaps are not served through the depository [chain-unsupported]"],
    ["a flexible amount", {flex: true}, "relay: the amount is sealed into the order (no flexible deposits) [request-invalid]"],
    ["a source token not in the catalog", {sourceToken: "NOPE"}, "relay: source token NOPE is not known on eip155:42161 [request-invalid]"],
    ["a destination token that is not an address", {destToken: "USDC"}, "relay: the destination token must be an EVM address (zero for the native coin) [request-invalid]"],
  ])("%s is unsupported_pair, refused without asking Relay", async (_n, over, text) => {
    const {params, calls, quote} = await quoted(USDC, over);
    expect(quote).toBeNull();
    expect(calls).toHaveLength(0);
    expectHeard(params, text, {reason: "unsupported_pair"});
  });
  it.each<[string, Partial<QuoteParams>, string]>([
    ["a live quote with no recipient", {destAddress: ""}, "relay: a live quote needs a recipient [request-invalid]"],
    ["a live quote with no sender", {refundAddress: ""}, "relay: a live quote needs the sender's address (refundAddress) [request-invalid]"],
    ["a recipient that is not an address", {destAddress: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE"}, "relay: the recipient must be an EVM address [request-invalid]"],
    ["a zero amount", {amountIn: "0"}, "relay: amount must be a positive base-unit integer [request-invalid]"],
    ["a floor that is not an integer", {minAmountOut: "1.5"}, "relay: the output floor must be a base-unit integer [request-invalid]"],
  ])("%s is the caller's own bug: not classified", async (_n, over, text) => {
    const {params, quote} = await quoted(USDC, over);
    expect(quote).toBeNull();
    expectHeard(params, text, undefined);
  });
  it("a zero-address recipient or sender is recipient_mismatch", async () => {
    expectHeard((await quoted(USDC, {destAddress: ZERO})).params, "relay: the recipient is the zero address [request-invalid]", {reason: "recipient_mismatch"});
    expectHeard((await quoted(USDC, {refundAddress: ZERO})).params, "relay: the depositor is the zero address [request-invalid]", {reason: "recipient_mismatch"});
  });
  it("slippage past the module's cap is policy_refused", async () => {
    expectHeard((await quoted(USDC, {slippageBps: 6000})).params, "relay: slippage must be a whole number of basis points up to 5000 [request-invalid]", {reason: "policy_refused"});
  });
});

describe("getQuote: the answer, verified on the device", () => {
  const fee = {recipientChainId: "base", recipient: OTHER, currencyChainId: "base", currency: OTHER, amount: "1"};
  it.each<[string, (f: QuoteFixture) => void, Swap2RefusalReason, (f: QuoteFixture) => string]>([
    ["no steps", (f) => { f.response.steps = []; }, "upstream_unavailable", () => "relay: the quote has no steps [quote-steps]"],
    ["a malformed step", (f) => { (f.response.steps as unknown[]) = [null]; }, "upstream_unavailable", () => "relay: the quote has a malformed step [quote-steps]"],
    ["only an approval", (f) => { f.response.steps = f.response.steps.filter((s) => s.id === "approve"); }, "upstream_unavailable", () => "relay: the quote has no deposit step [quote-steps]"],
    ["a deposit with no transaction", (f) => { (f.response.steps.at(-1)!.items as unknown[]) = [{}]; }, "upstream_unavailable", () => "relay: the deposit step has no transaction [quote-steps]"],
    ["no request id", (f) => { f.response.steps.at(-1)!.requestId = "0x12"; }, "upstream_unavailable", () => "relay: the quote has no request id to track the deposit by [quote-steps]"],
    ["a swap step", (f) => { f.response.steps.unshift({id: "swap", requestId: f.response.steps[0]!.requestId, items: f.response.steps.at(-1)!.items}); }, "unsupported_pair", () => `relay: the quote needs a "swap" step, only a single deposit is signed [quote-steps]`],
    ["two deposits", (f) => { f.response.steps.push(f.response.steps.at(-1)!); }, "unsupported_pair", () => "relay: the quote has more than one deposit step [quote-steps]"],
    ["a deposit of two transactions", (f) => { const s = f.response.steps.at(-1)!; s.items.push(s.items[0]!); }, "unsupported_pair", () => "relay: the deposit step is not a single transaction [quote-steps]"],
    ["no protocol data", (f) => { delete (f.response as {protocol?: unknown}).protocol; }, "upstream_unavailable", () => "relay: the quote carries no order (protocol.v2) — nothing to check the deposit against [protocol-data-missing]"],
    ["no order data", (f) => { (protoOf(f) as {orderData: unknown}).orderData = null; }, "upstream_unavailable", () => "relay: the quote carries no order data — nothing to check the deposit against [protocol-data-missing]"],
    ["a malformed order", (f) => { protoOf(f).orderData.salt = "x"; }, "upstream_unavailable", () => "relay: the order's salt is not an unsigned integer in range [order-malformed]"],
    ["an order version it does not read", (f) => { protoOf(f).orderData.version = "v9"; }, "upstream_unavailable", () => `relay: order version "v9" is not ${RELAY_ORDER_VERSION} [order-version]`],
    ["another hub", (f) => { protoOf(f).hubType = "offchain"; }, "unsupported_pair", () => `relay: the order settles through a "offchain" hub, only "onchain" is read [hub-type]`],
    ["destination calls", (f) => { protoOf(f).orderData.output.calls = ["0x00"]; }, "policy_refused", () => "relay: the order runs calls on the destination — only plain payments are accepted [order-calls]"],
    ["order-level fees", (f) => { protoOf(f).orderData.fees = [fee]; }, "policy_refused", () => "relay: the order carries order-level fees, which this module does not show and does not accept [order-fees]"],
    ["a zero-weight input", (f) => { protoOf(f).orderData.inputs[0]!.payment.weight = "0"; }, "policy_refused", () => "relay: the order's input has zero weight [input-weight]"],
    ["an unpinned solver", (f) => { protoOf(f).orderData.solver = OTHER; }, "recipient_unverifiable", () => `relay: solver ${OTHER} on "base" is not a pinned Relay solver [solver-not-pinned]`],
    ["a deposit into another contract", (f) => { depositOf(f).to = OTHER; }, "vault_mismatch", () => `relay: the deposit calls ${OTHER}, not the ${ARB.name} depository ${ARB.depository} — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]`],
    ["the whole-allowance deposit", (f) => { const t = depositOf(f); t.data = `0x5a1ee3ac${t.data.slice(10, 138)}${t.data.slice(-64)}`; }, "policy_refused", () => "relay: the deposit uses depositErc20 without an amount, which takes the whole allowance [tx-selector]"],
    ["an order paying someone else", (f) => { protoOf(f).orderData.output.payments[0]!.recipient = OTHER; }, "recipient_mismatch", (f) => `relay: the order pays ${OTHER}, not the recipient ${f.request.recipient.toLowerCase()} [output-recipient]`],
    ["an order paying on another chain", (f) => { protoOf(f).orderData.output.chainId = "optimism"; }, "recipient_mismatch", () => `relay: the order pays on "optimism", the request is for ${BASE.name} ("${BASE.slug}") [output-chain]`],
    ["a refund to someone else", (f) => { protoOf(f).orderData.inputs[0]!.refunds[0]!.recipient = OTHER; }, "recipient_mismatch", (f) => `relay: a source-chain refund goes to ${OTHER}, not the sender ${f.request.depositor.toLowerCase()} [refund-recipient]`],
    ["an order paying in another token", (f) => { protoOf(f).orderData.output.payments[0]!.currency = OTHER; }, "price_check_failed", (f) => `relay: the order pays in ${OTHER}, the request is for ${f.request.destToken.toLowerCase()} [output-currency]`],
    ["an order funded with another amount", (f) => { protoOf(f).orderData.inputs[0]!.payment.amount = "1"; }, "policy_refused", (f) => `relay: the order is funded with 1, the request sends ${f.request.amount} [input-amount]`],
    ["an order id that is not the order's", (f) => { protoOf(f).orderId = `0x${"00".repeat(32)}`; }, "recipient_unverifiable", () => `relay: the quote names order 0x${"00".repeat(32)}, the order data hashes to ${protoOf(loadQuote(USDC)).orderId} [order-id-mismatch]`],
    ["no signature", (f) => { protoOf(f).orderSignature = "0x"; }, "recipient_unverifiable", () => "relay: the order signature is not a valid signature [signature-invalid]"],
    ["no payment details", (f) => { (protoOf(f) as {paymentDetails: unknown}).paymentDetails = null; }, "upstream_unavailable", () => "relay: the quote has no payment details [payment-details]"],
    ["payment details on another depository", (f) => { protoOf(f).paymentDetails.depository = OTHER; }, "vault_mismatch", () => "relay: the quote's payment details do not describe the order's input on the pinned depository [payment-details]"],
    ["an app fee", (f) => { (f.response as {fees: unknown}).fees = {app: {amount: "5"}}; }, "policy_refused", () => "relay: the quote charges an app fee this module did not ask for [app-fee]"],
    ["a gas top-up", (f) => { (f.response.details as {currencyGasTopup?: unknown}).currencyGasTopup = {amount: "5"}; }, "policy_refused", () => "relay: the quote converts part of the output into a gas top-up this module did not ask for [gas-topup]"],
    ["two inputs", (f) => { const o = protoOf(f).orderData; o.inputs.push(o.inputs[0]!); }, "policy_refused", () => "relay: the order has 2 inputs, exactly one is signed for [order-inputs]"],
    ["two output payments", (f) => { const o = protoOf(f).orderData; o.output.payments.push(o.output.payments[0]!); }, "policy_refused", () => "relay: the order pays 2 outputs, exactly one is accepted [order-payments]"],
    ["a zero minimum output", (f) => { protoOf(f).orderData.output.payments[0]!.minimumAmount = "0"; }, "price_check_failed", () => "relay: the order's minimum output is zero [output-minimum]"],
    ["an expected amount under the minimum", (f) => { const p = protoOf(f).orderData.output.payments[0]!; p.expectedAmount = (BigInt(p.minimumAmount) - 1n).toString(); }, "price_check_failed", (f) => { const p = protoOf(f).orderData.output.payments[0]!; return `relay: the order expects ${p.expectedAmount}, less than its own minimum ${p.minimumAmount} [output-expected]`; }],
    ["an order funded on another chain", (f) => { protoOf(f).orderData.inputs[0]!.payment.chainId = "optimism"; }, "policy_refused", () => `relay: the order is funded on "optimism", the request sends on ${ARB.name} ("${ARB.slug}") [input-chain]`],
    ["an order funded in another token", (f) => { protoOf(f).orderData.inputs[0]!.payment.currency = OTHER; }, "policy_refused", (f) => `relay: the order is funded in ${OTHER}, the request sends ${f.request.sourceToken.toLowerCase()} [input-currency]`],
    ["a source-chain refund in another token", (f) => { protoOf(f).orderData.inputs[0]!.refunds[0]!.currency = OTHER; }, "policy_refused", () => `relay: a source-chain refund is in ${OTHER}, not the token sent [refund-currency]`],
    ["a destination-chain refund to someone else", (f) => { protoOf(f).orderData.inputs[0]!.refunds[1]!.recipient = OTHER; }, "recipient_mismatch", () => `relay: a destination-chain refund goes to ${OTHER}, neither the recipient nor the sender [refund-recipient]`],
    ["a destination-chain refund in no token", (f) => { protoOf(f).orderData.inputs[0]!.refunds[1]!.currency = "0x"; }, "policy_refused", () => "relay: a destination-chain refund names no token [refund-currency]"],
    ["a refund on a third chain", (f) => { protoOf(f).orderData.inputs[0]!.refunds[0]!.chainId = "optimism"; }, "recipient_mismatch", () => `relay: a refund is payable on "optimism", neither the source nor the destination chain [refund-chain]`],
    ["no source-chain refund", (f) => { const i = protoOf(f).orderData.inputs[0]!; i.refunds = i.refunds.slice(1); }, "policy_refused", () => "relay: the order has no refund to the sender on the source chain [refund-missing]"],
    ["a valid signature by someone other than the solver", (f) => { protoOf(f).orderSignature = STRANGER_SIG; }, "recipient_unverifiable", (f) => `relay: the order is signed by ${STRANGER.address.toLowerCase()}, not by its solver ${protoOf(f).orderData.solver.toLowerCase()} [signature-invalid]`],
  ])("a response with %s", async (_n, edit, reason, text) => {
    const {params, quote, f} = await quoted(USDC, {}, edit);
    expect(quote).toBeNull();
    expectHeard(params, text(f), {reason});
  });

  it("a route that swaps on the source chain names a router: vault_mismatch", async () => {
    const {params, f} = await quoted("arb-arb_base-eth");
    const to = depositOf(f).to;
    expectHeard(params, `relay: the deposit calls ${to}, not the ${ARB.name} depository ${ARB.depository} — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]`, {reason: "vault_mismatch"});
  });
  it("a minimum under the caller's floor or slippage is price_check_failed", async () => {
    const min = BigInt(protoOf(loadQuote(ETH)).orderData.output.payments[0]!.minimumAmount);
    const expected = BigInt(protoOf(loadQuote(ETH)).orderData.output.payments[0]!.expectedAmount);
    expectHeard((await quoted(ETH, {minAmountOut: (min + 1n).toString()})).params, `relay: the order's minimum output ${min} is under the caller's floor ${min + 1n} [output-minimum]`, {reason: "price_check_failed"});
    expectHeard((await quoted(ETH, {slippageBps: 100})).params, `relay: the order's minimum output ${min} is more than 100 bps under its expected ${expected} [output-minimum]`, {reason: "price_check_failed"});
  });
  it("an order already too old is quote_expired; one living too long is policy_refused", async () => {
    const f = loadQuote(USDC);
    const deadline = protoOf(f).orderData.output.deadline;
    const ask = async (plusMs: number) => {
      vi.setSystemTime(f.request.nowMs + plusMs);
      const params = paramsOf(f);
      expect(await relayProvider({fetchImpl: serve(f.response)}).getQuote(params)).toBeNull();
      return {params, left: deadline - Math.floor((f.request.nowMs + plusMs) / 1000)};
    };
    const old = await ask(11 * 60_000);
    expectHeard(old.params, `relay: the output deadline is ${old.left} s away: the order is older than ${RELAY_MAX_ORDER_AGE_S} s or already past it [output-deadline]`, {reason: "quote_expired"});
    const far = await ask(-10 * 60_000);
    expectHeard(far.params, `relay: the output deadline is ${far.left} s away, past the ${RELAY_ORDER_LIFETIME_S} s an order lives [output-deadline]`, {reason: "policy_refused"});
  });
});

describe("buildDeposit and preflightDeposit", () => {
  it("a quote priced without the real addresses is policy_refused, marked or not", async () => {
    const f = loadQuote("base-eth_arb-eth");
    at(f);
    const provider = relayProvider({fetchImpl: serve(f.response)});
    const quote = (await provider.getQuote(paramsOf(f, {dry: true, destAddress: "", refundAddress: ""})))!;
    expectThrown(await caught(provider.buildDeposit(quote)), "relay: a quote priced without the real addresses is never built — quote again with them [request-invalid]", "policy_refused");
    expectThrown(await caught(provider.preflightDeposit!(quote, {chain: f.request.sourceChain, to: OTHER, value: "0"})), "relay: a quote priced without the real addresses is never signed [request-invalid]", "policy_refused");
    const stripped = {...quote, providerData: {...quote.providerData!}};
    delete stripped.providerData.placeholder;
    expectThrown(await caught(provider.buildDeposit(stripped)), "relay: a quote priced without the real addresses is never built or signed — quote again with them [request-invalid]", "policy_refused");
  });
  it("a quote with no transaction stays a plain Error, policy_refused", async () => {
    const {provider, quote} = await built(USDC);
    const err = await caught(provider.buildDeposit({...quote, txRequest: undefined} as unknown as Quote));
    expect(Object.getPrototypeOf(err)).toBe(Error.prototype);
    expect((err as Error).name).toBe("Error");
    expectThrown(err, "swap2: Relay quote has no transaction request", "policy_refused", false);
  });
  it("a quote that no longer says what was asked is policy_refused", async () => {
    const {provider, quote} = await built(USDC);
    expectThrown(await caught(provider.buildDeposit({...quote, providerData: {...quote.providerData!, recipient: OTHER}})), "relay: the quote no longer says what was asked when it was issued — quote again [request-invalid]", "policy_refused");
  });
  it("an order grown stale is quote_expired at build and at signing", async () => {
    const {provider, quote, tx, f} = await built(ETH);
    at(f, 11 * 60_000);
    const left = protoOf(f).orderData.output.deadline - Math.floor((f.request.nowMs + 11 * 60_000) / 1000);
    const text = `relay: the output deadline is ${left} s away: the order is older than ${RELAY_MAX_ORDER_AGE_S} s or already past it [output-deadline]`;
    expectThrown(await caught(provider.buildDeposit(quote)), text, "quote_expired");
    expectThrown(await caught(provider.preflightDeposit!(quote, tx)), text, "quote_expired");
  });
  it("an order cleared once is policy_refused the second time, in memory or in the app's store", async () => {
    const {provider, quote, tx} = await built(ETH);
    await provider.preflightDeposit!(quote, tx);
    const text = `relay: order ${quote.providerData!.orderId} was already cleared for a deposit — quote again [order-reused]`;
    expectThrown(await caught(provider.preflightDeposit!(quote, tx)), text, "policy_refused");
    forgetClearedOrders();
    const store: RelayClearedStore = {has: () => true, add: () => undefined};
    const withStore = relayProvider({fetchImpl: serve({}), clearedStore: store});
    expectThrown(await caught(withStore.preflightDeposit!(quote, tx)), text, "policy_refused");
  });
  it("an app store that fails is the app's own error, passed on unclassified", async () => {
    const {quote, tx} = await built(ETH);
    const store: RelayClearedStore = {has: () => { throw new Error("store offline"); }, add: () => undefined};
    const err = await caught(relayProvider({fetchImpl: serve({}), clearedStore: store}).preflightDeposit!(quote, tx));
    expect((err as Error).message).toBe("store offline");
    expect(refusalOf(err)).toBeUndefined();
  });

  it.each<[string, (t: UnsignedTx, q: Quote) => UnsignedTx, Swap2RefusalReason, (t: UnsignedTx, q: Quote) => string]>([
    ["another chain label", (t) => ({...t, chain: "eip155:8453"}), "vault_mismatch", () => "relay: the deposit is for eip155:8453, not eip155:42161 [tx-chain]"],
    ["another chain id", (t) => ({...t, chainId: 8453}), "vault_mismatch", () => "relay: the deposit is for chain 8453, not 42161 [tx-chain]"],
    ["another target", (t) => ({...t, to: OTHER}), "vault_mismatch", () => `relay: the deposit calls ${OTHER}, not the ${ARB.name} depository ${ARB.depository} — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]`],
    ["another spender", (t) => ({...t, approvalAddress: OTHER}), "vault_mismatch", () => `relay: the quote approves ${OTHER}, the order needs ${ARB.depository} [quote-approval]`],
    ["a serialized transaction beside it", (t) => ({...t, serializedTx: "AA=="}), "policy_refused", () => "relay: a Relay deposit is one EVM call [quote-shape]"],
    ["a value", (t) => ({...t, value: "1"}), "policy_refused", () => "relay: the deposit sends 1 wei, it must send 0 [tx-value]"],
    ["no calldata", (t) => { const {data: _d, ...rest} = t; return rest; }, "policy_refused", () => "relay: the deposit has no calldata [tx-calldata]"],
    ["a gas limit under the floor", (t) => ({...t, gasLimit: "1"}), "policy_refused", () => "relay: the gas limit 1 is outside 180000–60000000 [quote-gas]"],
    ["another order id in the calldata", (t) => ({...t, data: `${t.data!.slice(0, -2)}00`}), "recipient_unverifiable", (t, q) => `relay: the deposit names order 0x${t.data!.slice(-64, -2)}00, the order received hashes to ${q.providerData!.orderId} [tx-id]`],
    ["another depositor in the calldata", (t) => ({...t, data: `${t.data!.slice(0, 10)}${OTHER.slice(2).padStart(64, "0")}${t.data!.slice(74)}`}), "recipient_mismatch", (_t, q) => `relay: the deposit is credited to ${OTHER}, not to the sender ${q.providerData!.depositor} [tx-depositor]`],
    ["another token in the calldata", (t) => ({...t, data: `${t.data!.slice(0, 74)}${OTHER.slice(2).padStart(64, "0")}${t.data!.slice(138)}`}), "policy_refused", (_t, q) => `relay: the deposit moves ${OTHER}, the order's input is ${q.providerData!.sourceToken} [tx-token]`],
    ["another amount in the calldata", (t) => ({...t, data: `${t.data!.slice(0, 138)}${"1".padStart(64, "0")}${t.data!.slice(202)}`}), "policy_refused", (_t, q) => `relay: the deposit moves 1, the order's input is ${q.providerData!.amount} [tx-amount]`],
    ["an unknown function", (t) => ({...t, data: `0xdeadbeef${t.data!.slice(10)}`}), "policy_refused", () => "relay: the deposit calls 0xdeadbeef, not a known deposit function [tx-selector]"],
    ["the native deposit for a token", (t) => ({...t, data: `${RELAY_DEPOSIT_NATIVE}${t.data!.slice(10)}`}), "policy_refused", () => "relay: the deposit calls depositNative for an order whose input is a token [tx-selector]"],
    ["calldata of another length", (t) => ({...t, data: `${t.data!}00`}), "policy_refused", () => "relay: the deposit calldata is 133 bytes, not 132 [tx-calldata]"],
    ["a depositor word that is not an address", (t) => ({...t, data: `${t.data!.slice(0, 10)}${"f".repeat(64)}${t.data!.slice(74)}`}), "policy_refused", () => "relay: the depositor argument is not a padded address [tx-calldata]"],
    ["a token word that is not an address", (t) => ({...t, data: `${t.data!.slice(0, 74)}${"f".repeat(64)}${t.data!.slice(138)}`}), "policy_refused", () => "relay: the token argument is not a padded address [tx-calldata]"],
  ])("signing a transaction with %s", async (_n, edit, reason, text) => {
    const {provider, quote, tx} = await built(USDC);
    expectThrown(await caught(provider.preflightDeposit!(quote, edit(tx, quote))), text(tx, quote), reason);
  });

  it.each<[string, (q: Quote) => Quote, Swap2RefusalReason, string]>([
    ["a lower minimum shown", (q) => ({...q, minDestAmount: "1"}), "price_check_failed", "relay: the amounts the quote shows are not the order's [quote-amounts]"],
    ["a deposit address", (q) => ({...q, depositAddress: OTHER}), "vault_mismatch", "relay: a Relay quote pays the depository through its calldata, never a deposit address [quote-shape]"],
    ["a native fee", (q) => ({...q, txRequest: {...q.txRequest!, nativeFee: "1"} as never}), "policy_refused", "relay: a Relay deposit carries no extra native fee and no serialized transaction [quote-shape]"],
    ["another provider's name", (q) => ({...q, provider: "lifi"}), "policy_refused", "relay: not a Relay quote [quote-shape]"],
    ["a lifetime past a Relay quote's", (q) => ({...q, validUntilMs: Date.now() + 3_600_000}), "policy_refused", "relay: the quote claims to live longer than a Relay quote may [quote-expiry]"],
    ["an order that is not JSON", (q) => ({...q, providerData: {...q.providerData!, orderData: "{"}}), "upstream_unavailable", "relay: the quote carries no order (protocol.v2) — nothing to check the deposit against [protocol-data-missing]"],
    ["an id that is not its request id", (q) => ({...q, intentId: `relay:0x${"00".repeat(32)}`}), "policy_refused", "relay: the quote's id is not its Relay request id [quote-shape]"],
  ])("building a quote with %s", async (_n, edit, reason, text) => {
    const {provider, quote} = await built(USDC);
    expectThrown(await caught(provider.buildDeposit(edit(quote))), text, reason);
  });
  it("a quote checked without any transaction is policy_refused", async () => {
    const {quote, f} = await built(USDC);
    expectThrown(await caught(() => checkRelayQuote(fixtureRequest(f), {...quote, txRequest: undefined} as unknown as Quote)), "relay: the quote has no transaction [quote-shape]", "policy_refused");
  });
  it("a record of cleared orders full of live entries is policy_refused", async () => {
    const {provider, quote, tx} = await built(USDC);
    for (let i = 0; i < 4096; i++) relayClearOrder(`0x${i.toString(16).padStart(64, "0")}`, "sign");
    expectThrown(await caught(provider.preflightDeposit!(quote, tx)), "relay: too many deposits cleared in the last minutes — try again later [order-reused]", "policy_refused");
  });
});

describe("remote pins", () => {
  it("reasonOf classifies each text verifyQuote and verifyBuild return", async () => {
    const {quote, params, tx, f} = await built(USDC);
    const quoteText = (over: Partial<QuoteParams>, q: Quote = quote) => relayPins.verifyQuote!({...params, ...over}, q)!;
    const cases: [string | null, Swap2RefusalReason, string][] = [
      [quoteText({destAddress: OTHER}), "recipient_mismatch", `relay: the order pays ${f.request.recipient.toLowerCase()}, not the recipient ${OTHER} [output-recipient]`],
      [quoteText({amountIn: "24999999"}), "policy_refused", `relay: the order is funded with ${f.request.amount}, the request sends 24999999 [input-amount]`],
      [quoteText({refundAddress: OTHER}), "recipient_mismatch", `relay: a source-chain refund goes to ${f.request.depositor.toLowerCase()}, not the sender ${OTHER} [refund-recipient]`],
      [quoteText({}, {...quote, txRequest: {...quote.txRequest!, to: OTHER}}), "vault_mismatch", `relay: the deposit calls ${OTHER}, not the ${ARB.name} depository ${ARB.depository} — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]`],
      [quoteText({sourceChain: "eip155:14"}), "unsupported_pair", "relay: source chain eip155:14 is not a pinned Relay chain [chain-unsupported]"],
      [relayPins.verifyBuild!(quote, tx) as string | null, "policy_refused", "relay: the request this quote answered is not known on this side — quote again [request-invalid]"],
      [relayPins.verifyBuild!(quote, {...tx, chain: "eip155:1"}, params) as string | null, "vault_mismatch", "relay: the build is for eip155:1, not eip155:42161 [tx-chain]"],
      [relayPins.verifyBuild!(quote, {...tx, memo: "x"}, params) as string | null, "policy_refused", "relay: a Relay deposit is one EVM call [quote-shape]"],
    ];
    for (const [text, reason, want] of cases) {
      expect(text).toBe(want);
      expect(relayPins.reasonOf!(text!)).toEqual({reason});
      seen.add(reason);
    }
    // A build goes through once; the second is the order reused.
    expect(relayPins.verifyBuild!(quote, tx, params)).toBeNull();
    const again = relayPins.verifyBuild!(quote, tx, params) as string | null;
    expect(again).toBe(`relay: order ${quote.providerData!.orderId} was already cleared for a deposit — quote again [order-reused]`);
    expect(relayPins.reasonOf!(again!)).toEqual({reason: "policy_refused"});
  });
  it("reasonOf leaves the caller's own malformed request and unknown texts unclassified", async () => {
    const {quote, params} = await built(USDC);
    const text = relayPins.verifyQuote!({...params, destAddress: "not-an-address"}, quote);
    expect(text).toBe("relay: the recipient must be an EVM address [request-invalid]");
    expect(relayPins.reasonOf!(text!)).toBeUndefined();
    expect(relayPins.reasonOf!("relay: something else")).toBeUndefined();
  });
  it("a remote stub's refusal carries the pins' reason", async () => {
    const {quote, params, tx} = await built(USDC);
    const lying = {...quote, txRequest: {...quote.txRequest!, to: OTHER}};
    const answers: Record<string, unknown> = {quote: lying};
    const fetchImpl = (async (url: RequestInfo | URL) => new Response(JSON.stringify(answers[String(url).split("/").pop()!]))) as typeof fetch;
    const stub = remoteProvider({name: "relay", baseUrl: "https://backend.example/api/swap2", fetchImpl, ...relayPins});
    const inner = `relay: the deposit calls ${OTHER}, not the ${ARB.name} depository ${ARB.depository} — routes that first swap on the source chain go through a router and are not signed by this module [tx-target]`;
    expectThrown(await caught(stub.getQuote(params)), `relay: the quote fails this app's own check — ${inner.slice(0, 240)}`, "vault_mismatch", false);
    // An honest quote, then a build that names another chain.
    answers.quote = quote;
    answers.build = {...tx, chain: "eip155:10"};
    expect(await stub.getQuote(params)).not.toBeNull();
    expectThrown(await caught(stub.buildDeposit(quote)), "relay: the build fails this app's own check — relay: the build is for eip155:10, not eip155:42161 [tx-chain]", "vault_mismatch", false);
  });
});

describe("through the engine", () => {
  it("a throttled Relay makes the engine's no-route error rate_limited, its text unchanged", async () => {
    const f = loadQuote(USDC);
    at(f);
    const protocol = new RelaySwap2Protocol(undefined, {fromChain: "eip155:42161", fetchImpl: serve("slow down", 429, {"retry-after": "5"})});
    const err = await caught(protocol.quoteSwap2({fromToken: "USDC", toToken: f.request.destToken, toChain: 8453, recipient: f.request.recipient, fromTokenAmount: BigInt(f.request.amount)}));
    expect(err).toBeInstanceOf(Swap2QuoteError);
    expect((err as Error).message).toBe("swap2: no route available for the requested pair :: relay: no quote — HTTP 429");
    // The engine's combined reason keeps the wait (core's combinedRefusal); each venue's refusal keeps its status too.
    expect(refusalOf(err)).toEqual({reason: "rate_limited", retryAfterMs: 5000});
    expect((err as Swap2QuoteError).refusals).toEqual([{provider: "relay", message: "relay: no quote — HTTP 429", reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000}]);
  });
  it("an order paying someone else makes it recipient_mismatch", async () => {
    const f = loadQuote(USDC);
    protoOf(f).orderData.output.payments[0]!.recipient = OTHER;
    at(f);
    const protocol = new RelaySwap2Protocol(undefined, {fromChain: "eip155:42161", fetchImpl: serve(f.response)});
    const err = await caught(protocol.quoteSwap2({fromToken: "USDC", toToken: f.request.destToken, toChain: 8453, recipient: f.request.recipient, fromTokenAmount: BigInt(f.request.amount)}));
    expect(refusalOf(err)?.reason).toBe("recipient_mismatch");
    expect((err as Error).message).toMatch(/^swap2: no route available for the requested pair :: relay: the order pays 0x1111111111111111111111111111111111111111, not the recipient 0x[0-9a-f]{40} \[output-recipient\]$/);
  });
});

describe("not refusals", () => {
  it("a bad configuration is not classified", () => {
    for (const [config, text] of [
      [{baseUrl: "ftp://x"}, "relay: baseUrl must use http or https"],
      [{quoteTtlMs: 300_001}, "relay: quoteTtlMs must be an integer between 1 and 300000"],
      [{apiKey: "a\nb"}, "relay: apiKey must be a printable string"],
    ] as const) {
      const err = (() => { try { relayProvider(config); } catch (e) { return e; } return null; })();
      expect((err as Error).message).toBe(text);
      expect(refusalOf(err)).toBeUndefined();
    }
  });
  it("a malformed request or argument to the exported checks is not classified", async () => {
    const f = loadQuote(USDC);
    expectThrown(await caught(() => verifyRelayOrder(null as never, protoOf(f), depositOf(f))), "relay: no request to check the order against [request-invalid]", undefined);
    expectThrown(await caught(() => buildRelayDeposit(ARB, f.request.depositor, f.request.sourceToken, 1n, "0x12")), "relay: the order id is not 32 bytes [order-id-mismatch]", undefined);
    expectThrown(await caught(() => buildRelayDeposit(ARB, "nope", f.request.sourceToken, 1n, protoOf(f).orderId as `0x${string}`)), "relay: the depositor is not an address [request-invalid]", undefined);
  });
  it("a RelayRefusal keeps its class, name and code next to the reason", async () => {
    const {params} = await quoted(USDC, {}, (f) => { depositOf(f).to = OTHER; });
    expect(params.heard[0]!.info).toEqual({reason: "vault_mismatch"});
    const err = new RelayRefusal("tx-target", "x", "vault_mismatch");
    expect(err).toBeInstanceOf(RelayRefusal);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RelayRefusal");
    expect(err.code).toBe("tx-target");
    expect(err.message).toBe("relay: x [tx-target]");
    expect(err.reason).toBe("vault_mismatch");
    expect(new RelayRefusal("tx-target", "x").reason).toBeUndefined();
  });
});

describe("coverage", () => {
  it("every reason seen is one of the union, and these are the ones Relay emits", () => {
    for (const r of seen) expect(SWAP2_REFUSAL_REASONS).toContain(r);
    expect([...seen].sort()).toEqual([
      "amount_too_large", "amount_too_small", "chain_halted", "insufficient_liquidity", "key_rejected", "no_route", "policy_refused", "price_check_failed",
      "quote_expired", "rate_limited", "recipient_mismatch", "recipient_unverifiable", "unsupported_pair", "upstream_unavailable", "vault_mismatch",
    ]);
  });
});
