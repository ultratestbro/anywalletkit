import {describe, expect, it} from "vitest";
import {ACROSS_API_V1, acrossV5QuoteRequest, parseAcrossV5Error} from "../src/api.js";
import {ARB_USDC, BASE_USDC, USER, ZERO, ethRequest, usdcRequest} from "./fixtures.js";

const NOW = 1_794_700_000_000;

describe("V5 request body", () => {
  it("names exactly what this module sends: exact input, exact approval, EVM approve + send only, the fee cap the verifier holds", () => {
    expect(ACROSS_API_V1).toBe("https://api.across.to/v1");
    expect(acrossV5QuoteRequest(usdcRequest())).toEqual({
      origin: {token: {chainId: 8453, address: BASE_USDC}, depositor: USER, amount: "25000000"},
      destination: {token: {chainId: 42161, address: ARB_USDC}, recipient: USER},
      amountType: "exact_input",
      capabilities: {operations: [{kind: "approve_token", ecosystem: "evm"}, {kind: "send_transaction", ecosystem: "evm"}]},
      authorizationPolicy: {allowedTypes: ["approval"], approvalAmount: "exact"},
      maxFee: {bps: 1000},
    });
    expect(acrossV5QuoteRequest(usdcRequest({maxFeeBps: 50})).maxFee).toEqual({bps: 50});
    expect(acrossV5QuoteRequest(ethRequest()).origin.token.address).toBe(ZERO);
    // No app fee, no gas top-up, no destination actions, no slippage field: the API refuses unknown fields, and these
    // are never sent.
    const body = JSON.stringify(acrossV5QuoteRequest(usdcRequest()));
    for (const f of ["appFeeBps", "gasTopUp", "destinationActions", "slippageBps", "integratorId"]) expect(body).not.toContain(f);
    expect(() => acrossV5QuoteRequest(usdcRequest({sourceChain: "eip155:56"}))).toThrow();
  });
});

describe("V5 error envelopes → CS-13", () => {
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
    expect(parseAcrossV5Error(401, {error: {code: "auth.invalid_credentials"}}, null, NOW).info).toEqual({reason: "key_rejected", httpStatus: 401});
  });

  it("403 permission.not_entitled → key_rejected; request.invalid_field → policy_refused", () => {
    expect(parseAcrossV5Error(403, {error: {code: "permission.not_entitled", message: "min-input-quote"}}, null, NOW).info).toEqual({reason: "key_rejected", httpStatus: 403});
    expect(parseAcrossV5Error(400, {error: {code: "request.invalid_field", param: "appFeeBps"}}, null, NOW).info).toEqual({reason: "policy_refused"});
  });

  it("400 policy.amount_out_of_range: the direction from the text, else the fee over maxFee", () => {
    expect(parseAcrossV5Error(400, {error: {code: "policy.amount_out_of_range", message: "Amount below the route minimum"}}, null, NOW).info).toEqual({reason: "amount_too_small"});
    expect(parseAcrossV5Error(400, {error: {code: "policy.amount_out_of_range", message: "Amount above available liquidity"}}, null, NOW).info).toEqual({reason: "amount_too_large"});
    expect(parseAcrossV5Error(400, {error: {code: "policy.amount_out_of_range", message: "fee exceeds maxFee"}}, null, NOW).info).toEqual({reason: "price_check_failed"});
  });

  it("409 conflict.submission_state_unknown: retry the same request, never re-quote", () => {
    const e = parseAcrossV5Error(409, {error: {code: "conflict.submission_state_unknown"}}, null, NOW);
    expect(e.retrySameRequest).toBe(true);
    expect(e.info).toEqual({reason: "upstream_unavailable", httpStatus: 409});
    expect(parseAcrossV5Error(409, {error: {code: "conflict.other"}}, null, NOW).retrySameRequest).toBe(false);
  });

  it("429 (flat gateway shape) → rate_limited with Retry-After, whatever the code says", () => {
    expect(parseAcrossV5Error(429, {code: "rate_limited"}, "5", NOW).info).toEqual({reason: "rate_limited", httpStatus: 429, retryAfterMs: 5000});
    expect(parseAcrossV5Error(429, {code: "unauthenticated"}, "Sat, 14 Nov 2026 21:46:50 GMT", NOW).info).toMatchObject({reason: "rate_limited", httpStatus: 429});
    expect(parseAcrossV5Error(429, "slow down", null, NOW).info).toEqual({reason: "rate_limited", httpStatus: 429});
  });

  it("5xx → upstream_unavailable; a JSON 4xx no code names → no_route; 404 and non-JSON 4xx unclassified", () => {
    expect(parseAcrossV5Error(503, "<html>", null, NOW).info).toEqual({reason: "upstream_unavailable", httpStatus: 503});
    expect(parseAcrossV5Error(500, {code: "internal"}, null, NOW).info).toEqual({reason: "upstream_unavailable", httpStatus: 500});
    expect(parseAcrossV5Error(400, {error: {code: "something.new", message: "?"}}, null, NOW).info).toEqual({reason: "no_route"});
    expect(parseAcrossV5Error(404, {error: {code: "not_found.transfer"}}, null, NOW).info).toBeUndefined();
    expect(parseAcrossV5Error(400, "not json", null, NOW).info).toBeUndefined();
  });

  it("long or odd fields are bounded, non-strings dropped", () => {
    const e = parseAcrossV5Error(400, {error: {code: 5, message: "m".repeat(1000), param: {x: 1}, requestId: ["a"]}}, null, NOW);
    expect(e.code).toBeUndefined();
    expect(e.message).toHaveLength(240);
    expect(e.param).toBeUndefined();
    expect(e.requestId).toBeUndefined();
  });
});
