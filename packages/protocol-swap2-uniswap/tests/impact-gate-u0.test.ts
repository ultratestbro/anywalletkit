// U0 (0.4.12), UNISWAP-V4-RESEARCH §5.2 / §7.2 / gaps/impact-gate §4: `maxPriceImpactBps`, opt-in. Ranked first, then
// only the best route is gated; every read at one block; G = max(retried 1/1000 probe, spot value loss against the
// pools' slot0 mids, fees included); an unmeasured probe falls back to spot; nothing measurable is a refusal.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, parseAbi, type Hex} from "viem";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {BLOCK, D, ME, MID_SQRT_PRICE, RPC, USDT, poolOf, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160[], uint32[], uint256)",
]);
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"};
/** A mid price of 4 (token1 per token0): the pool's own rate is 1, so the trade loses 75% of its value against the mid. */
const MID_4 = 2n ** 97n;

type Req = {jsonrpc: string; id: number; method: string; params: unknown[]};
type Rule = (req: Req, seen: number) => object | {http: number} | undefined;

/** The quoted input of a quoter call, else undefined. */
function quotedIn(req: Req): bigint | undefined {
  const p = req.params?.[0] as {data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data) return undefined;
  try {
    const c = decodeFunctionData({abi: QUOTER, data: p.data});
    return c.functionName === "quoteExactInputSingle" ? (c.args[0] as {amountIn: bigint}).amountIn : (c.args[1] as bigint);
  } catch {
    return undefined;
  }
}
const sel = (req: Req) => ((req.params?.[0] as {data?: string} | undefined)?.data ?? "").slice(0, 10);
const isProbe = (req: Req) => quotedIn(req) === 1000n;
const isGetPool = (req: Req) => sel(req) === "0x1698ee82";
const isSlot0 = (req: Req) => sel(req) === "0x3850c7bd";

/**
 * The fixtures' stub, with items answered by `rule` instead (an item, or a whole-batch HTTP status). `seen` counts the
 * times this exact call was asked before; every batch and every eth_call's block tag is logged.
 */
function stub(o: StubOptions = {}, rule: Rule = () => undefined) {
  const inner = rpcStub(o);
  const counts = new Map<string, number>();
  const batches: Req[][] = [];
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Req[];
    batches.push(batch);
    const answers = batch.map((req) => {
      const key = JSON.stringify([req.method, req.params?.[0]]);
      const seen = counts.get(key) ?? 0;
      counts.set(key, seen + 1);
      return rule(req, seen);
    });
    const http = answers.find((a): a is {http: number} => !!a && "http" in a);
    if (http) return new Response("{}", {status: http.http});
    const res = (await (await inner(url, init)).json()) as {id: number}[];
    return new Response(JSON.stringify(res.map((r, i) => (answers[i] ? {jsonrpc: "2.0", id: r.id, ...answers[i]} : r))));
  }) as typeof fetch;
  const calls = () => batches.flat();
  return {fetch: f, batches, calls, tags: () => calls().filter((c) => c.method === "eth_call").map((c) => [sel(c), (c.params as [unknown, string])[1]] as const)};
}

async function quote(s: ReturnType<typeof stub>, config: Record<string, unknown> = {}, over: Record<string, unknown> = {}, signal?: AbortSignal) {
  vi.stubGlobal("fetch", s.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, ...config}).getQuote({...base, ...over, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }} as never, signal);
  return {q, heard};
}

const single = (amount: bigint) => ({result: encodeAbiParameters([{type: "uint256"}, {type: "uint160"}, {type: "uint32"}, {type: "uint256"}], [amount, MID_SQRT_PRICE, 1, 90_000n])});
const limited = {error: {code: -32007, message: "50/second request limit reached"}};
const LOSES = (pct: string, limit: string, route = "direct 0.05%") => `uniswap: loses ${pct}% of the value to price impact — its pools are too thin for this amount (limit ${limit}%; best route ${route})`;

describe("maxPriceImpactBps: the option", () => {
  it("must be an integer 1..10000; 1 and 10000 are accepted, unset is the default", () => {
    for (const bad of [0, -1, 1.5, 10_001, Number.NaN, Number.POSITIVE_INFINITY, "500", null]) {
      expect(() => uniswapProvider({rpcUrls: RPC, maxPriceImpactBps: bad as never})).toThrow("uniswap: maxPriceImpactBps must be an integer 1..10000");
      expect(refusalOf((() => { try { uniswapProvider({rpcUrls: RPC, maxPriceImpactBps: bad as never}); } catch (e) { return e; } })())).toBeUndefined();
    }
    for (const ok of [1, 500, 10_000]) expect(() => uniswapProvider({rpcUrls: RPC, maxPriceImpactBps: ok})).not.toThrow();
    expect(() => uniswapProvider({rpcUrls: RPC})).not.toThrow();
    expect(() => new UniswapSwap2Protocol(undefined, {fromChain: "eip155:1", rpcUrls: RPC, maxPriceImpactBps: 0})).toThrow(/maxPriceImpactBps/);
  });
});

describe("maxPriceImpactBps set: refused at or above the limit, the best route only", () => {
  it("the Monad-class quote (impact 9982) is refused with the exact text, as insufficient_liquidity", async () => {
    const {q, heard} = await quote(stub({impactBps: 9982}), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard).toEqual([[LOSES("99.8", "5"), {reason: "insufficient_liquidity"}]]);
  });

  it("boundaries: 500 at 500 refused, 499 at 500 returned, 9999 at 10000 returned", async () => {
    const at = await quote(stub({impactBps: 500}), {maxPriceImpactBps: 500});
    expect(at.q).toBeNull();
    expect(at.heard).toEqual([[LOSES("5.0", "5"), {reason: "insufficient_liquidity"}]]);
    const under = await quote(stub({impactBps: 499}), {maxPriceImpactBps: 500});
    expect(under.q).toMatchObject({destAmount: "950100", providerData: {priceImpactBps: "499", valueLossBps: "498"}});
    const top = await quote(stub({impactBps: 9999}), {maxPriceImpactBps: 10_000});
    expect(top.q).toMatchObject({providerData: {priceImpactBps: "9999"}});
    const quarter = await quote(stub({impactBps: 260}), {maxPriceImpactBps: 250});
    expect(quarter.heard).toEqual([[LOSES("2.6", "2.5"), {reason: "insufficient_liquidity"}]]);
  });

  it("a passing quote keeps priceImpactBps (the probe, fees excluded) and adds valueLossBps (spot, fees included)", async () => {
    const {q} = await quote(stub({impactBps: 4300}), {maxPriceImpactBps: 5000});
    expect(q).toMatchObject({destAmount: "570000", providerData: {priceImpactBps: "4300", valueLossBps: "4299"}});
  });

  it("G is the larger measure: spot catches a loss the probe does not see (a pool parked past an empty range)", async () => {
    // The probe sees the pool's own rate (1) at both sizes: impact 0. The pool's mid is 4: the trade loses 75%.
    const {q, heard} = await quote(stub({byFee: {500: 1_000_000n}, slot0: {500: MID_4}}), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard).toEqual([[LOSES("75.0", "5"), {reason: "insufficient_liquidity"}]]);
    // Unset, the same quote is returned (0.4.11: impact 0, information only).
    const unset = await quote(stub({byFee: {500: 1_000_000n}, slot0: {500: MID_4}}));
    expect(unset.q).toMatchObject({providerData: {priceImpactBps: "0"}});
    expect(unset.q!.providerData!.valueLossBps).toBeUndefined();
  });

  it("rank first, then gate: a lower-output candidate that would pass is never offered instead", async () => {
    // 0.05% pays 1,000,000 but loses 75% against its mid; 0.3% pays 990,000 at its mid (1).
    const {q, heard} = await quote(stub({slot0: {500: MID_4}}), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard[0]![0]).toBe(LOSES("75.0", "5"));
  });

  it("two-pool routes: the probe on the whole path, spot as the product of both pools' mids", async () => {
    const s = stub({byFee: {}, multiHop: 1_000_000n, slot0: {100: MID_4}});
    const {q, heard} = await quote(s, {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    // Both hops' mids are 4: the path's mid rate is 16, so 1:1 loses 93.75% (rounded down to 9374 bps).
    expect(heard[0]![0]).toBe(LOSES("93.7", "5", "via WETH 0.01% → 0.01%"));
    const pools = s.calls().filter(isGetPool).map((c) => (c.params[0] as {data: string}).data);
    expect(pools).toHaveLength(2);
    const flat = await quote(stub({byFee: {}, multiHop: 1_000_000n}), {maxPriceImpactBps: 500});
    expect(flat.q).toMatchObject({providerData: {priceImpactBps: "0", valueLossBps: "0"}});
  });

  it("every read of the quote is at one block (eth_blockNumber once); the deployment check stays at latest", async () => {
    const s = stub();
    const p = uniswapProvider({rpcUrls: RPC, maxPriceImpactBps: 500});
    vi.stubGlobal("fetch", s.fetch);
    expect(await p.getQuote(base)).not.toBeNull();
    expect(await p.getQuote(base)).not.toBeNull();
    expect(s.calls().filter((c) => c.method === "eth_blockNumber")).toHaveLength(2);
    const tags = s.tags();
    expect(tags.filter(([x]) => x === "0xc45a0155" || x === "0x4aa4a4fc").every(([, t]) => t === "latest")).toBe(true);
    const reads = tags.filter(([x]) => x !== "0xc45a0155" && x !== "0x4aa4a4fc");
    expect(new Set(reads.map(([x]) => x))).toEqual(new Set(["0xc6a5026a", "0xcdca1753", "0x1698ee82", "0x3850c7bd"]));
    expect(reads.every(([, t]) => t === BLOCK)).toBe(true);
  });

  it("preflightDeposit does not apply it: one re-quote at latest, the signed minimum governs", async () => {
    const s = stub();
    vi.stubGlobal("fetch", s.fetch);
    const p = uniswapProvider({rpcUrls: RPC, maxPriceImpactBps: 500});
    const q = (await p.getQuote(base))!;
    const before = s.batches.length;
    vi.stubGlobal("fetch", stub({impactBps: 40}).fetch); // a little worse, still above the minimum
    await expect(p.preflightDeposit!(q, await p.buildDeposit(q))).resolves.toBeUndefined();
    vi.stubGlobal("fetch", s.fetch);
    await p.preflightDeposit!(q, await p.buildDeposit(q));
    const pre = s.batches.slice(before).flat();
    expect(pre).toHaveLength(1);
    expect((pre[0]!.params as [unknown, string])[1]).toBe("latest");
  });
});

describe("maxPriceImpactBps set: an unmeasured probe falls back to spot (P1–P9)", () => {
  // Each probe failure, first with a fair pool (spot ~0: the quote passes, unmeasured by the probe) and then with a
  // pool whose mid says 75% is lost (spot refuses). The option unset returns the quote in every case (unset test).
  const cases: Array<[string, Record<string, unknown>, Rule]> = [
    ["P1 amount under 1000 units (no probe)", {amountIn: "999"}, () => undefined],
    ["P2a the probe reverts", {}, (r) => (isProbe(r) ? {error: {code: 3, message: "execution reverted: AS", data: "0x08c379a0"}} : undefined)],
    ["P2b a per-item RPC error on every attempt", {}, (r) => (isProbe(r) ? limited : undefined)],
    ["P4 an empty answer", {}, (r) => (isProbe(r) ? {result: "0x"} : undefined)],
    ["P5 a zero output", {}, (r) => (isProbe(r) ? single(0n) : undefined)],
    ["P6 an answer that does not decode", {}, (r) => (isProbe(r) ? {result: "0x1234"} : undefined)],
  ];
  for (const [what, over, rule] of cases) {
    it(`${what}: spot decides`, async () => {
      const fair = await quote(stub({}, rule), {maxPriceImpactBps: 500}, over);
      expect(fair.heard).toEqual([]);
      expect(fair.q!.providerData!.priceImpactBps).toBeUndefined();
      expect(fair.q!.providerData!.valueLossBps).toBe("0");
      const lossy = await quote(stub({slot0: {500: MID_4}}, rule), {maxPriceImpactBps: 500}, over);
      expect(lossy.q).toBeNull();
      expect(lossy.heard[0]![1]).toEqual({reason: "insufficient_liquidity"});
      expect(lossy.heard[0]![0]).toMatch(/^uniswap: loses 7[45]\.\d% of the value to price impact/);
    });
  }

  it("P3 HTTP 429 on every attempt: the pool lookups ride in the same batch, so nothing is measurable — refused", async () => {
    const s = stub({}, (r) => (isProbe(r) ? {http: 429} : undefined));
    const {q, heard} = await quote(s, {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again", {reason: "rate_limited", httpStatus: 429}]]);
    expect(s.calls().filter(isProbe)).toHaveLength(3); // asked, then retried twice
    // Answered on a retry, it is measured.
    const again = stub({impactBps: 600}, (r, seen) => (isProbe(r) && seen === 0 ? {http: 429} : undefined));
    expect((await quote(again, {maxPriceImpactBps: 500})).heard[0]![0]).toBe(LOSES("6.0", "5"));
  });

  it("P2b retried: a transient per-item error on the probe is asked again and measured", async () => {
    const s = stub({impactBps: 600}, (r, seen) => (isProbe(r) && seen === 0 ? limited : undefined));
    const {q, heard} = await quote(s, {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard[0]![0]).toBe(LOSES("6.0", "5"));
    expect(s.calls().filter(isProbe)).toHaveLength(2);
  });

  it("P7 a batch refused with a JSON-RPC error, then answered: retried", async () => {
    let refused = 0;
    const inner = stub({impactBps: 600});
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as Req[];
      if (batch.some(isProbe) && refused++ === 0) return new Response(JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32007, message: "50/second request limit reached"}}));
      return inner.fetch(url, init);
    }) as typeof fetch;
    const {q, heard} = await quote({...inner, fetch: f}, {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard[0]![0]).toBe(LOSES("6.0", "5"));
  });

  it("P8 the caller aborts during the gate: no quote, the abort unclassified", async () => {
    const ctrl = new AbortController();
    const s = stub({}, (r) => {
      if (isProbe(r)) ctrl.abort();
      return undefined;
    });
    const inner = s.fetch;
    const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const res = await inner(url, init);
      if (init?.signal?.aborted) throw new DOMException("This operation was aborted", "AbortError");
      return res;
    }) as typeof fetch;
    const {q, heard} = await quote({...s, fetch: f}, {maxPriceImpactBps: 500}, {}, ctrl.signal);
    expect(q).toBeNull();
    expect(heard).toHaveLength(1);
    expect(heard[0]![1]).toBeUndefined();
  });

  it("P9 a probe rate under the full rate: measured as 0, spot still counts", async () => {
    const fair = await quote(stub({}, (r) => (isProbe(r) ? single(900n) : undefined)), {maxPriceImpactBps: 500});
    expect(fair.q).toMatchObject({providerData: {priceImpactBps: "0", valueLossBps: "0"}});
    const lossy = await quote(stub({slot0: {500: MID_4}}, (r) => (isProbe(r) ? single(900n) : undefined)), {maxPriceImpactBps: 500});
    expect(lossy.heard[0]![0]).toBe(LOSES("75.0", "5"));
  });
});

describe("maxPriceImpactBps set: nothing measurable is a refusal (fail closed)", () => {
  const COULD_NOT = "uniswap: could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again";

  it("too small to probe and the pool lookups rate-limited → rate_limited", async () => {
    const {q, heard} = await quote(stub({}, (r) => (isGetPool(r) ? limited : undefined)), {maxPriceImpactBps: 500}, {amountIn: "999"});
    expect(q).toBeNull();
    expect(heard).toEqual([[COULD_NOT, {reason: "rate_limited"}]]);
  });

  it("probe and mid prices both unanswered → the RPC's reason (rate_limited / upstream_unavailable)", async () => {
    const both = await quote(stub({}, (r) => (isProbe(r) || isSlot0(r) ? limited : undefined)), {maxPriceImpactBps: 500});
    expect(both.heard).toEqual([[COULD_NOT, {reason: "rate_limited"}]]);
    const down = await quote(stub({}, (r) => (isProbe(r) || isGetPool(r) ? {error: {code: -32000, message: "header not found"}} : undefined)), {maxPriceImpactBps: 500});
    expect(down.heard).toEqual([[COULD_NOT, {reason: "upstream_unavailable"}]]);
    const http = await quote(stub({}, (r) => (isProbe(r) || isSlot0(r) ? {http: 503} : undefined)), {maxPriceImpactBps: 500});
    expect(http.heard).toEqual([[COULD_NOT, {reason: "upstream_unavailable", httpStatus: 503}]]);
  });

  it("the probe reverts and no pool has a mid price → insufficient_liquidity", async () => {
    const rule: Rule = (r) => (isProbe(r) ? {error: {code: 3, message: "execution reverted"}} : isGetPool(r) ? {result: `0x${"0".repeat(64)}`} : undefined);
    const {q, heard} = await quote(stub({}, rule), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: the route would not quote a smaller amount; its price impact cannot be measured", {reason: "insufficient_liquidity"}]]);
  });

  it("the probe measured, the mid prices unanswered: the probe decides (G = c)", async () => {
    const pass = await quote(stub({impactBps: 100}, (r) => (isSlot0(r) ? limited : undefined)), {maxPriceImpactBps: 500});
    expect(pass.q).toMatchObject({providerData: {priceImpactBps: "100"}});
    expect(pass.q!.providerData!.valueLossBps).toBeUndefined();
    const refused = await quote(stub({impactBps: 700}, (r) => (isSlot0(r) ? limited : undefined)), {maxPriceImpactBps: 500});
    expect(refused.heard[0]![0]).toBe(LOSES("7.0", "5"));
  });

  it("the latest block cannot be read → refused, classified", async () => {
    const {q, heard} = await quote(stub({}, (r) => (r.method === "eth_blockNumber" ? {http: 429} : undefined)), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: no RPC answered on chain 1 (HTTP 429)", {reason: "rate_limited", httpStatus: 429}]]);
    const odd = await quote(stub({}, (r) => (r.method === "eth_blockNumber" ? {result: "latest"} : undefined)), {maxPriceImpactBps: 500});
    expect(odd.heard).toEqual([["uniswap: the RPC on chain 1 did not name its latest block", {reason: "upstream_unavailable"}]]);
  });

  it("the getPool answers name each hop's pool (factory, tokens in swap order, fee)", async () => {
    const s = stub();
    await quote(s, {maxPriceImpactBps: 500});
    const lookups = s.calls().filter(isGetPool);
    expect(lookups).toHaveLength(1);
    expect((lookups[0]!.params[0] as {to: string}).to).toBe(D.factory);
    const slot0s = s.calls().filter(isSlot0).map((c) => (c.params[0] as {to: string}).to);
    expect(slot0s.map((a) => a.toLowerCase())).toEqual([poolOf(500)]);
  });
});
