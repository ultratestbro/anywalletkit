// CS-13 refusal reasons: every refusal the LI.FI provider produces keeps its text byte for byte and carries a stable
// `reason` (Swap2RefusalReason) next to it — on `onRefusal`'s second argument, on a thrown error (`refusalOf`), and
// through `lifiPins.reasonOf` for the texts `lifiVerifyQuote` returns. Driven through the provider's real code paths
// with a mocked fetch.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData, type Hex} from "viem";
import {refusalOf, Swap2QuoteError, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {lifiPins, lifiProvider, lifiVerifyQuote} from "../src/provider.js";
import {LifiSwap2Protocol} from "../src/protocol.js";
import {diamondCallMismatch} from "../src/calldata.js";
import {base58} from "../src/solana-address.js";
import {DIAMOND, DIAMOND_ABI, FROM_TOKEN, PARAMS, RECIPIENT, SENDER, TO_TOKEN, diamondCall, response} from "./fixtures.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const EVIL = "0x9999999999999999999999999999999999999999";
/** A receiver no other test puts in an action (the fixture re-encodes calldata it generated before). */
const ATTACKER = "0x8888888888888888888888888888888888888888";
const ZERO = "0x0000000000000000000000000000000000000000";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const SOLANA_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type Call = [text: string, info: Swap2RefusalInfo | undefined, arity: number];
/** The request without the sender: a dry quote priced for the placeholder. */
const {refundAddress: _sender, ...NO_SENDER} = PARAMS;

/** One getQuote against `answer` (a fetch stub): its single refusal, as `onRefusal` heard it. */
async function refusalFor(answer: (url: URL, init?: RequestInit) => Response | Promise<Response>, params: QuoteParams = PARAMS, signal?: AbortSignal): Promise<Call[]> {
  vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => answer(new URL(String(input)), init));
  const calls: Call[] = [];
  const quote = await lifiProvider().getQuote({...params, onRefusal: (...args: unknown[]) => { calls.push([args[0] as string, args[1] as Swap2RefusalInfo | undefined, args.length]); }}, signal);
  expect(quote).toBeNull();
  return calls;
}
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), {status, headers});
/** The single refusal, its text exactly and its classification. */
async function expectRefusal(calls: Promise<Call[]>, text: string, info: Swap2RefusalInfo | undefined) {
  const got = await calls;
  expect(got).toHaveLength(1);
  expect(got[0]![0]).toBe(text);
  expect(got[0]![1]).toEqual(info);
  if (info === undefined) expect(got[0]![2]).toBe(1); // an unclassified refusal is heard exactly as before: one argument
}

describe("LI.FI's error answers (real fetch path)", () => {
  it("404 'No available quotes' (NoQuoteError 1002) → no_route", async () => {
    await expectRefusal(refusalFor(() => json({message: "No available quotes for the requested transfer", code: 1002, errors: {filteredOut: [], failed: []}}, 404)),
      "lifi: No available quotes for the requested transfer", {reason: "no_route"});
  });

  it("429 with Retry-After → rate_limited, with the wait and the status", async () => {
    await expectRefusal(refusalFor(() => json({message: "Too many requests, slow down"}, 429, {"retry-after": "7"})),
      "lifi: Too many requests, slow down", {reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000});
  });

  it("401 and 403 → key_rejected (a body that is not JSON keeps the 'HTTP <status>' text)", async () => {
    await expectRefusal(refusalFor(() => json({message: "Invalid API key"}, 401)), "lifi: Invalid API key", {reason: "key_rejected", httpStatus: 401});
    await expectRefusal(refusalFor(() => new Response("<html>forbidden</html>", {status: 403})), "lifi: HTTP 403", {reason: "key_rejected", httpStatus: 403});
  });

  it("5xx → upstream_unavailable with the status", async () => {
    await expectRefusal(refusalFor(() => new Response("bad gateway", {status: 502})), "lifi: HTTP 502", {reason: "upstream_unavailable", httpStatus: 502});
    await expectRefusal(refusalFor(() => json({message: "Internal server error"}, 500)), "lifi: Internal server error", {reason: "upstream_unavailable", httpStatus: 500});
  });

  it("a 5xx whose body reads like a pair or route verdict stays upstream_unavailable with its status", async () => {
    await expectRefusal(refusalFor(() => json({message: "Upstream bridge API not supported right now"}, 503)), "lifi: Upstream bridge API not supported right now", {reason: "upstream_unavailable", httpStatus: 503});
    await expectRefusal(refusalFor(() => json({message: "Could not fetch quote: no route from aggregator"}, 500)), "lifi: Could not fetch quote: no route from aggregator", {reason: "upstream_unavailable", httpStatus: 500});
    await expectRefusal(refusalFor(() => json({message: "No available quotes for the requested transfer", code: 1002}, 502)), "lifi: No available quotes for the requested transfer", {reason: "upstream_unavailable", httpStatus: 502});
    await expectRefusal(refusalFor(() => json({message: "Gateway timeout", errors: [{code: "AMOUNT_TOO_LOW"}]}, 504)), "lifi: Gateway timeout", {reason: "upstream_unavailable", httpStatus: 504});
  });

  it("a 5xx whose body names a passing condition keeps it: a rate limit (code 1005, with the wait), liquidity, a halt", async () => {
    await expectRefusal(refusalFor(() => json({message: "Request limit reached", code: 1005}, 503, {"retry-after": "6"})), "lifi: Request limit reached", {reason: "rate_limited", httpStatus: 503, retryAfterMs: 6000});
    await expectRefusal(refusalFor(() => json({message: "Internal error", errors: [{code: "INSUFFICIENT_LIQUIDITY", tool: "1inch"}]}, 500)), "lifi: Internal error", {reason: "insufficient_liquidity"});
    await expectRefusal(refusalFor(() => json({message: "Bridge paused for maintenance"}, 503)), "lifi: Bridge paused for maintenance", {reason: "chain_halted"});
  });

  it("a rate limit or a rejected key named by a 4xx body: API codes 1005 / 1010 and their messages", async () => {
    await expectRefusal(refusalFor(() => json({message: "Request limit reached", code: 1005}, 400, {"retry-after": "4"})), "lifi: Request limit reached", {reason: "rate_limited", httpStatus: 400, retryAfterMs: 4000});
    await expectRefusal(refusalFor(() => json({message: "Rate limit exceeded, try later"}, 400)), "lifi: Rate limit exceeded, try later", {reason: "rate_limited", httpStatus: 400});
    await expectRefusal(refusalFor(() => json({message: "Not allowed", code: 1010}, 400)), "lifi: Not allowed", {reason: "key_rejected", httpStatus: 400});
    await expectRefusal(refusalFor(() => json({message: "The provided API key is invalid"}, 400)), "lifi: The provided API key is invalid", {reason: "key_rejected", httpStatus: 400});
  });

  it("the tool codes TOOL_TIMEOUT and RPC_ERROR → upstream_unavailable with the status", async () => {
    const failed = (code: string) => ({message: "No available quotes for the requested transfer", code: 1002, errors: {filteredOut: [], failed: [{overallPath: "1:USDT-42161:USDC", subpaths: {"1:USDT": [{errorType: "NO_QUOTE", code, tool: "across", message: "…"}]}}]}});
    await expectRefusal(refusalFor(() => json(failed("TOOL_TIMEOUT"), 404)), "lifi: No available quotes for the requested transfer", {reason: "upstream_unavailable", httpStatus: 404});
    await expectRefusal(refusalFor(() => json(failed("RPC_ERROR"), 404)), "lifi: No available quotes for the requested transfer", {reason: "upstream_unavailable", httpStatus: 404});
  });

  it("the tool codes win over the generic message when they agree: amount too low / high, liquidity", async () => {
    const failed = (code: string) => ({
      message: "No available quotes for the requested transfer", code: 1002,
      errors: {filteredOut: [], failed: [{overallPath: "1:USDT-42161:USDC", subpaths: {"1:USDT": [{errorType: "NO_QUOTE", code, action: {code: "AMOUNT_TOO_HIGH"}, tool: "across", message: "…"}]}}]},
    });
    await expectRefusal(refusalFor(() => json(failed("AMOUNT_TOO_LOW"), 404)), "lifi: No available quotes for the requested transfer", {reason: "amount_too_small"});
    await expectRefusal(refusalFor(() => json(failed("FEES_HIGHER_THAN_AMOUNT"), 404)), "lifi: No available quotes for the requested transfer", {reason: "amount_too_small"});
    await expectRefusal(refusalFor(() => json(failed("AMOUNT_TOO_HIGH"), 404)), "lifi: No available quotes for the requested transfer", {reason: "amount_too_large"});
    // The documented flat shape: errors as a list.
    await expectRefusal(refusalFor(() => json({message: "Unable to find a quote for the requested transfer.", errors: [{errorType: "NO_QUOTE", code: "INSUFFICIENT_LIQUIDITY", tool: "1inch", message: "The tool's liquidity is insufficient."}]}, 404)),
      "lifi: Unable to find a quote for the requested transfer.", {reason: "insufficient_liquidity"});
  });

  it("tool codes that disagree leave it to the API code (no_route)", async () => {
    const body = {message: "No available quotes for the requested transfer", code: 1002, errors: {failed: [{subpaths: {a: [{code: "AMOUNT_TOO_LOW"}], b: [{code: "INSUFFICIENT_LIQUIDITY"}]}}]}};
    await expectRefusal(refusalFor(() => json(body, 404)), "lifi: No available quotes for the requested transfer", {reason: "no_route"});
  });

  it("the single filtered-out reason stays in the text; the classification reads the body", async () => {
    const why = "ROUTE_SLIPPAGE_FLOOR_UNREACHABLE: the floor cannot be met";
    await expectRefusal(refusalFor(() => json({message: "No available quotes for the requested transfer", code: 1002, errors: {filteredOut: [{overallPath: "x", reason: why}]}}, 404)),
      `lifi: No available quotes for the requested transfer (${why})`, {reason: "price_check_failed"});
    const sei = "wallet is not linked to the original SEI address";
    await expectRefusal(refusalFor(() => json({message: "No available quotes for the requested transfer", errors: {filteredOut: [{overallPath: "1329:SEI~1329:USDC", reason: sei}]}}, 404)),
      `lifi: No available quotes for the requested transfer (${sei})`, {reason: "no_route"});
  });

  it("422 'None of the available routes could successfully generate a tx' → no_route; messages name the rest", async () => {
    await expectRefusal(refusalFor(() => json({message: "None of the available routes could successfully generate a tx"}, 422)),
      "lifi: None of the available routes could successfully generate a tx", {reason: "no_route"});
    await expectRefusal(refusalFor(() => json({message: "Token not supported on this chain"}, 400)), "lifi: Token not supported on this chain", {reason: "unsupported_pair"});
    await expectRefusal(refusalFor(() => json({message: "The chain is under maintenance"}, 400)), "lifi: The chain is under maintenance", {reason: "chain_halted"});
    // Anything else LI.FI refuses is it declining to route the request.
    await expectRefusal(refusalFor(() => json({message: "Invalid toAddress"}, 400)), "lifi: Invalid toAddress", {reason: "no_route"});
  });

  it("its own 12 s deadline → upstream_unavailable; a plain network failure inside it stays the silent null it was", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      c.abort(new DOMException("The operation timed out.", "TimeoutError"));
      return c.signal;
    });
    await expectRefusal(refusalFor((_url, init) => { if (init?.signal?.aborted) throw init.signal.reason; return json(response()); }),
      "lifi: no quote within 12 s", {reason: "upstream_unavailable"});
    vi.restoreAllMocks();
    expect(await refusalFor(() => { throw new TypeError("fetch failed"); })).toEqual([]);
  });

  it("the caller's own abort is not upstream_unavailable (nothing is reported)", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await refusalFor((_url, init) => { if (init?.signal?.aborted) throw init.signal.reason; return json(response()); }, PARAMS, ctrl.signal)).toEqual([]);
  });

  it("the engine's no route carries the reason (LifiSwap2Protocol.quoteSwap2)", async () => {
    vi.stubGlobal("fetch", async () => json({message: "Too many requests"}, 429, {"retry-after": "3"}));
    const account = {getAddress: async () => SENDER, getChainId: async () => 1};
    const e = await new LifiSwap2Protocol(account as never, {fromChain: "eip155:1"})
      .quoteSwap2({fromToken: "USDT", toToken: TO_TOKEN, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 1_000_000n})
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Swap2QuoteError);
    expect((e as Error).message).toBe("swap2: no route available for the requested pair :: lifi: Too many requests");
    // The engine adds the venues' refusals up (core combinedRefusal: the wait for rate_limited); the venue's own keeps its status.
    expect(refusalOf(e)).toEqual({reason: "rate_limited", retryAfterMs: 3000});
    expect((e as Swap2QuoteError).refusals).toEqual([{message: "lifi: Too many requests", provider: "lifi", reason: "rate_limited", httpStatus: 429, retryAfterMs: 3000}]);
  });
});

describe("LI.FI's quote, held to the request", () => {
  const answer = (overrides: Record<string, unknown>) => () => json(response(overrides));

  it("an answer missing its parts, or malformed → upstream_unavailable", async () => {
    await expectRefusal(refusalFor(answer({transactionRequest: undefined})), "lifi: incomplete quote (no action, estimate or transaction)", {reason: "upstream_unavailable"});
    await expectRefusal(refusalFor(answer({estimate: {...response().estimate, toAmountMin: undefined}})), "lifi: the quote has no minimum output", {reason: "upstream_unavailable"});
    await expectRefusal(refusalFor(answer({transactionRequest: {...response().transactionRequest, value: "lots"}})), "lifi: the transaction value or gas limit is not a number", {reason: "upstream_unavailable"});
    await expectRefusal(refusalFor(answer({transactionRequest: {...response().transactionRequest, gasLimit: undefined}})), "lifi: the transaction is malformed or targets an untrusted contract", {reason: "upstream_unavailable"});
  });

  it("another recipient or sender → recipient_mismatch; another amount → policy_refused", async () => {
    await expectRefusal(refusalFor(answer({action: {...response().action, toAddress: EVIL}})), "lifi: quote does not match the request (recipient)", {reason: "recipient_mismatch"});
    await expectRefusal(refusalFor(answer({action: {...response().action, fromAddress: EVIL}})), "lifi: quote does not match the request (sender)", {reason: "recipient_mismatch"});
    await expectRefusal(refusalFor(answer({action: {...response().action, fromAmount: "999999"}})), "lifi: quote does not match the request (amount spent)", {reason: "policy_refused"});
  });

  it("the estimate and the input-side fee", async () => {
    await expectRefusal(refusalFor(answer({estimate: {...response().estimate, fromAmount: "1000001"}})), "lifi: the estimate bridges 1000001, more than the 1000000 spent", {reason: "price_check_failed"});
    await expectRefusal(refusalFor(answer({estimate: {...response().estimate, fromAmount: "960000"}})), "lifi: the route takes 4% of the input as a fee (over 3%)", {reason: "policy_refused"});
  });

  it("an untrusted call target or spender → vault_mismatch", async () => {
    await expectRefusal(refusalFor(answer({transactionRequest: {...response().transactionRequest, to: EVIL}})), "lifi: the transaction is malformed or targets an untrusted contract", {reason: "vault_mismatch"});
    await expectRefusal(refusalFor(answer({estimate: {...response().estimate, approvalAddress: EVIL}})), "lifi: the approval target is not a trusted LI.FI contract", {reason: "vault_mismatch"});
  });

  it("slippage, floor and the route's own minimum → price_check_failed", async () => {
    await expectRefusal(refusalFor(answer({action: {...response().action, slippage: 0.01}})), "lifi: the quote ignored the requested slippage", {reason: "price_check_failed"});
    await expectRefusal(refusalFor(answer({}), {...PARAMS, minAmountOut: "985051"}), "lifi: floor breach (min=985050 < floor=985051)", {reason: "price_check_failed"});
    // LI.FI answers the slippage it was sent, both times, with a minimum 9.09 % under the quote.
    await expectRefusal(refusalFor((url) => json(response({
      action: {...response().action, slippage: Number(url.searchParams.get("slippage"))},
      estimate: {...response().estimate, toAmountMin: "900000"},
    }))), "lifi: this route's minimum is 9.09% under the quote (LI.FI applies slippage on every step) — more than the requested 0.5%", {reason: "price_check_failed"});
  });

  it("a native source paying less than its input → policy_refused", async () => {
    const native = response({
      action: {...response().action, fromToken: {address: ZERO, chainId: 1}, fromAmount: "2000000000000000"},
      estimate: {...response().estimate, fromAmount: "2000000000000000", approvalAddress: DIAMOND},
      transactionRequest: {...response().transactionRequest, value: "0x1"},
    });
    await expectRefusal(refusalFor(() => json(native), {...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"}), "lifi: the transaction sends less native coin than the input", {reason: "policy_refused"});
  });

  it("a same-chain route settling through a solver → unsupported_pair", async () => {
    const action = {...response().action, toToken: {address: TO_TOKEN, chainId: 1}, toChainId: 1};
    const body = {...response({action, estimate: {...response().estimate, executionDuration: 600}}), tool: "relay"};
    await expectRefusal(refusalFor(() => json(body), {...PARAMS, destChain: "eip155:1"}),
      "lifi: same-chain route settles asynchronously (600 s via relay) — a same-chain swap must deliver in the same transaction", {reason: "unsupported_pair"});
  });

  it("EVM → Solana through Smart Deposits → recipient_unverifiable", async () => {
    const params = {...PARAMS, destChain: "solana:mainnet", destToken: SOLANA_USDC, destAddress: SOLANA_RECIPIENT};
    await expectRefusal(refusalFor(() => json({...response(), tool: "smartDeposits"}), params),
      "lifi: LI.FI Smart Deposits pay a deposit address whose recipient the transaction does not bind — refused for a Solana destination", {reason: "recipient_unverifiable"});
  });

  it("a live quote without the sender's address is the caller's own error: unclassified, heard as before", async () => {
    await expectRefusal(refusalFor(() => json(response()), {...PARAMS, dry: false, refundAddress: ""}), "lifi: a live quote needs the sender's address", undefined);
  });

  const SOL = "11111111111111111111111111111111";
  const solanaBody = (data: string) => ({
    type: "lifi", id: "q",
    action: {fromToken: {address: SOL, chainId: 1151111081099710}, toToken: {address: TO_TOKEN, chainId: 42161}, fromAmount: "1000000000", fromChainId: 1151111081099710, toChainId: 42161, slippage: 0.005, fromAddress: SOLANA_SENDER, toAddress: RECIPIENT},
    estimate: {fromAmount: "1000000000", toAmount: "990000", toAmountMin: "985050", executionDuration: 20},
    transactionRequest: {data},
  });
  const SOLANA_PARAMS = {...PARAMS, sourceChain: "solana:mainnet", sourceToken: "SOL", amountIn: "1000000000", refundAddress: SOLANA_SENDER};

  it("a Solana source whose transaction is not base64 → upstream_unavailable", async () => {
    await expectRefusal(refusalFor(() => json(solanaBody("not base64!")), SOLANA_PARAMS), "lifi: the Solana transaction is not base64", {reason: "upstream_unavailable"});
  });

  it("a Solana source's bridge transaction paid by another account → policy_refused (getQuote's own read of it)", async () => {
    const other = new Uint8Array(32).fill(7);
    const tx = new Uint8Array([1, ...new Uint8Array(64), 1, 0, 0, 1, ...other, ...new Uint8Array(32), 0]);
    await expectRefusal(refusalFor(() => json(solanaBody(Buffer.from(tx).toString("base64"))), SOLANA_PARAMS),
      `lifi: the Solana transaction is paid by ${base58(other)}, not the sender ${SOLANA_SENDER}`, {reason: "policy_refused"});
  });
});

describe("the Diamond calldata, read on the device", () => {
  const withData = (data: Hex) => () => json(response({transactionRequest: {...response().transactionRequest, data}}));
  const call = (over: Parameters<typeof diamondCall>[2]) => diamondCall(response().action as never, response().estimate as never, over);
  const prefix = "lifi: the transaction does not match the quote: ";

  it("another receiver → recipient_mismatch; a destination call → recipient_unverifiable; another chain → policy_refused", async () => {
    await expectRefusal(refusalFor(withData(call({receiver: ATTACKER}))), `${prefix}pays ${ATTACKER}, not ${RECIPIENT}`, {reason: "recipient_mismatch"});
    await expectRefusal(refusalFor(withData(call({hasDestinationCall: true}))), `${prefix}the route runs a call on the destination chain, whose recipient cannot be checked here`, {reason: "recipient_unverifiable"});
    await expectRefusal(refusalFor(withData(call({destChainId: 10n}))), `${prefix}bridges to chain 10, not 42161`, {reason: "policy_refused"});
  });

  it("a bridge that does not bind its recipient (Relay) → recipient_unverifiable", async () => {
    const bridgeData = {
      transactionId: `0x${"00".repeat(32)}` as Hex, bridge: "relay", integrator: "awk", referrer: ZERO as Hex, sendingAssetId: FROM_TOKEN.toLowerCase() as Hex,
      receiver: RECIPIENT as Hex, minAmount: 1_000_000n, destinationChainId: 42161n, hasSourceSwaps: false, hasDestinationCall: false,
    };
    const data = encodeFunctionData({abi: DIAMOND_ABI, functionName: "startBridgeTokensViaRelayDepository", args: [bridgeData, {orderId: `0x${"11".repeat(32)}`, depositorAddress: SENDER}]});
    await expectRefusal(refusalFor(withData(data)), `${prefix}Relay delivers to a recipient the transaction does not bind (an off-chain order or unchecked facet data)`, {reason: "recipient_unverifiable"});
  });

  it("a same-chain swap accepting less than shown → price_check_failed", async () => {
    const action = {...response().action, toToken: {address: TO_TOKEN, chainId: 1}, toChainId: 1};
    const data = diamondCall(action as never, response().estimate as never, {minOut: 1n});
    await expectRefusal(refusalFor(() => json(response({action, transactionRequest: {...response().transactionRequest, data}})), {...PARAMS, destChain: "eip155:1"}),
      `${prefix}accepts 1, below the 985050 shown`, {reason: "price_check_failed"});
  });

  it("garbage calldata → upstream_unavailable; an unknown entry point → policy_refused (pins.reasonOf reads them back)", () => {
    const e = {fromToken: FROM_TOKEN, toToken: TO_TOKEN, amountIn: 1_000_000n, receiver: RECIPIENT, sender: SENDER, minOut: 985_050n, destChainId: 42161n, sameChain: false, evmDestination: true};
    const short = diamondCallMismatch("0x12345678", e)!;
    expect(short).toBe("the calldata is too short");
    expect(lifiPins.reasonOf!(short)).toEqual({reason: "upstream_unavailable"});
    const unknown = diamondCallMismatch(`0xdeadbeef${"00".repeat(64)}`, e)!;
    expect(unknown).toBe("unknown Diamond call 0xdeadbeef");
    expect(lifiPins.reasonOf!(unknown)).toEqual({reason: "policy_refused"});
  });
});

describe("lifiVerifyQuote (lifiPins) and its reasons", () => {
  const okQuote = async (): Promise<Quote> => {
    vi.stubGlobal("fetch", async () => json(response()));
    return (await lifiProvider().getQuote(PARAMS))!;
  };
  const verdict = (params: QuoteParams, quote: Quote): [string | null, Swap2RefusalInfo | undefined] => {
    const text = lifiVerifyQuote(params, quote);
    return [text, text === null ? undefined : lifiPins.reasonOf!(text)];
  };

  it("the pins carry reasonOf; a text they never produced is not classified", () => {
    expect(typeof lifiPins.reasonOf).toBe("function");
    expect(lifiPins.reasonOf!("some other text")).toBeUndefined();
  });

  it("each text, unchanged, with its reason", async () => {
    const q = await okQuote();
    expect(verdict(PARAMS, q)).toEqual([null, undefined]);
    expect(verdict({...PARAMS, sourceChain: "tron:728126428"}, q)).toEqual(["not a LI.FI chain pair", {reason: "unsupported_pair"}]);
    expect(verdict(NO_SENDER, q)).toEqual(["a dry quote priced for a placeholder sender carries a transaction — it would pay or refund that placeholder, not the wallet that signs it", {reason: "recipient_mismatch"}]);
    const {txRequest: _tx, ...noTx} = q;
    expect(verdict(PARAMS, noTx)).toEqual(["the quote carries no transaction", {reason: "policy_refused"}]);
    expect(verdict(PARAMS, {...q, txRequest: {...q.txRequest!, to: EVIL}})).toEqual([`the call targets ${EVIL}, not the LI.FI Diamond`, {reason: "vault_mismatch"}]);
    expect(verdict(PARAMS, {...q, txRequest: {...q.txRequest!, approvalAddress: EVIL}})).toEqual(["a token input approves the LI.FI Diamond", {reason: "vault_mismatch"}]);
    expect(verdict({...PARAMS, minAmountOut: "985051"}, q)).toEqual(["the quoted minimum 985050 is below the caller's floor 985051", {reason: "price_check_failed"}]);
    expect(verdict(PARAMS, {...q, minDestAmount: "1.5"})).toEqual(["the quote's amounts are not integers", {reason: "upstream_unavailable"}]);
    expect(verdict(PARAMS, {...q, intentId: "lifi:1:10"})).toEqual(["the intent id does not name this route", {reason: "policy_refused"}]);
    const evilData = diamondCall(response().action as never, response().estimate as never, {receiver: EVIL});
    expect(verdict(PARAMS, {...q, txRequest: {...q.txRequest!, data: evilData}})).toEqual([`the transaction does not match the request: pays ${EVIL}, not ${RECIPIENT}`, {reason: "recipient_mismatch"}]);
  });

  it("a price-only quote naming a deposit address → vault_mismatch", async () => {
    const PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
    vi.stubGlobal("fetch", async () => json(response({action: {...response().action, fromAddress: PLACEHOLDER}, transactionRequest: {...response().transactionRequest, from: PLACEHOLDER}})));
    const params = NO_SENDER;
    const q = (await lifiProvider().getQuote(params))!;
    expect(q.txRequest).toBeUndefined();
    expect(verdict(params, {...q, depositAddress: "0xdeposit"})).toEqual(["a LI.FI quote pays no deposit address, but this one names 0xdeposit", {reason: "vault_mismatch"}]);
  });

  it("a live request without the sender is the caller's own error: unclassified", async () => {
    const q = await okQuote();
    expect(verdict({...PARAMS, dry: false, refundAddress: ""}, q)).toEqual(["a live quote needs the sender and the recipient", undefined]);
  });

  it("a Solana source's transaction: paid by another account → policy_refused; truncated → policy_refused", () => {
    const params = {...PARAMS, sourceChain: "solana:mainnet", sourceToken: "SOL", amountIn: "1000000000", refundAddress: SOLANA_SENDER};
    const other = new Uint8Array(32).fill(7);
    const tx = new Uint8Array([1, ...new Uint8Array(64), 1, 0, 0, 1, ...other, ...new Uint8Array(32), 0]);
    const quote = {provider: "lifi", intentId: "lifi:1151111081099710:42161", depositAddress: "", depositMemo: null, sourceAmount: "1000000000", destAmount: "990000", minDestAmount: "985050", feeUsd: 0, etaSeconds: 20, reliability: 0.97, validUntilMs: Date.now() + 50_000};
    const serialized = (b: Uint8Array) => ({...quote, txRequest: {serializedTx: Buffer.from(b).toString("base64"), value: "1000000000"}});
    expect(verdict(params, serialized(tx))).toEqual([`the Solana transaction is paid by ${base58(other)}, not the sender ${SOLANA_SENDER}`, {reason: "policy_refused"}]);
    expect(verdict(params, serialized(tx.subarray(0, 65)))).toEqual(["the Solana transaction does not decode (truncated)", {reason: "policy_refused"}]);
  });

  it("remoteProvider + lifiPins: the stub's 'fails this app's own check' carries the reason", async () => {
    const q = await okQuote();
    const evil = {...q, txRequest: {...q.txRequest!, to: EVIL}};
    const stub = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", ...lifiPins,
      fetchImpl: (async () => new Response(JSON.stringify(evil), {status: 200})) as unknown as typeof fetch});
    const err = await stub.getQuote(PARAMS).catch((x: unknown) => x);
    expect((err as Error).message).toBe(`lifi: the quote fails this app's own check — the call targets ${EVIL}, not the LI.FI Diamond`);
    expect(refusalOf(err)).toEqual({reason: "vault_mismatch"});
  });
});

describe("buildDeposit and configuration", () => {
  it("a quote priced for a placeholder, or one without a transaction → policy_refused, a plain Error with the same text", async () => {
    const base = {provider: "lifi", intentId: "lifi:1:42161", depositAddress: "", depositMemo: null, sourceAmount: "1", destAmount: "1", minDestAmount: "1", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 1000};
    const placeholder = await lifiProvider().buildDeposit({...base, providerData: {placeholder: "sender"}}).catch((x: unknown) => x);
    expect(placeholder).toBeInstanceOf(Error);
    expect((placeholder as Error).constructor).toBe(Error);
    expect((placeholder as Error).message).toBe("swap2: this LI.FI quote was priced for a placeholder sender (a dry quote without that address) and has no transaction to build — quote again with the sender and the recipient");
    expect(refusalOf(placeholder)).toEqual({reason: "policy_refused"});
    const bare = await lifiProvider().buildDeposit(base).catch((x: unknown) => x);
    expect((bare as Error).message).toBe("swap2: LI.FI quote has no transaction request");
    expect(refusalOf(bare)).toEqual({reason: "policy_refused"});
  });

  it("configuration errors are not refusals: unclassified", () => {
    const insecure = (() => { try { lifiProvider({apiUrl: "http://proxy.example"}); } catch (e) { return e; } })();
    expect((insecure as Error).message).toBe("lifi: apiUrl must use https (allowInsecureApiUrl for local development)");
    expect(refusalOf(insecure)).toBeUndefined();
    const target = (() => { try { lifiProvider({trustedTransactionTargets: {"eip155:1": ["nope"]}}); } catch (e) { return e; } })();
    expect((target as Error).message).toBe("lifi: invalid transaction target address for eip155:1");
    expect(refusalOf(target)).toBeUndefined();
  });
});
