// Quote.gasEstimate (protocol-swap2-core's contract, source "model"): the measured table of src/gas.ts — a base plus
// one cost per step by kind. Checked on the provider's quotes, against real exchange transactions (fixtures/gas: their
// calldata and receipts' gasUsed, recorded read-only on 2026-11-28), on the recorded live quotes, and for coverage of
// the shipped allowlist.
import {afterEach, describe, expect, it, vi} from "vitest";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {curveProvider} from "../src/provider.js";
import {decodeExchange} from "../src/abi.js";
import {CURVE_DEPLOYMENTS} from "../src/deployments.js";
import {CURVE_POOLS} from "../src/pools/index.js";
import {poolIndex} from "../src/routes.js";
import {CURVE_GAS_BASE, CURVE_GAS_CHAINS, CURVE_STEP_GAS, curveGasEstimateOfCall} from "../src/gas.js";
import {D143, M_AUSD, ME, RPC, TABLES, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const make = () => curveProvider({rpcUrls: RPC, ...TABLES, onWarning: () => {}});
const json = <T,>(path: string): T => JSON.parse(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8")) as T;

describe("the provider's quotes", () => {
  it("Ethereum USDC → USDT through 3pool: base + one stable 3-coin pool = 197,200, a model, no gas limit", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10});
    expect(q!.providerData!.route).toBe("3pool");
    expect(q!.gasEstimate).toBe((CURVE_GAS_BASE + CURVE_STEP_GAS["t1/3"]!).toString());
    expect(q!.gasEstimate).toBe("197200");
    expect(q!.gasEstimateSource).toBe("model");
    expect(q!.txRequest!.gasLimit).toBeUndefined();
    expect(gasEstimateProblem(q!, "eip155:1")).toBeNull();
  });

  it("no estimate on Monad (another gas schedule; its receipts report the gas limit) — the quote is otherwise as before", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({sourceChain: "eip155:143", destChain: "eip155:143", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: M_AUSD, amountIn: "1000000000"});
    expect(q!.txRequest!.to).toBe(D143.router);
    expect(q!.gasEstimate).toBeUndefined();
    expect(q!.gasEstimateSource).toBeUndefined();
  });

  it("measured chains only: Ethereum, OP Mainnet, Base, Plasma, Arbitrum", () => {
    expect([...CURVE_GAS_CHAINS].sort((a, b) => a - b)).toEqual([1, 10, 8453, 9745, 42161]);
    for (const c of CURVE_GAS_CHAINS) expect(Object.prototype.hasOwnProperty.call(CURVE_DEPLOYMENTS, c)).toBe(true);
  });
});

describe("real exchange transactions (fixtures/gas/receipts-2026-11-28.json)", () => {
  const fx = json<{about: string; rows: {chainId: number; hash: string; to: string; input: string; gasUsed: string}[]}>("../fixtures/gas/receipts-2026-11-28.json");
  const errors: number[] = [];
  it("hold no endpoint, and are calls to the pinned routers along routes the module builds", () => {
    expect(JSON.stringify(fx)).not.toMatch(/https?:\/\//);
    expect(fx.rows.length).toBeGreaterThanOrEqual(60);
    for (const r of fx.rows) {
      const d = CURVE_DEPLOYMENTS[r.chainId]!;
      expect(r.to.toLowerCase()).toBe(d.router.toLowerCase());
      expect(decodeExchange(d.family, r.input), r.hash).not.toBeNull();
    }
  });
  it("every one gets an estimate; median within 6% of its gasUsed, 9 in 10 within 15%, none off by more than 40%", () => {
    for (const r of fx.rows) {
      const d = CURVE_DEPLOYMENTS[r.chainId]!;
      const call = decodeExchange(d.family, r.input)!;
      const e = curveGasEstimateOfCall(r.chainId, call, poolIndex(r.chainId, d, CURVE_POOLS[r.chainId]));
      expect(e, r.hash).toBeDefined();
      expect(gasEstimateProblem({gasEstimate: e!.toString(), gasEstimateSource: "model"}, `eip155:${r.chainId}`)).toBeNull();
      errors.push(Math.abs(Number(e! - BigInt(r.gasUsed))) / Number(r.gasUsed));
    }
    const sorted = [...errors].sort((a, b) => a - b);
    expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThanOrEqual(0.06);
    expect(sorted[Math.floor(0.9 * (sorted.length - 1))]!).toBeLessThanOrEqual(0.15);
    expect(sorted.at(-1)!).toBeLessThanOrEqual(0.4);
  });
});

describe("the recorded live quotes (fixtures/quotes/quotes-2026-11-06.json)", () => {
  const recorded = json<{label: string; params: QuoteParams; quote: Quote}[]>("../fixtures/quotes/quotes-2026-11-06.json");
  for (const {label, quote} of recorded) {
    it(`${label}: the same figure the provider sets, where the chain is measured`, () => {
      const chainId = Number(quote.intentId.split(":")[1]);
      const d = CURVE_DEPLOYMENTS[chainId]!;
      const e = curveGasEstimateOfCall(chainId, decodeExchange(d.family, quote.txRequest!.data!)!, poolIndex(chainId, d, CURVE_POOLS[chainId]));
      if (!CURVE_GAS_CHAINS.has(chainId)) return expect(e).toBeUndefined();
      expect(e).toBeDefined();
      expect(gasEstimateProblem({...quote, gasEstimate: e!.toString(), gasEstimateSource: "model"}, `eip155:${chainId}`)).toBeNull();
    });
  }
});

describe("coverage of the shipped allowlist", () => {
  it("on every measured chain each pool step has a measured cost, but a stable-ng 3-coin pool swapped directly (t10/3)", () => {
    const missing = new Set<string>();
    for (const c of CURVE_GAS_CHAINS) {
      for (const p of poolIndex(c, CURVE_DEPLOYMENTS[c]!, CURVE_POOLS[c]).values()) {
        const kinds = [`t${p.poolType}/${p.coins.length}`, ...(p.underlying && p.swapTypes.includes(2) ? [`t${p.poolType}/${p.underlying.length}u`] : [])];
        for (const k of kinds) if (!Object.prototype.hasOwnProperty.call(CURVE_STEP_GAS, k)) missing.add(`${c}:${k}`);
      }
    }
    expect([...missing].sort()).toEqual(["1:t10/3", "8453:t10/3"]);
  });
  it("a call through a pool the allowlist does not hold, or an unknown swap type, gets no figure", () => {
    const d = CURVE_DEPLOYMENTS[1]!;
    const zero = "0x0000000000000000000000000000000000000000" as const;
    const route = ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0x00000000000000000000000000000000000bad01", "0xdAC17F958D2ee523a2206206994597C13D831ec7", ...Array(8).fill(zero)] as `0x${string}`[];
    const params = [[1n, 2n, 1n, 1n, 3n], ...Array.from({length: 4}, () => [0n, 0n, 0n, 0n, 0n])];
    expect(curveGasEstimateOfCall(1, {route, params}, poolIndex(1, d, CURVE_POOLS[1]))).toBeUndefined();
    const t3pool = "0xbEbc44782C7dB0a1A60Cb6fe97d0b483032FF1C7" as const;
    expect(curveGasEstimateOfCall(1, {route: [route[0]!, t3pool, route[2]!, ...route.slice(3)], params}, poolIndex(1, d, CURVE_POOLS[1]))).toBe(197_200n);
    expect(curveGasEstimateOfCall(1, {route: [route[0]!, t3pool, route[2]!, ...route.slice(3)], params: [[1n, 2n, 7n, 1n, 3n], ...params.slice(1)]}, poolIndex(1, d, CURVE_POOLS[1]))).toBeUndefined();
    expect(curveGasEstimateOfCall(143, {route: [route[0]!, t3pool, route[2]!, ...route.slice(3)], params}, poolIndex(1, d, CURVE_POOLS[1]))).toBeUndefined();
  });
});
