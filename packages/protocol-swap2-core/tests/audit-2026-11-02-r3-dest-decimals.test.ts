// A quote's `destDecimals` (the provider's word for a destination token the catalog may not list) must survive the swap2
// server's seal, or a remote Mayan leg to such a token would reach the account without a reviewed minimum and be
// refused. It is sealed as a whole number in 0..36; anything else is refused like any malformed quote field.
import {describe, expect, it} from "vitest";
import {createSwap2Handler} from "../src/server.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../src/types.js";

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: `0x${"ab".repeat(20)}`, amountIn: "100000000",
  destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "mock", intentId: "intent-1", depositAddress: "0x2222222222222222222222222222222222222222", depositMemo: null,
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0.1, etaSeconds: 30, reliability: 0.97, validUntilMs: Date.now() + 60_000,
};
const handler = (q: Partial<Quote> & Record<string, unknown>) => {
  const provider: CrossChainProvider = {name: "mock", enabled: () => true, supportsRoute: () => true, getQuote: async () => ({...QUOTE, ...q}) as Quote,
    buildDeposit: async () => { throw new Error("unused"); }, trackIntent: async () => ({state: "pending"})};
  return createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
};

describe("audit 2026-11-02 r3: the server seals a quote's destDecimals", () => {
  it("keeps whole decimals in 0..36 and refuses anything else", async () => {
    const ok = await handler({destDecimals: 18})("quote", {provider: "mock", params: PARAMS}, "u");
    expect(ok.status).toBe(200);
    expect((ok.body as Quote).destDecimals).toBe(18);
    for (const bad of [6.5, -1, 37, "6"]) expect((await handler({destDecimals: bad as never})("quote", {provider: "mock", params: PARAMS}, "u")).status).toBe(502);
  });
});
