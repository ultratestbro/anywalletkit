import {describe, expect, it, vi} from "vitest";
import {CrossChainRouter} from "@forgewallet/protocol-swidge-core/router";
import {RouterSwidgeProtocol} from "../src/swidge/router.js";

describe("aggregator public contract", () => {
  const options = {
    fromToken: "USDT", toToken: "USDT", toChain: "eip155:42161", recipient: "0xrecipient",
    fromTokenAmount: 100n, minAmountOut: 90n,
  };
  const quote = {
    fromTokenAmount: 100n, toTokenAmount: 100n, toTokenAmountMin: 90n,
    fees: [] as never[], expiry: Math.floor(Date.now() / 1000) + 60,
  };
  const external = (overrides: Record<string, unknown> = {}) => ({
    quoteSwidge: async () => quote,
    swidge: async () => ({id: "source", fees: [], fromTokenAmount: 100n, toTokenAmount: 100n, toTokenAmountMin: 90n}),
    getSwidgeStatus: async () => ({status: "pending" as const}),
    getSupportedChains: async () => [], getSupportedTokens: async () => [],
    ...overrides,
  });

  it("rejects duplicate external module names", () => {
    const protocol = {quoteSwidge: async () => { throw new Error(); }, swidge: async () => { throw new Error(); }, getSwidgeStatus: async () => ({status: "pending" as const}), getSupportedChains: async () => [], getSupportedTokens: async () => []};
    expect(() => new RouterSwidgeProtocol(undefined, {fromChain: "eip155:1", router: new CrossChainRouter([]), modules: [{name: "x", protocol}, {name: "x", protocol}]})).toThrow(/duplicate/);
  });

  it("rejects malformed quotes and execution results from external modules", async () => {
    const router = new CrossChainRouter([]);
    const badQuote = new RouterSwidgeProtocol(undefined, {
      fromChain: "eip155:1", router,
      modules: [{name: "bad", protocol: external({quoteSwidge: async () => ({...quote, fees: [{type: "network", amount: -1n, token: "ETH"}]})})}],
    });
    await expect(badQuote.quoteSwidge(options)).rejects.toThrow(/no route/);

    const badResult = new RouterSwidgeProtocol(undefined, {
      fromChain: "eip155:1", router,
      modules: [{name: "bad", protocol: external({swidge: async () => ({id: "", fees: [], fromTokenAmount: 100n, toTokenAmount: 100n})})}],
    });
    await expect(badResult.swidge(options)).rejects.toThrow(/malformed execution result/);
  });

  it("rejects malformed wrapped ids without calling a module", async () => {
    const status = vi.fn(async () => ({status: "pending" as const}));
    const protocol = new RouterSwidgeProtocol(undefined, {
      fromChain: "eip155:1", router: new CrossChainRouter([]),
      modules: [{name: "mod", protocol: external({getSwidgeStatus: status})}],
    });
    await expect(protocol.getSwidgeStatus("awk1.mod~mod.%ZZ")).rejects.toThrow(/malformed external-module status id/);
    expect(status).not.toHaveBeenCalled();
  });

  it("isolates throwing route discovery hooks", async () => {
    const protocol = new RouterSwidgeProtocol(undefined, {
      fromChain: "eip155:1", router: new CrossChainRouter([]),
      modules: [{name: "mod", protocol: external(), supportsRoute: () => { throw new Error("boom"); }}],
    });
    await expect(protocol.getSupportedTokens({fromChain: "eip155:1", toChain: "eip155:42161"})).resolves.toEqual([]);
  });
});

/**
 * A module that cannot name its account is excluded from an account-bound
 * auction — correctly, since it could be wired to a different account. That
 * exclusion used to happen silently at auction time, which meant such a module
 * quoted perfectly while unbound (every display quote, every test that only
 * quotes) and disappeared the moment a wallet was attached. It is now refused
 * at construction, where the wiring mistake actually is.
 */
describe("module account binding", () => {
  const protocol = {
    quoteSwidge: async () => ({fromTokenAmount: 100n, toTokenAmount: 100n, toTokenAmountMin: 90n, fees: []}),
    swidge: async () => ({id: "source", fees: [], fromTokenAmount: 100n, toTokenAmount: 100n, toTokenAmountMin: 90n}),
    getSwidgeStatus: async () => ({status: "pending" as const}),
    getSupportedChains: async () => [],
    getSupportedTokens: async () => [],
  };
  const account = {getAddress: async () => "0xabc", getChainId: async () => 1};
  const config = (modules: unknown[]) => ({
    fromChain: "eip155:1",
    router: new CrossChainRouter([]),
    modules: modules as never,
  });

  it("refuses an unbindable module on an account-bound router", () => {
    expect(() => new RouterSwidgeProtocol(account as never, config([{name: "usdt0", protocol}]))).toThrow(
      /must declare accountAddress/,
    );
  });

  it("accepts it once the module names its account", () => {
    expect(
      () => new RouterSwidgeProtocol(account as never, config([{name: "usdt0", protocol, accountAddress: "0xabc"}])),
    ).not.toThrow();
  });

  it("still allows account-less routers, which is all status resolution needs", () => {
    expect(() => new RouterSwidgeProtocol(undefined, config([{name: "usdt0", protocol}]))).not.toThrow();
  });
});

describe("module skip diagnostics", () => {
  it("reports why a module left the auction, and cannot break routing by throwing", async () => {
    const skips: string[] = [];
    const protocol = {
      quoteSwidge: async () => {
        throw new Error("pair is not a same-token bridge route");
      },
      swidge: async () => ({id: "s", fees: [], fromTokenAmount: 100n, toTokenAmount: 100n, toTokenAmountMin: 90n}),
      getSwidgeStatus: async () => ({status: "pending" as const}),
      getSupportedChains: async () => [],
      getSupportedTokens: async () => [],
    };
    const aggregate = new RouterSwidgeProtocol(undefined, {
      fromChain: "eip155:1",
      router: new CrossChainRouter([]),
      modules: [{name: "usdt0", protocol}] as never,
      onModuleSkipped: (name, reason) => {
        skips.push(`${name}: ${reason}`);
        throw new Error("a broken observer must not change the outcome");
      },
    });
    await expect(
      aggregate.quoteSwidge({
        fromToken: "USDT",
        toToken: "USDT",
        toChain: "eip155:42161",
        recipient: "0xrecipient",
        fromTokenAmount: 100n,
        minAmountOut: 90n,
      }),
    ).rejects.toThrow(/no route/);
    expect(skips).toEqual(["usdt0: pair is not a same-token bridge route"]);
  });
});

describe("statusOnlyModule", () => {
  it("resolves delivery without an account and declines every route", async () => {
    const {statusOnlyModule} = await import("../src/swidge/bridgeAdapter.js");
    const module = statusOnlyModule({
      name: "usdt0",
      status: async (hash) => ({status: "completed", transactions: [{hash, type: "destination"}]}),
    });
    expect(module.accountAddress).toBeUndefined();

    const aggregate = new RouterSwidgeProtocol(undefined, {
      fromChain: "eip155:1",
      router: new CrossChainRouter([]),
      modules: [module],
    });
    const status = await aggregate.getSwidgeStatus("awk1.mod~usdt0.0xsource");
    expect(status.status).toBe("completed");

    // It declines at the pair gate, before its own protocol is ever consulted.
    await expect(
      module.protocol.quoteSwidge({
        fromToken: "USDT",
        toToken: "USDT",
        toChain: "eip155:42161",
        recipient: "0xrecipient",
        fromTokenAmount: 100n,
      } as never),
    ).rejects.toThrow(/not a same-token bridge route/);
  });
});
