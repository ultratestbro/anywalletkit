// U1/U2 review round 2 (R2-1 / SEC-U4-R2-2): pool lists are rebuilt and re-released when the watch reports a new live
// hookless pool, so a server can run a newer list than the apps it serves. Before the fix the default
// `v4RankedPools: "listed"` ranked every pool of the server's own list against v3; a route through a pool only the newer
// list has then beat v3, every app on the older list refused it ("not in the pinned pool list") and — a stub gets one
// quote per pair — lost the v3 quote it had.
//
// The case, on the fake Monad node: the server's Monad list carries MON/AUSD 0.05%/1 (P) with `since` = a later build
// block (as scripts/build-v4-pools.mjs now marks a pool a rebuild adds); an app on the older list pins every Monad pool
// but P. 100 MON → AUSD: P pays 20% more than v3's MON/AUSD 0.3% route.
import {afterEach, describe, expect, it, vi} from "vitest";
import {getAddress} from "viem";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import type {CrossChainProvider, Quote, QuoteParams, RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapPins, uniswapV3VerifyQuote, uniswapVerifyQuote} from "../src/addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {uniswapRemoteProvider} from "../src/remote.js";
import {UNISWAP_V4_POOL_KEYS} from "../src/v4/listed.js";
import {poolIdOf} from "../src/v4/pool.js";
import {uniswapV4VerifyQuote} from "../src/v4/verify.js";
import {UNISWAP_V4_POOLS} from "../src/v4pools/index.js";
import {AUSD, CHAIN, D3, D4, ME, RPC, V4, fakeNode} from "./v4-fake-node.js";

/** The block of the later build that added P (the shipped Monad list is at 125,461,100). */
const LATER = 130_000_000;
const P_ID = "0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219";
// The server's list: the shipped Monad list with P marked as added by the later build.
vi.mock("../src/v4pools/143.js", async (importOriginal) => {
  const m = await importOriginal<typeof import("../src/v4pools/143.js")>();
  return {V4_POOLS_143: {...m.V4_POOLS_143, pools: m.V4_POOLS_143.pools.map((p) => (p.id === "0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219" ? {...p, since: 130_000_000} : p))}};
});

afterEach(() => vi.unstubAllGlobals());

const AMOUNT = 100n * 10n ** 18n;
const V3_OUT = 1_000_000n;
const V4_OUT = 1_200_000n;
const node = (v3 = true) => fakeNode({amount: AMOUNT, v3: v3 ? {tokenOut: AUSD, fee: 3000, out: V3_OUT} : undefined, v4: new Map([[P_ID, {out: V4_OUT, gas: 90_000n}]])});
const params = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "MON", destToken: AUSD, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME});
const server = (c: Partial<UniswapProviderConfig> = {}) => uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4, ...c});

/** The pins of an app on the older Monad list: every shipped pool but P. */
const OLD_LIST = Object.freeze(UNISWAP_V4_POOL_KEYS[CHAIN]!.filter((k) => poolIdOf(k).toLowerCase() !== P_ID));
const OLD_POOLS = Object.freeze({...UNISWAP_V4_POOL_KEYS, [CHAIN]: OLD_LIST});
const oldVerify = (p: QuoteParams, q: Quote): string | null => {
  const to = q.txRequest?.to;
  return to && getAddress(to) === getAddress(D4.universalRouter) ? uniswapV4VerifyQuote(p, q, {pools: OLD_POOLS}) : uniswapV3VerifyQuote(p, q);
};
const OLD_PINS: RemotePins = {...uniswapPins, verifyQuote: oldVerify};

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
function backend(provider: CrossChainProvider): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [provider], sealSecret: SECRET, guard: () => {}, subject: () => "app"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "app");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}
async function viaStub(stub: CrossChainProvider): Promise<{q: Quote | null; error?: Error}> {
  try {
    return {q: await stub.getQuote(params())};
  } catch (error) {
    return {q: null, error: error as Error};
  }
}
const oldApp = (provider: CrossChainProvider) => remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(provider), supportsSameChain: true, ...OLD_PINS});

describe("R2-1 / SEC-U4-R2-2: a pool a later list added never displaces v3 for an app on the older list", () => {
  it("the case holds: the server's list marks P as added later, P pays 20% more than v3, the older pins refuse a route over it", async () => {
    expect(UNISWAP_V4_POOLS[CHAIN]!.pools.find((p) => p.id === P_ID)?.since).toBe(LATER);
    expect(UNISWAP_V4_POOLS[CHAIN]!.block).toBeLessThan(LATER);
    vi.stubGlobal("fetch", node().fetch);
    const local = await server({v4RankedPools: "all"}).getQuote(params());
    expect(local).toMatchObject({destAmount: V4_OUT.toString(), providerData: {venue: "v4", route: "v4 direct 0.05%/1"}});
    expect(oldVerify(params(), local!)).toMatch(new RegExp(`the pool ${P_ID} is not in the pinned pool list`));
    expect(uniswapVerifyQuote(params(), local!)).toBeNull(); // an app on the newer list accepts it
  });

  it("default (no v4RankedListBlock): the server keeps v3 for the pair, and the app on the older list gets it end to end", async () => {
    vi.stubGlobal("fetch", node().fetch);
    const q = await server().getQuote(params());
    expect(q).toMatchObject({destAmount: V3_OUT.toString(), txRequest: {to: D3.router}});
    expect(q!.providerData!.venue).toBeUndefined();
    const stub = oldApp(server());
    const r = await viaStub(stub);
    expect(r.error).toBeUndefined();
    expect(r.q).toMatchObject({destAmount: V3_OUT.toString(), txRequest: {to: D3.router}});
    expect(remotePinRefusal(stub, r.q!, `eip155:${CHAIN}`)).toBeNull();
    // Through the uniswap remote helper (the shipped, newer pins) the same v3 quote passes too.
    const helper = await viaStub(uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server())}));
    expect(helper.q?.destAmount).toBe(V3_OUT.toString());
  });

  it("v4RankedListBlock at or above P's block (every app on the newer list): P is ranked and wins; below it, still v3", async () => {
    vi.stubGlobal("fetch", node().fetch);
    const on = await server({v4RankedListBlock: {[CHAIN]: LATER}}).getQuote(params());
    expect(on).toMatchObject({destAmount: V4_OUT.toString(), providerData: {venue: "v4"}});
    expect(uniswapVerifyQuote(params(), on!)).toBeNull();
    const below = await server({v4RankedListBlock: {[CHAIN]: LATER - 1}}).getQuote(params());
    expect(below?.destAmount).toBe(V3_OUT.toString());
    // Another chain's entry says nothing about Monad.
    const other = await server({v4RankedListBlock: {8453: LATER}}).getQuote(params());
    expect(other?.destAmount).toBe(V3_OUT.toString());
    // Raised too early (an app is still on the older list) the app refuses — why the default stays at the first list.
    const {q, error} = await viaStub(oldApp(server({v4RankedListBlock: {[CHAIN]: LATER}})));
    expect(q).toBeNull();
    expect(error?.message).toMatch(/is not in the pinned pool list/);
  });

  it('"extra" keeps the newer-list rule too; "all" (a provider in the app) ranks P', async () => {
    vi.stubGlobal("fetch", node().fetch);
    expect((await server({v4RankedPools: "extra"}).getQuote(params()))?.destAmount).toBe(V3_OUT.toString());
    expect((await server({v4RankedPools: "all"}).getQuote(params()))?.destAmount).toBe(V4_OUT.toString());
  });

  it("with no v3 route for the pair the route over P is still returned (the app had nothing to lose)", async () => {
    vi.stubGlobal("fetch", node(false).fetch);
    const q = await server().getQuote(params());
    expect(q).toMatchObject({destAmount: V4_OUT.toString(), providerData: {venue: "v4"}});
  });

  it("v4RankedListBlock is checked when the provider is made", () => {
    for (const bad of [{abc: 1}, {"0x8f": 1}, {[CHAIN]: -1}, {[CHAIN]: 1.5}, {[CHAIN]: Number.NaN}] as never[]) expect(() => server({v4RankedListBlock: bad})).toThrow(/v4RankedListBlock/);
    expect(() => server({v4RankedListBlock: {[CHAIN]: 0}})).not.toThrow();
  });
});
