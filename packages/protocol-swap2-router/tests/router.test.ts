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

describe("router dispatch snapshot", () => {
  it("keeps every optional provider method, the claim step included", () => {
    const calls: string[] = [];
    const p = {
      name: "twophase",
      enabled: () => true,
      supportsRoute: () => true,
      getQuote: async () => null,
      buildDeposit: async () => ({chain: "", to: "0x", value: "0"}),
      trackIntent: async () => ({state: "pending" as const}),
      preflightDeposit: async () => { calls.push("preflight"); },
      buildClaim: async () => { calls.push("claim"); return null; },
    };
    const r = new CrossChainRouter([p]);
    const got = r.getProvider("twophase")!;
    expect(typeof got.buildClaim).toBe("function");
    expect(typeof got.preflightDeposit).toBe("function");
    void got.buildClaim!({intentId: "x"});
    expect(calls).toEqual(["claim"]);
  });
});

describe("ranking, route picker, progressive quotes", () => {
  const q = (name: string, out: string, eta: number, extra: Record<string, unknown> = {}, delayMs = 0) =>
    provider(name, {
      getQuote: async (params) => {
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        return {
          provider: name, intentId: name, depositAddress: "0xd", depositMemo: null,
          sourceAmount: params.amountIn, destAmount: out, minDestAmount: out,
          feeUsd: 0, etaSeconds: eta, reliability: 0.95, validUntilMs: Date.now() + 60_000, ...extra,
        };
      },
    });
  // Ethereum USDT → Arbitrum USDT (6 decimals): 1_000_000 = $1.
  const PARAMS = {
    sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161",
    destToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", amountIn: "100000000", destAddress: "0x3333333333333333333333333333333333333333",
  };

  it("a sliver of extra output no longer beats a route twenty times faster", async () => {
    const router = new CrossChainRouter([q("slow", "99950000", 1200), q("fast", "99900000", 60)]);
    const set = (await router.getQuotes(PARAMS))!;
    expect(set.best.provider).toBe("fast"); // 0.05% apart: the same price, the faster wins
    expect(set.fastest.provider).toBe("fast");
    expect(set.quotes.map((x) => x.provider)).toEqual(["fast", "slow"]);
  });

  it("a real price gap still wins over speed", async () => {
    const router = new CrossChainRouter([q("slow", "99000000", 1200), q("fast", "97000000", 60)]);
    const set = (await router.getQuotes(PARAMS))!;
    expect(set.best.provider).toBe("slow");
    expect(set.best.tags).toEqual(["best"]);
    expect(set.fastest.provider).toBe("fast");
    expect(set.fastest.tags).toEqual(["fastest"]);
    expect((await router.getBestQuote(PARAMS, {prefer: "fastest"}))!.provider).toBe("fast");
  });

  it("nets a native bridge fee out of the route's value (usdValue)", async () => {
    const {usdValue} = await import("../src/value.js");
    // "bridge" lands $1 more but charges 0.001 ETH ($3) on top of the input.
    const router = new CrossChainRouter(
      [q("bridge", "100000000", 60, {txRequest: {to: "0xd", data: "0x", value: "1000000000000000", nativeFee: "1000000000000000"}}), q("plain", "99000000", 60)],
      {valueUsd: usdValue({ETH: 3000, USDT: 1})},
    );
    const set = (await router.getQuotes(PARAMS))!;
    expect(set.best.provider).toBe("plain");
    expect(set.quotes.find((x) => x.provider === "bridge")!.netValueUsd).toBeCloseTo(97, 6);
    expect(set.best.netValueUsd).toBeCloseTo(99, 6);
  });

  it("without a price for every quote it compares guaranteed outputs", async () => {
    const router = new CrossChainRouter([q("a", "99000000", 60), q("b", "98000000", 60)], {valueUsd: () => null});
    const set = (await router.getQuotes(PARAMS))!;
    expect(set.best.provider).toBe("a");
    expect(set.best.netValueUsd).toBeNull();
  });

  it("publishes the ranked set as each provider answers — the first price does not wait for the slowest", async () => {
    const router = new CrossChainRouter([q("quick", "98000000", 60, {}, 5), q("late", "99500000", 300, {}, 80)]);
    const updates: {providers: string[]; pending: string[]; at: number}[] = [];
    const t0 = Date.now();
    const final = await router.getQuotes(PARAMS, {onUpdate: (s) => updates.push({providers: s.quotes.map((x) => x.provider), pending: s.pending, at: Date.now() - t0})});
    expect(updates[0]).toMatchObject({providers: ["quick"], pending: ["late"]});
    expect(updates[0]!.at).toBeLessThan(60);
    expect(updates.at(-1)).toMatchObject({providers: ["late", "quick"], pending: []});
    expect(final!.best.provider).toBe("late");
  });

  it("lists routes for a picker and executes the one the user chose", async () => {
    const swap2 = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [q("slow", "99000000", 1200), q("fast", "97000000", 60)]});
    const options = {
      fromToken: "USDT", toToken: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9", toChain: "eip155:42161",
      fromTokenAmount: 100_000_000n, recipient: "0x3333333333333333333333333333333333333333",
    };
    const routes = await swap2.quoteSwap2Routes(options);
    expect(routes.map((r) => [r.provider, r.tags])).toEqual([["slow", ["best"]], ["fast", ["fastest"]]]);
    expect((await swap2.using("fast").quoteSwap2(options)).toTokenAmountMin).toBe(97_000_000n);
    expect(() => swap2.using("nope")).toThrow(/not registered/);
    const fastFirst = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", prefer: "fastest", providers: [q("slow", "99000000", 1200), q("fast", "97000000", 60)]});
    expect((await fastFirst.quoteSwap2(options)).toTokenAmountMin).toBe(97_000_000n);
  });
});
