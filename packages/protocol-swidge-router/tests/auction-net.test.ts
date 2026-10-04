/**
 * Auction fairness: candidates are ranked on the guaranteed output NET of the
 * venue's own fees charged on top (fees[].included === false), so a 1:1
 * bridge with a native-token fee cannot outrank a rival on dust.
 */
import {describe, expect, it} from "vitest";
import {CrossChainRouter} from "@forgewallet/protocol-swidge-core/router";
import {RouterSwidgeProtocol} from "../src/swidge/router.js";

const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_ARB = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const AMOUNT = 100_000_000n; // 100 USDT in, USDC out on Arbitrum

type Fee = {type: "network" | "protocol" | "affiliate" | "other"; amount: bigint; token: string; included?: boolean; chain?: string | number};

function module(name: string, min: bigint, fees: Fee[] = []) {
  return {
    name,
    protocol: {
      quoteSwidge: async () => ({fromTokenAmount: AMOUNT, toTokenAmount: min, toTokenAmountMin: min, fees}),
      swidge: async () => ({id: name, fees: [], fromTokenAmount: AMOUNT, toTokenAmount: min, toTokenAmountMin: min}),
      getSwidgeStatus: async () => ({status: "pending" as const}),
      getSupportedChains: async () => [],
      getSupportedTokens: async () => [],
    },
  };
}

function protocolWith(mods: unknown[], priceUsd?: (s: string) => number | undefined, skips: string[] = []) {
  return new RouterSwidgeProtocol(undefined, {
    fromChain: "eip155:1",
    router: new CrossChainRouter([]),
    modules: mods as never,
    onModuleSkipped: (name, reason) => { skips.push(`${name}: ${reason}`); },
    ...(priceUsd ? {priceUsd} : {}),
  });
}

const options = {fromToken: "USDT", toToken: USDC_ARB, toChain: 42161, fromTokenAmount: AMOUNT, recipient: RECIPIENT};
const prices = (s: string) => ({ETH: 3000, USDT: 1, USDC: 1})[s];

describe("auction nets venue fees charged on top", () => {
  it("lets a rival beat a 1:1 bridge whose native fee outweighs its spread (price hook)", async () => {
    // A: 100 USDC out, but 0.01 ETH ($30) bridge fee on top → net 70.
    // B: 90 USDC out, nothing on top → net 90.
    const a = module("bridge", AMOUNT, [
      {type: "network", amount: 500_000_000_000_000n, token: "ETH", included: false}, // gas: ignored, everyone pays it
      {type: "protocol", amount: 10_000_000_000_000_000n, token: "ETH", included: false},
    ]);
    const b = module("swap", 90_000_000n);
    await expect(protocolWith([a, b], prices).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: 90_000_000n});
    // Same fee, but small enough to keep A ahead: 0.001 ETH ($3) → net 97.
    const cheap = module("bridge", AMOUNT, [{type: "protocol", amount: 1_000_000_000_000_000n, token: "ETH", included: false}]);
    await expect(protocolWith([cheap, b], prices).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: AMOUNT});
  });

  it("subtracts a fee in the destination token directly, with no price hook", async () => {
    const a = module("bridge", AMOUNT, [{type: "protocol", amount: 15_000_000n, token: USDC_ETH, included: false}]); // 15 USDC, the destination token spelled as an address
    const b = module("swap", 90_000_000n);
    await expect(protocolWith([a, b]).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: 90_000_000n});
    const a2 = module("bridge", AMOUNT, [{type: "protocol", amount: 5_000_000n, token: "USDC", included: false}]); // 5 USDC, spelled as a symbol
    await expect(protocolWith([a2, b]).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: AMOUNT});
  });

  it("ignores fees already included in the quoted floor", async () => {
    const a = module("bridge", AMOUNT, [{type: "protocol", amount: 50_000_000_000_000_000n, token: "ETH", included: true}]);
    const b = module("swap", 90_000_000n);
    await expect(protocolWith([a, b], prices).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: AMOUNT});
  });

  it("without a price hook, an unpriceable native fee falls back to the gross comparison", async () => {
    const a = module("bridge", AMOUNT, [{type: "protocol", amount: 10_000_000_000_000_000n, token: "ETH", included: false}]);
    const b = module("swap", 90_000_000n);
    await expect(protocolWith([a, b]).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: AMOUNT});
  });

  it("with a price hook, a candidate whose fee cannot be priced sits out and says why", async () => {
    const skips: string[] = [];
    const a = module("bridge", AMOUNT, [{type: "protocol", amount: 1n, token: "WEIRD", included: false}]);
    const b = module("swap", 90_000_000n);
    await expect(protocolWith([a, b], prices, skips).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: 90_000_000n});
    expect(skips).toEqual(["bridge: a fee charged on top cannot be priced for a net comparison"]);
    // …unless it is the only candidate, in which case there is no route.
    await expect(protocolWith([a], prices).quoteSwidge(options)).rejects.toThrow(/no route available/);
  });

  it("never lets a fee push the net below zero in a way that breaks ordering", async () => {
    const a = module("bridge", AMOUNT, [{type: "protocol", amount: 1_000_000_000_000_000_000n, token: "ETH", included: false}]); // $3000 fee
    const b = module("swap", 1n);
    await expect(protocolWith([a, b], prices).quoteSwidge(options)).resolves.toMatchObject({toTokenAmountMin: 1n});
  });
});
