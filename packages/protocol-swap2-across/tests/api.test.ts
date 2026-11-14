import {describe, expect, it} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {
  ACROSS_API_V1, ACROSS_SUGGESTED_FEES_MAX_AGE_S, ACROSS_V5_PRICING_MAX_FEE_BPS, acrossHttp, acrossSuggestedFeesQuery, acrossUsdToUnits, acrossV5QuoteRequest,
  parseAcrossV5Error, readAcrossSuggestedFees, readAcrossV5Quote,
} from "../src/api.js";
import {acrossRouteOf, type AcrossRoute} from "../src/config.js";
import type {AcrossRequest} from "../src/verify.js";
import {ARB_USDC, BASE_USDC, USER, ZERO, ethRequest, refused, usdcRequest} from "./fixtures.js";
import {FEES_ERRORS, V5_ERRORS, feesCall, feesError, loadRecorded, v5Call, v5Error} from "./recorded.js";

const NOW = 1_794_700_000_000;
const routeOf = (r: AcrossRequest) => acrossRouteOf(r.sourceChain, r.sourceToken, r.destChain, r.destToken) as AcrossRoute;
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("V5 request body", () => {
  it("names exactly what this module sends: exact input, exact approval, EVM approve + send only, the pricing cap", () => {
    expect(ACROSS_API_V1).toBe("https://api.across.to/v1");
    expect(ACROSS_V5_PRICING_MAX_FEE_BPS).toBe(5000);
    expect(acrossV5QuoteRequest(usdcRequest())).toEqual({
      origin: {token: {chainId: 8453, address: BASE_USDC}, depositor: USER, amount: "25000000"},
      destination: {token: {chainId: 42161, address: ARB_USDC}, recipient: USER},
      amountType: "exact_input",
      capabilities: {operations: [{kind: "approve_token", ecosystem: "evm"}, {kind: "send_transaction", ecosystem: "evm"}]},
      authorizationPolicy: {allowedTypes: ["approval"], approvalAmount: "exact"},
      maxFee: {bps: 5000},
    });
    // The user's cap is the deposit's (the verifier holds it), not V5's: its estimate does not move with maxFee.
    expect(acrossV5QuoteRequest(usdcRequest({maxFeeBps: 50})).maxFee).toEqual({bps: 5000});
    expect(acrossV5QuoteRequest(ethRequest()).origin.token.address).toBe(ZERO);
    // No app fee, no gas top-up, no destination actions, no slippage, no attestation, no refund address: never sent.
    const body = JSON.stringify(acrossV5QuoteRequest(usdcRequest()));
    for (const f of ["appFee", "gasTopUp", "actions", "slippage", "integratorId", "attestation", "refundAddress"]) expect(body).not.toContain(f);
    expect(() => acrossV5QuoteRequest(usdcRequest({sourceChain: "eip155:56"}))).toThrow();
  });

  it("the recorded requests are the bodies this module builds", () => {
    const f = loadRecorded("eth-arb-base-2000");
    expect(v5Call(f).request).toEqual({
      origin: {token: {chainId: 42161, address: ZERO}, depositor: f.params.sender!.toLowerCase(), amount: f.params.amountIn},
      destination: {token: {chainId: 8453, address: ZERO}, recipient: f.params.destAddress.toLowerCase()},
      amountType: "exact_input",
      capabilities: {operations: [{kind: "approve_token", ecosystem: "evm"}, {kind: "send_transaction", ecosystem: "evm"}]},
      authorizationPolicy: {allowedTypes: ["approval"], approvalAmount: "exact"},
      maxFee: {bps: 5000},
    });
  });
});

describe("reading a V5 quote", () => {
  const f = loadRecorded("usdc-base-arb-25");
  const request = usdcRequest({depositor: f.params.sender!, recipient: f.params.destAddress, minAmountOut: undefined});
  const route = routeOf(request);
  const answer = () => clone(v5Call(f).response);

  it("the fee, the origin step taken out at the destination token's price, the destination gas, the fill time, the size", () => {
    const p = readAcrossV5Quote(request, route, answer());
    expect(p.totalFee).toBe(34_564n);
    expect(p.destinationAmount).toBe(24_965_436n);
    // 0.00360466932 USD / 0.99969 USD per USDC, rounded down.
    expect(p.originGas).toBe(3_605n);
    expect(p.destinationGas).toBe(8_450n);
    expect(p.expectedFillTimeMs).toBe(v5Call(f).response.expectedFillTimeMs);
    expect(p.amountUsd).toBeCloseTo(24.99, 1);
  });

  it("an ETH route takes its gas legs in wei, exactly", () => {
    const e = loadRecorded("eth-arb-base-2000");
    const r = ethRequest({sourceChain: "eip155:42161", destChain: "eip155:8453", amount: BigInt(e.params.amountIn), depositor: e.params.sender!, recipient: e.params.destAddress});
    const v = v5Call(e).response;
    const p = readAcrossV5Quote(r, routeOf(r), v);
    const leg = (side: string) => v.gasEstimates.filter((g: {leg: string; effect: string}) => g.leg === side && g.effect === "included_in_transfer_fee").reduce((s: bigint, g: {amount: string}) => s + BigInt(g.amount), 0n);
    expect(p.originGas).toBe(leg("origin"));
    expect(p.destinationGas).toBe(leg("destination"));
  });

  it("an answer about another transfer is refused (policy_refused)", () => {
    const cases: [(a: ReturnType<typeof answer>) => void, RegExp][] = [
      [(a) => { a.origin.token.address = ARB_USDC; }, /another input token/],
      [(a) => { a.origin.token.chainId = 10; }, /another input token/],
      [(a) => { a.destination.token.chainId = 10; }, /another output token/],
      [(a) => { a.origin.amount = "25000001"; }, /sends 25000001/],
      [(a) => { a.amountType = "exact_output"; }, /not exact input/],
      [(a) => { a.fee.appFee.amount = "1"; }, /app fee/],
      [(a) => { a.destination.amount = "25000001"; a.fee.totalFee.amount = "0"; }, /more to arrive/],
    ];
    for (const [edit, text] of cases) {
      const a = answer();
      edit(a);
      expect(refused(() => readAcrossV5Quote(request, route, a), "api-answer", "policy_refused")).toMatch(text);
    }
  });

  it("an answer that does not read or does not add up is refused (upstream_unavailable)", () => {
    expect(refused(() => readAcrossV5Quote(request, route, null), "api-answer", "upstream_unavailable")).toMatch(/not a JSON object/);
    expect(refused(() => readAcrossV5Quote(request, route, [answer()]), "api-answer", "upstream_unavailable")).toMatch(/not a JSON object/);
    const cases: [(a: ReturnType<typeof answer>) => unknown, RegExp][] = [
      [(a) => { delete a.fee; return a; }, /no fee/],
      [(a) => { a.fee.totalFee.amount = "34565"; return a; }, /not its input minus its estimate/],
      [(a) => { a.fee.totalFee.amount = "-1"; return a; }, /not a base-unit integer/],
      [(a) => { a.fee.totalFee.token.decimals = 18; return a; }, /another token/],
      [(a) => { a.gasEstimates = {}; return a; }, /no gas estimates/],
      [(a) => { delete a.expectedFillTimeMs; return a; }, /no fill time/],
      [(a) => { a.destination.amount = 5; return a; }, /no output estimate/],
      [(a) => { a.fee.appFee = {amount: "x"}; return a; }, /app fee that does not read/],
    ];
    for (const [edit, text] of cases) {
      const a = answer();
      edit(a);
      expect(refused(() => readAcrossV5Quote(request, route, a), "api-answer", "upstream_unavailable")).toMatch(text);
    }
  });

  it("gas legs that cannot be read: the origin step adds nothing back (the fee stays higher), the destination gas is unknown", () => {
    const a = answer();
    for (const g of a.gasEstimates) delete g.amountUsd;
    const p = readAcrossV5Quote(request, route, a);
    expect(p.originGas).toBe(0n);
    expect(p.destinationGas).toBeNull();
    // An add-back is never more than the fee.
    const b = answer();
    b.gasEstimates[0].amountUsd = "5000";
    expect(readAcrossV5Quote(request, route, b).originGas).toBe(34_564n);
    // `nextActions`, `orderId`, `minAmount` are not read: their absence changes nothing.
    const c = answer();
    delete c.nextActions; delete c.orderId; delete c.destination.minAmount; delete c.refundPolicy;
    expect(readAcrossV5Quote(request, route, c)).toEqual(readAcrossV5Quote(request, route, answer()));
  });

  it("acrossUsdToUnits: integer math, rounded down; null for anything that is not a price", () => {
    expect(acrossUsdToUnits("0.012048778559999999", 0.999678, 6)).toBe(12_052n);
    expect(acrossUsdToUnits("1.5", 64047.03, 8)).toBe(2_342n);
    expect(acrossUsdToUnits("0", 1, 6)).toBe(0n);
    for (const [usd, price] of [["1e-5", 1], ["-1", 1], ["1", 0], ["1", -2], ["1", Number.NaN], [1, 1], ["1", "1"], ["1", 1e13]] as const) {
      expect(acrossUsdToUnits(usd, price, 6)).toBeNull();
    }
    expect(acrossUsdToUnits("1", 1, 37)).toBeNull();
  });
});

describe("reading /suggested-fees", () => {
  const f = loadRecorded("usdc-base-arb-25");
  const request = usdcRequest({depositor: f.params.sender!, recipient: f.params.destAddress, minAmountOut: undefined});
  const route = routeOf(request);
  const nowS = Math.floor(f.nowMs / 1000);
  const body = () => clone(feesCall(f)!.response);

  it("the query is the deposit's own: the wrapped native token for ETH, the recipient", () => {
    expect(feesCall(f)!.url).toBe(`https://app.across.to/api/suggested-fees?${acrossSuggestedFeesQuery(request, route)}`);
    const e = ethRequest();
    expect(acrossSuggestedFeesQuery(e, routeOf(e))).toContain("inputToken=0x4200000000000000000000000000000000000006&outputToken=0x82af49447d8a07e3bd95bd0d56f35241523fbab1");
  });

  it("a clean answer: the relayer fee, the quote time, the fill estimate", () => {
    expect(readAcrossSuggestedFees(request, route, 200, body(), nowS)).toEqual({kind: "fees", totalRelayFee: 8_804n, timestamp: 1_794_698_771, estimatedFillTimeSec: 2});
  });

  it("Across's own refusals of the deposit are refusals; a SpokePool other than the pinned one too", () => {
    const refusedOf = (b: unknown, status = 200) => readAcrossSuggestedFees(request, route, status, b, nowS);
    expect(refusedOf(feesError("fees-amount-too-low").body, 400)).toMatchObject({kind: "refused", reason: "amount_too_small"});
    expect(refusedOf(feesError("fees-amount-too-high").body, 400)).toMatchObject({kind: "refused", reason: "amount_too_large"});
    expect(refusedOf(feesError("fees-route-not-enabled").body, 400)).toMatchObject({kind: "refused", reason: "unsupported_pair"});
    expect(refusedOf({...body(), isAmountTooLow: true})).toMatchObject({kind: "refused", reason: "amount_too_small"});
    expect(refusedOf({...body(), limits: {...body().limits, maxDeposit: "24999999"}})).toMatchObject({kind: "refused", reason: "amount_too_large"});
    expect(refusedOf({...body(), limits: {...body().limits, minDeposit: "25000001"}})).toMatchObject({kind: "refused", reason: "amount_too_small"});
    expect(refusedOf({...body(), spokePoolAddress: "0x1111111111111111111111111111111111111111"})).toMatchObject({kind: "refused", reason: "vault_mismatch", detail: expect.stringMatching(/pinned for Base/)});
    expect(refusedOf({...body(), destinationSpokePoolAddress: "0x1111111111111111111111111111111111111111"})).toMatchObject({kind: "refused", reason: "vault_mismatch", detail: expect.stringMatching(/pinned for Arbitrum/)});
  });

  it("anything else is unavailable — the pinned floor stands in", () => {
    const at = (b: unknown, status = 200, now = nowS) => readAcrossSuggestedFees(request, route, status, b, now).kind;
    expect(at(feesError("fees-invalid-param").body, 400)).toBe("unavailable");
    expect(at(undefined, 502)).toBe("unavailable");
    expect(at({error: "gone"}, 404)).toBe("unavailable");
    expect(at("not json")).toBe("unavailable");
    expect(at({...body(), outputAmount: "24991197"})).toBe("unavailable");
    expect(at({...body(), totalRelayFee: {pct: "1", total: "x"}})).toBe("unavailable");
    expect(at({...body(), inputToken: {...body().inputToken, chainId: 10}})).toBe("unavailable");
    expect(at({...body(), outputToken: {...body().outputToken, address: BASE_USDC}})).toBe("unavailable");
    expect(at({...body(), timestamp: 1794698771})).toBe("unavailable");
    // Stale or ahead: its timestamp would be the deposit's quote time.
    expect(at(body(), 200, 1_794_698_771 + ACROSS_SUGGESTED_FEES_MAX_AGE_S + 1)).toBe("unavailable");
    expect(at(body(), 200, 1_794_698_771 - 121)).toBe("unavailable");
    expect(at(body(), 200, 1_794_698_771 + ACROSS_SUGGESTED_FEES_MAX_AGE_S)).toBe("fees");
  });

  it("every recorded error answer reads", () => {
    for (const e of FEES_ERRORS) expect(["refused", "unavailable"]).toContain(readAcrossSuggestedFees(request, route, e.status, e.body, nowS).kind);
  });
});

describe("V5 error envelopes → CS-13", () => {
  it("the real answers, each classified", () => {
    const want: Record<string, unknown> = {
      "v5-unauthenticated-no-key": {reason: "key_rejected", httpStatus: 401},
      "v5-unauthenticated-bad-key": {reason: "key_rejected", httpStatus: 401},
      "v5-unsupported-param": {reason: "upstream_unavailable", httpStatus: 400},
      "v5-missing-field": {reason: "upstream_unavailable", httpStatus: 400},
      "v5-invalid-field-token": {reason: "policy_refused"},
      "v5-amount-too-small": {reason: "amount_too_small"},
      "v5-amount-too-large": {reason: "amount_too_large"},
      // "raise the amount above N base units", amountLimits.side = "min": the amount is too small, not too large.
      "v5-fee-cap-min": {reason: "amount_too_small"},
      "v5-fee-cap-min-usdt": {reason: "amount_too_small"},
      "v5-fee-cap-min-wbtc": {reason: "amount_too_small"},
      "v5-system-unavailable": {reason: "upstream_unavailable", httpStatus: 503},
      "v5-not-found-transfer": undefined,
    };
    expect(Object.keys(want).sort()).toEqual(V5_ERRORS.map((e) => e.name).sort());
    for (const e of V5_ERRORS) expect(parseAcrossV5Error(e.status, e.body, null, NOW).info, e.name).toEqual(want[e.name]);
  });

  it("amountLimits: the side and the bound", () => {
    const min = parseAcrossV5Error(400, v5Error("v5-fee-cap-min").body, null, NOW);
    expect(min).toMatchObject({code: "policy.amount_out_of_range", type: "policy", param: "origin.amount", amountLimit: {side: "min", amount: "10794099445838946"}});
    expect(parseAcrossV5Error(400, v5Error("v5-amount-too-large").body, null, NOW).amountLimit).toEqual({side: "max", amount: "10000000000000"});
    expect(parseAcrossV5Error(400, v5Error("v5-amount-too-small").body, null, NOW).amountLimit).toBeUndefined();
  });

  it("flat {code, message, details}", () => {
    expect(parseAcrossV5Error(401, {code: "unauthenticated", message: "AUTH_INVALID", details: null}, null, NOW)).toEqual({
      status: 401, code: "unauthenticated", message: "AUTH_INVALID", info: {reason: "key_rejected", httpStatus: 401}, retrySameRequest: false,
    });
  });

  it("nested {error: {type, code, message, param, requestId}}", () => {
    expect(parseAcrossV5Error(400, {error: {type: "request", code: "request.unsupported_param", message: "unsupported field: amountTyp", param: "amountTyp", requestId: "req_1"}}, null, NOW)).toEqual({
      status: 400, code: "request.unsupported_param", type: "request", message: "unsupported field: amountTyp", param: "amountTyp", requestId: "req_1",
      info: {reason: "upstream_unavailable", httpStatus: 400}, retrySameRequest: false,
    });
    expect(parseAcrossV5Error(401, {error: {code: "auth.missing_credentials"}}, null, NOW).info).toEqual({reason: "key_rejected", httpStatus: 401});
    expect(parseAcrossV5Error(403, {error: {code: "permission.not_entitled", message: "min-input-quote"}}, null, NOW).info).toEqual({reason: "key_rejected", httpStatus: 403});
  });

  it("policy.amount_out_of_range without a side: the text's direction, the cap's own wording before its direction words", () => {
    const reason = (message: string) => parseAcrossV5Error(400, {error: {code: "policy.amount_out_of_range", message}}, null, NOW).info?.reason;
    expect(reason("quote value loss exceeds the allowance of 1000 bps plus $0; raise the amount above 10794099445838946 base units")).toBe("amount_too_small");
    expect(reason("worst-case relayer costs exceed the minimum output; increase the amount or try again when gas is lower")).toBe("amount_too_small");
    expect(reason("lower the amount below 5")).toBe("amount_too_large");
    expect(reason("Amount below the route minimum")).toBe("amount_too_small");
    expect(reason("amount is above the maximum this route will move")).toBe("amount_too_large");
    expect(reason("fee above maxFee")).toBe("price_check_failed");
    expect(reason("Total fee is above the maximum fee")).toBe("price_check_failed");
    expect(reason("Guaranteed output is below the minimum allowed by maxFee")).toBe("price_check_failed");
    expect(reason("Sent amount is too low relative to fees")).toBe("amount_too_small");
    expect(reason("?")).toBe("price_check_failed");
  });

  it("409 conflict.submission_state_unknown: retry the same request, never re-quote", () => {
    const e = parseAcrossV5Error(409, {error: {code: "conflict.submission_state_unknown"}}, null, NOW);
    expect(e.retrySameRequest).toBe(true);
    expect(e.info).toEqual({reason: "upstream_unavailable", httpStatus: 409});
  });

  it("429 → rate_limited with Retry-After, whatever the code says; 5xx → upstream_unavailable; an unnamed JSON 4xx → no_route", () => {
    expect(parseAcrossV5Error(429, {code: "rate_limited"}, "5", NOW).info).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000});
    expect(parseAcrossV5Error(429, {code: "unauthenticated"}, null, NOW).info).toEqual({reason: "rate_limited", httpStatus: 429});
    expect(parseAcrossV5Error(503, "<html>", null, NOW).info).toEqual({reason: "upstream_unavailable", httpStatus: 503});
    expect(parseAcrossV5Error(400, {error: {code: "something.new", message: "?"}}, null, NOW).info).toEqual({reason: "no_route"});
    expect(parseAcrossV5Error(400, "not json", null, NOW).info).toBeUndefined();
  });

  it("long or odd fields are bounded, non-strings dropped", () => {
    const e = parseAcrossV5Error(400, {error: {code: 5, message: "m".repeat(1000), param: {x: 1}, requestId: ["a"], details: {amountLimits: {side: "sideways", amount: "x"}}}}, null, NOW);
    expect(e.code).toBeUndefined();
    expect(e.message).toHaveLength(240);
    expect(e.param).toBeUndefined();
    expect(e.requestId).toBeUndefined();
    expect(e.amountLimit).toBeUndefined();
  });
});

describe("the HTTP layer", () => {
  const ok = (over: Record<string, unknown> = {}) => (async () => {
    const res = new Response(JSON.stringify({a: 1}), {status: 200});
    for (const [k, v] of Object.entries(over)) Object.defineProperty(res, k, {value: v});
    return res;
  }) as unknown as typeof fetch;
  const opts = (fetchImpl: typeof fetch, signal?: AbortSignal) => ({fetchImpl, timeoutMs: 1000, what: "Across API V5", ...(signal ? {signal} : {})});
  const URL_V5 = "https://api.across.to/v1/quotes";

  it("reads status, body and Retry-After; asks fetch not to follow redirects", async () => {
    let init: RequestInit | undefined;
    const f = (async (_u: unknown, i: RequestInit) => { init = i; return new Response("{\"x\":1}", {status: 429, headers: {"retry-after": "3"}}); }) as unknown as typeof fetch;
    expect(await acrossHttp(URL_V5, {method: "GET", headers: {}}, opts(f))).toEqual({status: 429, body: {x: 1}, retryAfter: "3"});
    expect(init!.redirect).toBe("error");
    expect(init!.signal).toBeDefined();
  });

  it("an answer that came through a redirect, or from another origin, is refused (policy_refused)", async () => {
    for (const over of [{redirected: true}, {url: "https://evil.example/v1/quotes"}]) {
      const err = await acrossHttp(URL_V5, {method: "POST", headers: {}}, opts(ok(over))).catch((e: unknown) => e);
      expect(String((err as Error).message)).toMatch(/redirect or from another origin — refused .*\[api-answer\]$/);
      expect(refusalOf(err)?.reason).toBe("policy_refused");
    }
    // The same origin is fine.
    await expect(acrossHttp(URL_V5, {method: "POST", headers: {}}, opts(ok({url: URL_V5})))).resolves.toMatchObject({status: 200});
  });

  it("no answer → upstream_unavailable; the caller's own abort stays unclassified; an oversized answer is refused", async () => {
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const err = await acrossHttp(URL_V5, {method: "GET", headers: {}}, opts(down)).catch((e: unknown) => e);
    expect(refusalOf(err)?.reason).toBe("upstream_unavailable");
    const ctrl = new AbortController();
    ctrl.abort();
    const aborted = await acrossHttp(URL_V5, {method: "GET", headers: {}}, opts(down, ctrl.signal)).catch((e: unknown) => e);
    expect(refusalOf(aborted)).toBeUndefined();
    const huge = (async () => new Response("x".repeat(600 * 1024))) as unknown as typeof fetch;
    expect(refusalOf(await acrossHttp(URL_V5, {method: "GET", headers: {}}, opts(huge)).catch((e: unknown) => e))?.reason).toBe("upstream_unavailable");
  });
});
