import {describe, expect, it} from "vitest";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler} from "../src/server.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../src/types.js";

// Review 2026-11-15 (Across): a provider whose deposit gives its sender more than refunds — an Across depositor can
// sign a speed-up that pays the output to another recipient — had only `refundAddress`, which a caller may set to any
// address. An execution quote now carries the signing account itself (`QuoteParams.sender`), set by the engine, and a
// backend passes it through.

const SELF = "0x4444444444444444444444444444444444444444";
const OTHER = "0x9999999999999999999999999999999999999999";
const DEPOSIT = "0x5555555555555555555555555555555555555555";
const options = {fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: SELF, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};
const quote = (p: QuoteParams): Quote => ({
  provider: "dep", intentId: "i-1", depositAddress: DEPOSIT, depositMemo: null, sourceAmount: p.amountIn, destAmount: "990000", minDestAmount: "980000",
  feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
}) as Quote;

function engine() {
  const seen: QuoteParams[] = [];
  const provider: CrossChainProvider = {
    name: "dep", enabled: () => true, supportsRoute: () => true, getQuote: async (p) => { seen.push({...p}); return quote(p); },
    buildDeposit: async () => ({chain: "eip155:1", to: DEPOSIT, value: "0"}),
    trackIntent: async () => ({state: "pending"}),
  };
  const account = {getAddress: async () => SELF, getChainId: async () => 1, waitForTransaction: async () => {}, sendTransaction: async () => ({hash: "0x1"})};
  class P extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  return {protocol: new P(account as never, {fromChain: "eip155:1"}), seen};
}

describe("QuoteParams.sender", () => {
  it("an execution quote carries the signing account, whatever refund address the caller names", async () => {
    const e = engine();
    await e.protocol.swap2(options);
    expect(e.seen.at(-1)).toMatchObject({sender: SELF, refundAddress: SELF, dry: false});
    await e.protocol.swap2({...options, refundAddress: OTHER});
    expect(e.seen.at(-1)).toMatchObject({sender: SELF, refundAddress: OTHER, dry: false});
  });

  it("a dry quote names no signer", async () => {
    const e = engine();
    await e.protocol.quoteSwap2(options);
    expect(e.seen.at(-1)!.dry).toBe(true);
    expect(e.seen.at(-1)!.sender).toBeUndefined();
  });

  it("a backend hands it to its provider as given", async () => {
    const seen: QuoteParams[] = [];
    const provider: CrossChainProvider = {
      name: "mock", enabled: () => true, supportsRoute: () => true, getQuote: async (p) => { seen.push(p); return null; },
      buildDeposit: async () => { throw new Error("unused"); }, trackIntent: async () => ({state: "pending"}),
    };
    const handle = createSwap2Handler({providers: [provider], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "user-1");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const client = remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl});
    const params: QuoteParams = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "1000000", destAddress: SELF, refundAddress: SELF, sender: SELF, dry: true};
    await client.getQuote(params);
    expect(seen[0]!.sender).toBe(SELF);
    const {sender: _sender, ...unsigned} = params;
    await client.getQuote(unsigned);
    expect(seen[1]!.sender).toBeUndefined();
  });
});
