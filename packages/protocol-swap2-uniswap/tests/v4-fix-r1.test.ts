// 0.5.0 review, fix round 1: the smaller v4 findings, each with the case that showed it.
import {afterEach, describe, expect, it, vi} from "vitest";
import {getAddress} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {poolIdOf, type V4PoolKey} from "../src/v4/pool.js";
import {V4_HOP_SYMBOLS, v4HopTokens} from "../src/v4/verify.js";
import {V4_HOP_SYMBOLS as FROM_SUBPATH} from "../src/v4/index.js";
import {fakeNode, v4PinsFor, type FakeNodeOptions} from "./v4-fake-node.js";

afterEach(() => vi.unstubAllGlobals());

describe("FUNDS-3: the hop currencies the pins accept cannot be widened from inside the process", () => {
  it("V4_HOP_SYMBOLS is frozen (before: a push made the pins accept a two-hop route through AUSD on Monad)", () => {
    expect(FROM_SUBPATH).toBe(V4_HOP_SYMBOLS);
    expect(Object.isFrozen(V4_HOP_SYMBOLS)).toBe(true);
    const before = v4HopTokens(143, UNISWAP_V4[143]!).size;
    expect(() => (V4_HOP_SYMBOLS as unknown as string[]).push("AUSD")).toThrow(TypeError);
    expect(v4HopTokens(143, UNISWAP_V4[143]!).size).toBe(before);
    expect([...V4_HOP_SYMBOLS]).toEqual(["USDC", "USDT", "USDT0"]);
  });
});

// Avalanche (no per-transaction or execution cap the module knows): 1 AVAX → USDC, v3 direct 0.05% pays 1 USDC, v4
// 0.05%/10 is priced and 0.3%/60 comes back from the V4Quoter without revert data — with no bound to read it at, the
// quote is refused (README "so does an empty call on a chain whose cap is not known").
const AVAX = 43114;
const A_USDC = getAddress("0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E");
const NATIVE = "0x0000000000000000000000000000000000000000" as const;
const ME = getAddress("0x4444444444444444444444444444444444444444");
const avaxKey = (fee: number, tickSpacing: number): V4PoolKey => ({currency0: NATIVE, currency1: A_USDC, fee, tickSpacing, hooks: NATIVE});
const A500 = poolIdOf(avaxKey(500, 10)).toLowerCase();
const A3000 = poolIdOf(avaxKey(3000, 60)).toLowerCase();
const ONE = 10n ** 18n;
const avaxNode = (extra: Partial<FakeNodeOptions> = {}) => fakeNode({chainId: AVAX, amount: ONE, v3: {tokenOut: A_USDC, fee: 500, out: 1_000_000n}, v4: new Map([[A500, {out: 1_100_000n, gas: 100_000n}]]), emptyQuotes: new Set([A3000]), ...extra});
const avaxParams = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: `eip155:${AVAX}`, destChain: `eip155:${AVAX}`, sourceToken: "AVAX", destToken: A_USDC, amountIn: ONE.toString(), destAddress: ME, refundAddress: ME, ...extra});
async function avax(config: Partial<UniswapProviderConfig>, how: "quote" | "quotes", extra: Partial<QuoteParams> = {}) {
  vi.stubGlobal("fetch", avaxNode().fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const warned: Array<[string, unknown]> = [];
  const p = uniswapProvider({rpcUrls: {[AVAX]: ["https://avax.fake"]}, v4Deployments: v4PinsFor(AVAX), v4: "native-in", ...config, onV4Warning: (t, i) => { warned.push([t, i]); }});
  const params = avaxParams({...extra, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  const r = how === "quotes" ? await p.getQuotes!(params) : await p.getQuote(params);
  return {r, heard, warned};
}
const EMPTY = "a quoter call failed without revert data (v4 direct 0.3%/60) — refusing rather than ranking fewer routes";

describe('QUOTES-4: a v4 read\'s refusal names the venue once (before: "uniswap: uniswap v4: …", "v4: uniswap v4: …")', () => {
  it('"best": refused as "uniswap: v4: …"', async () => {
    const {r, heard} = await avax({}, "quote");
    expect(r).toBeNull();
    expect(heard).toEqual([[`uniswap: v4: ${EMPTY}`, expect.objectContaining({reason: "upstream_unavailable"})]]);
  });

  it('"both": the v3 row stands and the alert names the v4 read once; a picked "v4" is refused with the bare text', async () => {
    const both = await avax({venueRoutes: "both"}, "quotes");
    expect((both.r as {routeId?: string}[]).map((q) => q.routeId)).toEqual(["v3"]);
    expect(both.warned).toEqual([[`uniswap: Uniswap v4 is left out on chain ${AVAX}: its reads failed (${EMPTY}) — only the v3 route is offered; a retry may bring the v4 one back`, {chainId: AVAX, reason: "upstream_unavailable"}]]);
    const picked = await avax({venueRoutes: "both"}, "quote", {routeId: "v4"});
    expect(picked.r).toBeNull();
    expect(picked.heard).toEqual([[`uniswap: ${EMPTY}`, expect.objectContaining({reason: "upstream_unavailable"})]]);
  });

  it("with v4 off the same node quotes v3 (the refusal above is v4's read, not the pair)", async () => {
    const {r, heard} = await avax({v4: "off"}, "quote");
    expect(heard).toEqual([]);
    expect(r).toMatchObject({destAmount: "1000000"});
  });
});

// Monad 700 USDC → AUSD, v4 "all": v4 AUSD/USDC 0.0009%/1 pays 700.5 and 0.005%/1 700.2 AUSD, both of their simulated
// swaps revert (V4TooLittleReceived), v3 USDC/AUSD 0.01% pays 699.
const M_AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
const M_USDC_IN = 700_000_000n;
const AUSD_USDC_9_1 = "0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8";
const AUSD_USDC_50_1 = "0x092b650478145f0aee73a1b400b342b9c6314db2e07aeb91faf7e75e8159ce72";
async function monad(extra: Partial<QuoteParams>, node: Partial<FakeNodeOptions> = {}) {
  vi.stubGlobal("fetch", fakeNode({amount: M_USDC_IN, v3: {tokenOut: M_AUSD, fee: 100, out: 699_000_000n}, v4: new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}], [AUSD_USDC_50_1, {out: 700_200_000n, gas: 60_000n}]]), simulateReverts: new Set([AUSD_USDC_9_1, AUSD_USDC_50_1]), ...node}).fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const warned: Array<[string, unknown]> = [];
  const p = uniswapProvider({rpcUrls: {143: ["https://monad.fake"]}, v4Deployments: v4PinsFor(143), v4: "all", onV4Warning: (t, i) => { warned.push([t, i]); }});
  const q = await p.getQuote({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "USDC", destToken: M_AUSD, amountIn: M_USDC_IN.toString(), destAddress: ME, refundAddress: ME, sender: ME, ...extra, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, warned};
}

describe("QUOTES-3: the alert for a v4 route set aside says what v3 then did", () => {
  it('v3 refused too (the caller\'s floor): the alert says so — before: "— quoted v3" beside the refusal', async () => {
    const {q, heard, warned} = await monad({minAmountOut: "696000000"});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: floor breach (min=695505000 < floor=696000000)", {reason: "price_check_failed"}]]);
    expect(warned).toEqual([[expect.stringMatching(/^uniswap: the best Uniswap v4 route on chain 143 was set aside \(price moved .*\) — v3 was refused too \(floor breach \(min=695505000 < floor=696000000\)\)$/), {chainId: 143, reason: "price_check_failed"}]]);
  });

  it('v3 quoted: "— quoted v3", as before', async () => {
    const {q, warned} = await monad({});
    expect(q).toMatchObject({destAmount: "699000000"});
    expect(warned).toEqual([[expect.stringMatching(/set aside \(price moved .*\) — quoted v3$/), {chainId: 143, reason: "price_check_failed"}]]);
  });
});
