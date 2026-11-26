// LIVE-VR-3 review (VR3-RANK-1, VR3-RANK-2, VR3-ID-1, 2026-11-26): the first LIVE-VR-3 fix ranked the candidates with
// the block gas limit read before the probe — waiting up to 1.5 s for a first read there — and the gas step read it
// again after the probe. Two reads of one quote could disagree: a read landing in between refused the picked route
// with "its pools are too thin" while a lower one fit (RANK-1), or ranked out a best route the gas step, and 039db9fe,
// let through (ID-1); and the early wait delayed refusals that need no gas figure and moved the probe later (RANK-2).
//
// Now one set of bounds goes for the whole quote, taken once with the wait the gas step always had. A best by output
// that the chain's caps (or a block read already in) refuse whatever the node says is ranked out before it is
// measured; any other best goes on as in 039db9fe, its bounds taken at its gas step, and gives way there to the next
// route those same bounds let through. A refusal before the gas step stands at once when the best fits the block gas
// limit in hand. Fake timers: every delay below is the node's, to the millisecond.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, parseAbi, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";
import {D, ME, MID_SQRT_PRICE, USDC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const QUOTER = parseAbi(["function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)"]);
const M = 1_000_000n;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 26);
type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};
/** A block read's answer: the gasLimit after `ms`, or a read that never answers. */
type Read = {limit: bigint; ms: number} | "hang";

/** The direct quote a request item is ("direct <fee>" at its input), else undefined. */
function direct(req: Body): {fee: number; amountIn: bigint} | undefined {
  const p = req.params?.[0] as {data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data) return undefined;
  try {
    const c = decodeFunctionData({abi: QUOTER, data: p.data});
    return c.args[0] as {fee: number; amountIn: bigint};
  } catch {
    return undefined;
  }
}

/**
 * A node pricing direct routes from `table` (fee → output at 1 USDC, quoter gas): block reads answer `reads` in turn,
 * a batch carrying the 1/1000 probe answers after `probeMs`, everything else at once. Logs [ms, what] per batch.
 */
function node(table: Record<number, {out: bigint; gas: bigint}>, reads: Read[], probeMs: number, o: StubOptions = {}) {
  const inner = rpcStub({byFee: {}, ...o});
  const log: string[] = [];
  let read = 0;
  const f = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Body[];
    const at = Date.now() - T0;
    if (batch.some((b) => b.method === "eth_getBlockByNumber")) {
      const r = reads[Math.min(read++, reads.length - 1)]!;
      log.push(`${at % MIN} block read`);
      if (r === "hang") return new Promise<Response>(() => {});
      await new Promise((ok) => setTimeout(ok, r.ms));
      return new Response(JSON.stringify(batch.map((b) => ({jsonrpc: "2.0", id: b.id, result: {number: "0x1234", gasLimit: `0x${r.limit.toString(16)}`}}))));
    }
    const probe = batch.map(direct).find((c) => c?.amountIn === M / 1000n);
    if (probe) {
      log.push(`${at % MIN} probe ${probe.fee}`);
      await new Promise((ok) => setTimeout(ok, probeMs));
    }
    const res = (await (await inner(url, init)).json()) as {id: number}[];
    return new Response(JSON.stringify(res.map((r, i) => {
      const c = direct(batch[i]!);
      const leg = c && table[c.fee];
      if (!c || !leg) return r;
      return {jsonrpc: "2.0", id: r.id, result: encodeAbiParameters([{type: "uint256"}, {type: "uint160"}, {type: "uint32"}, {type: "uint256"}], [(leg.out * c.amountIn) / M, MID_SQRT_PRICE, 1, leg.gas])};
    })));
  }) as typeof fetch;
  return {fetch: f, log};
}

/** One provider on `chainId`; each quote begins `at` ms after T0 (11 min apart: the block read is due again). */
async function quotes(chainId: number, n: {fetch: typeof fetch}, at: number[], config: Record<string, unknown> = {}) {
  vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout", "Date"]});
  vi.setSystemTime(T0);
  vi.stubGlobal("fetch", n.fetch);
  const p = uniswapProvider({rpcUrls: {[chainId]: ["https://rpc.test"]}, deployments: {[chainId]: {...D}}, ...config});
  const out = [];
  for (const t of at) {
    vi.setSystemTime(T0 + t);
    const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
    let done = false;
    const job = p.getQuote({sourceChain: `eip155:${chainId}`, destChain: `eip155:${chainId}`, destAddress: ME, refundAddress: ME, sourceToken: USDC, sourceDecimals: 6, destToken: USDT, amountIn: M.toString(), onRefusal: (w: string, i?: Swap2RefusalInfo) => { heard.push([w, i]); }} as never);
    void job.then(() => { done = true; });
    const start = Date.now();
    while (!done) await vi.advanceTimersByTimeAsync(1);
    const q = await job;
    out.push({ms: Date.now() - start, heard, q});
    await vi.advanceTimersByTimeAsync(5_000); // every read lands before the next quote
  }
  return out;
}

/** A quote's time (fake ms): from `want` to a few ticks after it (the stub's own zero-delay answers take a tick each). */
const took = (ms: number, want: number) => expect([ms >= want, ms < want + 10, ms]).toEqual([true, true, ms]);
const NEEDS = (need: bigint, chainId: number, cap: bigint) => `uniswap: the swap needs ${need} gas, more than chain ${chainId} takes in one transaction (${cap}) — its pools are too thin for this amount`;

describe("LIVE-VR-3 review: the route picked and the route bounded go by one block read", () => {
  it("VR3-RANK-1: a re-read that lands during the probe and refuses the best gives way to the next route under it (039db9fe and 0a3fdf25: refused)", async () => {
    // Avalanche (no known cap: the block gas limit is the cap). Read 20M; 11 min later the re-read answers 15M at 200
    // ms, while the best route's probe (400 ms) is out. The best needs 16,926,000.
    const n = node({500: {out: 1_000_000n, gas: 16_000_000n}, 3000: {out: 990_000n, gas: 1_000_000n}}, [{limit: 20_000_000n, ms: 0}, {limit: 15_000_000n, ms: 200}], 400);
    const [first, second] = await quotes(43114, n, [0, 11 * MIN]);
    expect(first!.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "20000000"}, providerData: {route: "direct 0.05%"}});
    expect(second!.heard).toEqual([]); // before: [NEEDS(16_926_000n, 43114, 15_000_000n), insufficient_liquidity]
    expect(second!.q).toMatchObject({destAmount: "990000", txRequest: {gasLimit: "1620000"}, providerData: {route: "direct 0.3%", priceImpactBps: "0"}});
    // One block read a quote; the second quote's gas steps both go by the read that refused the best (no third read).
    expect(n.log).toEqual(["0 block read", "0 probe 500", "0 block read", "0 probe 500", "400 probe 3000"]);
  });

  it("VR3-RANK-2: a refusal that needs no gas figure is not held by a pending first block read (0a3fdf25: 1.5 s)", async () => {
    // Ethereum, maxPriceImpactBps 500: the best fits 2^24 but loses 75% (a mid of 4); the block read never answers.
    const n = node({500: {out: 1_000_000n, gas: 90_000n}, 3000: {out: 990_000n, gas: 90_000n}}, ["hang"], 0, {slot0: {500: 2n ** 97n}});
    const [r] = await quotes(1, n, [0], {maxPriceImpactBps: 500});
    expect(r!.heard).toEqual([["uniswap: loses 75.0% of the value to price impact — its pools are too thin for this amount (limit 5%; best route direct 0.05%)", {reason: "insufficient_liquidity"}]]);
    expect(r!.ms).toBeLessThan(50);
  });

  it("VR3-RANK-2: the probe goes with the quote and the block read is waited for alongside it, as in 039db9fe (0a3fdf25: one after the other)", async () => {
    // Ethereum: the block read answers at 1.4 s, the probe after 1 s. The quote is done when the read is in.
    const n = node({500: {out: 1_000_000n, gas: 90_000n}, 3000: {out: 990_000n, gas: 90_000n}}, [{limit: 60_000_000n, ms: 1_400}], 1_000);
    const [r] = await quotes(1, n, [0]);
    expect(r!.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "255000"}, providerData: {route: "direct 0.05%"}});
    expect(n.log).toEqual(["0 block read", "0 probe 500"]);
    took(r!.ms, 1_400);
  });

  it("VR3-RANK-2: a read landing after the gas step's own 1.5 s wait does not bound the quote, as in 039db9fe (0a3fdf25: bounded by it)", async () => {
    // Avalanche: the read answers 15M at 1.6 s; the best needs 12.726M and its padded limit is 18.12M. The gas step
    // (after the 400 ms probe) waits until 1.5 s, then goes by the known caps alone — the fallback the first read always had.
    const n = node({500: {out: 1_000_000n, gas: 12_000_000n}, 3000: {out: 990_000n, gas: 1_000_000n}}, [{limit: 15_000_000n, ms: 1_600}], 400);
    const [r] = await quotes(43114, n, [0]);
    expect(r!.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "18120000"}, providerData: {route: "direct 0.05%"}});
    took(r!.ms, 1_500);
  });

  it("VR3-ID-1: a pending re-read that lets the best through at the gas step keeps the best (0a3fdf25: ranked out on the older read)", async () => {
    // Avalanche: read 15M; 11 min later the re-read (30M) answers at 2 s, the probe at 2.5 s. The best needs 19,026,000:
    // over the 15M read, under the 30M one its gas step goes by — 039db9fe's quote.
    const n = node({500: {out: 1_000_000n, gas: 18_000_000n}, 3000: {out: 990_000n, gas: 90_000n}}, [{limit: 15_000_000n, ms: 0}, {limit: 30_000_000n, ms: 2_000}], 2_500);
    const [, second] = await quotes(43114, n, [0, 11 * MIN]);
    expect(second!.heard).toEqual([]);
    expect(second!.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "27120000"}, providerData: {route: "direct 0.05%"}});
    took(second!.ms, 2_500);
  });

  it("VR3-ID-1: a first read landing after 1.5 s but before the gas step counts, as in 039db9fe (0a3fdf25: ranked out on Celo's 30M snapshot)", async () => {
    // Celo cold: the read (60M) answers at 1.6 s, the probe at 2 s; the best needs 31,626,000, over the 30M snapshot.
    const n = node({500: {out: 1_000_000n, gas: 30_000_000n}, 3000: {out: 990_000n, gas: 90_000n}}, [{limit: 60_000_000n, ms: 1_600}], 2_000);
    const [r] = await quotes(42220, n, [0]);
    expect(r!.heard).toEqual([]);
    expect(r!.q).toMatchObject({destAmount: "1000000", txRequest: {gasLimit: "45120000"}, providerData: {route: "direct 0.05%"}});
    took(r!.ms, 2_000);
  });

  it("a best route the block read in hand cannot carry is ranked out before it is measured, without waiting", async () => {
    // Avalanche, the 15M read already in (the first quote): the second quote's best (20M) is never probed.
    const n = node({500: {out: 1_000_000n, gas: 20_000_000n}, 3000: {out: 990_000n, gas: 1_000_000n}}, [{limit: 15_000_000n, ms: 0}], 400);
    const [first, second] = await quotes(43114, n, [0, 6_000]);
    expect(first!.q).toMatchObject({destAmount: "990000", txRequest: {gasLimit: "1620000"}, providerData: {route: "direct 0.3%"}});
    expect(second!.q).toEqual({...first!.q, validUntilMs: second!.q!.validUntilMs, txRequest: {...first!.q!.txRequest, data: second!.q!.txRequest!.data}});
    took(second!.ms, 400);
    expect(n.log.filter((l) => parseInt(l, 10) >= 6_000)).toEqual(["6000 probe 3000"]); // the second quote's requests: one probe, no block read
  });

  it("a refusal before the gas step of a best the chain cannot carry gives way to the next route (maxPriceImpactBps)", async () => {
    // Celo cold, maxPriceImpactBps 500. The best (30M quoter gas, need 31,626,000) loses 75%; the read never answers.
    // In hand: Celo's 30M snapshot (29M after the reserve), which refuses it — the bounds are taken (the 1.5 s wait,
    // then the snapshot) and the 0.3% route, which they let through, is measured and quoted.
    const n = node({500: {out: 1_000_000n, gas: 30_000_000n}, 3000: {out: 997_000n, gas: 90_000n}}, ["hang"], 0, {slot0: {500: 2n ** 97n}});
    const [r] = await quotes(42220, n, [0], {maxPriceImpactBps: 500});
    expect(r!.heard).toEqual([]);
    expect(r!.q).toMatchObject({destAmount: "997000", txRequest: {gasLimit: "255000"}, providerData: {route: "direct 0.3%", valueLossBps: "30"}});
    took(r!.ms, 1_500);
    // A best that fits the snapshot is refused for its loss at once, as before.
    const fits = node({500: {out: 1_000_000n, gas: 20_000_000n}, 3000: {out: 997_000n, gas: 90_000n}}, ["hang"], 0, {slot0: {500: 2n ** 97n}});
    const [s] = await quotes(42220, fits, [0], {maxPriceImpactBps: 500});
    expect(s!.heard).toEqual([["uniswap: loses 75.0% of the value to price impact — its pools are too thin for this amount (limit 5%; best route direct 0.05%)", {reason: "insufficient_liquidity"}]]);
    expect(s!.ms).toBeLessThan(50);
  });

  it("a best the caps rank out with no later route under the caps either: refused at once for its loss, as in 039db9fe (b39901dc: held by the block read)", async () => {
    // Monad (30M per transaction), maxPriceImpactBps 500, the block read never answers. The best (40M) loses 75%; the
    // only other route (30M quoter gas, need over 30M) no read can let through, so there is nothing to wait for.
    const n = node({500: {out: 1_000_000n, gas: 40_000_000n}, 3000: {out: 990_000n, gas: 30_000_000n}}, ["hang"], 0, {slot0: {500: 2n ** 97n}});
    const [r] = await quotes(143, n, [0], {maxPriceImpactBps: 500});
    expect(r!.q).toBeNull();
    expect(r!.heard).toEqual([["uniswap: loses 75.0% of the value to price impact — its pools are too thin for this amount (limit 5%; best route direct 0.05%)", {reason: "insufficient_liquidity"}]]);
    expect(r!.ms).toBeLessThan(50);
  });

  it("a best over Ethereum's 2^24 with no later route under it: the gas refusal comes with the block read, alongside the probe, as in 039db9fe (b39901dc: one after the other)", async () => {
    // Ethereum: the read answers at 1.2 s, the probe after 400 ms. Best 20M, the other 18M: neither fits 2^24.
    const n = node({500: {out: 1_000_000n, gas: 20_000_000n}, 3000: {out: 990_000n, gas: 18_000_000n}}, [{limit: 60_000_000n, ms: 1_200}], 400);
    const [r] = await quotes(1, n, [0]);
    expect(r!.q).toBeNull();
    expect(r!.heard).toHaveLength(1);
    expect(r!.heard[0]![0]).toMatch(/^uniswap: the swap needs \d+ gas, more than chain 1 takes in one transaction \(16777216\) — its pools are too thin for this amount$/);
    expect(n.log).toEqual(["0 block read", "0 probe 500"]);
    took(r!.ms, 1_200);
  });

  it("the gas step's refusal with nothing else under its bounds: the best's own text, one block read", async () => {
    const n = node({500: {out: 1_000_000n, gas: 16_000_000n}, 3000: {out: 990_000n, gas: 15_000_000n}}, [{limit: 20_000_000n, ms: 0}, {limit: 15_000_000n, ms: 200}], 400);
    const [, second] = await quotes(43114, n, [0, 11 * MIN]);
    expect(second!.q).toBeNull();
    expect(second!.heard).toEqual([[NEEDS(16_926_000n, 43114, 15_000_000n), {reason: "insufficient_liquidity"}]]);
    expect(n.log).toEqual(["0 block read", "0 probe 500", "0 block read", "0 probe 500"]);
  });
});
