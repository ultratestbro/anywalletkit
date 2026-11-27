// 0.6.0: Quote.gasEstimate / gasEstimateSource (protocol-swap2-core's contract) — the gas the swap is expected to use:
// the quoter's own figure for the route (QuoterV2 / V4Quoter, already read: no request more) plus the overhead table
// of src/gas-estimate.ts, measured on the module's own quotes (README "Gas estimate"). Checked here: the table and its
// bounds, the figure on every quote the fake-node scenarios return, and on the recordings (fixtures/rpc/) — present,
// within the core contract, at most the quote's gasLimit, and against the recorded simulation of the same call.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {getAddress} from "viem";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {uniswapGasEstimateChains, v3GasEstimate, v4GasEstimate} from "../src/gas-estimate.js";
import {boundGasLimit, gasBoundsOf} from "../src/impact.js";
import {UNISWAP_V3} from "../src/addresses.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {SCENARIOS, run} from "./unset-scenarios.js";
import {BASE_TOKEN, HOLDER, MONAD_TOKEN, tokenReplay} from "./v4-token-replay.js";

afterEach(() => vi.unstubAllGlobals());

const BIG = 10n ** 12n;
const t2t = {nativeIn: false, nativeOut: false, refund: false, pools: 1n};

/** The core contract, and the bound by the quote's own gas limit. */
function holds(q: Quote, sourceChain: string): void {
  expect(gasEstimateProblem(q, sourceChain)).toBeNull();
  expect(q.gasEstimate).toMatch(/^[1-9][0-9]*$/);
  expect(q.gasEstimateSource).toBe("simulated");
  expect(q.txRequest?.gasLimit).toBeDefined();
  expect(BigInt(q.gasEstimate!) <= BigInt(q.txRequest!.gasLimit!)).toBe(true);
}

describe("the table", () => {
  it("v3 on Ethereum's schedule: the quoter's figure plus 43,500 (token → token), 41,400 (native in), 52,400 (native out); −8,000 a pool past the first; +1,700 for refundETH", () => {
    expect(v3GasEstimate(1, 90_000n, t2t, BIG)).toBe(133_500n);
    expect(v3GasEstimate(1, 90_000n, {...t2t, nativeIn: true}, BIG)).toBe(131_400n);
    expect(v3GasEstimate(1, 90_000n, {...t2t, nativeIn: true, refund: true}, BIG)).toBe(133_100n);
    expect(v3GasEstimate(1, 90_000n, {...t2t, nativeOut: true}, BIG)).toBe(142_400n);
    expect(v3GasEstimate(1, 180_000n, {...t2t, pools: 2n}, BIG)).toBe(215_500n);
    expect(v3GasEstimate(8453, 90_000n, t2t, BIG)).toBe(133_500n);
  });

  it("v4 on Ethereum's schedule: + 79,800 (native in, Universal Router), 113,000 (token → token, SwapProxy), 91,000 (token → native)", () => {
    expect(v4GasEstimate(1, 42_000n, {nativeIn: true, nativeOut: false}, BIG)).toBe(121_800n);
    expect(v4GasEstimate(1, 42_000n, {nativeIn: false, nativeOut: false}, BIG)).toBe(155_000n);
    expect(v4GasEstimate(1, 42_000n, {nativeIn: false, nativeOut: true}, BIG)).toBe(133_000n);
  });

  it("Monad has its own table (measured against eth_estimateGas: the account's estimate is what Monad charges)", () => {
    expect(v3GasEstimate(143, 168_170n, {...t2t, nativeIn: true}, BIG)).toBe(243_470n);
    expect(v4GasEstimate(143, 49_747n, {nativeIn: true, nativeOut: false}, BIG)).toBe(181_747n);
    expect(v4GasEstimate(143, 49_282n, {nativeIn: false, nativeOut: false}, BIG)).toBe(306_282n);
  });

  it("no estimate where the schedule was not measured or differs: Polygon, Robinhood Chain, zkSync Era, MegaETH, Avalanche, Celo's v3", () => {
    for (const chain of [137, 4663, 324, 4326, 43114, 99901, 999, 31337]) {
      expect(v3GasEstimate(chain, 90_000n, t2t, BIG), String(chain)).toBeUndefined();
      expect(v4GasEstimate(chain, 42_000n, {nativeIn: true, nativeOut: false}, BIG), String(chain)).toBeUndefined();
    }
    expect(v3GasEstimate(42220, 90_000n, t2t, BIG)).toBeUndefined();
    expect(v4GasEstimate(42220, 42_000n, {nativeIn: false, nativeOut: false}, BIG)).toBe(155_000n);
    // Every v3 chain with a table has a pinned v3 deployment, every v4 one a pinned v4 deployment.
    const {v3, v4} = uniswapGasEstimateChains();
    for (const c of v3) expect(Object.prototype.hasOwnProperty.call(UNISWAP_V3, c), String(c)).toBe(true);
    for (const c of v4) expect(Object.prototype.hasOwnProperty.call(UNISWAP_V4, c), String(c)).toBe(true);
  });

  it("never above the gas limit the quote derives from the same figure, whatever the figure (every chain, every flow)", () => {
    const {v3, v4} = uniswapGasEstimateChains();
    for (const g of [20_000n, 49_000n, 90_000n, 400_000n, 5_000_000n, 15_000_000n]) {
      for (const chain of v3) {
        for (const f of [t2t, {...t2t, nativeIn: true}, {...t2t, nativeIn: true, refund: true}, {...t2t, nativeOut: true}, {...t2t, pools: 2n}, {...t2t, pools: 2n, nativeOut: true}]) {
          const g2 = g * f.pools;
          const extra = (f.nativeOut ? 40_000n : 0n) + (f.refund ? 10_000n : 0n);
          const bounded = boundGasLimit(g2 + 120_000n + extra, (g2 * 3n) / 2n + 120_000n + extra, gasBoundsOf(chain, undefined));
          if ("refuse" in bounded) continue;
          const e = v3GasEstimate(chain, g2, f, BIG);
          expect(e! <= bounded.gasLimit, `${chain} ${g2}`).toBe(true);
        }
      }
      for (const chain of v4) {
        for (const nativeIn of [true, false]) {
          const overhead = 150_000n + (nativeIn ? 0n : 140_000n);
          const bounded = boundGasLimit(g + overhead, (g * 3n) / 2n + overhead, gasBoundsOf(chain, undefined));
          if ("refuse" in bounded) continue;
          for (const nativeOut of nativeIn ? [false] : [false, true]) expect(v4GasEstimate(chain, g, {nativeIn, nativeOut}, BIG)! <= bounded.gasLimit, `${chain} ${g}`).toBe(true);
        }
      }
    }
  });

  it("left out rather than above the limit or past 10 digits", () => {
    expect(v3GasEstimate(1, 90_000n, t2t, 133_499n)).toBeUndefined();
    expect(v3GasEstimate(1, 90_000n, t2t, 133_500n)).toBe(133_500n);
    expect(v3GasEstimate(1, 10n ** 10n, t2t, 10n ** 12n)).toBeUndefined();
    expect(v4GasEstimate(1, 10n ** 10n, {nativeIn: true, nativeOut: false}, 10n ** 12n)).toBeUndefined();
    expect(v3GasEstimate(1, 90_000n, {...t2t, pools: 0n}, BIG)).toBeUndefined();
  });
});

describe("the fake-node scenarios (tests/unset-scenarios.ts, Ethereum)", () => {
  // The stub's QuoterV2 answers 90,000 gas for a single pool and 180,000 for a two-pool path unless a scenario says.
  const want: Record<string, string | null> = {
    "best of the fee tiers": "133500",
    "native in": "131400",
    "native in with refundETH": "133100",
    "native out": "142400",
    "two pools only": "215500",
    "quoter gas 0": null, // no gas limit from a figure of 0, so no estimate
    "quoter gas 5M": "5043500",
  };
  for (const s of SCENARIOS) {
    it(s.name, async () => {
      const got = await run(uniswapProvider as never, s, refusalOf);
      if (got.quote === null) return;
      if (s.name in want) expect(got.quote.gasEstimate ?? null).toBe(want[s.name]);
      if (got.quote.gasEstimate !== undefined || got.quote.txRequest?.gasLimit !== undefined) holds(got.quote, s.params.sourceChain);
      else expect(got.quote.gasEstimateSource).toBeUndefined();
    });
  }
});

describe("the recordings", () => {
  const params = (chain: number, sourceToken: string, destToken: string, amountIn: string, extra: Partial<QuoteParams> = {}): QuoteParams => ({
    sourceChain: `eip155:${chain}`, destChain: `eip155:${chain}`, sourceToken, destToken, amountIn, destAddress: HOLDER, refundAddress: HOLDER, sender: HOLDER, ...extra,
  });
  async function tokenQuote(fx: typeof BASE_TOKEN, p: QuoteParams, config: Partial<UniswapProviderConfig> = {}) {
    const r = tokenReplay([fx]);
    vi.stubGlobal("fetch", r.fetch);
    const q = await uniswapProvider({rpcUrls: {143: ["https://monad.fixture"], 8453: ["https://base.fixture"]}, v4: "all", ...config}).getQuote(p);
    return {q, misses: r.misses};
  }
  /** The recorded eth_simulateV1 answer's swap call (the last call of the block): its gasUsed. */
  function simulatedSwapGas(fx: typeof BASE_TOKEN): bigint {
    const key = Object.keys(fx.calls).find((k) => k.startsWith("eth_simulateV1"))!;
    const block = (fx.calls[key] as {result: [{calls: {gasUsed: string; status: string}[]}]}).result[0];
    const swap = block.calls.at(-1)!;
    expect(swap.status).toBe("0x1");
    return BigInt(swap.gasUsed);
  }

  it("Base 1,000 USDC → ETH (block 62,413,790): the v3 quote and the v4 SwapProxy quote both carry an estimate; v4's is within 3% of the recorded simulation of that very call", async () => {
    const v3 = await tokenQuote(BASE_TOKEN, params(8453, "USDC", "0x0000000000000000000000000000000000000000", "1000000000"));
    expect(v3.misses).toEqual([]);
    expect(v3.q!.txRequest!.to).toBe(UNISWAP_V3[8453]!.router);
    holds(v3.q!, "eip155:8453");
    const v4 = await tokenQuote(BASE_TOKEN, params(8453, "USDC", "0x0000000000000000000000000000000000000000", "1000000000"), {deployments: {}});
    expect(v4.misses).toEqual([]);
    expect(v4.q!.txRequest!.to).toBe(UNISWAP_V4[8453]!.swapProxy);
    holds(v4.q!, "eip155:8453");
    const simulated = simulatedSwapGas(BASE_TOKEN); // 133,325: [approve(SwapProxy, 1,000 USDC), swap] from the holder
    const estimate = BigInt(v4.q!.gasEstimate!);
    const off = estimate > simulated ? estimate - simulated : simulated - estimate;
    expect(off * 100n <= simulated * 3n, `estimate ${estimate} vs simulated ${simulated}`).toBe(true);
  });

  it("Monad 700 USDC → AUSD / → MON (block 125,499,326): the ranked quote and the v4 SwapProxy quote carry Monad's estimate, under their limits", async () => {
    const AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
    for (const dest of [AUSD, "0x0000000000000000000000000000000000000000"]) {
      const ranked = await tokenQuote(MONAD_TOKEN, params(143, "USDC", dest, "700000000"));
      expect(ranked.misses).toEqual([]);
      holds(ranked.q!, "eip155:143");
      const {q, misses} = await tokenQuote(MONAD_TOKEN, params(143, "USDC", dest, "700000000"), {deployments: {}});
      expect(misses).toEqual([]);
      expect(q!.txRequest!.to).toBe(UNISWAP_V4[143]!.swapProxy);
      holds(q!, "eip155:143");
    }
  });

  interface Fixture {calls: Record<string, {result?: unknown; error?: unknown}>}
  const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/rpc/${name}`, import.meta.url), "utf8")) as Fixture;
  const MONAD_CALLS = {...load("monad-125409523.json").calls, ...load("monad-125409523-v4.json").calls};
  function monadReplay() {
    vi.stubGlobal("fetch", (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
      return new Response(JSON.stringify(batch.map((req) => {
        let key = req.method;
        if (req.method === "eth_call") {
          const [c] = req.params as [{to: string; data: string}];
          key = `eth_call ${c.to.toLowerCase()} ${c.data.toLowerCase()}`;
        } else if (req.method === "eth_getCode") key = `eth_getCode ${String(req.params[0]).toLowerCase()}`;
        const answer = MONAD_CALLS[key];
        return answer ? {jsonrpc: "2.0", id: req.id, ...answer} : {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
      })));
    }) as typeof fetch);
  }

  it("Monad 62,000 MON → AUSD (block 125,409,523): v3's 16.3M-gas route and v4's winner both carry an estimate, under their limits", async () => {
    const ME = "0x1111111111111111111111111111111111111111";
    const p = {sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", amountIn: (62_000n * 10n ** 18n).toString(), destAddress: ME, refundAddress: ME};
    monadReplay();
    const v3 = await uniswapProvider({rpcUrls: {143: ["https://monad.fixture"]}}).getQuote(p);
    expect(v3).toMatchObject({txRequest: {gasLimit: "16303291"}});
    holds(v3!, "eip155:143");
    monadReplay();
    const v4 = await uniswapProvider({rpcUrls: {143: ["https://monad.fixture"]}, v4: "native-in"}).getQuote(p);
    expect(v4).toMatchObject({providerData: {venue: "v4"}, txRequest: {gasLimit: "264844"}});
    holds(v4!, "eip155:143");
  });
});
