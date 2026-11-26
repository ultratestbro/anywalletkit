// venueRoutes (owner request 2026-11-26): an app shows Uniswap v3 and Uniswap v4 as two route rows. With
// `venueRoutes: "both"` the provider's `getQuotes` returns the best v3 route (`routeId: "v3"`) and the best v4 route
// (`routeId: "v4"`) from one ranking pass, each built and checked as it would be had it won; `getQuote` honours the
// routeId and never substitutes the other venue; the pins bind the routeId to the calldata. The default ("best") is the
// 0.5.0 behaviour, untouched (every other suite runs on it). Replayed offline: the Monad recordings at block 125,409,523
// (62,000 and 100 MON → AUSD), the fake Monad node of the review rounds (token input, simulation), and a small grid
// node for pool provenance (MON → an unlisted token).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, getAddress, keccak256, parseAbi, type Hex} from "viem";
import {createMockAccount, describeProtocolBehaviour} from "@anywalletkit/conformance";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import {RouterSwap2Protocol} from "@anywalletkit/protocol-swap2-router/swap2/router";
import {UNISWAP_V3, uniswapPins, uniswapPinsWith, uniswapVerifyQuote} from "../src/addresses.js";
import {describeUniswapActivity} from "../src/activity.js";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {uniswapRemoteProvider} from "../src/remote.js";
import {SWAP_PROXY_ABI, UNISWAP_V4, V4_SWAP_INPUT_ABI, V4_TAKE_ABI} from "../src/v4/addresses.js";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {poolIdOf} from "../src/v4/pool.js";
import {V4_QUOTER_ABI} from "../src/v4/quote.js";
import {UNISWAP_V4_POOLS} from "../src/v4pools/index.js";
import {AUSD as FAKE_AUSD, D4 as FAKE_D4, ME as FAKE_ME, RPC as FAKE_RPC, V4 as FAKE_V4, fakeNode} from "./v4-fake-node.js";
import {BASE_TOKEN, HOLDER, tokenReplay} from "./v4-token-replay.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The Monad recordings (block 125,409,523) ──

interface Fixture {
  chainId: number;
  block: {number: string; hex: string; hash: string; gasLimit: string};
  calls: Record<string, {result?: unknown; error?: unknown}>;
}
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/rpc/${name}`, import.meta.url), "utf8")) as Fixture;
const v3fx = load("monad-125409523.json");
const CALLS = {...v3fx.calls, ...load("monad-125409523-v4.json").calls};

const AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
const NATIVE = "0x0000000000000000000000000000000000000000";
const ME = "0x1111111111111111111111111111111111111111";
const RPC = {143: ["https://monad.fixture"]};
const D3 = UNISWAP_V3[143]!;
const D4 = UNISWAP_V4[143]!;
const MON = (n: bigint) => (n * 10n ** 18n).toString();
const params = (amountIn: string, extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: AUSD, amountIn, destAddress: ME, refundAddress: ME, ...extra});
const DEPLOYMENT_CHECK = /^0x(c45a0155|4aa4a4fc|dc4c90d3)$/;
const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
type Req = {method: string; to?: string; data?: string; gas?: string; from?: string};
type Odd = (req: Req) => object | undefined;
/** Serves both recordings (or `odd`'s answer); every read's block tag, every miss and every call are kept. */
function replay(odd?: Odd) {
  const tags = new Set<string>();
  const misses: string[] = [];
  const seen: Req[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
    return new Response(JSON.stringify(batch.map((req) => {
      let key = req.method;
      const r: Req = {method: req.method};
      if (req.method === "eth_call") {
        const [c, tag] = req.params as [{to: string; data: string; gas?: string; from?: string}, string];
        r.to = c.to.toLowerCase();
        r.data = c.data.toLowerCase();
        if (c.gas) r.gas = c.gas;
        if (c.from) r.from = c.from.toLowerCase();
        if (!DEPLOYMENT_CHECK.test(r.data.slice(0, 10))) tags.add(tag);
        key = `eth_call ${r.to} ${r.data}`;
      } else if (req.method === "eth_getCode") {
        r.to = String(req.params[0]).toLowerCase();
        key = `eth_getCode ${r.to}`;
      }
      seen.push(r);
      const instead = odd?.(r);
      if (instead) return {jsonrpc: "2.0", id: req.id, ...instead};
      const answer = CALLS[key];
      if (!answer) {
        misses.push(key.slice(0, 120));
        return {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
      }
      return {jsonrpc: "2.0", id: req.id, ...answer};
    })));
  }) as typeof fetch;
  return {fetch: f, tags, misses, seen};
}

type Heard = Array<[string, Swap2RefusalInfo | undefined]>;
const both = (c: Partial<UniswapProviderConfig> = {}) => uniswapProvider({rpcUrls: RPC, v4: "native-in", venueRoutes: "both", ...c});
/** getQuotes on a fresh "both" provider over the recordings. */
async function candidates(amountIn: string, c: Partial<UniswapProviderConfig> = {}, odd?: Odd, extra: Partial<QuoteParams> = {}) {
  const r = replay(odd);
  vi.stubGlobal("fetch", r.fetch);
  const heard: Heard = [];
  const warned: Array<[string, unknown]> = [];
  const provider = both({...c, onV4Warning: (t, i) => { warned.push([t, i]); }});
  const qs = await provider.getQuotes!({...params(amountIn, extra), onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {qs, heard, warned, tags: [...r.tags], misses: r.misses, seen: r.seen, provider};
}
/** getQuote over the recordings, on the provider `c` makes. */
async function single(amountIn: string, c: Partial<UniswapProviderConfig>, extra: Partial<QuoteParams> = {}, odd?: Odd) {
  const r = replay(odd);
  vi.stubGlobal("fetch", r.fetch);
  const heard: Heard = [];
  const provider = uniswapProvider({rpcUrls: RPC, ...c});
  const q = await provider.getQuote({...params(amountIn, extra), onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, tags: [...r.tags], misses: r.misses, seen: r.seen, provider};
}
const isV4Read = (s: Req) => s.to === MULTICALL3.toLowerCase() || s.to === D4.quoter.toLowerCase() || s.method === "eth_getCode" || (s.data?.startsWith("0xdc4c90d3") ?? false);
const withoutRoute = (q: Quote): Quote => {
  const {routeId: _r, ...rest} = q;
  return rest;
};
const fixedClock = () => {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
};

describe("venueRoutes: the option", () => {
  it('"best" (the default): no getQuotes property, no routeId on the quote', async () => {
    for (const c of [{}, {venueRoutes: "best" as const}]) {
      const p = uniswapProvider({rpcUrls: RPC, v4: "native-in", ...c});
      expect("getQuotes" in p).toBe(false);
      expect(p.getQuotes).toBeUndefined();
    }
    const {q, misses} = await single(MON(62_000n), {v4: "native-in"});
    expect(misses).toEqual([]);
    expect(q).toMatchObject({destAmount: "676608109", providerData: {venue: "v4"}});
    expect("routeId" in q!).toBe(false);
    const v3 = await single(MON(62_000n), {});
    expect("routeId" in v3.q!).toBe(false);
    expect("getQuotes" in v3.provider).toBe(false);
  });

  it('"both" needs v4 on: the constructor throws with v4 "off" (or unset), and on an unknown value', () => {
    expect(() => uniswapProvider({rpcUrls: RPC, venueRoutes: "both"})).toThrow(/venueRoutes "both" needs v4 "native-in" or "all"/);
    expect(() => uniswapProvider({rpcUrls: RPC, v4: "off", venueRoutes: "both"})).toThrow(/venueRoutes "both" needs v4/);
    expect(() => uniswapProvider({rpcUrls: RPC, v4: "native-in", venueRoutes: "all" as never})).toThrow(/venueRoutes must be "best" or "both"/);
    expect(typeof both().getQuotes).toBe("function");
    expect(typeof uniswapProvider({rpcUrls: RPC, v4: "all", venueRoutes: "both"}).getQuotes).toBe("function");
  });
});

describe("Monad 62,000 MON → AUSD (recorded): Uniswap v3 and Uniswap v4 as two candidates", () => {
  it("getQuotes returns both — v3 1.130999 AUSD on SwapRouter02, v4 676.608109 AUSD on the Universal Router — each passing the shipped pins", async () => {
    const {qs, heard, misses, tags} = await candidates(MON(62_000n));
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(tags).toEqual(["latest"]);
    expect(qs.map((q) => [q.routeId, q.destAmount, q.txRequest?.to])).toEqual([["v3", "1130999", D3.router], ["v4", "676608109", D4.universalRouter]]);
    const [v3, v4] = qs as [Quote, Quote];
    expect(v3.providerData!.venue).toBeUndefined();
    expect(v3.txRequest).toMatchObject({value: MON(62_000n), gasLimit: "16303291"});
    expect(v4.providerData).toMatchObject({venue: "v4", route: "v4 via USDC 0.05%/10 → 0.005%/1", priceImpactBps: "17"});
    for (const q of qs) expect(uniswapVerifyQuote(params(MON(62_000n)), q)).toBeNull();
  });

  it("each candidate is what that venue alone returns (v4 off for v3; no v3 deployment for v4); the default getQuote is the \"best\" winner naming its route", async () => {
    fixedClock();
    const {qs} = await candidates(MON(62_000n));
    const v3Alone = await single(MON(62_000n), {});
    const v4Alone = await single(MON(62_000n), {v4: "native-in", deployments: {}});
    const best = await single(MON(62_000n), {v4: "native-in"});
    expect(withoutRoute(qs[0]!)).toEqual(v3Alone.q);
    expect(withoutRoute(qs[1]!)).toEqual(v4Alone.q);
    const r = replay();
    vi.stubGlobal("fetch", r.fetch);
    const dflt = await both().getQuote(params(MON(62_000n)));
    expect(dflt).toEqual({...best.q!, routeId: "v4"});
    expect(dflt).toEqual(qs[1]);
  });

  it("one ranking pass: the same v4 discovery and quote reads as a \"best\" quote, plus only the losing venue's own probe", async () => {
    const pass = await candidates(MON(62_000n));
    const best = await single(MON(62_000n), {v4: "native-in"});
    const aggregates = (seen: Req[]) => seen.filter((s) => s.to === MULTICALL3.toLowerCase()).map((s) => s.data).sort();
    expect(aggregates(pass.seen)).toEqual(aggregates(best.seen));
    const v3Quoter = (seen: Req[]) => seen.filter((s) => s.to === D3.quoter.toLowerCase() && !DEPLOYMENT_CHECK.test(s.data!.slice(0, 10))).length;
    // The v3 batch (every fee tier and two-hop route) once in each; "both" adds v3's 1/1000 probe, which "best" (v4 won) never sends.
    expect(v3Quoter(pass.seen)).toBe(v3Quoter(best.seen) + 1);
    expect(pass.seen.length).toBe(best.seen.length + 1);
  });

  it("100 MON: both candidates (v3 0.871160, v4 1.093251)", async () => {
    const {qs, misses} = await candidates(MON(100n));
    expect(misses).toEqual([]);
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v3", "871160"], ["v4", "1093251"]]);
  });

  it("maxPriceImpactBps 500: the gate is applied per candidate — v3 (99.8%) is left out, v4 (G 23) stands; every read at the one block", async () => {
    const {qs, heard, misses, tags} = await candidates(MON(62_000n), {maxPriceImpactBps: 500});
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(tags).toEqual([v3fx.block.hex]);
    expect(qs.map((q) => [q.routeId, q.destAmount, q.providerData?.valueLossBps])).toEqual([["v4", "676608109", "23"]]);
  });

  it("both venues refused (the gate at 23): no candidate, one refusal naming both, classified", async () => {
    const {qs, heard} = await candidates(MON(62_000n), {maxPriceImpactBps: 23});
    expect(qs).toEqual([]);
    expect(heard).toEqual([[
      "uniswap: v3: loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 0.23%; best route via USDC 0.3% → 0.01%); v4: loses 0.2% of the value to price impact — its pools are too thin for this amount (limit 0.23%; best route v4 via USDC 0.05%/10 → 0.005%/1)",
      {reason: "insufficient_liquidity"},
    ]]);
  });

  it('getQuote with routeId "v3" quotes v3 alone (no v4 read at all); "v4" v4 alone', async () => {
    fixedClock();
    const {qs} = await candidates(MON(62_000n));
    const r3 = await single(MON(62_000n), {v4: "native-in", venueRoutes: "both"}, {routeId: "v3"});
    expect(r3.heard).toEqual([]);
    expect(r3.q).toEqual(qs[0]);
    expect(r3.seen.some(isV4Read)).toBe(false);
    const r4 = await single(MON(62_000n), {v4: "native-in", venueRoutes: "both"}, {routeId: "v4"});
    expect(r4.q).toEqual(qs[1]);
    // getQuotes with a routeId: that one candidate.
    const r = replay();
    vi.stubGlobal("fetch", r.fetch);
    expect((await both().getQuotes!(params(MON(62_000n), {routeId: "v4"}))).map((q) => q.routeId)).toEqual(["v4"]);
  });

  it("the default follows the ranking (an edge of 10000 bps keeps v3 at 100 MON → routeId \"v3\"); a picked \"v4\" is still v4", async () => {
    const dflt = await single(MON(100n), {v4: "native-in", venueRoutes: "both", v4MinEdgeBps: 10_000});
    expect(dflt.q).toMatchObject({routeId: "v3", destAmount: "871160", txRequest: {to: D3.router}});
    const picked = await single(MON(100n), {v4: "native-in", venueRoutes: "both", v4MinEdgeBps: 10_000}, {routeId: "v4"});
    expect(picked.q).toMatchObject({routeId: "v4", destAmount: "1093251", txRequest: {to: D4.universalRouter}});
  });

  it("a routeId this provider does not know is refused (policy_refused) before any read", async () => {
    for (const id of ["v5", "V4", "taxi"]) {
      const r = await single(MON(62_000n), {v4: "native-in", venueRoutes: "both"}, {routeId: id});
      expect(r.q).toBeNull();
      expect(r.heard).toEqual([[expect.stringMatching(new RegExp(`^uniswap: unknown route '${id}'`)), {reason: "policy_refused"}]]);
      expect(r.seen).toEqual([]);
    }
  });

  it("a picked venue is quoted or refused, never substituted: v3 thin under the gate refuses \"v3\"; v4 rate-limited refuses \"v4\"", async () => {
    const thin = await single(MON(62_000n), {v4: "native-in", venueRoutes: "both", maxPriceImpactBps: 500}, {routeId: "v3"});
    expect(thin.q).toBeNull();
    expect(thin.heard).toEqual([[expect.stringMatching(/loses 99\.8% of the value/), {reason: "insufficient_liquidity"}]]);
    const limited = {error: {code: -32007, message: "50/second request limit reached"}};
    const isDiscovery = (s: Req) => s.to === MULTICALL3.toLowerCase() && decodeFunctionData({abi: MC3, data: s.data as Hex}).args[0].every((c) => getAddress(c.target) === getAddress(D4.stateView));
    const r4 = await single(MON(62_000n), {v4: "native-in", venueRoutes: "both"}, {routeId: "v4"}, (s) => (isDiscovery(s) ? limited : undefined));
    expect(r4.q).toBeNull();
    expect(r4.heard).toHaveLength(1);
    expect(r4.heard[0]![1]).toEqual({reason: "rate_limited"});
  }, 30_000);
});

describe("one venue failing or refusing keeps the other", () => {
  const limited = {error: {code: -32007, message: "50/second request limit reached"}};
  const isDiscovery = (s: Req) => s.to === MULTICALL3.toLowerCase() && decodeFunctionData({abi: MC3, data: s.data as Hex}).args[0].every((c) => getAddress(c.target) === getAddress(D4.stateView));
  const isV3Quote = (s: Req) => s.to === D3.quoter.toLowerCase() && !DEPLOYMENT_CHECK.test(s.data!.slice(0, 10));

  it("the v4 discovery rate-limited on every attempt: the v3 candidate alone (a \"best\" quote is refused rate_limited), and the operator alerted", async () => {
    const {qs, heard, warned} = await candidates(MON(62_000n), {}, (s) => (isDiscovery(s) ? limited : undefined));
    expect(heard).toEqual([]);
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v3", "1130999"]]);
    // Review LIVE-VR-1: the row that is missing for a failed read is named to the operator (the app's onRefusal is not
    // called while a candidate stands), with the node's reason — a retry may bring it back.
    expect(warned).toEqual([[expect.stringMatching(/^uniswap: Uniswap v4 is left out on chain 143: its reads failed \(no RPC answered on chain 143 \(-32007 .*\)\) — only the v3 route is offered; a retry may bring the v4 one back$/), {chainId: 143, reason: "rate_limited"}]]);
    const best = await single(MON(62_000n), {v4: "native-in"}, {}, (s) => (isDiscovery(s) ? limited : undefined));
    expect(best.q).toBeNull();
    expect(best.heard[0]![1]).toEqual({reason: "rate_limited"});
  }, 30_000);

  it("v3's quoter reads unanswered: the v4 candidate alone, over shipped-list pools only (v3 may have a route), and the operator alerted", async () => {
    const {qs, heard, warned} = await candidates(MON(62_000n), {}, (s) => (isV3Quote(s) ? limited : undefined));
    expect(heard).toEqual([]);
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v4", "676608109"]]);
    expect(uniswapVerifyQuote(params(MON(62_000n)), qs[0]!)).toBeNull();
    expect(warned).toEqual([[expect.stringMatching(/^uniswap: Uniswap v3 is left out on chain 143: its reads failed \(no RPC answered .*\) — only the v4 route is offered/), {chainId: 143, reason: "rate_limited"}]]);
  }, 30_000);

  it("a v4 deployment that does not match its pins: the v3 candidate, and the operator alerted", async () => {
    const {qs, heard, warned, seen} = await candidates(MON(62_000n), {}, (s) => (s.method === "eth_getCode" ? {result: "0x6080604052"} : undefined));
    expect(heard).toEqual([]);
    expect(qs.map((q) => q.routeId)).toEqual(["v3"]);
    expect(warned).toEqual([[expect.stringMatching(/Uniswap v4 is off on chain 143: the deployment does not match its pins/), {chainId: 143, reason: "vault_mismatch"}]]);
    expect(seen.some((s) => s.to === MULTICALL3.toLowerCase())).toBe(false);
  });

  it("a chain with Uniswap v4 but no v3 (review F2): no v3 venue to answer — a pair without a v4 route is no_route, as a \"best\" quote says; a picked \"v3\" is unsupported_pair", async () => {
    const p = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: FAKE_AUSD, amountIn: (10n ** 18n).toString(), destAddress: FAKE_ME, refundAddress: FAKE_ME, ...extra});
    const make = (c: Partial<UniswapProviderConfig> = {}) => uniswapProvider({rpcUrls: FAKE_RPC, v4Deployments: FAKE_V4, v4: "native-in", deployments: {}, ...c});
    const ask = async (f: (heard: Heard) => Promise<unknown>) => {
      vi.stubGlobal("fetch", fakeNode({amount: 10n ** 18n, v4: new Map()}).fetch);
      const heard: Heard = [];
      return {out: await f(heard), heard};
    };
    const best = await ask((heard) => make().getQuote({...p(), onRefusal: (t, i) => { heard.push([t, i]); }}));
    expect(best.out).toBeNull();
    expect(best.heard).toEqual([["uniswap: no Uniswap v4 pool route for this pair and amount", {reason: "no_route"}]]);
    const listed = await ask((heard) => make({venueRoutes: "both"}).getQuotes!({...p(), onRefusal: (t, i) => { heard.push([t, i]); }}));
    expect(listed.out).toEqual([]);
    expect(listed.heard).toEqual([["uniswap: v4: no Uniswap v4 pool route for this pair and amount", {reason: "no_route"}]]);
    const v4 = await ask((heard) => make({venueRoutes: "both"}).getQuote({...p({routeId: "v4"}), onRefusal: (t, i) => { heard.push([t, i]); }}));
    expect(v4.heard).toEqual([["uniswap: no Uniswap v4 pool route for this pair and amount", {reason: "no_route"}]]);
    const v3 = await ask((heard) => make({venueRoutes: "both"}).getQuote({...p({routeId: "v3"}), onRefusal: (t, i) => { heard.push([t, i]); }}));
    expect(v3.out).toBeNull();
    expect(v3.heard).toEqual([["uniswap: no Uniswap v3 deployment on chain 143", {reason: "unsupported_pair"}]]);
  });
});

// ── The fake Monad node: token input through the SwapProxy, simulated before the quote ──

describe("token input (v4 \"all\", the fake Monad node): each candidate built and checked as a winner", () => {
  const USDC_IN = 700_000_000n;
  const AUSD_USDC_9_1 = "0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8";
  const AUSD_USDC_50_1 = "0x092b650478145f0aee73a1b400b342b9c6314db2e07aeb91faf7e75e8159ce72";
  const pools = new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}], [AUSD_USDC_50_1, {out: 700_200_000n, gas: 60_000n}]]);
  const node = (o: {simulateReverts?: string[]; balance?: bigint} = {}) =>
    fakeNode({amount: USDC_IN, v3: {tokenOut: FAKE_AUSD, fee: 100, out: 699_000_000n}, v4: pools, ...(o.simulateReverts ? {simulateReverts: new Set(o.simulateReverts)} : {}), ...(o.balance !== undefined ? {balance: o.balance} : {})});
  const usdcToAusd = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "USDC", destToken: FAKE_AUSD, amountIn: USDC_IN.toString(), destAddress: FAKE_ME, refundAddress: FAKE_ME, sender: FAKE_ME, ...extra});
  const provider = (warned: Array<[string, unknown]>, c: Partial<UniswapProviderConfig> = {}) => uniswapProvider({rpcUrls: FAKE_RPC, v4Deployments: FAKE_V4, v4: "all", venueRoutes: "both", onV4Warning: (t, i) => { warned.push([t, i]); }, ...c});

  it("v3 6990 and v4 7005 (the SwapProxy call, approve + swap simulated): both offered, both pass the shipped pins", async () => {
    const n = node();
    vi.stubGlobal("fetch", n.fetch);
    const heard: Heard = [];
    const qs = await provider([]).getQuotes!({...usdcToAusd(), onRefusal: (t, i) => { heard.push([t, i]); }});
    expect(heard).toEqual([]);
    expect(qs.map((q) => [q.routeId, q.destAmount, q.txRequest?.to, q.txRequest?.approvalAddress])).toEqual([["v3", "699000000", D3.router, D3.router], ["v4", "700500000", FAKE_D4.swapProxy, FAKE_D4.swapProxy]]);
    expect(qs[1]!.providerData).toMatchObject({venue: "v4", route: "v4 direct 0.0009%/1", simulated: "approve+swap"});
    for (const q of qs) expect(uniswapVerifyQuote(usdcToAusd(), q)).toBeNull();
    expect(n.seen.filter((s) => s.method === "eth_simulateV1")).toHaveLength(1);
  });

  it("the best v4 route's simulation reverts: the next v4 route is the v4 candidate (alerted), v3 unchanged", async () => {
    vi.stubGlobal("fetch", node({simulateReverts: [AUSD_USDC_9_1]}).fetch);
    const warned: Array<[string, unknown]> = [];
    const qs = await provider(warned).getQuotes!(usdcToAusd());
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v3", "699000000"], ["v4", "700200000"]]);
    expect(warned).toEqual([[expect.stringMatching(/set aside \(price moved .*\) — quoted another v4 route/), {chainId: 143, reason: "price_check_failed"}]]);
  });

  it("every v4 simulation reverts: v3 alone, the operator alerted; a picked \"v4\" is refused with the route's reason, never v3", async () => {
    vi.stubGlobal("fetch", node({simulateReverts: [AUSD_USDC_9_1, AUSD_USDC_50_1]}).fetch);
    const warned: Array<[string, unknown]> = [];
    const qs = await provider(warned).getQuotes!(usdcToAusd());
    expect(qs.map((q) => q.routeId)).toEqual(["v3"]);
    expect(warned).toEqual([[expect.stringMatching(/set aside \(price moved .*\) — no v4 route is offered/), {chainId: 143, reason: "price_check_failed"}]]);
    vi.stubGlobal("fetch", node({simulateReverts: [AUSD_USDC_9_1, AUSD_USDC_50_1]}).fetch);
    const heard: Heard = [];
    const q = await provider([]).getQuote({...usdcToAusd({routeId: "v4"}), onRefusal: (t, i) => { heard.push([t, i]); }});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/price moved .* Nothing was approved/), {reason: "price_check_failed"}]]);
  });

  it("v4's own checks are v4's: a wallet short of the input refuses the v4 candidate; the v3 row stands (its own build has no such check)", async () => {
    vi.stubGlobal("fetch", node({balance: USDC_IN - 1n}).fetch);
    const qs = await provider([]).getQuotes!(usdcToAusd());
    expect(qs.map((q) => q.routeId)).toEqual(["v3"]);
    vi.stubGlobal("fetch", node({balance: USDC_IN - 1n}).fetch);
    const heard: Heard = [];
    expect(await provider([]).getQuote({...usdcToAusd({routeId: "v4"}), onRefusal: (t, i) => { heard.push([t, i]); }})).toBeNull();
    expect(heard[0]).toEqual([expect.stringMatching(/the wallet holds 699999999 of the input/), {reason: "simulation_failed"}]);
  });

  it("the caller's floor applies to each candidate: above v3's minimum only v4 is offered (a trade verdict: no alert)", async () => {
    vi.stubGlobal("fetch", node().fetch);
    const warned: Array<[string, unknown]> = [];
    const qs = await provider(warned).getQuotes!(usdcToAusd({minAmountOut: "696000000"}));
    expect(qs.map((q) => q.routeId)).toEqual(["v4"]);
    expect(warned).toEqual([]);
  });

  it("review LIVE-VR-1: the allowance read rate-limited on every attempt — the v4 row is left out with the operator alerted (rate_limited); a \"best\" quote refuses, a picked \"v4\" refuses with the node's reason", async () => {
    const limitedAllowance = (inner: typeof fetch): typeof fetch => (async (u: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]} | {id: number; method: string; params: unknown[]}[];
      const batch = Array.isArray(body) ? body : [body];
      const res = (await (await inner(u, init)).json()) as {id: number} | {id: number}[];
      const answers = (Array.isArray(res) ? res : [res]).map((r, i) => {
        const req = batch[i]!;
        const c = req.params[0] as {data?: string} | undefined;
        return req.method === "eth_call" && req.params[2] === undefined && c?.data?.startsWith("0xdd62ed3e") ? {jsonrpc: "2.0", id: r.id, error: {code: -32007, message: "50/second request limit reached"}} : r;
      });
      return new Response(JSON.stringify(Array.isArray(body) ? answers : answers[0]));
    }) as typeof fetch;
    vi.stubGlobal("fetch", limitedAllowance(node().fetch));
    const warned: Array<[string, unknown]> = [];
    const heard: Heard = [];
    const qs = await provider(warned).getQuotes!({...usdcToAusd(), onRefusal: (t, i) => { heard.push([t, i]); }});
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v3", "699000000"]]);
    expect(heard).toEqual([]);
    expect(warned).toEqual([[expect.stringMatching(/^uniswap: Uniswap v4 is left out on chain 143: its reads failed \(no RPC answered on chain 143 \(-32007 .*\)\) — only the v3 route is offered/), {chainId: 143, reason: "rate_limited"}]]);
    vi.stubGlobal("fetch", limitedAllowance(node().fetch));
    const picked: Heard = [];
    expect(await provider([]).getQuote({...usdcToAusd({routeId: "v4"}), onRefusal: (t, i) => { picked.push([t, i]); }})).toBeNull();
    expect(picked).toEqual([[expect.stringMatching(/no RPC answered on chain 143/), {reason: "rate_limited"}]]);
    vi.stubGlobal("fetch", limitedAllowance(node().fetch));
    const ranked: Heard = [];
    expect(await uniswapProvider({rpcUrls: FAKE_RPC, v4Deployments: FAKE_V4, v4: "all"}).getQuote({...usdcToAusd(), onRefusal: (t, i) => { ranked.push([t, i]); }})).toBeNull();
    expect(ranked[0]![1]).toEqual({reason: "rate_limited"});
  }, 60_000);

  it('with v4 "native-in", a token input has no v4 candidate: v3 alone; a picked "v4" is refused unsupported_pair', async () => {
    vi.stubGlobal("fetch", node().fetch);
    const qs = await provider([], {v4: "native-in"}).getQuotes!(usdcToAusd());
    expect(qs.map((q) => q.routeId)).toEqual(["v3"]);
    const heard: Heard = [];
    expect(await provider([], {v4: "native-in"}).getQuote({...usdcToAusd({routeId: "v4"}), onRefusal: (t, i) => { heard.push([t, i]); }})).toBeNull();
    expect(heard).toEqual([['uniswap: Uniswap v4 takes a native-coin input only here (v4: "native-in")', {reason: "unsupported_pair"}]]);
  });
});

// ── Pool provenance: MON → a token the shipped list does not know, found by the grid (as in the R1 provenance test) ──

describe("v4 candidate provenance (v4RankedPools): a grid route only where v3 has none, as in a \"best\" pass", () => {
  const CHAIN = 143;
  const ROUTER_CODE: Hex = "0x60806040526000805500fe";
  const V4 = {...UNISWAP_V4, [CHAIN]: {...UNISWAP_V4[CHAIN]!, routerCodehash: keccak256(ROUTER_CODE)}};
  const X = getAddress("0xfefefefefefefefefefefefefefefefefefefefe");
  const AMOUNT = 100n * 10n ** 18n;
  const GRID_KEY = {currency0: NATIVE, currency1: X, fee: 3000, tickSpacing: 60, hooks: NATIVE} as const;
  const GRID_ID = poolIdOf(GRID_KEY);
  const LISTED_FEE = new Map(UNISWAP_V4_POOLS[CHAIN]!.pools.map((p) => [p.id.toLowerCase(), p.fee]));
  const STATE_VIEW = parseAbi(["function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)", "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)"]);
  const V3_QUOTER = parseAbi([
    "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
    "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
  ]);
  const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  const gridNode = (v3Route: boolean) => (async (_u: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
    return new Response(JSON.stringify(batch.map((req) => {
      const ok = (result: unknown) => ({jsonrpc: "2.0", id: req.id, result});
      const revert = {jsonrpc: "2.0", id: req.id, error: {code: 3, message: "execution reverted", data: "0x"}};
      if (req.method === "eth_getBlockByNumber") return ok({number: "0x1", gasLimit: "0xbebc200"});
      if (req.method === "eth_getCode") return ok(getAddress(String(req.params[0])) === getAddress(V4[CHAIN]!.universalRouter) ? ROUTER_CODE : "0x");
      const c = req.params[0] as {to: string; data: Hex};
      const to = getAddress(c.to);
      const sel = c.data.slice(0, 10);
      if ((to === getAddress(D3.router) || to === getAddress(D3.quoter)) && sel === "0xc45a0155") return ok(word(D3.factory));
      if ((to === getAddress(D3.router) || to === getAddress(D3.quoter)) && sel === "0x4aa4a4fc") return ok(word(D3.weth));
      if (sel === "0xdc4c90d3") return ok(word(D4.poolManager));
      if (to === getAddress(D3.quoter)) {
        const d = decodeFunctionData({abi: V3_QUOTER, data: c.data});
        if (d.functionName !== "quoteExactInputSingle") return revert;
        const p = d.args[0] as {tokenOut: Hex; amountIn: bigint; fee: number};
        if (v3Route && getAddress(p.tokenOut) === X && p.fee === 3000) return ok(encodeFunctionResult({abi: V3_QUOTER, functionName: "quoteExactInputSingle", result: [(1_000_000n * p.amountIn) / AMOUNT, 1n << 96n, 1, 110_000n]}));
        return revert;
      }
      if (to === getAddress(MULTICALL3)) {
        const calls = decodeFunctionData({abi: MC3, data: c.data}).args[0];
        return ok(encodeFunctionResult({abi: MC3, functionName: "aggregate3", result: calls.map((x) => {
          if (getAddress(x.target) === getAddress(D4.stateView)) {
            const s = decodeFunctionData({abi: STATE_VIEW, data: x.callData});
            const id = (s.args[0] as Hex).toLowerCase();
            const fee = LISTED_FEE.get(id) ?? (id === GRID_ID ? GRID_KEY.fee : undefined);
            return {success: true, returnData: s.functionName === "getSlot0"
              ? encodeFunctionResult({abi: STATE_VIEW, functionName: "getSlot0", result: fee === undefined ? [0n, 0, 0, 0] : [1n << 96n, 0, 0, fee]})
              : encodeFunctionResult({abi: STATE_VIEW, functionName: "getLiquidity", result: fee === undefined ? 0n : 10n ** 24n})};
          }
          const q = decodeFunctionData({abi: V4_QUOTER_ABI, data: x.callData});
          const p = q.args[0] as {poolKey: Parameters<typeof poolIdOf>[0]; exactAmount: bigint};
          if (q.functionName === "quoteExactInputSingle" && poolIdOf(p.poolKey) === GRID_ID) return {success: true, returnData: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [(1_200_000n * p.exactAmount) / AMOUNT, 90_000n])};
          return {success: false, returnData: "0x486aa307" as Hex};
        })}));
      }
      return revert;
    })));
  }) as typeof fetch;
  const monToX = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: X, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, ...extra});
  const server = (c: Partial<UniswapProviderConfig> = {}) => uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4, venueRoutes: "both", ...c});

  it('v3 has a route (default "listed"): v3 alone — the grid route is not offered next to it, so an app on the shipped pins never gets a candidate it refuses', async () => {
    vi.stubGlobal("fetch", gridNode(true));
    const heard: Heard = [];
    const qs = await server().getQuotes!({...monToX(), onRefusal: (t, i) => { heard.push([t, i]); }});
    expect(heard).toEqual([]);
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v3", "1000000"]]);
    const r4: Heard = [];
    expect(await server().getQuote({...monToX({routeId: "v4"}), onRefusal: (t, i) => { r4.push([t, i]); }})).toBeNull();
    expect(r4).toEqual([[expect.stringMatching(/only Uniswap v4 routes for this pair go through pools outside the ranked pool lists \(v4RankedPools\)/), {reason: "no_route"}]]);
  });

  it("no v3 route: the grid route is the v4 candidate (as a \"best\" quote returns it); a picked \"v4\" agrees", async () => {
    vi.stubGlobal("fetch", gridNode(false));
    const qs = await server().getQuotes!(monToX());
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v4", "1200000"]]);
    expect(JSON.parse(qs[0]!.providerData!.poolKeys!).map(poolIdOf)).toEqual([GRID_ID]);
    expect((await server().getQuote(monToX({routeId: "v4"})))?.destAmount).toBe("1200000");
    // An app on the shipped pins drops this candidate (its pool is not pinned), exactly as it drops the same route as a
    // "best" quote: nothing it had is lost, and nothing is executed (review SEC-VR-1, the release note's wording).
    vi.stubGlobal("fetch", gridNode(false));
    const ranked = await uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4}).getQuote(monToX());
    expect(ranked?.destAmount).toBe("1200000");
    for (const q of [qs[0]!, ranked!]) expect(uniswapVerifyQuote(monToX(), q)).toMatch(/is not in the pinned pool list/);
  });

  it("review F1: a picked \"v4\" whose provenance read went unanswered (v3's quotes, or v3's deployment check) is refused with that read's reason, never no_route", async () => {
    const V3_CHECK = /^0x(c45a0155|4aa4a4fc)/;
    /** The grid node with the v3 calls `match` picks rate-limited on every attempt. */
    const limitedV3 = (inner: typeof fetch, match: (data: string) => boolean): typeof fetch => (async (u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
      const res = (await (await inner(u, init)).json()) as {id: number}[];
      return new Response(JSON.stringify(res.map((r, i) => {
        const req = batch[i]!;
        const c = req.params[0] as {to?: string; data?: string} | undefined;
        const v3 = req.method === "eth_call" && c?.to !== undefined && [D3.router, D3.quoter].some((a) => getAddress(a) === getAddress(c.to!));
        return v3 && match(c!.data!) ? {jsonrpc: "2.0", id: r.id, error: {code: -32007, message: "50/second request limit reached"}} : r;
      })));
    }) as typeof fetch;
    for (const [what, match] of [["v3's quotes", (d: string) => !V3_CHECK.test(d)], ["v3's deployment check", (d: string) => V3_CHECK.test(d)]] as const) {
      vi.stubGlobal("fetch", limitedV3(gridNode(false), match));
      const heard: Heard = [];
      expect(await server().getQuote({...monToX({routeId: "v4"}), onRefusal: (t, i) => { heard.push([t, i]); }}), what).toBeNull();
      expect(heard, what).toEqual([[expect.stringMatching(/^uniswap: the only Uniswap v4 routes for this pair go through pools outside the ranked pool lists \(v4RankedPools\), which stand only where Uniswap v3 has no route — and v3 could not be read: no RPC answered on chain 143 \(-32007 /), {reason: "rate_limited"}]]);
      // getQuotes in the same state: both venues refused, classified by the read that failed.
      vi.stubGlobal("fetch", limitedV3(gridNode(false), match));
      const listed: Heard = [];
      expect(await server().getQuotes!({...monToX(), onRefusal: (t, i) => { listed.push([t, i]); }}), what).toEqual([]);
      expect(listed, what).toEqual([[expect.stringMatching(/^uniswap: v3: no RPC answered on chain 143 .*; v4: the only Uniswap v4 routes .* v3 could not be read/), {reason: "rate_limited"}]]);
      // A "best" quote in the same state is refused for the same read.
      vi.stubGlobal("fetch", limitedV3(gridNode(false), match));
      const ranked: Heard = [];
      expect(await uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4}).getQuote({...monToX(), onRefusal: (t, i) => { ranked.push([t, i]); }}), what).toBeNull();
      expect(ranked[0]![1], what).toEqual({reason: "rate_limited"});
    }
  }, 60_000);

  it('v4RankedPools "all" (a provider in the app): both, the grid route next to v3', async () => {
    vi.stubGlobal("fetch", gridNode(true));
    const qs = await server({v4RankedPools: "all"}).getQuotes!(monToX());
    expect(qs.map((q) => [q.routeId, q.destAmount])).toEqual([["v3", "1000000"], ["v4", "1200000"]]);
  });
});

// ── The pins bind routeId to calldata ──

describe("pins: routeId bound to the call it names", () => {
  async function quotes(): Promise<{v3: Quote; ur: Quote; proxy: Quote; tokenParams: QuoteParams}> {
    const {qs} = await candidates(MON(62_000n));
    const USDC_IN = 700_000_000n;
    vi.stubGlobal("fetch", fakeNode({amount: USDC_IN, v3: {tokenOut: FAKE_AUSD, fee: 100, out: 699_000_000n}, v4: new Map([["0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8", {out: 700_500_000n, gas: 60_000n}]])}).fetch);
    const tokenParams: QuoteParams = {sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "USDC", destToken: FAKE_AUSD, amountIn: USDC_IN.toString(), destAddress: FAKE_ME, refundAddress: FAKE_ME, sender: FAKE_ME};
    const t = await uniswapProvider({rpcUrls: FAKE_RPC, v4Deployments: FAKE_V4, v4: "all", venueRoutes: "both"}).getQuotes!(tokenParams);
    return {v3: qs[0]!, ur: qs[1]!, proxy: t.find((q) => q.routeId === "v4")!, tokenParams};
  }

  it("every cross combination of routeId and call target is refused; the matching ones (and no routeId) pass — shipped pins and uniswapPinsWith()", async () => {
    const {v3, ur, proxy, tokenParams} = await quotes();
    const p = params(MON(62_000n));
    expect(proxy.txRequest!.to).toBe(FAKE_D4.swapProxy);
    const cases: [string, QuoteParams, Quote, string | undefined, RegExp | null][] = [
      ["v3 call, no routeId", p, v3, undefined, null],
      ["v3 call, routeId v3", p, v3, "v3", null],
      ["v3 call, routeId v4", p, v3, "v4", /^the 'v4' route calls 0x[0-9a-fA-F]{40}, not the chain's pinned Universal Router 2\.1\.2 or SwapProxy$/],
      ["UR call, no routeId", p, ur, undefined, null],
      ["UR call, routeId v4", p, ur, "v4", null],
      ["UR call, routeId v3", p, ur, "v3", /^the 'v3' route calls the chain's Uniswap v4 Universal Router \(0x[0-9a-fA-F]{40}\), not the SwapRouter$/],
      ["SwapProxy call, no routeId", tokenParams, proxy, undefined, null],
      ["SwapProxy call, routeId v4", tokenParams, proxy, "v4", null],
      ["SwapProxy call, routeId v3", tokenParams, proxy, "v3", /^the 'v3' route calls the chain's Uniswap v4 SwapProxy \(0x[0-9a-fA-F]{40}\), not the SwapRouter$/],
      ["v3 call, routeId v5", p, v3, "v5", /unknown Uniswap route 'v5'/],
      ["UR call, routeId taxi", p, ur, "taxi", /unknown Uniswap route 'taxi'/],
    ];
    for (const pins of [uniswapPins, uniswapPinsWith()]) {
      for (const [name, prm, q, routeId, refused] of cases) {
        const {routeId: _r, ...bare} = q;
        const quote: Quote = routeId === undefined ? bare : {...bare, routeId};
        const text = pins.verifyQuote!(prm, quote);
        if (refused === null) expect(text, name).toBeNull();
        else {
          expect(text, name).toMatch(refused);
          expect(pins.reasonOf!(text!)?.reason, name).toBe(/unknown/.test(text!) ? "policy_refused" : "vault_mismatch");
        }
      }
    }
    expect(uniswapVerifyQuote(p, {...ur, routeId: "v3"})).toMatch(/the 'v3' route calls/);
  });

  it("a 'v4' route on another target (an attacker contract, SwapRouter02 with v4 calldata) and a routeId other than the request's are refused", async () => {
    const {v3, ur} = await quotes();
    const p = params(MON(62_000n));
    const attacker = "0x2222222222222222222222222222222222222222";
    expect(uniswapVerifyQuote(p, {...ur, txRequest: {...ur.txRequest!, to: attacker}})).toMatch(/the 'v4' route calls 0x2222222222222222222222222222222222222222, not/);
    expect(uniswapVerifyQuote(p, {...ur, txRequest: {...ur.txRequest!, to: D3.router}})).toMatch(/the 'v4' route calls/);
    expect(uniswapVerifyQuote(p, {...v3, txRequest: {...v3.txRequest!, to: attacker}})).toMatch(/not the SwapRouter/);
    const asked = uniswapVerifyQuote(params(MON(62_000n), {routeId: "v4"}), v3);
    expect(asked).toMatch(/the quote is the 'v3' route, not the 'v4' route asked for/);
    expect(uniswapPins.reasonOf!(asked!)?.reason).toBe("policy_refused");
    expect(uniswapVerifyQuote(params(MON(62_000n), {routeId: "v4"}), ur)).toBeNull();
  });

  it("the provider holds a routed quote to its venue too: build and preflight refuse a mislabelled or unknown route; trackIntent and describeActivity serve both", async () => {
    const {v3, ur} = await quotes();
    const p = both();
    await expect(p.buildDeposit({...ur, routeId: "v3"})).rejects.toMatchObject({reason: "vault_mismatch", message: expect.stringMatching(/the quote's 'v3' route calls 0x[0-9a-fA-F]{40} \(venue v4\), not the pinned SwapRouter02/)});
    await expect(p.buildDeposit({...v3, routeId: "v4"})).rejects.toMatchObject({reason: "vault_mismatch", message: expect.stringMatching(/the quote's 'v4' route calls .* not the pinned Universal Router 2\.1\.2 or SwapProxy/)});
    await expect(p.buildDeposit({...v3, routeId: "v9"})).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/unknown route \(v9\)/)});
    await expect(p.preflightDeposit!({...ur, routeId: "v3"}, await p.buildDeposit(ur))).rejects.toMatchObject({reason: "vault_mismatch"});
    const {venue: _v, ...noVenue} = ur.providerData!;
    await expect(p.buildDeposit({...ur, providerData: noVenue})).rejects.toMatchObject({reason: "vault_mismatch"});
    const b3 = await p.buildDeposit(v3);
    const b4 = await p.buildDeposit(ur);
    expect([b3.to, b4.to]).toEqual([D3.router, D4.universalRouter]);
    // Tracking is by intent id, the same for both venues.
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as {id: number}[];
      return new Response(JSON.stringify(batch.map((r) => ({jsonrpc: "2.0", id: r.id, result: {status: "0x1"}}))));
    }) as typeof fetch);
    for (const q of [v3, ur]) expect(await p.trackIntent({intentId: q.intentId, sourceTxHash: `0x${"ab".repeat(32)}`})).toEqual({state: "completed", destTxHash: `0x${"ab".repeat(32)}`});
    const owner = getAddress(ME);
    const row = (q: Quote) => {
      const to = getAddress(q.txRequest!.to!);
      return describeUniswapActivity({
        chain: "eip155:143", hash: `0x${"cd".repeat(32)}`, time: 1_795_000_000, status: "confirmed", address: owner, from: owner, to, nativeValue: BigInt(q.txRequest!.value!),
        transfers: [{token: null, from: owner, to, amount: BigInt(q.txRequest!.value!)}, {token: AUSD, from: to, to: owner, amount: BigInt(q.minDestAmount), standard: "erc20"}],
        call: {to, selector: q.txRequest!.data!.slice(0, 10), data: q.txRequest!.data!},
      }, {own: new Set([owner.toLowerCase()])});
    };
    expect(row(v3)?.subtitle).toBe("Uniswap v3 · Monad");
    expect(row(ur)?.subtitle).toBe("Uniswap v4 · Monad");
  });
});

// ── The remote corridor: createSwap2Handler (venueRoutes "both") → uniswapRemoteProvider ──

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
function backend(provider: CrossChainProvider): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [provider], sealSecret: SECRET, guard: () => {}, subject: () => "app"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "app");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

describe("remote corridor: server venueRoutes \"both\", app uniswapRemoteProvider({multiQuotes: true})", () => {
  it("two sealed candidates, each verified by the app's pins; execution quotes with routeId \"v4\" and \"v3\" come back on their venue", async () => {
    const r = replay();
    vi.stubGlobal("fetch", r.fetch);
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(both()), multiQuotes: true});
    expect(typeof stub.getQuotes).toBe("function");
    const qs = await stub.getQuotes!({...params(MON(62_000n)), dry: true});
    expect(qs.map((q) => [q.routeId, q.destAmount, q.txRequest?.to])).toEqual([["v3", "1130999", D3.router], ["v4", "676608109", D4.universalRouter]]);
    for (const q of qs) {
      expect(q.providerData!.__remoteSeal).toMatch(/^[0-9a-f]{64}$/);
      expect(q.intentId).toMatch(/^uniswap:143~[0-9a-f]{32}$/);
      expect(remotePinRefusal(stub, q, "eip155:143")).toBeNull();
    }
    const v4 = await stub.getQuote({...params(MON(62_000n), {routeId: "v4"}), dry: false});
    expect(v4).toMatchObject({routeId: "v4", destAmount: "676608109", txRequest: {to: D4.universalRouter}});
    const v3 = await stub.getQuote({...params(MON(62_000n), {routeId: "v3"}), dry: false});
    expect(v3).toMatchObject({routeId: "v3", destAmount: "1130999", txRequest: {to: D3.router}});
    // The server builds each sealed quote; the build is the venue's call.
    expect((await stub.buildDeposit(v4!)).to).toBe(D4.universalRouter);
    expect((await stub.buildDeposit(v3!)).to).toBe(D3.router);
    expect(r.misses).toEqual([]);
  });

  it("a client without multiQuotes still gets one quote through /quote (the server's ranked winner, naming its route)", async () => {
    vi.stubGlobal("fetch", replay().fetch);
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(both())});
    expect("getQuotes" in stub).toBe(false);
    const q = await stub.getQuote(params(MON(62_000n)));
    expect(q).toMatchObject({routeId: "v4", destAmount: "676608109", txRequest: {to: D4.universalRouter}});
    expect(remotePinRefusal(stub, q!, "eip155:143")).toBeNull();
  });

  it("a backend that swaps the labels (v3 calldata as \"v4\", v4 calldata as \"v3\") gets nothing past the app's pins", async () => {
    vi.stubGlobal("fetch", replay().fetch);
    const real = both();
    const relabel: CrossChainProvider = {...real, name: "uniswap", getQuotes: async (p) => (await real.getQuotes!(p)).map((q) => ({...q, routeId: q.routeId === "v4" ? "v3" : "v4"}))};
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(relabel), multiQuotes: true});
    expect(await stub.getQuotes!({...params(MON(62_000n)), dry: true})).toEqual([]);
  });

  it('a multiQuotes client against a "best" server: /quotes is refused (turn multiQuotes on only after the server)', async () => {
    vi.stubGlobal("fetch", replay().fetch);
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(uniswapProvider({rpcUrls: RPC, v4: "native-in"})), multiQuotes: true});
    await expect(stub.getQuotes!({...params(MON(62_000n)), dry: true})).rejects.toThrow(/400 .*no candidate quoting capability/);
  });
});

// ── The router: two Uniswap rows; picking ("uniswap", "v4") executes the v4 route ──

describe("router: Uniswap v3 and v4 as two rows of one auction", () => {
  const SENDER = getAddress("0x4444444444444444444444444444444444444444");
  /** The recordings, plus the preflight's reads: the V4Quoter re-quote (named 30M gas on Monad) and the dry run from the sender. */
  const execution: Odd = (s) => {
    if (s.to === D4.quoter.toLowerCase() && s.gas !== undefined && s.from === undefined) return {result: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [676_608_109n, 86_591n])};
    if (s.from === SENDER.toLowerCase() && (s.to === D4.universalRouter.toLowerCase() || s.to === D3.router.toLowerCase())) return {result: "0x"};
    return undefined;
  };
  const options = {fromToken: "MON", toToken: AUSD, toChain: 143, recipient: SENDER, fromTokenAmount: 62_000n * 10n ** 18n, minAmountOut: 1n};

  it("CrossChainRouter.getQuotes shows both Uniswap candidates, v4 the best", async () => {
    vi.stubGlobal("fetch", replay().fetch);
    const set = await new CrossChainRouter([both()]).getQuotes(params(MON(62_000n)));
    expect(set!.quotes.map((q) => [q.provider, q.routeId, q.destAmount])).toEqual([["uniswap", "v4", "676608109"], ["uniswap", "v3", "1130999"]]);
    expect(set!.best.routeId).toBe("v4");
  });

  it('quoteSwap2Routes lists two rows; using("uniswap", "v4") sends the Universal Router call, using("uniswap", "v3") the SwapRouter02 one', async () => {
    const r = replay(execution);
    vi.stubGlobal("fetch", r.fetch);
    const provider = both();
    const reviewed: (string | undefined)[] = [];
    const accountFor = () => createMockAccount({chain: "eip155:143", address: SENDER, balance: 10n ** 30n});
    const api = new RouterSwap2Protocol(accountFor() as never, {fromChain: "eip155:143", providers: [provider], reviewExecution: async (plan) => { reviewed.push(plan.routeId); }});
    const rows = await api.quoteSwap2Routes(options);
    expect(rows.map((x) => [x.provider, x.routeId, x.quote.toTokenAmount])).toEqual([["uniswap", "v4", 676_608_109n], ["uniswap", "v3", 1_130_999n]]);

    const a4 = accountFor();
    await new RouterSwap2Protocol(a4 as never, {fromChain: "eip155:143", providers: [provider], reviewExecution: async (plan) => { reviewed.push(plan.routeId); }}).using("uniswap", "v4").swap2(options);
    const sent4 = a4.sent as {to?: string; value?: bigint; data?: string}[];
    expect(sent4).toHaveLength(1);
    expect(getAddress(sent4[0]!.to!)).toBe(getAddress(D4.universalRouter));
    expect(sent4[0]!.value).toBe(62_000n * 10n ** 18n);
    expect(sent4[0]!.data!.slice(0, 10)).toBe("0x3593564c"); // execute(bytes,bytes[],uint256)

    const a3 = accountFor();
    await new RouterSwap2Protocol(a3 as never, {fromChain: "eip155:143", providers: [provider], reviewExecution: async (plan) => { reviewed.push(plan.routeId); }}).using("uniswap", "v3").swap2(options);
    const sent3 = a3.sent as {to?: string; data?: string}[];
    expect(sent3).toHaveLength(1);
    expect(getAddress(sent3[0]!.to!)).toBe(getAddress(D3.router));
    expect(sent3[0]!.data!.slice(0, 10)).toBe("0x5ae401dc"); // multicall(uint256,bytes[])
    expect(reviewed).toEqual(["v4", "v3"]);
    expect(r.misses).toEqual([]);
  });
});


// ── The standalone protocol with venueRoutes "both": the shared behaviour suite on the Base SwapProxy recording ──

const D8453 = UNISWAP_V4[8453]!;
const baseNode = tokenReplay([BASE_TOKEN], (s) => {
  if (s.method !== "eth_call" || s.params[2] !== undefined) return undefined;
  const c = s.params[0] as {to: string; from?: string; data: string};
  if (getAddress(c.to) === getAddress(D8453.quoter) && c.from === undefined && /^0x(aa9d21cb|ca253dc9)/.test(c.data)) {
    return {result: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [592_387_949_236_107_032n, 38_972n])};
  }
  if (getAddress(c.to) === getAddress(D8453.swapProxy) && c.from && getAddress(c.from) === HOLDER) return {result: "0x"};
  return undefined;
}).fetch;
/** Who a SwapProxy call pays: the TAKE recipient of its one V4_SWAP input. */
const decodeSwapProxy = (source: {kind: string; data?: string}): string[] => {
  const [, , , , inputs] = decodeFunctionData({abi: SWAP_PROXY_ABI, data: source.data as Hex}).args as readonly [string, string, bigint, Hex, readonly Hex[], bigint];
  return inputs.map((input) => {
    const [actions, ps] = decodeAbiParameters(V4_SWAP_INPUT_ABI, input) as readonly [Hex, readonly Hex[]];
    const take = actions.slice(2).match(/../g)!.indexOf("0e");
    if (take < 0) throw new Error("the V4_SWAP input has no TAKE");
    return decodeAbiParameters(V4_TAKE_ABI, ps[take]!)[1];
  });
};
describeProtocolBehaviour("protocol-swap2-uniswap (venueRoutes \"both\", v4 SwapProxy)", {
  type: "swap2",
  Protocol: UniswapSwap2Protocol,
  config: {fromChain: "eip155:8453", rpcUrls: {8453: ["https://base.fixture"]}, v4: "all", venueRoutes: "both", deployments: {}},
  fixtures: [
    {
      name: "1,000 USDC → ETH on Base, the default quote naming its route \"v4\" (exact approve to the SwapProxy, then SwapProxy.execute)",
      options: {fromToken: "USDC", toToken: "ETH", toChain: 8453, recipient: HOLDER, fromTokenAmount: 1_000_000_000n, minAmountOut: 1n},
      fetch: baseNode, account: {chain: "eip155:8453", address: HOLDER}, own: [HOLDER], spender: D8453.swapProxy, callTargets: [D8453.swapProxy], sourceToken: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"), decode: decodeSwapProxy,
    },
  ],
});
