// LIVE-VR-3 (0.4.12 release review, 2026-11-26): the v3 quote ranked QuoterV2 candidates by output alone, then bounded
// the winner's gas and refused it when no transaction on the chain can carry it — so a highest-output route that can
// never be mined hid lower-output routes that can, and the pair got no quote. Live, Arbitrum 2000 ETH → ARB: direct
// 0.05% paid 6,951,284 ARB at ~48.0M quoter gas (over Nitro's 32M execution cap) and was refused, while "via USDC 0.05%
// → 0.3%" (1,180,277 ARB at 21.5M) and "via USDC 0.3% → 0.3%" (1,162,590 ARB at 14.2M) can be mined; a node whose
// eth_call stops at ~20M gas answered ~1.16M ARB for the same request (results depended on the node).
//
// Now a candidate whose need (its quoter gas + the router's 120k + this request's unwrap/refund, +5%) is above the
// chain's bound is ranked out before the best is picked, as Uniswap v4's candidates are. A candidate without a gas
// figure (under MIN_POOL_GAS per pool) stays one. With none the chain can carry, the best by output goes on and is
// refused exactly as before. The price impact (and maxPriceImpactBps) is measured on the route returned.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, decodeFunctionResult, encodeAbiParameters, getAddress, parseAbi, toFunctionSelector, type Hex} from "viem";
import {ccAsset} from "@anywalletkit/swap2-assets";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {GAS_NEED_PCT} from "../src/impact.js";
import {D, ME, MID_SQRT_PRICE, USDC, USDT, poolOf, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160[], uint32[], uint256)",
]);
const NATIVE = "0x0000000000000000000000000000000000000000";
const P24 = 16_777_216n;
const NEEDS = (need: bigint, chainId: number, cap: bigint) => `uniswap: the swap needs ${need} gas, more than chain ${chainId} takes in one transaction (${cap}) — its pools are too thin for this amount`;
/** USDC → USDT (Ethereum's addresses, which the stub answers for any chain) of 1 USDC. */
const on = (chainId: number) => ({sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`, destAddress: ME, refundAddress: ME, sourceToken: USDC, sourceDecimals: 6, destToken: USDT, amountIn: "1000000"});

type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};
/** A quoter call: its route key ("direct 500", or "<mid> 500/3000") and its input. */
type Asked = {key: string; amountIn: bigint};
type Leg = {out: bigint; gas: bigint};

/** The quoter call a request item is, else undefined. */
function asked(req: Body): Asked | undefined {
  const p = req.params?.[0] as {data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data) return undefined;
  try {
    const c = decodeFunctionData({abi: QUOTER, data: p.data});
    if (c.functionName === "quoteExactInputSingle") {
      const a = c.args[0] as {fee: number; amountIn: bigint};
      return {key: `direct ${a.fee}`, amountIn: a.amountIn};
    }
    const path = (c.args[0] as Hex).slice(2);
    if (path.length !== 132) return undefined;
    const mid = getAddress(`0x${path.slice(46, 86)}`);
    return {key: `${mid} ${parseInt(path.slice(40, 46), 16)}/${parseInt(path.slice(86, 92), 16)}`, amountIn: c.args[1] as bigint};
  } catch {
    return undefined;
  }
}

/**
 * A node that prices each route in `table` ("direct <fee>", "<mid> <f1>/<f2>") at `full` input: its output (linear in
 * the input, so the 1/1000 probe sees no impact) and its quoter gas at any size; every other route reverts. Deployment,
 * getPool, slot0 and the block are the fixtures' stub (`o`). Every request batch is kept, as sent.
 */
function node(full: bigint, table: Record<string, Leg>, o: StubOptions = {}) {
  const inner = rpcStub({byFee: {}, ...o});
  const bodies: string[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = String(init?.body);
    bodies.push(body);
    const batch = JSON.parse(body) as Body[];
    const res = (await (await inner(url, init)).json()) as {id: number}[];
    return new Response(JSON.stringify(res.map((r, i) => {
      const a = asked(batch[i]!);
      const leg = a && table[a.key];
      if (!a || !leg) return r;
      const out = (leg.out * a.amountIn) / full;
      const result = a.key.startsWith("direct ")
        ? encodeAbiParameters([{type: "uint256"}, {type: "uint160"}, {type: "uint32"}, {type: "uint256"}], [out, MID_SQRT_PRICE, 1, leg.gas])
        : encodeAbiParameters([{type: "uint256"}, {type: "uint160[]"}, {type: "uint32[]"}, {type: "uint256"}], [out, [MID_SQRT_PRICE, MID_SQRT_PRICE], [1, 1], leg.gas]);
      return {jsonrpc: "2.0", id: r.id, result};
    })));
  }) as typeof fetch;
  const calls = () => bodies.flatMap((b) => JSON.parse(b) as Body[]);
  /** The routes quoted at `amountIn` (the probe: full / 1000). */
  const quotedAt = (amountIn: bigint) => calls().flatMap((c) => {
    const a = asked(c);
    return a && a.amountIn === amountIn ? [a.key] : [];
  });
  return {fetch: f, bodies, calls, quotedAt};
}

async function quote(chainId: number, n: {fetch: typeof fetch}, over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", n.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const p = uniswapProvider({rpcUrls: {[chainId]: ["https://rpc.test"]}, deployments: {[chainId]: {...D}}, ...config});
  const q = await p.getQuote({...on(chainId), ...over, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never);
  return {q, heard};
}

const M = 1_000_000n;
/** The largest quoter gas whose need (with `extra` gas of unwrap/refund) fits 2^24 — one more does not. */
const fitsP24 = (extra: bigint) => (P24 * 100n) / GAS_NEED_PCT - 120_000n - extra;

describe("LIVE-VR-3: a route no transaction can carry never displaces one that can", () => {
  it("the best route needs more than 2^24 on Ethereum: the next one is quoted, its probe and gas limit its own", async () => {
    const n = node(M, {"direct 500": {out: 1_000_000n, gas: 16_700_000n}, "direct 3000": {out: 990_000n, gas: 90_000n}});
    const {q, heard} = await quote(1, n);
    expect(heard).toEqual([]); // 039db9fe: [NEEDS(17_661_000n, 1, P24), insufficient_liquidity] — no quote for the pair
    expect(q).toMatchObject({destAmount: "990000", minDestAmount: "985050", txRequest: {gasLimit: "255000"}});
    expect(q!.providerData).toMatchObject({route: "direct 0.3%", fee: "3000", priceImpactBps: "0"});
    expect(n.quotedAt(1_000n)).toEqual(["direct 3000"]); // the probe ran on the route returned, never on the unminable one
  });

  it("every route over the bound: refused as before, with the need of the highest-output route", async () => {
    // Arbitrum (Nitro's 32M execution cap): 40M at the most output, 35M under it — the text names 40M's need.
    for (const [hi, lo] of [["direct 500", "direct 3000"], ["direct 3000", "direct 500"]] as const) {
      const n = node(M, {[hi]: {out: 1_000_000n, gas: 40_000_000n}, [lo]: {out: 990_000n, gas: 35_000_000n}});
      const {q, heard} = await quote(42161, n, {}, {});
      expect(q).toBeNull();
      expect(heard).toEqual([[NEEDS(42_126_000n, 42161, 32_000_000n), {reason: "insufficient_liquidity"}]]);
      expect(n.quotedAt(1_000n)).toEqual([hi]); // the same reads as before: the probe of the best by output, then the refusal
    }
    // One candidate only: the single-candidate refusal, byte for byte.
    const one = await quote(1, node(M, {"direct 500": {out: 1_000_000n, gas: 16_700_000n}}));
    expect(one.heard).toEqual([[NEEDS(17_661_000n, 1, P24), {reason: "insufficient_liquidity"}]]);
  });

  it("every route over the bound, maxPriceImpactBps set: the checks speak in the order they did (impact, then gas)", async () => {
    const table = {"direct 500": {out: 1_000_000n, gas: 16_700_000n}, "direct 3000": {out: 990_000n, gas: 16_800_000n}};
    const flat = await quote(1, node(M, table), {}, {maxPriceImpactBps: 500});
    expect(flat.heard).toEqual([[NEEDS(17_661_000n, 1, P24), {reason: "insufficient_liquidity"}]]);
    // A mid of 4 on the best pool: its 75% loss is the refusal, as before (measured on the best by output).
    const thin = await quote(1, node(M, table, {slot0: {500: 2n ** 97n}}), {}, {maxPriceImpactBps: 500});
    expect(thin.heard).toEqual([["uniswap: loses 75.0% of the value to price impact — its pools are too thin for this amount (limit 5%; best route direct 0.05%)", {reason: "insufficient_liquidity"}]]);
  });

  it("the best route can be mined: the same quote and the same requests whether a lower route can or not", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    const runs = [];
    for (const lowGas of [90_000n, 40_000_000n]) {
      const n = node(M, {"direct 500": {out: 1_000_000n, gas: 90_000n}, "direct 3000": {out: 990_000n, gas: lowGas}});
      runs.push({...(await quote(1, n)), bodies: n.bodies});
    }
    expect(runs[0]!.heard).toEqual([]);
    expect(runs[0]!.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "255000"}, providerData: {route: "direct 0.05%"}});
    expect(runs[1]).toEqual(runs[0]);
  });

  it("maxPriceImpactBps is measured on the route returned: its pool lookups, slot0 and probe, its fee-aware text", async () => {
    // The best pool (0.05%) cannot be mined; its mid of 4 would read a 75% loss. The 0.3% pool pays exactly its fee.
    const table = {"direct 500": {out: 1_000_000n, gas: 16_700_000n}, "direct 3000": {out: 997_000n, gas: 90_000n}};
    const o = {slot0: {500: 2n ** 97n}};
    const n = node(M, table, o);
    const pass = await quote(1, n, {}, {maxPriceImpactBps: 31});
    expect(pass.heard).toEqual([]);
    expect(pass.q).toMatchObject({destAmount: "997000", providerData: {route: "direct 0.3%", priceImpactBps: "0", valueLossBps: "30"}});
    const sel = (c: Body) => ((c.params?.[0] as {data?: string; to?: string} | undefined)?.data ?? "").slice(0, 10);
    const to = (c: Body) => (c.params?.[0] as {to?: string}).to;
    expect(n.calls().filter((c) => sel(c) === "0x1698ee82").map((c) => parseInt(((c.params[0] as {data: string}).data).slice(-6), 16))).toEqual([3000]);
    expect(n.calls().filter((c) => sel(c) === "0x3850c7bd").map(to)).toEqual([poolOf(3000)]);
    expect(n.quotedAt(1_000n)).toEqual(["direct 3000"]);
    // At its fee: refused with the fee-aware text naming the route returned.
    const fees = await quote(1, node(M, table, o), {}, {maxPriceImpactBps: 30});
    expect(fees.q).toBeNull();
    expect(fees.heard).toEqual([["uniswap: loses 0.3% of the value to price impact and pool fees — the route's fees (0.3%) bring it to the limit; its price impact alone is under it (limit 0.3%; best route direct 0.3%)", {reason: "insufficient_liquidity"}]]);
    // Its own pool too thin (a mid of 4: 997,000 out against 4,000,000): refused for its own loss.
    const thin = await quote(1, node(M, table, {slot0: {500: MID_SQRT_PRICE, 3000: 2n ** 97n}}), {}, {maxPriceImpactBps: 500});
    expect(thin.heard).toEqual([["uniswap: loses 75.1% of the value to price impact — its pools are too thin for this amount (limit 5%; best route direct 0.3%)", {reason: "insufficient_liquidity"}]]);
  });

  it("Arbitrum One and Robinhood Chain: an execution need over Nitro's 32M ranks the route out; the next keeps its padded limit above 32M", async () => {
    for (const chainId of [42161, 4663]) {
      const n = node(M, {"direct 500": {out: 1_000_000n, gas: 40_000_000n}, "direct 3000": {out: 990_000n, gas: 22_000_000n}}, {blockGasLimit: 1n << 50n});
      const {q, heard} = await quote(chainId, n);
      expect([chainId, heard]).toEqual([chainId, []]); // 039db9fe: NEEDS(42_126_000n, chainId, 32_000_000n)
      expect(q).toMatchObject({destAmount: "990000", txRequest: {gasLimit: "33120000"}, providerData: {route: "direct 0.3%"}});
    }
  });

  it("the review's Arbitrum shape, 2000 ETH → ARB: direct 0.05% at 48M is ranked out, via USDC 0.05% → 0.3% is quoted", async () => {
    const usdc = getAddress(ccAsset("eip155:42161", "USDC")!.contract!);
    const ARB = "0x912CE59144191C1204E64559FE8253a0e49E6548";
    const E = 10n ** 18n;
    const full = 2_000n * E;
    const n = node(full, {
      "direct 500": {out: 6_951_284n * E, gas: 48_000_000n},
      [`${usdc} 500/3000`]: {out: 1_180_277n * E, gas: 21_500_000n},
      [`${usdc} 3000/3000`]: {out: 1_162_590n * E, gas: 14_200_000n},
    }, {blockGasLimit: 1n << 50n});
    const {q, heard} = await quote(42161, n, {sourceToken: "ETH", sourceDecimals: undefined, destToken: ARB, amountIn: full.toString()});
    expect(heard).toEqual([]); // 039db9fe: NEEDS(50_526_000n, 42161, 32_000_000n) — no quote
    expect(q).toMatchObject({destAmount: (1_180_277n * E).toString(), txRequest: {gasLimit: "32370000", value: full.toString()}, providerData: {route: "via USDC 0.05% → 0.3%", poolFee: "0.05% + 0.3%"}});
    expect(n.quotedAt(full / 1000n)).toEqual([`${usdc} 500/3000`]);
  });

  it("the pool count is each candidate's own: a two-pool route under 2 × MIN_POOL_GAS has no gas figure and stays a candidate", async () => {
    const weth = getAddress(D.weth);
    // 30k measures one pool, not two: no limit is derived (the wallet estimates it), as for any route without a figure.
    const noFigure = await quote(1, node(M, {"direct 500": {out: 1_000_000n, gas: 16_700_000n}, [`${weth} 500/500`]: {out: 950_000n, gas: 30_000n}}));
    expect(noFigure.heard).toEqual([]);
    expect(noFigure.q).toMatchObject({destAmount: "950000", providerData: {route: "via WETH 0.05% → 0.05%"}});
    expect(noFigure.q!.txRequest!.gasLimit).toBeUndefined();
    // With a figure, the two-pool route is bounded as any other: 180k → 390,000; one over the bound is ranked out too.
    const table = {
      "direct 500": {out: 1_000_000n, gas: 16_700_000n},
      [`${weth} 500/500`]: {out: 950_000n, gas: 16_650_000n},
      [`${weth} 3000/3000`]: {out: 900_000n, gas: 180_000n},
    };
    const n = node(M, table);
    const two = await quote(1, n);
    expect(two.heard).toEqual([]);
    expect(two.q).toMatchObject({destAmount: "900000", txRequest: {gasLimit: "390000"}, providerData: {route: "via WETH 0.3% → 0.3%"}});
    expect(n.quotedAt(1_000n)).toEqual([`${weth} 3000/3000`]);
  });

  it("a direct route without a gas figure after an unminable best stays a candidate: quoted without a limit", async () => {
    const {q, heard} = await quote(1, node(M, {"direct 500": {out: 1_000_000n, gas: 16_700_000n}, "direct 3000": {out: 990_000n, gas: 0n}}));
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "990000", providerData: {route: "direct 0.3%"}});
    expect(q!.txRequest!.gasLimit).toBeUndefined();
  });

  it("the unwrap's 40k and refundETH's 10k count in each candidate's need", async () => {
    const table = (gas: bigint) => ({"direct 500": {out: 1_000_000n, gas}, "direct 3000": {out: 990_000n, gas: 90_000n}});
    // Native out: the best fits 2^24 without the unwrap, not with it — ranked out, the next one quoted (+40k).
    const unwrap = fitsP24(40_000n) + 1n;
    const out = await quote(1, node(M, table(unwrap)), {destToken: NATIVE});
    expect(out.heard).toEqual([]); // 039db9fe: "the swap needs 16777217 gas …"
    expect(out.q).toMatchObject({destAmount: "990000", txRequest: {gasLimit: "295000"}, providerData: {route: "direct 0.3%"}});
    const erc20 = await quote(1, node(M, table(unwrap)));
    expect(erc20.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: P24.toString()}, providerData: {route: "direct 0.05%"}});
    // Native in with refundNativeInput: the same with refundETH's 10k.
    const refund = fitsP24(10_000n) + 1n;
    const eth = {sourceToken: "ETH", sourceDecimals: undefined, destToken: USDC, amountIn: "1000000000000000"};
    const withRefund = await quote(1, node(10n ** 15n, table(refund)), eth, {refundNativeInput: true});
    expect(withRefund.heard).toEqual([]);
    expect(withRefund.q).toMatchObject({destAmount: "990000", txRequest: {gasLimit: "265000"}, providerData: {route: "direct 0.3%"}});
    const without = await quote(1, node(10n ** 15n, table(refund)), eth);
    expect(without.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: P24.toString()}, providerData: {route: "direct 0.05%"}});
  });

  it("rpcCallsPerSecond: the same ranking under the rate limiter, within the quote's turns", async () => {
    const n = node(M, {"direct 500": {out: 1_000_000n, gas: 16_700_000n}, "direct 3000": {out: 990_000n, gas: 90_000n}});
    const {q, heard} = await quote(1, n, {}, {rpcCallsPerSecond: 13});
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "990000", txRequest: {gasLimit: "255000"}, providerData: {route: "direct 0.3%"}});
  });

  it("a best route without a gas figure waits for no block read (as before), even one that hangs", async () => {
    const inner = node(M, {"direct 500": {out: 1_000_000n, gas: 0n}, "direct 3000": {out: 990_000n, gas: 90_000n}});
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(init?.body).includes("eth_getBlockByNumber")) return new Promise<Response>(() => {}); // never answers
      return inner.fetch(url, init);
    }) as typeof fetch);
    const t0 = Date.now();
    const q = await uniswapProvider({rpcUrls: {1: ["https://rpc.test"]}}).getQuote(on(1));
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(q).toMatchObject({destAmount: "1000000", providerData: {route: "direct 0.05%"}});
    expect(q!.txRequest!.gasLimit).toBeUndefined();
  });
});

// The offline repro: Monad at block 125,409,523 (fixtures/rpc/monad-125409523.json), 100 MON → AUSD. The best v3 route
// (via USDC 0.3% → 0.01%, 871,160 raw AUSD) is given 40M of quoter gas, over Monad's 30M per-transaction cap; the rest
// of the recording answers as recorded (via USDC 0.05% → 0.01% pays 582,877 at 593,513 gas; direct 0.01% 477,907).
describe("Monad recording, 100 MON → AUSD, the best route's gas raised over 30M", () => {
  interface Fixture {calls: Record<string, {result?: unknown; error?: unknown}>}
  const fx = JSON.parse(readFileSync(new URL("../fixtures/rpc/monad-125409523.json", import.meta.url), "utf8")) as Fixture;
  const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
  const MON100 = (100n * 10n ** 18n).toString();
  const quoter = "0x661e93cca42afacb172121ef892830ca3b70f08d";
  const SINGLE = toFunctionSelector(QUOTER[0]);
  const PATH = toFunctionSelector(QUOTER[1]);

  /** Serves the recording; `raise` replaces the quoter gas of the best route (871,160 out), or of every route (`all`). */
  function replay(raise: bigint | undefined, all = false) {
    const misses: string[] = [];
    const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Body[];
      return new Response(JSON.stringify(batch.map((req) => {
        let key = req.method;
        if (req.method === "eth_call") {
          const [{to, data}] = req.params as [{to: string; data: string}];
          key = `eth_call ${to.toLowerCase()} ${data.toLowerCase()}`;
        }
        const answer = fx.calls[key];
        if (!answer) {
          misses.push(key);
          return {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
        }
        const data = key.split(" ")[2] ?? "";
        const single = data.startsWith(SINGLE);
        if (raise !== undefined && key.startsWith(`eth_call ${quoter} `) && (single || data.startsWith(PATH)) && typeof answer.result === "string" && answer.result !== "0x") {
          const [out, after, ticks] = decodeFunctionResult({abi: QUOTER, functionName: single ? "quoteExactInputSingle" : "quoteExactInput", data: answer.result as Hex}) as unknown as [bigint, bigint | readonly bigint[], number | readonly number[], bigint];
          if (all || out === 871_160n) {
            const result = single
              ? encodeAbiParameters([{type: "uint256"}, {type: "uint160"}, {type: "uint32"}, {type: "uint256"}], [out, after as bigint, ticks as number, raise])
              : encodeAbiParameters([{type: "uint256"}, {type: "uint160[]"}, {type: "uint32[]"}, {type: "uint256"}], [out, after as readonly bigint[], ticks as readonly number[], raise]);
            return {jsonrpc: "2.0", id: req.id, result};
          }
        }
        return {jsonrpc: "2.0", id: req.id, ...answer};
      })));
    }) as typeof fetch;
    return {fetch: f, misses};
  }

  async function quote100(raise: bigint | undefined, all = false) {
    const r = replay(raise, all);
    vi.stubGlobal("fetch", r.fetch);
    const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
    const q = await uniswapProvider({rpcUrls: {143: ["https://monad.fixture"]}}).getQuote({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: AUSD, amountIn: MON100, destAddress: ME, refundAddress: ME, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
    return {q, heard, misses: r.misses};
  }

  it("as recorded: 0.871160 AUSD via USDC 0.3% → 0.01% (unchanged)", async () => {
    const {q, heard, misses} = await quote100(undefined);
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "871160", txRequest: {gasLimit: "1059868"}, providerData: {route: "via USDC 0.3% → 0.01%", priceImpactBps: "2016"}});
  });

  it("raised to 40M: via USDC 0.05% → 0.01% is quoted (582,877 at 593,513 gas), not a refusal", async () => {
    const {q, heard, misses} = await quote100(40_000_000n);
    expect(heard).toEqual([]); // 039db9fe: NEEDS(42_126_000n, 143, 30_000_000n)
    expect(q).toMatchObject({destAmount: "582877", txRequest: {gasLimit: "1010269", value: MON100}, providerData: {route: "via USDC 0.05% → 0.01%"}});
    // The only call outside the recording is the probe on the route returned (1/1000 of the input): never recorded, so
    // it goes unanswered and the quote stands without priceImpactBps (information only).
    expect(misses).toHaveLength(1);
    const data = misses[0]!.split(" ")[2] as Hex;
    const probe = decodeFunctionData({abi: QUOTER, data});
    expect(probe.functionName).toBe("quoteExactInput");
    expect(probe.args[1]).toBe(10n ** 17n);
    expect((probe.args[0] as string).slice(2 + 40, 2 + 46)).toBe("0001f4"); // 0.05% first: the returned route's path
    expect(q!.providerData!.priceImpactBps).toBeUndefined();
  });

  it("every route raised to 40M: refused as before, with the need of the best by output; a need under 30M: quoted as before", async () => {
    const all = await quote100(40_000_000n, true);
    expect(all.q).toBeNull();
    expect(all.misses).toEqual([]); // the same reads as before: the best route's probe is in the recording
    expect(all.heard).toEqual([[NEEDS(42_126_000n, 143, 30_000_000n), {reason: "insufficient_liquidity"}]]);
    const fits = await quote100(28_400_000n); // need 29,946,000 under the 30M cap: the best, its limit clamped to the cap
    expect(fits.heard).toEqual([]);
    expect(fits.misses).toEqual([]);
    expect(fits.q).toMatchObject({destAmount: "871160", txRequest: {gasLimit: "30000000"}, providerData: {route: "via USDC 0.3% → 0.01%", priceImpactBps: "2016"}});
  });
});
