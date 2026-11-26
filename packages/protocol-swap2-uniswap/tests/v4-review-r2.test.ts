// U1/U2 review round 2: R2-2 (v4 on never costs a pair its v3 route: a v4 build refused for a reason of the build
// falls back to the next v4 candidate or to v3, and a candidate no transaction can carry is ranked out before ranking),
// LIVE2-2 (a v4 deployment mismatch alerts through onV4Warning), R2-3 (module.json lists every chain the module
// serves), R2-4 (the verifier gates on G = max(probe, spot)), SEC-U4-R2-1 (the PoolId cache never outlives a mutable
// list), SEC-U4-R2-4 (one v4ExtraPools parser for the provider and the pins). The quotes run on the fake Monad node.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {UNISWAP_V3, uniswapPinsWith, uniswapVerifyQuote} from "../src/addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {checkedV4ExtraPools, poolIdOf, type V4PoolKey} from "../src/v4/pool.js";
import {v4ServedDeployment} from "../src/v4/serve.js";
import {uniswapV4ReasonOf, uniswapV4VerifyQuote} from "../src/v4/verify.js";
import {AUSD, CHAIN, D3, D4, ME, RPC, V4, fakeNode} from "./v4-fake-node.js";
import {MON_AUSD_500_1, POOLS, makeCase, now} from "./v4-helpers.js";

afterEach(() => vi.unstubAllGlobals());

const P_ID = poolIdOf(MON_AUSD_500_1).toLowerCase(); // MON/AUSD 0.05%/1
const AUSD_USDC_9_1 = "0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8";
const AUSD_USDC_50_1 = "0x092b650478145f0aee73a1b400b342b9c6314db2e07aeb91faf7e75e8159ce72";
const MON = 100n * 10n ** 18n;
const USDC_IN = 700_000_000n;

type Heard = Array<[string, Swap2RefusalInfo | undefined]>;
async function quote(p: QuoteParams, c: Partial<UniswapProviderConfig>) {
  const heard: Heard = [];
  const warned: Array<[string, unknown]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, v4Deployments: V4, ...c, onV4Warning: (t, i) => { warned.push([t, i]); }}).getQuote({...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, warned};
}
const monToAusd = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "MON", destToken: AUSD, amountIn: MON.toString(), destAddress: ME, refundAddress: ME});
const usdcToAusd = (): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "USDC", destToken: AUSD, amountIn: USDC_IN.toString(), destAddress: ME, refundAddress: ME, sender: ME});

describe("R2-2: a candidate the chain could never mine is ranked out before ranking", () => {
  // P pays 20% more than v3, but its quoter gas (29.0M) + the router's 150k, × 1.05, is above Monad's 30M cap.
  const node = (v3: boolean) => fakeNode({amount: MON, v3: v3 ? {tokenOut: AUSD, fee: 3000, out: 1_000_000n} : undefined, v4: new Map([[P_ID, {out: 1_200_000n, gas: 29_000_000n}]])});
  it("with a v3 route: v3 is quoted (before, the v4 winner was refused for gas and the v3 route was lost), the count rides on it", async () => {
    vi.stubGlobal("fetch", node(true).fetch);
    const {q, heard, warned} = await quote(monToAusd(), {v4: "native-in"});
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "1000000", txRequest: {to: D3.router}, providerData: {v4Unexecutable: "1"}});
    expect(q!.providerData!.venue).toBeUndefined();
    expect(warned).toEqual([]);
  });
  it("v4 alone: refused as insufficient_liquidity, naming the cap", async () => {
    vi.stubGlobal("fetch", node(false).fetch);
    const {q, heard} = await quote(monToAusd(), {v4: "native-in", deployments: {}});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/every Uniswap v4 route for this pair and amount is out: the v4 ones need more gas than one transaction on chain 143 may have \(30000000\)/), {reason: "insufficient_liquidity"}]]);
  });
  it("a minable candidate below it still wins over v3", async () => {
    vi.stubGlobal("fetch", fakeNode({amount: MON, v3: {tokenOut: AUSD, fee: 3000, out: 1_000_000n}, v4: new Map([[P_ID, {out: 1_200_000n, gas: 28_000_000n}]])}).fetch);
    const {q} = await quote(monToAusd(), {v4: "native-in"});
    expect(q).toMatchObject({destAmount: "1200000", providerData: {venue: "v4"}});
    expect(BigInt(q!.txRequest!.gasLimit!)).toBeLessThanOrEqual(30_000_000n);
  });
});

describe("R2-2: a v4 build refused for a reason of the build falls back; the trade's verdicts still refuse", () => {
  // USDC → AUSD: v4 AUSD/USDC 0.0009%/1 pays most, 0.005%/1 next, v3 USDC/AUSD 0.01% least.
  const pools = new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}], [AUSD_USDC_50_1, {out: 700_200_000n, gas: 60_000n}]]);
  const node = (o: {simulateReverts?: string[]; balance?: bigint} = {}) =>
    fakeNode({amount: USDC_IN, v3: {tokenOut: AUSD, fee: 100, out: 699_000_000n}, v4: pools, ...(o.simulateReverts ? {simulateReverts: new Set(o.simulateReverts)} : {}), ...(o.balance !== undefined ? {balance: o.balance} : {})});
  it("the healthy case: the best v4 route, simulated with its approval", async () => {
    vi.stubGlobal("fetch", node().fetch);
    const {q, warned} = await quote(usdcToAusd(), {v4: "all"});
    expect(q).toMatchObject({destAmount: "700500000", txRequest: {to: D4.swapProxy}, providerData: {venue: "v4", route: "v4 direct 0.0009%/1", simulated: "approve+swap"}});
    expect(warned).toEqual([]);
  });
  it("the best route's simulated swap reverts (V4TooLittleReceived): the next v4 route is built and returned, the operator warned", async () => {
    const n = node({simulateReverts: [AUSD_USDC_9_1]});
    vi.stubGlobal("fetch", n.fetch);
    const {q, heard, warned} = await quote(usdcToAusd(), {v4: "all"});
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "700200000", providerData: {venue: "v4", route: "v4 direct 0.005%/1", simulated: "approve+swap"}});
    expect(uniswapVerifyQuote(usdcToAusd(), q!)).toBeNull();
    expect(warned).toEqual([[expect.stringMatching(/best Uniswap v4 route on chain 143 was set aside \(price moved .*\) — quoted another v4 route/), {chainId: CHAIN, reason: "price_check_failed"}]]);
    expect(n.seen.filter((s) => s.method === "eth_simulateV1")).toHaveLength(2);
  });
  it("every v4 route's simulation reverts: v3 is quoted; v4 alone, the best route's reason refuses", async () => {
    vi.stubGlobal("fetch", node({simulateReverts: [AUSD_USDC_9_1, AUSD_USDC_50_1]}).fetch);
    const both = await quote(usdcToAusd(), {v4: "all"});
    expect(both.heard).toEqual([]);
    expect(both.q).toMatchObject({destAmount: "699000000", txRequest: {to: D3.router, approvalAddress: D3.router}});
    expect(both.warned).toEqual([[expect.stringMatching(/set aside \(price moved .*\) — quoted v3/), {chainId: CHAIN, reason: "price_check_failed"}]]);
    vi.stubGlobal("fetch", node({simulateReverts: [AUSD_USDC_9_1, AUSD_USDC_50_1]}).fetch);
    const alone = await quote(usdcToAusd(), {v4: "all", deployments: {}});
    expect(alone.q).toBeNull();
    expect(alone.heard).toEqual([[expect.stringMatching(/price moved .* Nothing was approved/), {reason: "price_check_failed"}]]);
  });
  it("a trade verdict is final: a wallet short of the input refuses the quote (no v3 quote for a swap that cannot run)", async () => {
    vi.stubGlobal("fetch", node({balance: USDC_IN - 1n}).fetch);
    const {q, heard, warned} = await quote(usdcToAusd(), {v4: "all"});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/the wallet holds 699999999 of the input, less than the 700000000 it sells/), {reason: "simulation_failed"}]]);
    expect(warned).toEqual([]);
  });
  it("the caller's floor is a trade verdict too (any lower-output route breaches it as well)", async () => {
    vi.stubGlobal("fetch", node().fetch);
    const {q, heard} = await quote({...usdcToAusd(), minAmountOut: "700000000"}, {v4: "all"});
    expect(q).toBeNull();
    expect(heard[0]).toEqual([expect.stringMatching(/floor breach/), {reason: "price_check_failed"}]);
  });
});

describe("LIVE2-2: a v4 deployment that does not match its pins alerts (§6.5 row 15: refuse + alert)", () => {
  const node = (o: {routerCode?: `0x${string}`; linkageReverts?: boolean}, v3 = true) => fakeNode({amount: MON, v3: v3 ? {tokenOut: AUSD, fee: 3000, out: 1_000_000n} : undefined, v4: new Map([[P_ID, {out: 1_200_000n, gas: 90_000n}]]), ...o});
  it("the router's code changed: v3 is quoted as before, and onV4Warning hears vault_mismatch naming the problem", async () => {
    vi.stubGlobal("fetch", node({routerCode: "0x60806040526000805500ff"}).fetch);
    const {q, heard, warned} = await quote(monToAusd(), {v4: "native-in"});
    expect(q).toMatchObject({destAmount: "1000000", txRequest: {to: D3.router}});
    expect(heard).toEqual([]); // the caller's refusal channel is untouched (first-wins, and dropped when a quote stands)
    expect(warned).toEqual([[expect.stringMatching(/^uniswap: Uniswap v4 is off on chain 143: the deployment does not match its pins \(the Universal Router's code is not the pinned 2\.1\.2 build\)/), {chainId: CHAIN, reason: "vault_mismatch"}]]);
  });
  it("a poolManager() linkage read reverts: the same alert", async () => {
    vi.stubGlobal("fetch", node({linkageReverts: true}).fetch);
    const {q, warned} = await quote(monToAusd(), {v4: "native-in", deployments: {...UNISWAP_V3, [CHAIN]: {...D3}}});
    expect(q?.txRequest?.to).toBe(D3.router);
    expect(warned).toEqual([[expect.stringMatching(/does not match its pins \(the Universal Router does not report the pinned PoolManager\)/), {chainId: CHAIN, reason: "vault_mismatch"}]]);
  });
  it("v4 alone: refused as vault_mismatch, and alerted", async () => {
    vi.stubGlobal("fetch", node({routerCode: "0x60806040526000805500ff"}, false).fetch);
    const {q, heard, warned} = await quote(monToAusd(), {v4: "native-in", deployments: {}});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/does not match its pins — refusing/), {reason: "vault_mismatch"}]]);
    expect(warned).toHaveLength(1);
  });
  it("a hook that throws or rejects never fails the quote", async () => {
    vi.stubGlobal("fetch", node({routerCode: "0x60806040526000805500ff"}).fetch);
    const q1 = await uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4, onV4Warning: () => { throw new Error("boom"); }}).getQuote(monToAusd());
    expect(q1?.destAmount).toBe("1000000");
    const q2 = await uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4, onV4Warning: (async () => { throw new Error("boom"); }) as never}).getQuote(monToAusd());
    expect(q2?.destAmount).toBe("1000000");
  });
});

describe("R2-3: module.json lists every chain the module serves (v3, and v4 with \"all\")", () => {
  it("= the v3 chains ∪ the chains v4 \"all\" quotes on (Arc included)", () => {
    const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8")) as {chains: string[]};
    const v4 = Object.keys(UNISWAP_V4).map(Number).filter((id) => v4ServedDeployment(id, "all", UNISWAP_V4, {}) !== undefined);
    const served = new Set([...Object.keys(UNISWAP_V3).map(Number), ...v4].map((id) => `eip155:${id}`));
    expect(new Set(manifest.chains)).toEqual(served);
    expect(manifest.chains).toContain("eip155:5042");
    expect(manifest.chains).not.toContain("eip155:999");
  });
});

describe("R2-4: the verifier's maxPriceImpactBps gates on G = max(probe, spot)", () => {
  const c = makeCase();
  const withPd = (pd: Record<string, string>): Quote => ({...c.quote, providerData: pd});
  const v = (q: Quote, limit = 500) => uniswapV4VerifyQuote(c.params, q, {pools: POOLS, now, maxPriceImpactBps: limit});
  it("spot alone (the probe could not run on a gated quote) is a measure: passes under the limit, refused at it", () => {
    expect(v(withPd({valueLossBps: "3"}))).toBeNull();
    const at = v(withPd({valueLossBps: "500"}));
    expect(at).toMatch(/loses 5\.00% of the value to price impact/);
    expect(uniswapV4ReasonOf(at!)).toEqual({reason: "insufficient_liquidity"});
  });
  it("a low probe never hides a high spot loss (a pool parked past an empty range)", () => {
    const r = v(withPd({priceImpactBps: "17", valueLossBps: "9800"}));
    expect(r).toMatch(/loses 98\.00%/);
    expect(uniswapV4ReasonOf(r!)).toEqual({reason: "insufficient_liquidity"});
    expect(v(withPd({priceImpactBps: "17", valueLossBps: "23"}))).toBeNull();
    expect(v(withPd({priceImpactBps: "600", valueLossBps: "23"}))).toMatch(/loses 6\.00%/);
  });
  it("neither measure, or one that does not read as bps, is refused (fail closed)", () => {
    for (const pd of [{}, {valueLossBps: "-1"}, {priceImpactBps: "17", valueLossBps: "x"}, {valueLossBps: "123456"}]) {
      const r = v(withPd(pd));
      expect(r, JSON.stringify(pd)).toMatch(/no price-impact measure/);
      expect(uniswapV4ReasonOf(r!)).toEqual({reason: "upstream_unavailable"});
    }
    // Unset: information only, whatever it says.
    expect(uniswapV4VerifyQuote(c.params, withPd({valueLossBps: "9999"}), {pools: POOLS, now})).toBeNull();
  });
});

describe("SEC-U4-R2-1: the pool-provenance cache never outlives a list the caller can change", () => {
  const c = makeCase();
  it("a mutable list: a pool removed after the first check is refused on the next one", () => {
    const list: V4PoolKey[] = [MON_AUSD_500_1];
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: list}, now})).toBeNull();
    list.length = 0;
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: list}, now})).toMatch(/no pinned Uniswap v4 pool list for chain 143/);
    list.push({...MON_AUSD_500_1, fee: 3000, tickSpacing: 60});
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: list}, now})).toMatch(/is not in the pinned pool list/);
  });
  it("a key edited in place is heard too; a frozen list of frozen keys is cached and cannot change", () => {
    const key = {...MON_AUSD_500_1};
    const list = Object.freeze([key]);
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: list}, now})).toBeNull();
    key.fee = 3000; // the array is frozen, its key is not: not cached, so the edit is heard
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: list}, now})).toMatch(/is not in the pinned pool list/);
    const sealed = Object.freeze([Object.freeze({...MON_AUSD_500_1})]);
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: sealed}, now})).toBeNull();
    expect(uniswapV4VerifyQuote(c.params, c.quote, {pools: {[CHAIN]: sealed}, now})).toBeNull();
    expect(() => { (sealed as unknown as V4PoolKey[]).length = 0; }).toThrow();
  });
});

describe("SEC-U4-R2-4: the provider reads v4ExtraPools with the pins' own parser", () => {
  const key: V4PoolKey = MON_AUSD_500_1;
  it("keys the pins refuse are refused by the provider too, with the same error", () => {
    for (const bad of [{"0x8f": [key]}, {abc: [key]}, {" 143": [key]}, {"1e2": [key]}, {"99999999999999999999": [key]}] as never[]) {
      let pins = "", provider = "";
      try { uniswapPinsWith({v4ExtraPools: bad}); } catch (e) { pins = (e as Error).message; }
      try { uniswapProvider({rpcUrls: {}, v4: "all", v4ExtraPools: bad}); } catch (e) { provider = (e as Error).message; }
      expect(pins, JSON.stringify(bad)).toMatch(/v4ExtraPools\[.*\] is not a list of pool keys/);
      expect(provider).toBe(pins);
    }
    expect(() => checkedV4ExtraPools({"143": [key], "0143": [key]} as never)).toThrow(/names chain 143 twice/);
    expect(() => uniswapProvider({rpcUrls: {}, v4: "all", v4ExtraPools: {"143": [key], "0143": [key]} as never})).toThrow(/twice/);
  });
  it("a good configuration reads the same on both sides (frozen, chain ids as numbers)", () => {
    const parsed = checkedV4ExtraPools({[CHAIN]: [key]});
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed[CHAIN]) && Object.isFrozen(parsed[CHAIN]![0])).toBe(true);
    expect(Object.keys(parsed)).toEqual([String(CHAIN)]);
    expect(uniswapPinsWith({v4ExtraPools: {[CHAIN]: [key]}}).callTargets(`eip155:${CHAIN}`)).toContain(D4.universalRouter);
    expect(uniswapProvider({rpcUrls: RPC, v4: "all", v4ExtraPools: {[CHAIN]: [key]}}).supportsChain!(`eip155:${CHAIN}`)).toBe(true);
  });
});
