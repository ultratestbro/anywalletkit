// The orderbook's quote is an answer to one request: every field it echoes is held to that request, and an answer
// bent in any single field is refused before anything is built from it.
import {describe, expect, it} from "vitest";
import {buildAppData} from "../src/appdata.js";
import {isoToMs, readQuoteResponse, type CowQuoteExpectation} from "../src/provider.js";
import {ME, OTHER, USDC, USDT, WETH, quoteAnswer, world} from "./fixtures.js";

const NOW = 1_800_000_000;
const doc = buildAppData({slippageBps: 50});
const expectation: CowQuoteExpectation = {sellToken: USDC, buyToken: WETH, receiver: ME, from: ME, signingScheme: "eip712", appData: doc, amountIn: "25000000", validForSeconds: 1200, nowSeconds: NOW};
const w = world({clock: () => NOW * 1000});
const request = {
  sellToken: USDC.toLowerCase(), buyToken: WETH.toLowerCase(), receiver: ME.toLowerCase(), from: ME.toLowerCase(), kind: "sell", sellAmountBeforeFee: "25000000",
  priceQuality: "verified", signingScheme: "eip712", validFor: 1200, appData: doc.json, appDataHash: doc.hash,
};
const answer = () => quoteAnswer(w, request);
const bent = (change: (a: ReturnType<typeof answer>) => void) => {
  const a = answer();
  change(a);
  return a;
};

describe("readQuoteResponse", () => {
  it("reads an honest answer", () => {
    expect(readQuoteResponse(answer(), expectation)).toEqual({
      sellAmount: 24_999_000n, buyAmount: 9_999n, feeAmount: 1000n, validTo: NOW + 1200, id: 777, expirationMs: NOW * 1000 + 120_000, verified: true,
    });
    expect(readQuoteResponse(bent((a) => { a.id = null; }), expectation).id).toBeNull();
    expect(readQuoteResponse(bent((a) => { delete a.verified; }), expectation).verified).toBe(false);
    expect(readQuoteResponse(bent((a) => { a.verified = "true"; }), expectation).verified).toBe(false);
    // The orderbook may echo the document or its hash.
    expect(readQuoteResponse(bent((a) => { a.quote.appData = doc.hash; }), expectation).buyAmount).toBe(9_999n);
    // The device's clock may be off by a few minutes, not more.
    expect(readQuoteResponse(bent((a) => { a.quote.validTo = NOW + 1200 + 300; }), expectation).validTo).toBe(NOW + 1500);
  });

  const cases: [string, (a: ReturnType<typeof answer>) => void, RegExp][] = [
    ["another sell token", (a) => { a.quote.sellToken = USDT.toLowerCase(); }, /sells another token/],
    ["a malformed sell token", (a) => { a.quote.sellToken = "USDC"; }, /sells another token/],
    ["another buy token", (a) => { a.quote.buyToken = USDT.toLowerCase(); }, /buys another token/],
    ["another receiver", (a) => { a.quote.receiver = OTHER.toLowerCase(); }, /pays another receiver/],
    ["no receiver (the owner by default is not what was asked)", (a) => { a.quote.receiver = null; }, /pays another receiver/],
    ["another account", (a) => { a.from = OTHER.toLowerCase(); }, /is for another account/],
    ["a buy order", (a) => { a.quote.kind = "buy"; }, /is not a sell order/],
    ["a partially fillable order", (a) => { a.quote.partiallyFillable = true; }, /is partially fillable/],
    ["a missing partiallyFillable", (a) => { delete a.quote.partiallyFillable; }, /is partially fillable/],
    ["an internal sell balance", (a) => { a.quote.sellTokenBalance = "internal"; }, /uses vault balances/],
    ["an external sell balance", (a) => { a.quote.sellTokenBalance = "external"; }, /uses vault balances/],
    ["an internal buy balance", (a) => { a.quote.buyTokenBalance = "internal"; }, /uses vault balances/],
    ["ethsign as the scheme", (a) => { a.quote.signingScheme = "ethsign"; }, /names another signing scheme/],
    ["presign as the scheme", (a) => { a.quote.signingScheme = "presign"; }, /names another signing scheme/],
    ["another appData hash", (a) => { a.quote.appDataHash = buildAppData({slippageBps: 51}).hash; }, /another appData document/],
    ["another appData document", (a) => { a.quote.appData = buildAppData({slippageBps: 51}).json; }, /another appData document/],
    ["a document with a partner fee", (a) => { a.quote.appData = doc.json.replace('"quote"', '"partnerFee":{"bps":100,"recipient":"0x0000000000000000000000000000000000000001"},"quote"'); }, /another appData document/],
    ["no appData hash", (a) => { delete a.quote.appDataHash; }, /another appData document/],
    ["a hex amount", (a) => { a.quote.buyAmount = "0x10"; }, /malformed amount/],
    ["a numeric amount", (a) => { a.quote.sellAmount = 24_999_000; }, /malformed amount/],
    ["a negative fee", (a) => { a.quote.feeAmount = "-1000"; }, /malformed amount/],
    ["a zero output", (a) => { a.quote.buyAmount = "0"; }, /zero amount/],
    ["a zero input", (a) => { a.quote.sellAmount = "0"; a.quote.feeAmount = "25000000"; }, /zero amount/],
    ["a larger input than asked", (a) => { a.quote.sellAmount = "25000000"; }, /does not add up to the input/],
    ["a smaller input than asked", (a) => { a.quote.sellAmount = "2499900"; }, /does not add up to the input/],
    ["a far-future expiry", (a) => { a.quote.validTo = NOW + 1200 + 301; }, /expires at another time than requested/],
    ["an expiry in the past", (a) => { a.quote.validTo = NOW - 1; }, /expires at another time than requested/],
    ["the maximum expiry", (a) => { a.quote.validTo = 0xffffffff; }, /malformed expiry/],
    ["a text expiry", (a) => { a.quote.validTo = String(NOW + 1200); }, /malformed expiry/],
    ["a fractional expiry", (a) => { a.quote.validTo = NOW + 1200.5; }, /malformed expiry/],
    ["a text id", (a) => { a.id = "777"; }, /malformed id/],
    ["a negative id", (a) => { a.id = -1; }, /malformed id/],
    ["an unsafe id", (a) => { a.id = 2 ** 60; }, /malformed id/],
    ["no expiration", (a) => { delete a.expiration; }, /malformed expiration/],
    ["an expiration that is not ISO", (a) => { a.expiration = "tomorrow"; }, /malformed expiration/],
    ["an expiration already past", (a) => { a.expiration = new Date(NOW * 1000).toISOString(); }, /has expired already/],
  ];
  for (const [name, change, error] of cases) it(`refuses ${name}`, () => expect(() => readQuoteResponse(bent(change), expectation)).toThrow(error));

  it("refuses an answer that is not a quote at all", () => {
    for (const raw of [null, undefined, "ok", 5, [], {}, {quote: null}, {quote: "x"}]) expect(() => readQuoteResponse(raw, expectation), JSON.stringify(raw)).toThrow(/is malformed|sells another token/);
  });

  it("every refusal names the orderbook's quote", () => {
    expect(() => readQuoteResponse({}, expectation)).toThrow(/^cow: the orderbook's quote /);
  });
});

describe("isoToMs", () => {
  it("reads the orderbook's nanosecond timestamps without Date.parse", () => {
    expect(isoToMs("2026-11-10T09:14:02.123456789Z")).toBe(Date.UTC(2026, 10, 10, 9, 14, 2, 123));
    expect(isoToMs("2026-11-10T09:14:02Z")).toBe(Date.UTC(2026, 10, 10, 9, 14, 2));
    expect(isoToMs("2026-11-10T09:14:02.5Z")).toBe(Date.UTC(2026, 10, 10, 9, 14, 2, 500));
  });
  it("reads nothing else", () => {
    for (const bad of ["2026-11-10 09:14:02Z", "2026-11-10T09:14:02+01:00", "2026-11-10T09:14:02", "", null, 5, "2026-11-10T09:14:02.1234567890Z"]) expect(isoToMs(bad)).toBeNull();
  });
});
