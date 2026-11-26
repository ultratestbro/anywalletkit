// U0 (0.4.12) pre-release review, 2026-11-26: the refusal text that blamed thin pools for a fee (U0C-2, U0-LIVE-2), a
// null block number taken for an answer (U0C-5), endpoint keys in transport errors of URLs without a scheme
// (U0-SEC-R3-1), candidate answers no quoter gives read as "no pool" (U0-SEC-R3-2), and the block gas bound before the
// block read is in or after it expires (U0-SEC-R3-3, U0-LIVE-5).
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {impactRefusalText, spotImpactNetOfFeesBps, spotValueLossBps, type Hop} from "../src/impact.js";
import {D, ME, RPC, USDC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const QUOTER = parseAbi(["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)"]);
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"};
type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};

/** The fee of a full-size single-pool quote, else undefined. */
function mainFee(req: Req): number | undefined {
  const p = req.params?.[0] as {data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data?.startsWith("0xc6a5026a")) return undefined;
  const a = decodeFunctionData({abi: QUOTER, data: p.data}).args[0] as {amountIn: bigint; fee: number};
  return a.amountIn === 1_000_000n ? a.fee : undefined;
}

/** The fixtures' stub with items replaced by `rule(req, seen)` (`seen`: times this exact call was asked before). */
function stub(o: StubOptions, rule: (req: Req, seen: number) => object | undefined = () => undefined) {
  const inner = rpcStub(o);
  const counts = new Map<string, number>();
  const calls: Req[] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Req[];
    calls.push(...batch);
    const res = (await (await inner(url, init)).json()) as {id: number}[];
    return new Response(JSON.stringify(res.map((r, i) => {
      const req = batch[i]!;
      const key = JSON.stringify([req.method, req.params]);
      const seen = counts.get(key) ?? 0;
      counts.set(key, seen + 1);
      const a = rule(req, seen);
      return a === undefined ? r : {jsonrpc: "2.0", id: r.id, ...a};
    })));
  }) as typeof fetch;
  return {fetch: f, calls};
}

async function quote(f: typeof fetch, config: Record<string, unknown> = {}, over: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", f);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, ...config}).getQuote({...base, ...over, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never);
  return {q, heard};
}

/** cp0x's refusals.ts reads the loss from the text after the provider prefix with this. */
const CP0X = /^loses ([\d.]+)% of the value to price impact/;

describe("U0C-2 / U0-LIVE-2: a limit the route's own fee reaches is not blamed on thin pools", () => {
  it("the loss net of fees: the gross loss against the mids less what each pool keeps", () => {
    const one: Hop[] = [{tokenIn: USDC, tokenOut: USDT, fee: 3000}];
    const P1 = 2n ** 96n; // price 1
    expect([spotValueLossBps(one, [P1], 1_000_000n, 997_000n), spotImpactNetOfFeesBps(one, [P1], 1_000_000n, 997_000n)]).toEqual([30, 0]);
    expect([spotValueLossBps(one, [P1], 1_000_000n, 900_000n), spotImpactNetOfFeesBps(one, [P1], 1_000_000n, 900_000n)]).toEqual([1000, 972]);
    const two: Hop[] = [{tokenIn: USDC, tokenOut: D.weth, fee: 3000}, {tokenIn: D.weth, tokenOut: USDT, fee: 100}];
    expect([spotValueLossBps(two, [P1, P1], 1_000_000n, 996_900n), spotImpactNetOfFeesBps(two, [P1, P1], 1_000_000n, 996_900n)]).toEqual([31, 0]);
    expect(spotImpactNetOfFeesBps([{tokenIn: USDC, tokenOut: USDT, fee: 1_000_000}], [P1], 1n, 1n)).toBeUndefined();
    expect(impactRefusalText(30, 30, "direct 0.3%", "0.3%")).toBe("loses 0.3% of the value to price impact and pool fees — the route's fees (0.3%) bring it to the limit; its price impact alone is under it (limit 0.3%; best route direct 0.3%)");
    expect(impactRefusalText(9981, 500, "via USDC 0.3% → 0.01%")).toBe("loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)");
  });

  it("a deep 1% pool (no price impact at all) at a 1% limit: refused, the text names the fee", async () => {
    // slot0 at the stub's own rate: the 1% the trade loses is the pool's fee, and the probe sees no impact.
    const {q, heard} = await quote(rpcStub({byFee: {10_000: 990_000n}}), {maxPriceImpactBps: 100});
    expect(q).toBeNull();
    const text = "uniswap: loses 1.0% of the value to price impact and pool fees — the route's fees (1%) bring it to the limit; its price impact alone is under it (limit 1%; best route direct 1%)";
    expect(heard).toEqual([[text, {reason: "insufficient_liquidity"}]]);
    expect(CP0X.exec(text.replace(/^uniswap: /, ""))?.[1]).toBe("1.0"); // cp0x still reads it
    // The gate is unchanged: a limit just above the fee passes, with the loss on the quote.
    const ok = await quote(rpcStub({byFee: {10_000: 990_000n}}), {maxPriceImpactBps: 101});
    expect(ok.q).toMatchObject({providerData: {fee: "10000", valueLossBps: "100", priceImpactBps: "0"}});
  });

  it("a deep 0.3% pool at a 0.3% limit (live: Monad MON → USDC, probe 0): named as the fee", async () => {
    const {heard} = await quote(rpcStub({byFee: {3000: 997_000n}}), {maxPriceImpactBps: 30});
    expect(heard).toEqual([["uniswap: loses 0.3% of the value to price impact and pool fees — the route's fees (0.3%) bring it to the limit; its price impact alone is under it (limit 0.3%; best route direct 0.3%)", {reason: "insufficient_liquidity"}]]);
  });

  it("two pools: thin when the loss net of their fees reaches the limit, the fees when only they tip it over", async () => {
    // 0.01% + 0.01% paying 99.4009%: 59.9 bps lost, 57.9 of it net of the two fees.
    const thin = await quote(rpcStub({byFee: {}, multiHop: 994_009n}), {maxPriceImpactBps: 57});
    expect(thin.heard).toEqual([["uniswap: loses 0.6% of the value to price impact — its pools are too thin for this amount (limit 0.57%; best route via WETH 0.01% → 0.01%)", {reason: "insufficient_liquidity"}]]);
    const fees = await quote(rpcStub({byFee: {}, multiHop: 994_009n}), {maxPriceImpactBps: 59});
    expect(fees.heard).toEqual([["uniswap: loses 0.6% of the value to price impact and pool fees — the route's fees (0.01% + 0.01%) bring it to the limit; its price impact alone is under it (limit 0.59%; best route via WETH 0.01% → 0.01%)", {reason: "insufficient_liquidity"}]]);
  });

  it("thin pools are still named so, whether the probe or the loss net of fees reaches the limit", async () => {
    // Probe: 43% impact on a 0.05% pool.
    const probe = await quote(rpcStub({byFee: {500: 1_000_000n}, impactBps: 4300}), {maxPriceImpactBps: 500});
    expect(probe.heard[0]![0]).toMatch(/^uniswap: loses 43\.0% of the value to price impact — its pools are too thin for this amount \(limit 5%; best route direct 0\.05%\)$/);
    // Spot net of fees: a mid of 4 against a rate of 1 (75% lost, 0.05% of it the fee), with a blind probe.
    const spot = await quote(rpcStub({byFee: {500: 1_000_000n}, slot0: {500: 2n ** 97n}}), {maxPriceImpactBps: 500});
    expect(spot.heard[0]![0]).toBe("uniswap: loses 75.0% of the value to price impact — its pools are too thin for this amount (limit 5%; best route direct 0.05%)");
    for (const [t] of [...probe.heard, ...spot.heard]) expect(t.replace(/^uniswap: /, "")).toMatch(CP0X);
  });
});

describe("U0C-5: a null block number is no answer — retried like every unanswered read of a gated quote", () => {
  it("null once: asked again, and the quote goes on at the block named then", async () => {
    const s = stub({}, (r, seen) => (r.method === "eth_blockNumber" && seen === 0 ? {result: null} : undefined));
    const {q, heard} = await quote(s.fetch, {maxPriceImpactBps: 500});
    expect(heard).toEqual([]);
    expect(q).toMatchObject({providerData: {fee: "500"}});
    expect(s.calls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(2);
  });

  it("null every time: three asks, then upstream_unavailable as an answer with no result", async () => {
    const s = stub({}, (r) => (r.method === "eth_blockNumber" ? {result: null} : undefined));
    const {q, heard} = await quote(s.fetch, {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: no RPC answered on chain 1 (the node answered a call with no result)", {reason: "upstream_unavailable"}]]);
    expect(s.calls.filter((c) => c.method === "eth_blockNumber")).toHaveLength(3);
  });
});

describe("U0-SEC-R3-1: an endpoint's key never reaches the refusal, scheme or not", () => {
  const KEY = "SECRETKEY123";
  for (const url of [`rpc.example.invalid/v2/${KEY}`, `//rpc.example.invalid/v2/${KEY}`, `user:${KEY}@rpc.example.invalid/x`, `RPC.Example.invalid/v2/${KEY}`]) {
    it(`fetch's own error for ${JSON.stringify(url.replace(KEY, "<key>"))}`, async () => {
      // Node's fetch: "Failed to parse URL from <the URL as given>" — core redactUrls only sees text with "://".
      vi.stubGlobal("fetch", (async (u: RequestInfo | URL) => {
        throw new TypeError(`Failed to parse URL from ${String(u)}`);
      }) as typeof fetch);
      const heard: Array<[string, unknown]> = [];
      await uniswapProvider({rpcUrls: {1: [url]}}).getQuote({...base, onRefusal: (t: string, i: unknown) => { heard.push([t, i]); }} as never);
      expect(heard).toEqual([["uniswap: no RPC answered on chain 1 (Failed to parse URL from <url>)", {reason: "upstream_unavailable"}]]);
      expect(JSON.stringify(heard)).not.toContain(KEY);
    });
  }

  it("a node's error text that echoes its own path or host + path is cleaned too, and other text stays", async () => {
    const url = `https://rpc.example.invalid/v2/${KEY}`;
    for (const echo of [`/v2/${KEY}`, `rpc.example.invalid/v2/${KEY}`]) {
      const s = stub({}, (r) => (mainFee(r) === 500 ? {error: {code: -32603, message: `internal error at ${echo} (try later)`}} : undefined));
      vi.stubGlobal("fetch", s.fetch);
      const heard: Array<[string, unknown]> = [];
      await uniswapProvider({rpcUrls: {1: [url]}}).getQuote({...base, onRefusal: (t: string, i: unknown) => { heard.push([t, i]); }} as never);
      expect(heard).toEqual([["uniswap: no RPC answered on chain 1 (-32603 internal error at <url> (try later))", {reason: "upstream_unavailable"}]]);
    }
  });
});

describe("U0-SEC-R3-2: a candidate answer no quoter gives is no answer, never 'no pool'", () => {
  const tiers = {byFee: {500: 1_000_000n, 3000: 990_000n}};
  /** The best pool's full-size quote answered `answer` on the first `times` asks. */
  const bestAnswered = (answer: object, times = Infinity) => stub(tiers, (r, seen) => (mainFee(r) === 500 && seen < times ? answer : undefined));
  const SHAPE = "uniswap: no RPC answered on chain 1 (the node answered a call in a shape the contract never returns)";

  for (const [name, answer] of [["a number", {result: 7}], ["an object", {result: {}}], ["bytes that do not decode", {result: "0x1234"}], ["not hex", {result: "0xzz"}]] as const) {
    it(`${name}: retried, then upstream_unavailable — with or without maxPriceImpactBps; once only: the best pool wins`, async () => {
      for (const config of [{}, {maxPriceImpactBps: 500}]) {
        const s = bestAnswered(answer);
        const {q, heard} = await quote(s.fetch, config);
        expect([config, q]).toEqual([config, null]);
        expect(heard).toEqual([[SHAPE, {reason: "upstream_unavailable"}]]);
        expect(s.calls.filter((c) => mainFee(c) === 500)).toHaveLength(3);
        const once = await quote(bestAnswered(answer, 1).fetch, config);
        expect(once.q).toMatchObject({destAmount: "1000000", providerData: {fee: "500"}});
      }
    });
  }

  it("an empty \"0x\": with maxPriceImpactBps a node fault (retried, then refused); unset, no candidate as 0.4.11 read it", async () => {
    const gated = await quote(bestAnswered({result: "0x"}).fetch, {maxPriceImpactBps: 500});
    expect(gated.q).toBeNull();
    expect(gated.heard).toEqual([[SHAPE, {reason: "upstream_unavailable"}]]);
    expect((await quote(bestAnswered({result: "0x"}, 1).fetch, {maxPriceImpactBps: 500})).q).toMatchObject({providerData: {fee: "500"}});
    // Unset: unchanged from 0.4.11 (every node read live answers a revert with an error, never "0x"; kept for parity).
    const unset = await quote(bestAnswered({result: "0x"}).fetch);
    expect(unset.q).toMatchObject({destAmount: "990000", providerData: {fee: "3000"}});
  });
});

describe("U0-SEC-R3-3 / U0-LIVE-5: the block gas bound before the block read is in, and after it expires", () => {
  const celo = {sourceChain: "eip155:42220", destChain: "eip155:42220"};
  const CELO = {rpcUrls: {42220: ["https://rpc.test"]}, deployments: {42220: {...D}}};
  /** The stub with the block read answered by `block(n)` (its n-th ask, from 0): a delay, or a failure. */
  function celoStub(o: StubOptions, block: (n: number) => {delayMs?: number; fail?: boolean; wait?: Promise<void>}) {
    const inner = rpcStub(o);
    let reads = 0;
    return (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (batch.some((r) => r.method === "eth_getBlockByNumber")) {
        const b = block(reads++);
        if (b.wait) await b.wait;
        if (b.delayMs) await new Promise((r) => setTimeout(r, b.delayMs));
        if (b.fail) return new Response("{}", {status: 503});
      }
      return inner(url, init);
    }) as typeof fetch;
  }

  it("Celo, the block read late (2 s) or failed: the padded limit is still bounded by the known 30M block less its 1M deposit", async () => {
    // Quoter gas 19.4M: need 20.5M, padded 29.22M — in the block's last 1M, where it fits no block (pending, nonces held).
    for (const read of [{delayMs: 2_000}, {fail: true}]) {
      vi.stubGlobal("fetch", celoStub({quoterGas: 19_400_000n, blockGasLimit: 30_000_000n}, () => read));
      const q = await uniswapProvider(CELO).getQuote({...base, ...celo});
      expect([read, q!.txRequest!.gasLimit]).toEqual([read, "29000000"]);
    }
  });

  it("after the 10 minutes, a quote does not wait for the re-read: it goes by the last block read, then by the new one", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    // A 25M block (bound 24M, under the known 29M): the first read answers; the re-read hangs until released.
    let release = () => {};
    const hung = new Promise<void>((r) => (release = r));
    vi.stubGlobal("fetch", celoStub({quoterGas: 19_400_000n, blockGasLimit: 25_000_000n}, (n) => (n === 1 ? {wait: hung} : {})));
    const p = uniswapProvider(CELO);
    expect((await p.getQuote({...base, ...celo}))!.txRequest!.gasLimit).toBe("24000000");
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    const t0 = performance.now();
    expect((await p.getQuote({...base, ...celo}))!.txRequest!.gasLimit).toBe("24000000"); // the last read, at once
    expect(performance.now() - t0).toBeLessThan(1_000); // not the 1.5 s wait for the re-read
    release();
    await new Promise((r) => setTimeout(r, 0));
  });

  it("the last read is dropped an hour after it was read while every re-read fails: the known block then", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(Date.UTC(2026, 10, 26));
    vi.stubGlobal("fetch", celoStub({quoterGas: 19_400_000n, blockGasLimit: 25_000_000n}, (n) => (n === 0 ? {} : {fail: true})));
    const p = uniswapProvider(CELO);
    const at = async (minutes: number) => {
      vi.setSystemTime(Date.UTC(2026, 10, 26) + minutes * 60_000);
      return (await p.getQuote({...base, ...celo}))!.txRequest!.gasLimit;
    };
    expect(await at(0)).toBe("24000000");
    expect(await at(11)).toBe("24000000"); // the re-read failed: the last read stands
    expect(await at(59)).toBe("24000000");
    expect(await at(61)).toBe("29000000"); // over an hour old: the known 30M block less its deposit
  });
});
