// Review of the quoting step (2026-11-15): each case below is a hostile backend's answer, an Across answer or a route
// the module mishandled before the fix (written first, seen failing, then fixed).
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {parseAcrossV5Error, readAcrossSuggestedFees} from "../src/api.js";
import {acrossQuoteOf, type NormalizedAcrossQuote} from "../src/build.js";
import {acrossChain, acrossRouteOf, type AcrossRoute} from "../src/config.js";
import {decodeAcrossDeposit, encodeAcrossDeposit} from "../src/deposit.js";
import {ACROSS_RELAYER_FEE_TOLERANCE_PCT, acrossFloorFee} from "../src/pricing.js";
import {acrossProvider} from "../src/provider.js";
import {acrossRemoteProvider} from "../src/remote.js";
import {
  ACROSS_MIN_FEE_PPM, ACROSS_PLACEHOLDER, acrossIntentId, acrossMinFeePpm, acrossPins, acrossRequestOf, verifyAcrossDeposit, type AcrossRequest,
} from "../src/verify.js";
import {ARB_USDC, BASE_USDC, NOW_MS, NOW_S, OTHER, USER, ZERO, ethRequest, refused, txOf, usdcArgs, usdcRequest} from "./fixtures.js";
import {TEST_KEY, feesCall, feesError, loadRecorded, replay, v5Call, v5Error} from "./recorded.js";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"], now: NOW_MS}); });
afterEach(() => { vi.useRealTimers(); });

const BACKEND = "https://backend.example/api/swap2";
const FEES = "https://app.across.to/api/suggested-fees";
const ETH_AMOUNT = 2_840_000_000_000_000n; // ~$5 of ETH, as the recorded eth-base-arb-5 cell
const LINEA = "eip155:59144";
const routeOf = (r: AcrossRequest): AcrossRoute => acrossRouteOf(r.sourceChain, r.sourceToken, r.destChain, r.destToken) as AcrossRoute;

const usdcParams = (over: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000",
  destAddress: USER, refundAddress: USER, sender: USER, dry: false, ...over,
});
const ethParams = (over: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: "eip155:8453", sourceToken: "ETH", destChain: "eip155:42161", destToken: ZERO, amountIn: ETH_AMOUNT.toString(),
  destAddress: USER, refundAddress: USER, sender: USER, dry: false, ...over,
});
const requestOf = (p: QuoteParams): AcrossRequest => acrossRequestOf(p, p.dry !== false ? {placeholder: ACROSS_PLACEHOLDER} : {});

/** An honest backend's quote for `params` that leaves `fee`, with any deposit field replaced. */
function quoteFor(params: QuoteParams, fee: bigint, over: Partial<NormalizedAcrossQuote> = {}): Quote {
  const request = requestOf(params);
  const route = routeOf(request);
  const qt = NOW_S - 200;
  return acrossQuoteOf(request, {
    sourceChainId: route.input.chain.chainId, destinationChainId: route.output.chain.chainId, inputToken: request.sourceToken, outputToken: request.destToken,
    inputAmount: request.amount.toString(), outputAmount: (request.amount - fee).toString(), quoteTimestamp: qt, fillDeadline: qt + 7200,
    exclusiveRelayer: ZERO, exclusivityParameter: 0, expectedFillTimeSec: 2, ...over,
  }, params.dry !== false ? {placeholder: true} : {});
}

/** Across's /suggested-fees answer for a request: a relayer fee of `total` on the pinned SpokePools, quoted `age` s ago. */
function feesBody(request: AcrossRequest, total: bigint, age = 200): Record<string, unknown> {
  const route = routeOf(request);
  return {
    totalRelayFee: {pct: "0", total: total.toString()}, outputAmount: (request.amount - total).toString(), timestamp: String(NOW_S - age),
    isAmountTooLow: false, estimatedFillTimeSec: 2, spokePoolAddress: route.input.chain.spokePool, destinationSpokePoolAddress: route.output.chain.spokePool,
    inputToken: {address: route.input.token, chainId: route.input.chain.chainId}, outputToken: {address: route.output.token, chainId: route.output.chain.chainId},
  };
}

type FeesAnswer = {status: number; body: unknown} | "down";
/** The backend answers `quote` with `answer(params)`, `build` with the quote's own transaction; Across's /suggested-fees with `fees`. */
function world(answer: (params: QuoteParams) => Quote, fees: (params: URLSearchParams) => FeesAnswer, calls: string[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(FEES)) {
      calls.push("suggested-fees");
      const a = fees(new URLSearchParams(url.slice(url.indexOf("?") + 1)));
      if (a === "down") throw new TypeError("fetch failed");
      return new Response(JSON.stringify(a.body), {status: a.status, headers: {"content-type": "application/json"}});
    }
    const action = url.slice(BACKEND.length + 1);
    calls.push(action);
    const body = JSON.parse(String(init?.body)) as {params?: QuoteParams; quote?: Quote};
    const out = action === "quote" ? answer(body.params!) : action === "build" ? {chain: body.params?.sourceChain ?? "eip155:8453", ...body.quote!.txRequest} : {};
    return new Response(JSON.stringify(out), {status: 200, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
}
/** /suggested-fees answering a relayer fee of `total` for whatever it is asked. */
const feesOf = (total: bigint, age?: number) => (q: URLSearchParams): FeesAnswer => {
  const p = q.get("originChainId") === "8453" && q.get("inputToken") === BASE_USDC ? usdcParams() : ethParams();
  return {status: 200, body: feesBody({...requestOf(p), amount: BigInt(q.get("amount")!), recipient: q.get("recipient")!}, total, age)};
};

/** The real swap2 engine over a provider, with an account that records every transaction it is asked to send. */
async function engineRun(provider: CrossChainProvider, opts: {maxProtocolFeeBps?: number}, swap: Record<string, unknown>) {
  const sent: {to?: string; data?: string}[] = [];
  class Engine extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected override chainSupported(): boolean { return true; }
  }
  const account = {
    getAddress: async () => USER, getChainId: async () => 8453, getBalance: async () => 10n ** 21n, getAllowance: async () => 0n,
    quoteSendTransaction: async () => ({fee: 1n}), waitForTransaction: async () => ({status: 1}),
    sendTransaction: async (t: {to?: string; data?: string}) => { sent.push(t); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const engine = new Engine(account as never, {fromChain: "eip155:8453", ...opts});
  const error = await engine.swap2({toChain: 42161, recipient: USER, minAmountOut: 1n, ...swap} as never).then(() => undefined, (e: unknown) => e);
  const deposits = sent.filter((t) => !String(t.data ?? "").startsWith("0x095ea7b3")).map((t) => decodeAcrossDeposit(t.data!));
  return {error, deposits};
}

describe("security: a backend cannot misstate the fees the engine's caps read", () => {
  const usdcSwap = {fromToken: "USDC", toToken: ARB_USDC, fromTokenAmount: 25_000_000n};
  const fee9pct = 2_250_000n;

  it("the reviewer's case: a 9 % deposit with `fees: []` is not signed under the app's 50 bps engine cap (the honest list is refused too)", async () => {
    const spoof = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => ({...quoteFor(p, fee9pct), fees: [], feeUsd: 0}), feesOf(8_804n))});
    const r = await engineRun(spoof, {maxProtocolFeeBps: 50}, usdcSwap);
    expect(r.deposits).toEqual([]);
    expect(String((r.error as Error)?.message)).toMatch(/the fees the quote shows are not the deposit's fee of 2250000/);
    expect(refusalOf(r.error)?.reason).toBe("price_check_failed");
    // Control: the honest list is refused by the engine's own cap.
    const honest = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, fee9pct), feesOf(8_804n))});
    const h = await engineRun(honest, {maxProtocolFeeBps: 50}, usdcSwap);
    expect(h.deposits).toEqual([]);
    expect(String((h.error as Error)?.message)).toMatch(/protocol fee exceeds configured cap/);
  });

  it("every way of misstating the list or feeUsd is refused on the device; the honest quote passes", async () => {
    const honest = (p: QuoteParams) => quoteFor(p, 9_033n);
    const token = BASE_USDC;
    const cases: ((q: Quote) => Quote)[] = [
      (q) => ({...q, fees: []}),
      (q) => { const {fees: _f, ...rest} = q; return rest as Quote; },
      (q) => ({...q, fees: [{type: "protocol", amount: "9032", token, included: true}]}),
      (q) => ({...q, fees: [{type: "network", amount: "9033", token, included: true}]}),
      (q) => ({...q, fees: [{type: "protocol", amount: "9033", token: OTHER, included: true}]}),
      (q) => ({...q, fees: [{type: "protocol", amount: "9033", token, included: false}]}),
      (q) => ({...q, fees: [{type: "protocol", amount: "4516", token, included: true}, {type: "affiliate", amount: "4517", token, included: true}]}),
      (q) => ({...q, feeUsd: 0}),
      (q) => ({...q, feeUsd: 0.009032}),
      (q) => ({...q, destDecimals: 18}),
    ];
    for (const edit of cases) {
      const app = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => edit(honest(p)), feesOf(8_804n))});
      const err = await app.getQuote(usdcParams()).catch((e: unknown) => e);
      expect(String((err as Error)?.message), JSON.stringify(edit(honest(usdcParams())).fees)).toMatch(/\[quote-amounts\]/);
      expect(refusalOf(err)?.reason).toBe("price_check_failed");
    }
    const app = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world(honest, feesOf(8_804n))});
    expect(await app.getQuote(usdcParams())).not.toBeNull();
    // ETH: the native coin's fee is in the zero address, its feeUsd 0 (no price is known).
    const eth = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => ({...quoteFor(p, 20_000_000_000_000n), feeUsd: 0.05}), feesOf(5_837_014_400_929n))});
    await expect(eth.getQuote(ethParams())).rejects.toThrow(/\[quote-amounts\]/);
  });
});

describe("security: a deposit relayers would not fill is not signed, and does not win the auction", () => {
  const floorFee = (ETH_AMOUNT * BigInt(ACROSS_MIN_FEE_PPM.ethFromL2) + 999_999n) / 1_000_000n;
  const need = 5_837_014_400_929n; // /suggested-fees for this deposit (recorded eth-base-arb-5): 20.55 bps

  it("the reviewer's case B: ETH Base → Arbitrum at the 4.5 bps device floor, where Across's own relayer quote names 20.55 bps", async () => {
    const calls: string[] = [];
    const app = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, floorFee), feesOf(need), calls)});
    const err = await app.getQuote(ethParams()).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/\[relayer-price\]/);
    expect(refusalOf(err)?.reason).toBe("price_check_failed");
    expect(calls).toEqual(["quote", "suggested-fees"]);
    // A dry quote (the auction) is held to it too.
    const {sender: _s, refundAddress: _r, ...anonymous} = ethParams({dry: true, destAddress: ""});
    await expect(app.getQuote(anonymous)).rejects.toThrow(/\[relayer-price\]/);
    // And through the engine nothing is signed.
    const r = await engineRun(app, {}, {fromToken: "ETH", toToken: ZERO, fromTokenAmount: ETH_AMOUNT});
    expect(r.deposits).toEqual([]);
  });

  it(`a fee within ${ACROSS_RELAYER_FEE_TOLERANCE_PCT} % under the relayer quote passes (the two reads are seconds apart); further under is refused`, async () => {
    const at = async (fee: bigint) => acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, fee), feesOf(need))}).getQuote(ethParams());
    const edge = need - (need * BigInt(ACROSS_RELAYER_FEE_TOLERANCE_PCT)) / 100n;
    expect(await at(need)).not.toBeNull();
    expect(await at(edge)).not.toBeNull();
    await expect(at(edge - 1n)).rejects.toThrow(/\[relayer-price\]/);
  });

  it("Across's relayer quote refusing the deposit refuses the quote, with its reason", async () => {
    const app = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, 9_033n), () => ({status: 400, body: feesError("fees-route-not-enabled").body}))});
    const err = await app.getQuote(usdcParams()).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/\[relayer-price\]/);
    expect(refusalOf(err)?.reason).toBe("unsupported_pair");
  });

  it("no relayer quote on the device: a studied route stands on the per-asset floor; any other route is refused", async () => {
    const studied = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, 9_033n), () => "down")});
    expect(await studied.getQuote(usdcParams())).not.toBeNull();
    const lineaParams = ethParams({sourceChain: LINEA, destChain: "eip155:8453"});
    const linea = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, ETH_AMOUNT / 100n), () => "down")});
    const err = await linea.getQuote(lineaParams).catch((e: unknown) => e);
    expect(String((err as Error)?.message)).toMatch(/\[relayer-price\]/);
    expect(refusalOf(err)?.reason).toBe("upstream_unavailable");
  });

  it("the app can turn the device read off: studied routes then stand on the floor alone, the rest are refused", async () => {
    const calls: string[] = [];
    const off = acrossRemoteProvider({baseUrl: BACKEND, suggestedFeesUrl: null, fetchImpl: world((p) => quoteFor(p, 9_033n), feesOf(8_804n), calls)});
    expect(await off.getQuote(usdcParams())).not.toBeNull();
    expect(calls).toEqual(["quote"]);
    expect(() => acrossRemoteProvider({baseUrl: BACKEND, suggestedFeesUrl: "http://evil.example/fees"})).toThrow(/https/);
  });
});

describe("security: no exclusive relayer — the module never sets one", () => {
  it("the reviewer's case C: the backend's own relayer for 3600 s, with a deadline that leaves room after it", async () => {
    const qt = NOW_S - 10;
    const req = usdcRequest({minAmountOut: undefined});
    expect(refused(() => verifyAcrossDeposit(req, txOf(usdcArgs({exclusiveRelayer: "0x000000000000000000000000000000000000beef", exclusivityParameter: 3600, quoteTimestamp: qt, fillDeadline: qt + 7800}))), "tx-exclusivity", "policy_refused")).toMatch(/exclusive relayer/);
    // A short window, a timestamp, a relayer without a window: refused alike. None at all passes.
    refused(() => verifyAcrossDeposit(req, txOf(usdcArgs({exclusiveRelayer: OTHER, exclusivityParameter: 3}))), "tx-exclusivity", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf(usdcArgs({exclusiveRelayer: OTHER, exclusivityParameter: NOW_S - 600}))), "tx-exclusivity", "policy_refused");
    refused(() => verifyAcrossDeposit(req, txOf(usdcArgs({exclusiveRelayer: ZERO, exclusivityParameter: 3}))), "tx-exclusivity", "policy_refused");
    verifyAcrossDeposit(req, txOf(usdcArgs({exclusiveRelayer: ZERO, exclusivityParameter: 0})));
    const app = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, 9_033n, {exclusiveRelayer: "0x000000000000000000000000000000000000beef", exclusivityParameter: 3600, quoteTimestamp: qt, fillDeadline: qt + 7800}), feesOf(8_804n))});
    await expect(app.getQuote(usdcParams())).rejects.toThrow(/\[tx-exclusivity\]/);
  });
});

describe("security: a deposit that is sure to revert on its quote time is not signed", () => {
  it("the reviewer's case D: a quote time 110 s ahead (the SpokePool reverts one ahead of the block)", () => {
    const req = usdcRequest({minAmountOut: undefined});
    const at = (qt: number) => txOf(usdcArgs({quoteTimestamp: qt, fillDeadline: qt + 7200}));
    expect(refused(() => verifyAcrossDeposit(req, at(NOW_S + 110)), "tx-quote-time", "policy_refused")).toMatch(/future/);
    verifyAcrossDeposit(req, at(NOW_S + 15));
    refused(() => verifyAcrossDeposit(req, at(NOW_S + 16)), "tx-quote-time", "policy_refused");
  });

  it("a quote whose validity outlives the SpokePool's quote-time buffer is refused (quote time 3290 s old, 419 s more to live)", () => {
    const params = ethParams();
    const qt = NOW_S - 3290;
    const q = {...quoteFor(params, 5_837_014_400_929n, {quoteTimestamp: qt, fillDeadline: qt + 7800}), validUntilMs: NOW_MS + 419_000};
    expect(acrossPins.verifyQuote!(params, q)).toMatch(/\[quote-expiry\]$/);
    expect(acrossPins.verifyBuild!(q, {chain: "eip155:8453", ...q.txRequest!} as UnsignedTx, params)).toMatch(/\[quote-expiry\]$/);
    // The honest quote lives no longer than that: its validity is cut at quote time + 3300 s.
    const honest = quoteFor(params, 5_837_014_400_929n, {quoteTimestamp: NOW_S - 3280, fillDeadline: NOW_S - 3280 + 7800});
    expect(honest.validUntilMs).toBe((NOW_S - 3280 + 3300) * 1000);
    expect(acrossPins.verifyQuote!(params, honest)).toBeNull();
  });

  it("right before signing the device checks the deposit again with its own clock, before the backend is asked", async () => {
    const calls: string[] = [];
    const app = acrossRemoteProvider({baseUrl: BACKEND, fetchImpl: world((p) => quoteFor(p, 9_033n), feesOf(8_804n), calls)});
    const q = (await app.getQuote(usdcParams()))!;
    const tx = await app.buildDeposit(q);
    await app.preflightDeposit!(q, tx);
    expect(calls).toEqual(["quote", "suggested-fees", "build", "preflight"]);
    // The signature waited (an approval, a review) until the quote time is too old for the SpokePool to take it.
    calls.length = 0;
    vi.setSystemTime(NOW_MS + 3_200_000);
    await expect(app.preflightDeposit!(q, tx)).rejects.toThrow(/\[tx-quote-time\]/);
    expect(calls).toEqual([]);
    // A quote this device never checked is not preflighted.
    vi.setSystemTime(NOW_MS);
    const stranger = quoteFor(usdcParams(), 9_034n);
    await expect(app.preflightDeposit!(stranger, {chain: "eip155:8453", ...stranger.txRequest!} as UnsignedTx)).rejects.toThrow(/not checked on this device/);
    expect(calls).toEqual([]);
  });

  it("on the server, a /suggested-fees time ahead of its clock is not taken as the deposit's quote time", () => {
    const request = usdcRequest({minAmountOut: undefined});
    const route = routeOf(request);
    expect(readAcrossSuggestedFees(request, route, 200, feesBody(request, 8_804n, -1), NOW_S).kind).toBe("unavailable");
    expect(readAcrossSuggestedFees(request, route, 200, feesBody(request, 8_804n, 0), NOW_S).kind).toBe("fees");
  });
});

describe("V5 pricing another rail is not the price of a plain deposit", () => {
  it("USDT Ethereum → USDT0 Arbitrum (V5: ~20 min, 12× the relayer fee): priced on Across's relayer fee", async () => {
    const f = loadRecorded("usdt-eth-arb-100");
    vi.setSystemTime(f.nowMs);
    const q = await acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f)}).getQuote(f.params);
    const need = BigInt(feesCall(f)!.response.totalRelayFee.total);
    expect(v5Call(f).response.expectedFillTimeMs).toBeGreaterThan(60_000);
    expect(q).not.toBeNull();
    expect(BigInt(f.params.amountIn) - BigInt(q!.destAmount)).toBe(need);
    expect(q!.providerData).toMatchObject({priceSource: "suggested-fees (V5 other rail)", relayerFee: need.toString()});
    expect(q!.etaSeconds).toBe(feesCall(f)!.response.estimatedFillTimeSec);
  });

  it("without Across's relayer fee such a route is refused, never priced on the floor or on V5", async () => {
    const f = loadRecorded("usdt-eth-arb-100");
    vi.setSystemTime(f.nowMs);
    const reasons: [string, unknown][] = [];
    const p = acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f, [], (c) => (c.kind === "suggested-fees" ? {status: 503, body: {}} : undefined))});
    expect(await p.getQuote({...f.params, onRefusal: (r, i) => reasons.push([r, i])})).toBeNull();
    expect(reasons[0]![0]).toMatch(/another rail.*\[route-unpriced\]/);
    expect(reasons[0]![1]).toEqual({reason: "upstream_unavailable"});
  });
});

describe("the ETH-from-an-L2 floor is the studied origins' (Optimism, Base, Arbitrum)", () => {
  const linea = (amount: bigint) => ethRequest({sourceChain: LINEA, destChain: "eip155:8453", amount});
  const lineaTx = (r: AcrossRequest, fee: bigint) => {
    const route = routeOf(r);
    const qt = NOW_S - 60;
    return {to: route.input.chain.spokePool, chainId: route.input.chain.chainId, value: r.amount.toString(), data: encodeAcrossDeposit({
      depositor: USER, recipient: USER, inputToken: route.input.token, outputToken: route.output.token, inputAmount: r.amount, outputAmount: r.amount - fee,
      destinationChainId: 8453n, exclusiveRelayer: ZERO, quoteTimestamp: qt, fillDeadline: qt + 7200, exclusivityParameter: 0, message: "0x",
    })};
  };

  it("ETH Linea → Base at Across's own 1.27 bps (V5 at 2.67 bps) is not refused as unfillable; under 0.7 bp still is", () => {
    const r = linea(1_134_000_000_000_000_000n);
    verifyAcrossDeposit(r, lineaTx(r, 302_658_112_173_757n)); // 2.67 bps: max(F5, Fneed) for the reviewer's cell
    verifyAcrossDeposit(r, lineaTx(r, 145_125_867_337_363n)); // 1.27 bps: Across's /suggested-fees, live 2026-11-15
    refused(() => verifyAcrossDeposit(r, lineaTx(r, (r.amount * 69n) / 1_000_000n)), "tx-fee", "price_check_failed");
    expect(acrossMinFeePpm(routeOf(r))).toBe(ACROSS_MIN_FEE_PPM.ethFromOtherL2);
    for (const chain of ["eip155:10", "eip155:8453", "eip155:42161"]) {
      expect(acrossMinFeePpm(routeOf(ethRequest({sourceChain: chain, destChain: chain === "eip155:8453" ? "eip155:10" : "eip155:8453"})))).toBe(ACROSS_MIN_FEE_PPM.ethFromL2);
    }
    // Ink's live 2.71 bps passes too.
    const ink = ethRequest({sourceChain: "eip155:57073", destChain: "eip155:8453"});
    expect(acrossMinFeePpm(routeOf(ink))).toBeLessThanOrEqual(271);
  });
});

describe("Across's own answers, classified as CS-13 means them", () => {
  it("/suggested-fees 400 INVALID_PARAM 'Unsupported token' is a refusal (unsupported_pair), never the floor", async () => {
    const request = usdcRequest({minAmountOut: undefined});
    const e = feesError("fees-invalid-param");
    expect(readAcrossSuggestedFees(request, routeOf(request), e.status, e.body, NOW_S)).toMatchObject({kind: "refused", reason: "unsupported_pair"});
    // Any other 400 Across names is a refusal too (the floor stands in only for an Across that does not answer).
    expect(readAcrossSuggestedFees(request, routeOf(request), 400, {type: "AcrossApiError", code: "SOMETHING_NEW", status: 400, message: "no"}, NOW_S)).toMatchObject({kind: "refused", reason: "upstream_unavailable"});
    for (const status of [404, 410, 500, 503]) expect(readAcrossSuggestedFees(request, routeOf(request), status, {}, NOW_S).kind).toBe("unavailable");

    // Through the provider (USDT Ethereum → Arbitrum: V5 keeps answering on its other rail).
    const f = loadRecorded("usdt-eth-arb-100");
    vi.setSystemTime(f.nowMs);
    const reasons: [string, unknown][] = [];
    const p = acrossProvider({apiKey: TEST_KEY, fetchImpl: replay(f, [], (c) => (c.kind === "suggested-fees" ? {status: e.status, body: e.body} : undefined))});
    expect(await p.getQuote({...f.params, onRefusal: (r, i) => reasons.push([r, i])})).toBeNull();
    expect(reasons[0]![1]).toEqual({reason: "unsupported_pair"});
  });

  it("the floor refuses an unstudied ETH route for the missing relayer price at any size, not as too large", () => {
    const linea = routeOf(ethRequest({sourceChain: LINEA, destChain: "eip155:8453"}));
    for (const usd of [1_000, 40_000]) {
      let err: unknown;
      try { acrossFloorFee(linea, 10n ** 18n, usd, 1n); } catch (e) { err = e; }
      expect(String((err as Error).message)).toMatch(/no relayer price for Linea → Base/);
      expect(refusalOf(err)?.reason).toBe("upstream_unavailable");
    }
    // A studied route over the size the floor was seen at is too large.
    let big: unknown;
    try { acrossFloorFee(routeOf(ethRequest()), 10n ** 18n, 40_000, 1n); } catch (e) { big = e; }
    expect(refusalOf(big)?.reason).toBe("amount_too_large");
  });

  it("V5 request.invalid_field 'unknown token' is an unsupported pair (the module sends only pinned tokens)", () => {
    const e = v5Error("v5-invalid-field-token");
    expect(parseAcrossV5Error(e.status, e.body).info).toEqual({reason: "unsupported_pair"});
    // Another field V5 no longer takes is another API shape.
    expect(parseAcrossV5Error(400, {error: {type: "request", code: "request.invalid_field", message: "appFeeBps above entitlement", param: "appFeeBps"}}).info).toEqual({reason: "upstream_unavailable", httpStatus: 400});
  });
});

// The intent id helper stays used for a quote re-encoded by hand.
void acrossIntentId; void acrossChain;
