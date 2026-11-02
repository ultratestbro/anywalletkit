// An INTENTS / CONFIDENTIAL_INTENTS credit lands in the intents.near contract on NEAR, so it is only claimed and quoted
// with a NEAR destChain: the engine's review (plan.destChain) never names a chain the output does not reach. Any intents
// token, Base USDC held in intents included, is still reachable as near:mainnet + its token id. DESTINATION_CHAIN keeps
// every destination chain.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {nearIntentsProvider, type NearIntentsProviderConfig} from "../src/provider.js";

const DEPOSIT = "0x5555555555555555555555555555555555555555";
const EVM_SELF = "0x4444444444444444444444444444444444444444";
const NEARCOM = "0x63428e70a8016d10e8e2f7da440c898063afa299";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const BASE_USDC_INTENTS = `nep141:base-${BASE_USDC}.omft.near`;
const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/quote")) return new Response("{}", {status: 404});
    const body = JSON.parse(String(init.body)) as {amount: string};
    bodies.push(body);
    return new Response(JSON.stringify({quote: {depositAddress: DEPOSIT, amountIn: body.amount, amountOut: "990000", minAmountOut: "980000", deadline: new Date(Date.now() + 600_000).toISOString()}}));
  });
});
afterEach(() => vi.unstubAllGlobals());

function engine(config: NearIntentsProviderConfig) {
  const plans: Array<{destChain: string; destToken: string; recipient: string}> = [];
  const sent: unknown[] = [];
  const account = {
    getAddress: async () => EVM_SELF, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = nearIntentsProvider({apiUrl: "https://near.invalid", ...config});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const swap2 = new P(account as never, {fromChain: "eip155:1", reviewExecution: (plan: (typeof plans)[number]) => { plans.push(plan); }} as never);
  return {plans, sent, swap2};
}

const modes: NearIntentsProviderConfig[] = [{recipientType: "INTENTS"}, {recipientType: "CONFIDENTIAL_INTENTS", jwt: "partner"}];

describe("intents credits are reviewed on NEAR", () => {
  it.each(modes)("$recipientType: Base USDC to an 0x recipient is not claimed, quoted or signed", async (config) => {
    const p = nearIntentsProvider(config);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDT"}, {chain: "eip155:8453", token: BASE_USDC})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDT"}, {chain: "eip155:8453", token: BASE_USDC_INTENTS})).toBe(false);
    expect(p.supportsChainPair!("eip155:1", "eip155:8453")).toBe(false);
    const refusals: string[] = [];
    expect(await p.getQuote({sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:8453", destToken: BASE_USDC_INTENTS, amountIn: "1000000", destAddress: NEARCOM, dry: true, onRefusal: (r: string) => refusals.push(r)})).toBeNull();
    expect(refusals[0]).toMatch(/destChain must be a NEAR chain/);

    const e = engine(config);
    await expect(e.swap2.swap2({fromToken: "ETH", toToken: BASE_USDC, toChain: 8453, recipient: NEARCOM, fromTokenAmount: 10n ** 16n, minAmountOut: 980_000n} as never)).rejects.toThrow();
    expect({plans: e.plans, sent: e.sent, wire: bodies}).toEqual({plans: [], sent: [], wire: []});
  });

  it.each(modes)("$recipientType: near:mainnet credits work, raw intents ids included, and the review names NEAR", async (config) => {
    const p = nearIntentsProvider(config);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDT"}, {chain: "near:mainnet", token: BASE_USDC_INTENTS})).toBe(true);
    expect(await p.getQuote({sourceChain: "eip155:1", sourceToken: "USDT", destChain: "near:mainnet", destToken: BASE_USDC_INTENTS, amountIn: "1000000", destAddress: NEARCOM, dry: true})).not.toBeNull();
    expect(bodies[0]).toMatchObject({destinationAsset: BASE_USDC_INTENTS, recipient: NEARCOM, recipientType: config.recipientType});

    const e = engine(config);
    await e.swap2.swap2({fromToken: "ETH", toToken: NEAR_USDC, toChain: "near:mainnet", recipient: NEARCOM, fromTokenAmount: 10n ** 16n, minAmountOut: 980_000n} as never);
    expect(e.plans).toEqual([expect.objectContaining({destChain: "near:mainnet", recipient: NEARCOM})]);
    expect(bodies.at(-1)).toMatchObject({destinationAsset: `nep141:${NEAR_USDC}`, recipientType: config.recipientType});
    expect(e.sent).toEqual([expect.objectContaining({to: DEPOSIT, value: 10n ** 16n})]);
  });

  it("DESTINATION_CHAIN keeps Base: claimed, quoted and reviewed as Base", async () => {
    const p = nearIntentsProvider({});
    expect(p.supportsRoute({chain: "eip155:1", token: "USDT"}, {chain: "eip155:8453", token: BASE_USDC})).toBe(true);
    expect(p.supportsChainPair!("eip155:1", "eip155:8453")).toBe(true);
    const e = engine({});
    await e.swap2.swap2({fromToken: "ETH", toToken: BASE_USDC, toChain: 8453, recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 10n ** 16n, minAmountOut: 980_000n} as never);
    expect(e.plans).toEqual([expect.objectContaining({destChain: "eip155:8453"})]);
    expect(bodies[0]).toMatchObject({destinationAsset: BASE_USDC_INTENTS, recipientType: "DESTINATION_CHAIN"});
  });
});
