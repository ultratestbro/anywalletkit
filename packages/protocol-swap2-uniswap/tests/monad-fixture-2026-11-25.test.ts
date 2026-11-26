// cp0x ask 1c (UNISWAP-V4-RESEARCH §7.3): the Monad trigger case, 62,000 MON → AUSD, replayed offline from a recording
// at block 125,409,523 (fixtures/rpc/monad-125409523.json). Uniswap v3 has one deep pool on the route (WMON/USDC 0.3%);
// every v3 pool touching AUSD is dust, so the best v3 route pays 1.130999 AUSD for about $678 of MON. With
// `maxPriceImpactBps` unset that quote is returned exactly as 0.4.11 returned it (impact is information); with 500 it
// is refused as `insufficient_liquidity` — "v4 absent → refused", the second of cp0x's two expectations (the first,
// "v4 deep → v4 wins and passes", needs the v4 module, U1).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

interface Fixture {
  chainId: number;
  block: {number: string; hex: string; hash: string; gasLimit: string};
  calls: Record<string, {result?: unknown; error?: unknown}>;
}
const fx = JSON.parse(readFileSync(new URL("../fixtures/rpc/monad-125409523.json", import.meta.url), "utf8")) as Fixture;

const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const ME = "0x1111111111111111111111111111111111111111";
const RPC = {143: ["https://monad.fixture"]};
const MON = (n: bigint) => (n * 10n ** 18n).toString();
const params = (amountIn: string) => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: AUSD, amountIn, destAddress: ME, refundAddress: ME});

/** The deployment check's calls (router / quoter factory() and WETH9()): read once per chain at "latest", not per quote. */
const DEPLOYMENT_CHECK = /^0x(c45a0155|4aa4a4fc)$/;

/** Serves the recording (an eth_call `odd` answers instead, when it returns one); every quote read's block tag and every
 *  call the recording lacks are kept for the test to check. */
function replay(odd?: (data: string) => object | undefined) {
  const tags = new Set<string>();
  const misses: string[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
    return new Response(JSON.stringify(batch.map((req) => {
      let key = req.method;
      if (req.method === "eth_call") {
        const [{to, data}, tag] = req.params as [{to: string; data: string}, string];
        if (!DEPLOYMENT_CHECK.test(data)) tags.add(tag);
        key = `eth_call ${to.toLowerCase()} ${data.toLowerCase()}`;
        const instead = odd?.(data);
        if (instead) return {jsonrpc: "2.0", id: req.id, ...instead};
      }
      const answer = fx.calls[key];
      if (!answer) {
        misses.push(key);
        return {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
      }
      return {jsonrpc: "2.0", id: req.id, ...answer};
    })));
  }) as typeof fetch;
  return {fetch: f, tags, misses};
}

async function quote(amountIn: string, config: Record<string, unknown> = {}, odd?: (data: string) => object | undefined) {
  const r = replay(odd);
  vi.stubGlobal("fetch", r.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const q = await uniswapProvider({rpcUrls: RPC, ...config}).getQuote({...params(amountIn), onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, tags: [...r.tags], misses: r.misses};
}

describe("Monad 62,000 MON → AUSD at block 125,409,523 (v3 only)", () => {
  it("the recording is the research fixture", () => {
    expect(fx.chainId).toBe(143);
    expect(fx.block).toMatchObject({number: "125409523", hex: "0x77998f3", hash: "0x35117d59056d410d59d676f16f746d9f205f37c4e5bb2d55457d73e6d1b4ee3e"});
    expect(BigInt(fx.block.gasLimit)).toBe(150_000_000n);
  });

  it("unset: the 0.4.11 quote, unchanged — 1.130999 AUSD via USDC 0.3% → 0.01%, impact 9981, gasLimit 16,303,291", async () => {
    const {q, heard, tags, misses} = await quote(MON(62_000n));
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(tags).toEqual(["latest"]);
    expect(q).toMatchObject({destAmount: "1130999", txRequest: {gasLimit: "16303291", value: MON(62_000n)}});
    expect(q!.providerData).toMatchObject({route: "via USDC 0.3% → 0.01%", priceImpactBps: "9981"});
    expect(q!.providerData!.valueLossBps).toBeUndefined();
    // Monad's 16.3M limit is under its 30M per-transaction cap and the 150M block: neither refused nor clamped.
  });

  it("unset, 100 MON: 0.871160 AUSD, impact 2016, gasLimit 1,059,868", async () => {
    const {q, misses} = await quote(MON(100n));
    expect(misses).toEqual([]);
    expect(q).toMatchObject({destAmount: "871160", txRequest: {gasLimit: "1059868"}});
    expect(q!.providerData).toMatchObject({route: "via USDC 0.3% → 0.01%", priceImpactBps: "2016"});
  });

  it("maxPriceImpactBps 500: refused as insufficient_liquidity with the exact text, every read at the one block", async () => {
    const {q, heard, tags, misses} = await quote(MON(62_000n), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(misses).toEqual([]);
    expect(tags).toEqual([fx.block.hex]);
    expect(heard).toEqual([[
      "uniswap: loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)",
      {reason: "insufficient_liquidity"},
    ]]);
    expect(heard[0]![0].replace(/^uniswap: /, "")).toMatch(/^loses ([\d.]+)% of the value to price impact/); // cp0x refusals.ts
  });

  it("maxPriceImpactBps 500, 100 MON: refused too (v3 alone loses 20.5%)", async () => {
    const {q, heard, misses} = await quote(MON(100n), {maxPriceImpactBps: 500});
    expect(q).toBeNull();
    expect(misses).toEqual([]);
    expect(heard).toEqual([["uniswap: loses 20.5% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)", {reason: "insufficient_liquidity"}]]);
  });

  // The two pools' mids at the block give 679.6999 AUSD for 62,000 MON: a gross loss of 9983.36 bps (computed apart
  // from the module with exact fractions), reported rounded down — rounding never adds to a refusal.
  it("the measure is the larger of the probe (9981) and the spot value loss against the slot0 mids (9983)", async () => {
    const pass = await quote(MON(62_000n), {maxPriceImpactBps: 9984});
    expect(pass.misses).toEqual([]);
    expect(pass.q).toMatchObject({destAmount: "1130999", txRequest: {gasLimit: "16303291"}});
    expect(pass.q!.providerData).toMatchObject({priceImpactBps: "9981", valueLossBps: "9983"});
    const at = await quote(MON(62_000n), {maxPriceImpactBps: 9983});
    expect(at.q).toBeNull();
    expect(at.heard[0]![1]).toEqual({reason: "insufficient_liquidity"});
  });

  // Round 1 (U0-LIVE-4, U0-SEC-1): at a limit between the probe and the spot loss, the full measure refuses; when the
  // spot reads go unanswered (QuickNode's -32007 on every attempt), the probe alone used to pass the quote.
  it("a limit above the probe (2016) and under the spot loss: refused, also when the spot reads are rate-limited", async () => {
    const healthy = await quote(MON(100n), {maxPriceImpactBps: 2017});
    expect(healthy.misses).toEqual([]);
    expect(healthy.heard[0]![0]).toMatch(/^uniswap: loses 20\.\d% of the value to price impact/);
    const limited = {error: {code: -32007, message: "50/second request limit reached"}};
    for (const selector of ["0x3850c7bd", "0x1698ee82"]) { // slot0(), getPool()
      const {q, heard} = await quote(MON(100n), {maxPriceImpactBps: 2017}, (data) => (data.startsWith(selector) ? limited : undefined));
      expect(q).toBeNull();
      expect(heard).toEqual([["uniswap: could not measure the price impact (maxPriceImpactBps is set) — nothing was quoted; try again", {reason: "rate_limited"}]]);
    }
  });
});
