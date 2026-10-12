import {describe, expect, it} from "vitest";
import type {CrossChainProvider} from "@forgewallet/protocol-swap2-core/types";
import {remoteProvider} from "@forgewallet/protocol-swap2-core/remote";
import {CrossChainRouter} from "../src/router.js";
import {RouterSwap2Protocol} from "../src/swap2/router.js";

const provider = (name: string, overrides: Partial<CrossChainProvider> = {}): CrossChainProvider => ({
  name,
  enabled: () => true,
  supportsRoute: () => true,
  getQuote: async (params) => ({
    provider: name, intentId: `${name}-intent`, depositAddress: "0xdeposit", depositMemo: null,
    sourceAmount: params.amountIn, destAmount: "100", minDestAmount: "100",
    feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
  }),
  buildDeposit: async () => ({chain: "", to: "0xdeposit", value: "0"}),
  trackIntent: async () => ({state: "pending"}),
  ...overrides,
});

describe("auction engine", () => {
  it("rejects duplicate provider names", () => {
    const p = provider("x");
    expect(() => new CrossChainRouter([p, p])).toThrow(/duplicate/i);
  });

  it("names each venue's own refusal in lastRejections, per call", async () => {
    const seen: string[] = [];
    const router = new CrossChainRouter([
      provider("a", {getQuote: async (params) => { params.onRefusal?.("a: floor breach"); return null; }}),
      provider("b", {getQuote: async (params) => { params.onRefusal?.("round it to 8 decimals"); return null; }}),
      provider("c", {getQuote: async () => null}),
    ]);
    await expect(router.getBestQuote({sourceChain: "eip155:1", sourceToken: "ETH", destChain: "eip155:10", destToken: "0x0", amountIn: "1", destAddress: "0x1", onRefusal: (r) => seen.push(r)})).resolves.toBeNull();
    expect([...router.lastRejections].sort()).toEqual(["a: floor breach", "b: round it to 8 decimals", "c: returned no quote"]);
    expect(seen.sort()).toEqual(["a: floor breach", "round it to 8 decimals"]);
  });

  it("keeps immediate-execution flows from selecting order-only quotes", async () => {
    const make = (name: string, destAmount: string, depositAddress: string) => provider(name, {
      getQuote: async (params) => ({
        provider: name, intentId: `${name}-intent`, depositAddress, depositMemo: null,
        sourceAmount: params.amountIn, destAmount, minDestAmount: destAmount,
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
      buildDeposit: async () => ({chain: "ton:-239", to: depositAddress, value: "100"}),
    });
    const router = new CrossChainRouter([make("order-only", "110", ""), make("deposit-address", "100", "EQdeposit")]);
    const params = {
      sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:1",
      destToken: "USDC", amountIn: "100", destAddress: "0x1",
    };
    expect((await router.getBestQuote(params))?.provider).toBe("order-only");
    expect((await router.getBestQuote(params, {requireImmediateExecution: true}))?.provider).toBe("deposit-address");
  });
});

describe("aggregator over caller-supplied providers", () => {
  it("needs exactly one of providers / router", () => {
    expect(() => new RouterSwap2Protocol(undefined, {fromChain: "eip155:1"})).toThrow(/exactly one/);
    expect(() => new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [], router: new CrossChainRouter([])}))
      .toThrow(/exactly one/);
    expect(() => new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: []})).not.toThrow();
  });

  it("takes capabilities from the providers themselves, honoring enabled", async () => {
    const evmOnly = provider("evm", {
      supportsChain: (c) => c.startsWith("eip155:"),
      supportsChainPair: (a, b) => a.startsWith("eip155:") && b.startsWith("eip155:"),
    });
    const tonDark = provider("ton", {
      enabled: () => false,
      supportsChain: (c) => c === "ton:-239",
      supportsChainPair: () => true,
    });
    const swap2 = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [evmOnly, tonDark]});
    const chains = (await swap2.getSupportedChains()).map((c) => String(c.id));
    expect(chains).toContain("eip155:1");
    expect(chains).not.toContain("ton:-239");
    expect(await swap2.getSupportedTokens({fromChain: "eip155:1", toChain: "ton:-239"})).toEqual([]);
    expect((await swap2.getSupportedTokens({fromChain: "eip155:1", toChain: "eip155:42161"})).length).toBeGreaterThan(0);
  });

  it("a remote provider is discoverable once the caller gives it capabilities", async () => {
    const remote = remoteProvider({name: "lifi", baseUrl: "https://example.invalid/swap2", supportsChain: (c) => c === "eip155:1"});
    const swap2 = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [remote]});
    expect((await swap2.getSupportedChains()).map((c) => String(c.id))).toEqual(["eip155:1"]);
    const blind = new RouterSwap2Protocol(undefined, {
      fromChain: "eip155:1",
      providers: [remoteProvider({name: "lifi", baseUrl: "https://example.invalid/swap2"})],
    });
    expect(await blind.getSupportedChains()).toEqual([]);
  });

  it("quotes the best provider across the auction", async () => {
    const worse = provider("worse", {
      getQuote: async (params) => ({
        provider: "worse", intentId: "w", depositAddress: "0xd", depositMemo: null,
        sourceAmount: params.amountIn, destAmount: "95", minDestAmount: "95",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
      }),
    });
    const swap2 = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [worse, provider("best")]});
    const quote = await swap2.quoteSwap2({
      fromToken: "USDT", toToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", toChain: "eip155:42161",
      fromTokenAmount: 100n, recipient: "0x3333333333333333333333333333333333333333",
    });
    expect(quote.toTokenAmountMin).toBe(100n);
  });
});
