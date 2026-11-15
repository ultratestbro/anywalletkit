import {describe, expect, it} from "vitest";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {acrossQuoteOf, buildAcrossDeposit} from "../src/build.js";
import {decodeAcrossDeposit} from "../src/deposit.js";
import {ACROSS_GAS_CAP, acrossIntentId, acrossPins, checkAcrossQuote, parseAcrossIntentId} from "../src/verify.js";
import type {NormalizedAcrossQuote} from "../src/build.js";
import {ARB_USDC, ARB_USDT0, BASE, BASE_USDC, NOW_MS, NOW_S, OTHER, RELAYER, USER, ZERO, ethRequest, refused, usdcQuote, usdcRequest, type Loose} from "./fixtures.js";

describe("buildAcrossDeposit", () => {
  it("encodes the call from the pins and the request, and the quote's numbers only", () => {
    const v = buildAcrossDeposit(usdcRequest(), usdcQuote());
    expect(v.deposit).toMatchObject({to: BASE.spokePool, value: "0", chainId: 8453, approvalAddress: BASE.spokePool});
    expect(decodeAcrossDeposit(v.deposit.data)).toEqual({
      depositor: USER, recipient: USER, inputToken: BASE_USDC, outputToken: ARB_USDC, inputAmount: 25_000_000n, outputAmount: 24_990_967n,
      destinationChainId: 42161n, exclusiveRelayer: ZERO, quoteTimestamp: NOW_S - 60, fillDeadline: NOW_S + 7140, exclusivityParameter: 0, message: "0x",
    });
  });

  it("the native coin: the wrapped native token on both sides, the amount as value, no approval", () => {
    const v = buildAcrossDeposit(ethRequest(), usdcQuote({inputToken: ZERO, outputToken: ZERO, inputAmount: "10000000000000000", outputAmount: "9990000000000000", fees: undefined}));
    expect(v.deposit.value).toBe("10000000000000000");
    expect(v.deposit.approvalAddress).toBeUndefined();
    expect(v.args.inputToken).toBe("0x4200000000000000000000000000000000000006");
    expect(v.args.outputToken).toBe("0x82af49447d8a07e3bd95bd0d56f35241523fbab1");
  });

  it("a quote for something else is refused before anything is encoded", () => {
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({destinationChainId: 10})), "quote-normalized", "policy_refused");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({sourceChainId: 1})), "quote-normalized", "policy_refused");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({outputToken: ARB_USDT0})), "quote-normalized", "policy_refused");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({inputAmount: "25000001"})), "quote-normalized", "policy_refused");
  });

  it("a malformed quote is the quote source's failure", () => {
    for (const bad of [
      {outputAmount: "1e6"}, {outputAmount: "-1"}, {outputAmount: "01"}, {inputAmount: 25000000 as unknown as string},
      {quoteTimestamp: -1}, {fillDeadline: 2 ** 32}, {exclusivityParameter: 1.5}, {exclusiveRelayer: "0x12"},
      {expectedFillTimeSec: Number.NaN}, {expiresAtMs: 0}, {orderId: "has space"}, {expectedOutputAmount: "x"},
      {fees: {total: "x"}}, {fees: {total: "9033", lp: "-1"}}, {fees: {total: "9033", totalUsd: -1}},
    ] as Loose<NormalizedAcrossQuote>[]) {
      refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote(bad)), "quote-normalized", "upstream_unavailable");
    }
    refused(() => buildAcrossDeposit(usdcRequest(), null as never), "quote-normalized", "upstream_unavailable");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({fees: {total: "1"}})), "quote-normalized", "price_check_failed");
  });

  it("what the verifier refuses, the builder refuses with the same code", () => {
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({outputAmount: "1", fees: undefined})), "tx-output-amount", "price_check_failed");
    refused(() => buildAcrossDeposit(usdcRequest({minAmountOut: undefined}), usdcQuote({outputAmount: "20000000", fees: undefined})), "tx-fee", "price_check_failed");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({exclusiveRelayer: RELAYER, exclusivityParameter: 3})), "tx-exclusivity", "policy_refused");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({fillDeadline: NOW_S + 60})), "tx-fill-deadline", "quote_expired");
    refused(() => buildAcrossDeposit(usdcRequest(), usdcQuote({quoteTimestamp: NOW_S - 3500})), "tx-quote-time", "quote_expired");
    refused(() => buildAcrossDeposit(usdcRequest({destToken: OTHER}), usdcQuote()), "token-unsupported", "unsupported_pair");
  });
});

describe("acrossQuoteOf / checkAcrossQuote", () => {
  const quote = (over: Partial<Quote> = {}): Quote => ({...acrossQuoteOf(usdcRequest(), usdcQuote({expiresAtMs: NOW_MS + 900_000, orderId: "ord_1"})), ...over});

  it("the quote carries the built deposit, the deposit's amounts, and an id naming its calldata", () => {
    const q = quote();
    expect(q).toMatchObject({provider: "across", depositAddress: "", depositMemo: null, sourceAmount: "25000000", destAmount: "24990967", minDestAmount: "24990967", destDecimals: 6, etaSeconds: 2, reliability: 0.97});
    expect(q.txRequest).toEqual({to: BASE.spokePool, data: buildAcrossDeposit(usdcRequest(), usdcQuote()).deposit.data, value: "0", chainId: 8453, approvalAddress: BASE.spokePool});
    expect(q.intentId).toBe(acrossIntentId(8453, 42161, q.txRequest!.data as `0x${string}`));
    expect(parseAcrossIntentId(q.intentId)).toMatchObject({sourceChainId: 8453, destChainId: 42161});
    expect(q.validUntilMs).toBe(NOW_MS + 60_000);
    expect(q.fees).toEqual([{type: "protocol", amount: "9033", token: BASE_USDC, included: true, description: "Across relayer and LP fee"}]);
    expect(q.providerData).toMatchObject({sourceChain: "eip155:8453", amount: "25000000", depositor: USER, outputAmount: "24990967", orderId: "ord_1"});
    for (const v of Object.values(q.providerData!)) expect(typeof v).toBe("string");
    expect(checkAcrossQuote(usdcRequest(), q).fee).toBe(9033n);
  });

  it("a quote source's expiry shortens the quote's life", () => {
    expect(acrossQuoteOf(usdcRequest(), usdcQuote({expiresAtMs: NOW_MS + 5_000})).validUntilMs).toBe(NOW_MS + 5_000);
    refused(() => acrossQuoteOf(usdcRequest(), usdcQuote(), {quoteTtlMs: 300_001}), "request-invalid");
  });

  it("tampered quotes", () => {
    const q = quote();
    refused(() => checkAcrossQuote(usdcRequest(), {...q, provider: "relay"}), "quote-shape", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, txRequest: undefined} as never), "quote-shape", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, depositAddress: OTHER}), "quote-shape", "vault_mismatch");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, txRequest: {...q.txRequest!, nativeFee: "1"}}), "quote-shape", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, txRequest: {...q.txRequest!, serializedTx: "AA"}}), "quote-shape", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, minDestAmount: "24990968"}), "quote-amounts", "price_check_failed");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, destAmount: "25000000"}), "quote-amounts", "price_check_failed");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, sourceAmount: "1"}), "quote-amounts", "price_check_failed");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, validUntilMs: NOW_MS + 10 * 60_000}), "quote-expiry", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, validUntilMs: Number.NaN}), "quote-expiry", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, intentId: "across:8453:42161:" + "0".repeat(32)}), "quote-intent", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, intentId: q.intentId.replace("8453", "10")}), "quote-intent", "policy_refused");
    refused(() => checkAcrossQuote(usdcRequest(), {...q, intentId: "relay:0x1"}), "quote-intent", "policy_refused");
    // A server's intent token is accepted after the id.
    checkAcrossQuote(usdcRequest(), {...q, intentId: `${q.intentId}~${"ab".repeat(16)}`});
    refused(() => checkAcrossQuote(usdcRequest(), {...q, intentId: `${q.intentId}~zz`}), "quote-intent", "policy_refused");
    // Gas: absent, or within the band.
    checkAcrossQuote(usdcRequest(), {...q, txRequest: {...q.txRequest!, gasLimit: "200000"}});
    for (const gasLimit of ["1", "89999", (ACROSS_GAS_CAP + 1n).toString(), "0x30d40", "2e5"]) {
      refused(() => checkAcrossQuote(usdcRequest(), {...q, txRequest: {...q.txRequest!, gasLimit}}), "quote-gas", "policy_refused");
    }
    // The request is what decides: the same quote for another recipient is refused.
    refused(() => checkAcrossQuote(usdcRequest({recipient: OTHER}), q), "tx-recipient", "recipient_mismatch");
  });
});

describe("remote pins", () => {
  const q = acrossQuoteOf(usdcRequest(), usdcQuote());
  const params = (over: Partial<QuoteParams> = {}): QuoteParams => ({
    sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "25000000",
    minAmountOut: "24900000", destAddress: USER, refundAddress: USER, sender: USER, ...over,
  });
  const at = <T>(fn: () => T): T => {
    const real = Date.now;
    Date.now = () => NOW_MS;
    try { return fn(); } finally { Date.now = real; }
  };
  const tx: UnsignedTx = {chain: "eip155:8453", to: q.txRequest!.to!, data: q.txRequest!.data!, value: "0", chainId: 8453, approvalAddress: BASE.spokePool};

  it("verifyQuote / verifyBuild pass the honest quote and build, and classify every refusal", () => {
    expect(at(() => acrossPins.verifyQuote!(params(), q))).toBeNull();
    expect(at(() => acrossPins.verifyBuild!(q, tx, params()))).toBeNull();
    const other = at(() => acrossPins.verifyQuote!(params({destAddress: OTHER}), q))!;
    expect(other).toMatch(/\[tx-recipient\]$/);
    expect(acrossPins.reasonOf!(other)).toEqual({reason: "recipient_mismatch"});
    const floor = at(() => acrossPins.verifyQuote!(params({minAmountOut: "24990968"}), q))!;
    expect(acrossPins.reasonOf!(floor)).toEqual({reason: "price_check_failed"});
  });

  it("a remote build: the request must be known, the chain right, the shape one EVM call", () => {
    expect(acrossPins.reasonOf!(at(() => acrossPins.verifyBuild!(q, tx)) as string)).toEqual({reason: "policy_refused"});
    expect(at(() => acrossPins.verifyBuild!(q, {...tx, chain: "eip155:1"}, params()))).toMatch(/\[tx-chain\]$/);
    expect(at(() => acrossPins.verifyBuild!(q, {...tx, typedData: "{}"}, params()))).toMatch(/\[tx-shape\]$/);
    const speedUp = at(() => acrossPins.verifyBuild!(q, {...tx, typedData: JSON.stringify({primaryType: "UpdateDepositDetails"})}, params())) as string;
    expect(speedUp).toMatch(/\[speed-up\]$/);
    expect(acrossPins.reasonOf!(speedUp)).toEqual({reason: "policy_refused"});
    expect(at(() => acrossPins.verifyBuild!(q, {...tx, memo: "x"}, params()))).toMatch(/\[tx-shape\]$/);
    expect(at(() => acrossPins.verifyBuild!(q, {...tx, approvalAddress: OTHER}, params()))).toMatch(/\[tx-approval\]$/);
    expect(at(() => acrossPins.verifyBuild!(q, {...tx, data: tx.data!.slice(0, -2) + "01"}, params()))).toMatch(/\[tx-calldata\]$/);
  });

  it("a text the pins did not produce has no reason", () => {
    expect(acrossPins.reasonOf!("something else")).toBeUndefined();
  });
});
