// SDK-291: a quote's `gasless` (the user signs, a third party sends and pays the gas) reaches a remote client through
// the swap2 server's seal, so the router's source-gas estimate counts no swap gas for it there too.
import {describe, expect, it} from "vitest";
import {createSwap2Handler} from "../src/server.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../src/types.js";

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "ton:-239", destToken: "USDT", amountIn: "100000000",
  destAddress: "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "mock", intentId: "intent-1", depositAddress: "", depositMemo: null,
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0.1, etaSeconds: 240, reliability: 0.9, validUntilMs: Date.now() + 60_000,
};
const handler = (q: Record<string, unknown>) => {
  const provider: CrossChainProvider = {name: "mock", enabled: () => true, supportsRoute: () => true, getQuote: async () => ({...QUOTE, ...q}) as Quote,
    buildDeposit: async () => { throw new Error("unused"); }, trackIntent: async () => ({state: "pending"})};
  return createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
};

describe("SDK-291: the server seals a quote's gasless flag", () => {
  it("keeps true, drops false and absent, refuses a non-boolean", async () => {
    const yes = await handler({gasless: true})("quote", {provider: "mock", params: PARAMS}, "u");
    expect(yes.status).toBe(200);
    expect((yes.body as Quote).gasless).toBe(true);
    for (const q of [{gasless: false}, {}]) {
      const res = await handler(q)("quote", {provider: "mock", params: PARAMS}, "u");
      expect(res.status).toBe(200);
      expect(res.body).not.toHaveProperty("gasless");
    }
    for (const bad of ["true", 1, null]) expect((await handler({gasless: bad})("quote", {provider: "mock", params: PARAMS}, "u")).status).toBe(502);
  });
});
