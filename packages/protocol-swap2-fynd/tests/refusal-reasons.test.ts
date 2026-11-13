// CS-13: every Fynd refusal keeps its text and carries a stable `reason` (Swap2RefusalReason). The real provider,
// router check, pins and engine run against a fake hosted API and RPC: no network, no keys.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeErrorResult, encodeFunctionData, parseAbi, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {Swap2QuoteError} from "@anywalletkit/protocol-swap2-core";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {fyndProvider} from "../src/provider.js";
import {FyndSwap2Protocol} from "../src/protocol.js";
import {FYND_CHAINS, FyndTransactionError, ROUTER_NATIVE, TYCHO_ROUTER_ABI, checkFyndTransaction, fyndPins, fyndVerifyQuote} from "../src/router.js";

afterEach(() => vi.unstubAllGlobals());

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ME = "0x4444444444444444444444444444444444444444";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const RPC = {8453: ["https://rpc.test"]};
const GROSS = 400_000_000_000_000_000n;
const ERRORS = parseAbi(["error TychoRouter__NegativeSlippage(uint256 amount, uint256 minAmount)", "error Error(string)"]);
const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;

interface Api {
  /** The quote endpoint answers this status (and these headers) with `{}`. */
  http?: number;
  headers?: Record<string, string>;
  /** The quote endpoint answers this raw body with 200. */
  raw?: string;
  /** The quote endpoint's fetch rejects (the network). */
  down?: boolean;
  status?: string;
  amountInEcho?: string;
  clientFee?: string;
  /** The breakdown's router fee is off by one (does not add up to the output). */
  breakdownOff?: boolean;
  /** Drop `amount_in` from the order. */
  noAmountIn?: boolean;
  tamper?: (tx: {to: string; value: string; data: string}) => {to: string; value: string; data: string};
  protocols?: string[];
  /** The router eth_call's JSON-RPC error; none → it executes. */
  revert?: {message: string; data?: unknown};
  balance?: bigint;
  allowance?: bigint;
  /** Every RPC request answers this HTTP status. */
  rpcHttp?: number;
}

/** The hosted API (one singleSwap order) and an RPC, as the provider's existing tests fake them. */
function api(o: Api = {}): typeof fetch {
  return vi.fn(async (url: string, init: {body: string; signal?: AbortSignal}) => {
    if (init.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
    const body = JSON.parse(init.body) as Record<string, unknown>;
    if (url.includes("/quote")) {
      if (o.down) throw new TypeError("fetch failed");
      if (o.http) return new Response("{}", {status: o.http, headers: o.headers ?? {}});
      if (o.raw !== undefined) return new Response(o.raw);
      const order = (body.orders as Record<string, string>[])[0]!;
      const amountIn = BigInt(order.amount!);
      const enc = (body.options as {encoding_options: {slippage: string}}).encoding_options;
      const bps = BigInt(Math.round(Number(enc.slippage) * 10_000));
      const slip = (GROSS * bps) / 10_000n;
      const min = GROSS - slip;
      const sentinel = (t: string) => (t === ZERO ? ROUTER_NATIVE : t);
      const data = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [amountIn, sentinel(order.token_in!) as Hex, sentinel(order.token_out!) as Hex, GROSS, min, order.receiver as Hex, NO_FEE as never, "0xdeadbeef"]});
      let tx = {to: ROUTER as string, value: order.token_in === ZERO ? amountIn.toString() : "0", data: data as string};
      if (o.tamper) tx = o.tamper(tx);
      return new Response(JSON.stringify({orders: [{
        status: o.status ?? "success",
        ...(o.noAmountIn ? {} : {amount_in: o.amountInEcho ?? amountIn.toString()}),
        amount_out: GROSS.toString(), gas_estimate: "150000",
        route: {swaps: (o.protocols ?? ["uniswap_v3"]).map((protocol) => ({protocol}))},
        fee_breakdown: {router_fee: o.breakdownOff ? "1" : "0", client_fee: o.clientFee ?? "0", max_slippage: slip.toString(), min_amount_received: min.toString()},
        transaction: tx,
      }]}));
    }
    if (o.rpcHttp) return new Response("{}", {status: o.rpcHttp});
    const rpc = body as {method: string; params: Array<{to: string; data: Hex}>};
    const reply = (v: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, ...(v as object)}));
    if (rpc.method === "eth_getBalance") return reply({result: "0x0"});
    if (rpc.method === "eth_call") {
      const call = rpc.params[0]!;
      if (call.to.toLowerCase() === ROUTER.toLowerCase()) return reply(o.revert ? {error: o.revert} : {result: "0x"});
      return reply({result: word(call.data.startsWith("0x70a08231") ? o.balance ?? 10n ** 12n : o.allowance ?? 10n ** 12n)});
    }
    if (rpc.method === "eth_getTransactionReceipt") return reply({result: {status: "0x1"}});
    return new Response("{}", {status: 404});
  }) as unknown as typeof fetch;
}

const USDC_IN = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH, amountIn: "1000000000", destAddress: ME, refundAddress: ME, slippageBps: 50};
const ETH_IN = {...USDC_IN, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"};

/** getQuote against `o`: the onRefusal text and its classification. */
async function quote(o: Api, over: Record<string, unknown> = {}, config: Record<string, unknown> = {}, signal?: AbortSignal) {
  vi.stubGlobal("fetch", api(o));
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await fyndProvider({apiKey: "k", ...config}).getQuote({...USDC_IN, ...over, onRefusal: (text: string, info?: Swap2RefusalInfo) => { heard.push([text, info]); }} as never, signal);
  expect(q).toBeNull();
  expect(heard).toHaveLength(1);
  return {text: heard[0]![0], info: heard[0]![1]};
}

/** The error a call rejects with. */
async function rejection(run: () => Promise<unknown>): Promise<Error> {
  try { await run(); } catch (e) { return e as Error; }
  throw new Error("expected a rejection");
}

describe("fynd getQuote: the request this venue does not serve", () => {
  const cases: Array<[string, Record<string, unknown>, string, Swap2RefusalInfo["reason"]]> = [
    ["an amount-flexible deposit", {flex: true}, "fynd: amount-flexible deposits are not supported", "unsupported_pair"],
    ["a cross-chain request", {destChain: "eip155:1"}, "fynd: same-chain swaps only", "unsupported_pair"],
    ["a chain without a server", {sourceChain: "eip155:10", destChain: "eip155:10"}, "fynd: Fynd is not configured for eip155:10", "unsupported_pair"],
    ["a token the catalog does not list", {sourceToken: "NOPE"}, "fynd: unknown source token NOPE", "unsupported_pair"],
    ["a destination token that is not an EVM address", {destToken: "So11111111111111111111111111111111111111112"}, "fynd: destination token must be an EVM address", "unsupported_pair"],
    ["the same token in and out", {destToken: USDC}, "fynd: same token in and out", "unsupported_pair"],
    ["a recipient that cannot receive on an EVM chain", {destAddress: "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG", refundAddress: undefined}, "fynd: recipient must be an EVM address", "recipient_mismatch"],
    ["a slippage the venue cannot encode (0 bps)", {slippageBps: 0}, "fynd: invalid slippage", "price_check_failed"],
  ];
  for (const [what, over, text, reason] of cases) {
    it(`${what} → ${reason}, the text unchanged`, async () => {
      const r = await quote({}, over);
      expect(r.text).toBe(text);
      expect(r.info).toEqual({reason});
    });
  }

  it("an invalid argument from the developer stays unclassified (not a refusal reason)", async () => {
    expect(await quote({}, {amountIn: "1.5"})).toEqual({text: "fynd: amount is not an integer", info: undefined});
    expect(await quote({}, {amountIn: "0"})).toEqual({text: "fynd: amount must be positive", info: undefined});
  });
});

describe("fynd getQuote: the hosted API's answer, through the real fetch path", () => {
  it("HTTP 429 with Retry-After → rate_limited with the wait", async () => {
    expect(await quote({http: 429, headers: {"retry-after": "7"}})).toEqual({text: "fynd: rate limited (HTTP 429)", info: {reason: "rate_limited", httpStatus: 429, retryAfterMs: 7000}});
    expect(await quote({http: 429})).toEqual({text: "fynd: rate limited (HTTP 429)", info: {reason: "rate_limited", httpStatus: 429}});
  });

  it("HTTP 401 / 403 → key_rejected", async () => {
    expect(await quote({http: 401})).toEqual({text: "fynd: API key rejected (HTTP 401)", info: {reason: "key_rejected", httpStatus: 401}});
    expect(await quote({http: 403})).toEqual({text: "fynd: API key rejected (HTTP 403)", info: {reason: "key_rejected", httpStatus: 403}});
  });

  it("HTTP 422 → no_route", async () => {
    expect(await quote({http: 422})).toEqual({text: "fynd: no route for this pair", info: {reason: "no_route"}});
  });

  it("HTTP 5xx / 408 → upstream_unavailable with the status; another 4xx stays unclassified", async () => {
    expect(await quote({http: 503})).toEqual({text: "fynd: API answered HTTP 503", info: {reason: "upstream_unavailable", httpStatus: 503}});
    expect(await quote({http: 408})).toEqual({text: "fynd: API answered HTTP 408", info: {reason: "upstream_unavailable", httpStatus: 408}});
    // A 404 is a misconfigured baseUrl / selfHosted URL: configuration, not a venue refusal.
    expect(await quote({http: 404})).toEqual({text: "fynd: API answered HTTP 404", info: undefined});
  });

  it("the network failing → upstream_unavailable; the caller's own abort is not", async () => {
    expect(await quote({down: true})).toEqual({text: "fynd: API unreachable (TypeError)", info: {reason: "upstream_unavailable"}});
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await quote({}, {}, {}, ctrl.signal)).toEqual({text: "fynd: API unreachable (AbortError)", info: undefined});
  });

  it("the caller aborting while the answer is still being read is not upstream_unavailable; the body failing on its own is", async () => {
    /** getQuote against an answer whose body stream starts and then fails (on the caller's abort, or by itself). */
    async function readFails(ctrl: AbortController | null) {
      vi.stubGlobal("fetch", vi.fn(async (_url: string, init: {signal?: AbortSignal}) => {
        const body = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode("{\"orders\":["));
            if (ctrl) init.signal?.addEventListener("abort", () => c.error(new DOMException("This operation was aborted", "AbortError")));
            else setTimeout(() => c.error(new TypeError("terminated")), 0);
          },
        });
        if (ctrl) setTimeout(() => ctrl.abort(), 0);
        return new Response(body);
      }));
      const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
      const q = await fyndProvider({apiKey: "k"}).getQuote({...USDC_IN, onRefusal: (text: string, info?: Swap2RefusalInfo) => { heard.push([text, info]); }} as never, ctrl?.signal);
      expect(q).toBeNull();
      expect(heard).toHaveLength(1);
      return {text: heard[0]![0], info: heard[0]![1]};
    }
    expect(await readFails(new AbortController())).toEqual({text: "fynd: malformed API response", info: undefined});
    expect(await readFails(null)).toEqual({text: "fynd: malformed API response", info: {reason: "upstream_unavailable"}});
  });

  it("an answer in another shape → upstream_unavailable", async () => {
    expect(await quote({raw: "<html>"})).toEqual({text: "fynd: malformed API response", info: {reason: "upstream_unavailable"}});
    expect(await quote({raw: JSON.stringify({orders: []})})).toEqual({text: "fynd: malformed API response (order count)", info: {reason: "upstream_unavailable"}});
    expect(await quote({noAmountIn: true})).toEqual({text: "fynd: malformed quote amounts", info: {reason: "upstream_unavailable"}});
  });

  it("each solver failure status maps to its reason; an unknown status stays unclassified", async () => {
    const statuses: Array<[string, string, Swap2RefusalInfo["reason"] | undefined]> = [
      ["no_route_found", "fynd: no route for this pair", "no_route"],
      ["insufficient_liquidity", "fynd: not enough liquidity for this amount", "insufficient_liquidity"],
      ["timeout", "fynd: the solver timed out", "upstream_unavailable"],
      ["not_ready", "fynd: the solver is still syncing", "stale_node"],
      ["price_check_failed", "fynd: the price guard rejected the route", "price_check_failed"],
      ["encoding_failed", "fynd: could not encode the swap (fees + slippage leave nothing)", "amount_too_small"],
      ["something_new", "fynd: quote status something_new", undefined],
    ];
    for (const [status, text, reason] of statuses) {
      expect(await quote({status}), status).toEqual({text, info: reason ? {reason} : undefined});
    }
  });
});

describe("fynd getQuote: the quote's own checks", () => {
  it("amounts, fees and the caller's floor → price_check_failed / policy_refused", async () => {
    expect(await quote({amountInEcho: "999"})).toEqual({text: "fynd: quoted 999, not the requested 1000000000", info: {reason: "price_check_failed"}});
    expect(await quote({clientFee: "1"})).toEqual({text: "fynd: the quote carries a client fee", info: {reason: "policy_refused"}});
    expect(await quote({breakdownOff: true})).toEqual({text: "fynd: fee breakdown does not add up to the output", info: {reason: "price_check_failed"}});
    const min = GROSS - (GROSS * 50n) / 10_000n;
    expect(await quote({}, {minAmountOut: "999999999999999999999"})).toEqual({text: `fynd: floor breach (min=${min} < floor=999999999999999999999)`, info: {reason: "price_check_failed"}});
  });

  it("the encoded transaction: another contract → vault_mismatch, another receiver → recipient_mismatch", async () => {
    expect(await quote({tamper: (tx) => ({...tx, to: "0x2222222222222222222222222222222222222222"})}))
      .toEqual({text: "fynd: the transaction targets 0x2222222222222222222222222222222222222222, not the Tycho router on Base", info: {reason: "vault_mismatch"}});
    expect(await quote({tamper: (tx) => ({...tx, data: tx.data.replace(ME.slice(2).toLowerCase(), "33".repeat(20))})}))
      .toEqual({text: "fynd: calldata pays 0x3333333333333333333333333333333333333333, not 0x4444444444444444444444444444444444444444", info: {reason: "recipient_mismatch"}});
  });

  it("a route through an excluded protocol → policy_refused; a native route that reverts now → simulation_failed", async () => {
    expect(await quote({protocols: ["uniswap_v3", "uniswap_v4_hooks"]})).toEqual({text: "fynd: the route goes through uniswap_v4_hooks, which this wallet excludes", info: {reason: "policy_refused"}});
    expect(await quote({revert: {message: "execution reverted"}}, ETH_IN, {rpcUrls: RPC}))
      .toEqual({text: "fynd: the route does not execute on-chain right now (simulation reverted via uniswap_v3)", info: {reason: "simulation_failed"}});
  });
});

describe("checkFyndTransaction: a FyndTransactionError, tagged", () => {
  const expected = {chainId: 8453, tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000_000n, receiver: ME, expectedAmountOut: GROSS, minAmountOut: GROSS - 1n};
  const single = (o: Partial<{amountIn: bigint; tokenOut: string; receiver: string; min: bigint; fee: Record<string, unknown>; swaps: Hex}> = {}) =>
    encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [o.amountIn ?? expected.amountIn, USDC, (o.tokenOut ?? WETH) as Hex, GROSS, o.min ?? expected.minAmountOut, (o.receiver ?? ME) as Hex, (o.fee ?? NO_FEE) as never, o.swaps ?? "0xdeadbeef"]});
  const cases: Array<[string, () => unknown, string, Swap2RefusalInfo["reason"]]> = [
    ["an unpinned chain", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, {...expected, chainId: 10}), "fynd: chain 10 has no pinned Tycho router", "unsupported_pair"],
    ["another contract", () => checkFyndTransaction({to: ATTACKER, value: 0n, data: single()}, expected), `fynd: the transaction targets ${ATTACKER}, not the Tycho router on Base`, "vault_mismatch"],
    ["the zero receiver", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, {...expected, receiver: ZERO}), "fynd: invalid receiver", "recipient_mismatch"],
    ["a minimum above the expected output", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, {...expected, minAmountOut: GROSS + 1n}), "fynd: invalid quote amounts", "price_check_failed"],
    ["native value on a token swap", () => checkFyndTransaction({to: ROUTER, value: 1n, data: single()}, expected), "fynd: native value does not match the input", "price_check_failed"],
    ["calldata that is not hex", () => checkFyndTransaction({to: ROUTER, value: 0n, data: "0xzz"}, expected), "fynd: malformed calldata", "policy_refused"],
    ["a Permit2 variant", () => checkFyndTransaction({to: ROUTER, value: 0n, data: "0x12345678" + single().slice(10)}, expected), "fynd: not a plain singleSwap / sequentialSwap / splitSwap call (Permit2 and vault variants are not used)", "policy_refused"],
    ["a bigger spend", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({amountIn: 2n})}, expected), "fynd: calldata spends 2, not 1000000000", "price_check_failed"],
    ["other tokens", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({tokenOut: USDC})}, expected), "fynd: calldata swaps other tokens than requested", "policy_refused"],
    ["another receiver", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({receiver: ATTACKER})}, expected), `fynd: calldata pays ${ATTACKER}, not ${ME}`, "recipient_mismatch"],
    ["a lower minimum", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({min: 1n})}, expected), "fynd: calldata amounts do not match the quote", "price_check_failed"],
    ["a client fee", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({fee: {...NO_FEE, clientFeeBps: 50}})}, expected), "fynd: calldata carries client-fee parameters — this module charges none", "policy_refused"],
    ["an empty route", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({swaps: "0x"})}, expected), "fynd: empty or invalid route", "policy_refused"],
  ];
  for (const [what, run, text, reason] of cases) {
    it(`${what} → ${reason}`, () => {
      let err: unknown;
      try { run(); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(FyndTransactionError);
      expect((err as Error).name).toBe("FyndTransactionError");
      expect((err as Error).message).toBe(text);
      expect(refusalOf(err)).toEqual({reason});
    });
  }
});

describe("fynd preflightDeposit and buildDeposit", () => {
  /** Quote with a clean RPC, then run the preflight against `o` (and `tx` when given). */
  async function preflight(o: Api, params: Record<string, unknown> = USDC_IN, tx?: (t: {to: string; data?: string; value: string}) => object) {
    vi.stubGlobal("fetch", api());
    const p = fyndProvider({apiKey: "k", rpcUrls: RPC});
    const q = (await p.getQuote(params as never))!;
    const built = await p.buildDeposit(q);
    vi.stubGlobal("fetch", api(o));
    return rejection(() => p.preflightDeposit!(q, (tx ? tx(built) : built) as never));
  }

  it("a transaction that is not the quoted swap → policy_refused", async () => {
    const err = await preflight({}, USDC_IN, (t) => ({...t, to: ATTACKER}));
    expect(err.message).toBe("fynd: the transaction is not the quoted swap. Nothing was sent; refresh the quote.");
    expect(err.constructor).toBe(Error);
    expect(refusalOf(err)).toEqual({reason: "policy_refused"});
  });

  it("the router's NegativeSlippage → price_check_failed; every other revert → simulation_failed", async () => {
    const slip = encodeErrorResult({abi: ERRORS, errorName: "TychoRouter__NegativeSlippage", args: [397_000n, 398_000n]});
    const cases: Array<[Api, string, Swap2RefusalInfo["reason"]]> = [
      [{revert: {message: "execution reverted", data: slip}}, "fynd: the price moved past your minimum — the route now pays 397000, under your minimum 398000. Nothing was sent; refresh the quote.", "price_check_failed"],
      [{revert: {message: "execution reverted"}, balance: 999_999_999n}, "fynd: the wallet's balance is below the amount (999999999 < 1000000000). Nothing was sent.", "simulation_failed"],
      [{revert: {message: "execution reverted"}, allowance: 0n}, "fynd: the token approval is not visible on-chain yet. Nothing was sent; try again in a moment.", "simulation_failed"],
      [{revert: {message: "execution reverted", data: encodeErrorResult({abi: ERRORS, errorName: "Error", args: ["STF"]})}}, "fynd: the swap would revert now (STF). Nothing was sent; refresh the quote.", "simulation_failed"],
    ];
    for (const [o, text, reason] of cases) {
      const err = await preflight(o);
      expect(err.message).toBe(text);
      expect(err.constructor).toBe(Error);
      expect(refusalOf(err)).toEqual({reason});
    }
  });

  it("an RPC that does not answer is still no refusal: the router's own minimum stands", async () => {
    vi.stubGlobal("fetch", api());
    const p = fyndProvider({apiKey: "k", rpcUrls: RPC});
    const q = (await p.getQuote(USDC_IN as never))!;
    const tx = await p.buildDeposit(q);
    vi.stubGlobal("fetch", api({rpcHttp: 503}));
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("a quote without a transaction → policy_refused", async () => {
    const err = await rejection(() => fyndProvider({apiKey: "k"}).buildDeposit({intentId: "fynd:8453"} as Quote));
    expect(err.message).toBe("swap2: Fynd quote has no transaction request");
    expect(refusalOf(err)).toEqual({reason: "policy_refused"});
  });
});

describe("fyndPins.reasonOf classifies fyndVerifyQuote's texts (return type unchanged)", () => {
  const GROSS_R = 250_000_000_000_000n, MIN_R = 248_750_000_000_000n;
  const params = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH, amountIn: "1000000", destAddress: ME, dry: false} as QuoteParams;
  const data = (receiver = ME) => encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [1_000_000n, USDC, WETH, GROSS_R, MIN_R, receiver as Hex, NO_FEE as never, "0xdeadbeef"]});
  const quoteWith = (tx?: {to: string; data: string}): Quote => ({
    provider: "fynd", intentId: "fynd:8453", depositAddress: "", depositMemo: null,
    ...(tx ? {txRequest: {to: tx.to, data: tx.data, value: "0", chainId: 8453, gasLimit: "300000", approvalAddress: tx.to}} : {}),
    sourceAmount: "1000000", destAmount: GROSS_R.toString(), minDestAmount: MIN_R.toString(), feeUsd: 0, etaSeconds: 15, reliability: 0.96,
    validUntilMs: Date.now() + 30_000, providerData: {gross: GROSS_R.toString()},
  } as Quote);

  it("each refusal text → its reason; a passing quote → null", () => {
    expect(fyndVerifyQuote(params, quoteWith({to: ROUTER, data: data()}))).toBeNull();
    const cases: Array<[QuoteParams, Quote, string, Swap2RefusalInfo["reason"]]> = [
      [{...params, destChain: "eip155:1"}, quoteWith({to: ROUTER, data: data()}), "same-chain swaps only", "unsupported_pair"],
      [{...params, sourceToken: "NOPE"}, quoteWith({to: ROUTER, data: data()}), "unknown source token NOPE", "unsupported_pair"],
      [params, quoteWith(), "the quote carries no router transaction", "policy_refused"],
      [params, quoteWith({to: ATTACKER, data: data()}), `the transaction targets ${ATTACKER}, not the Tycho router on Base`, "vault_mismatch"],
      [params, quoteWith({to: ROUTER, data: data(ATTACKER)}), `calldata pays ${ATTACKER}, not ${ME}`, "recipient_mismatch"],
      [{...params, amountIn: "2000000"}, quoteWith({to: ROUTER, data: data()}), "calldata spends 1000000, not 2000000", "price_check_failed"],
    ];
    for (const [p, q, text, reason] of cases) {
      const refusal = fyndVerifyQuote(p, q);
      expect(refusal).toBe(text);
      expect(fyndPins.reasonOf!(refusal!)).toEqual({reason});
    }
  });

  it("a request that does not parse, and a text these pins never produced, stay unclassified", () => {
    const refusal = fyndVerifyQuote({...params, destToken: "0xnot-an-address"}, quoteWith({to: ROUTER, data: data()}));
    expect(typeof refusal).toBe("string");
    expect(fyndPins.reasonOf!(refusal!)).toBeUndefined();
    expect(fyndPins.reasonOf!("something else entirely")).toBeUndefined();
  });

  it("behind remoteProvider the stub's refusal carries the pins' reason", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(quoteWith({to: ROUTER, data: data(ATTACKER)})), {status: 200})) as unknown as typeof fetch;
    const stub = remoteProvider({name: "fynd", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...fyndPins});
    const err = await rejection(() => stub.getQuote(params));
    expect(err.message).toBe(`fynd: the quote fails this app's own check — calldata pays ${ATTACKER}, not ${ME}`);
    expect(refusalOf(err)).toEqual({reason: "recipient_mismatch"});
  });
});

describe("the engine's no-route error carries Fynd's reason", () => {
  it("FyndSwap2Protocol.quoteSwap2 on a 429: the text unchanged, rate_limited with the wait", async () => {
    vi.stubGlobal("fetch", api({http: 429, headers: {"retry-after": "12"}}));
    const err = await rejection(() => new FyndSwap2Protocol(undefined, {fromChain: "eip155:8453", apiKey: "k"}).quoteSwap2({fromToken: "USDC", toToken: WETH, toChain: 8453, recipient: ME, fromTokenAmount: 1_000_000_000n} as never));
    expect(err).toBeInstanceOf(Swap2QuoteError);
    expect(err.message).toBe("swap2: no route available for the requested pair :: fynd: rate limited (HTTP 429)");
    expect(refusalOf(err)).toEqual({reason: "rate_limited", retryAfterMs: 12_000});
    expect((err as Swap2QuoteError).refusals).toEqual([{message: "fynd: rate limited (HTTP 429)", provider: "fynd", reason: "rate_limited", httpStatus: 429, retryAfterMs: 12_000}]);
  });
});
