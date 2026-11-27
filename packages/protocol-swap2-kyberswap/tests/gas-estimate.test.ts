// Quote.gasEstimate on real KyberSwap answers (fixtures/quotes): recorded 2026-11-28 for a throwaway sender = recipient
// that holds nothing — GET /routes (gasInclude=true, excludeRFQSources=true, as the module asks) and POST /route/build
// of that route summary at 50 bps — each with the gas the built call used when run with eth_simulateV1 right after
// (the sender funded by a state override, a token input approved exactly in the same simulated block, the chain's gas
// price; nothing sent). No key, no headers in the recordings.
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {gasEstimateProblem, quoteRejection} from "@anywalletkit/protocol-swap2-core/validate";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {kyberGasEstimate, kyberswapProvider} from "../src/provider.js";
import {KYBER_NATIVE, kyberApiSlippage, kyberVerifyQuote} from "../src/router.js";
import {params, stub} from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

interface Recording {
  name: string;
  request: {chainId: number; tokenIn: string; tokenOut: string; amountIn: string; sender: string; recipient: string; slippageBps: number};
  simulated: {method: string; status: string; gasUsed: string};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  routes: {code: number; data: {routeSummary: Record<string, any>; routerAddress: string}};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  build: {code: number; data: Record<string, any>};
}

const dir = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));
const RECORDINGS: Recording[] = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({name: f.slice(0, -5), ...(JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as Omit<Recording, "name">)}));
const ZERO = "0x0000000000000000000000000000000000000000";
const token = (t: string) => (t.toLowerCase() === KYBER_NATIVE.toLowerCase() ? ZERO : t);

/**
 * The request the recording answers. The build was asked for 50 bps, which is what the module asks KyberSwap for when
 * the user allows 51 (`kyberApiSlippage`: one basis point less, so KyberSwap's minimum, one unit under the floor,
 * still meets the user's).
 */
const paramsOf = (r: Recording, dry: boolean): QuoteParams => ({
  sourceChain: `eip155:${r.request.chainId}`, destChain: `eip155:${r.request.chainId}`, sourceToken: token(r.request.tokenIn), destToken: token(r.request.tokenOut),
  amountIn: r.request.amountIn, destAddress: r.request.recipient, refundAddress: r.request.sender, sender: r.request.sender, slippageBps: 51, dry,
}) as QuoteParams;

/** The recorded API answers; the RPC as the throwaway account saw it (no balance, no allowance; calls succeed). */
function replay(r: Recording): typeof fetch {
  return vi.fn(async (url: string, init: {body?: string} = {}) => {
    const u = String(url);
    if (u.includes("/api/v1/routes")) return new Response(JSON.stringify(r.routes));
    if (u.includes("/api/v1/route/build")) return new Response(JSON.stringify(r.build));
    const call = JSON.parse(init.body ?? "{}") as {method?: string};
    if (call.method === "eth_call") {
      const data = (call as {params?: [{data?: string}]}).params?.[0]?.data ?? "";
      // balanceOf / allowance of the throwaway account: nothing; the swap itself (native input): no revert
      return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: /^0x(70a08231|dd62ed3e)/.test(data) ? `0x${"0".repeat(64)}` : "0x"}));
    }
    return new Response("{}", {status: 404});
  }) as unknown as typeof fetch;
}

async function quoteOf(r: Recording, dry: boolean) {
  vi.stubGlobal("fetch", replay(r));
  const refusals: string[] = [];
  const p = paramsOf(r, dry);
  const q = await kyberswapProvider({rpcUrls: {[r.request.chainId]: ["https://rpc.recorded.test"]}}).getQuote({...p, onRefusal: (why: string) => refusals.push(why)} as QuoteParams);
  return {q, refusals, p};
}

describe("kyberswap gasEstimate on recorded routes", () => {
  it("has 16 recordings on 9 chains, each built and simulated successfully", () => {
    expect(RECORDINGS).toHaveLength(16);
    expect(new Set(RECORDINGS.map((r) => r.request.chainId))).toEqual(new Set([1, 8453, 42161, 10, 137, 56, 59144, 146, 130]));
    for (const r of RECORDINGS) {
      expect([r.name, r.routes.code, r.build.code, r.simulated.method, r.simulated.status]).toEqual([r.name, 0, 0, "eth_simulateV1", "0x1"]);
      expect(kyberApiSlippage(BigInt(r.routes.data.routeSummary.amountOut as string), 51)).toBe(50);
    }
  });

  for (const r of RECORDINGS) {
    it(`${r.name}: the dry quote carries routeSummary.gas, and so does the execution quote`, async () => {
      const gas = r.routes.data.routeSummary.gas as string;
      const dry = await quoteOf(r, true);
      expect(dry.refusals).toEqual([]);
      expect(dry.q!.txRequest).toBeUndefined();
      expect([dry.q!.gasEstimate, dry.q!.gasEstimateSource]).toEqual([gas, "venue"]);
      expect(gasEstimateProblem(dry.q!, dry.p.sourceChain)).toBeNull();
      expect(quoteRejection(dry.q!, dry.p, "kyberswap")).toBeNull();

      const live = await quoteOf(r, false);
      expect(live.refusals).toEqual([]);
      expect(live.q!.txRequest!.data).toBe(r.build.data.data);
      // the build states the same figure; the transaction still carries no gas limit (the account estimates it)
      expect(r.build.data.gas).toBe(gas);
      expect(live.q!.txRequest!.gasLimit).toBeUndefined();
      expect([live.q!.gasEstimate, live.q!.gasEstimateSource]).toEqual([gas, "venue"]);
      expect(gasEstimateProblem(live.q!, live.p.sourceChain)).toBeNull();
      expect(quoteRejection(live.q!, live.p, "kyberswap")).toBeNull();
      expect(kyberVerifyQuote(live.p, live.q!)).toBeNull();
    });
  }

  it("states how far the figure was from the gas used: 0.58–1.85 ×, a median of 0.73", () => {
    const ratios = RECORDINGS.map((r) => Number(r.simulated.gasUsed) / Number(r.routes.data.routeSummary.gas)).sort((a, b) => a - b);
    expect([ratios[0]!.toFixed(2), ratios.at(-1)!.toFixed(2), ((ratios[7]! + ratios[8]!) / 2).toFixed(2)]).toEqual(["0.58", "1.85", "0.73"]);
    expect(ratios.filter((x) => x < 1).length).toBe(12);
  });
});

describe("kyberGasEstimate", () => {
  it("is the route's figure as canonical digits, or nothing when the route states none", () => {
    expect(kyberGasEstimate("330498")).toBe("330498");
    expect(kyberGasEstimate("0330498")).toBe("330498");
    expect(kyberGasEstimate(330498)).toBe("330498");
    expect(kyberGasEstimate("0")).toBeUndefined();
    expect(kyberGasEstimate("")).toBeUndefined();
    expect(kyberGasEstimate(undefined)).toBeUndefined();
    expect(kyberGasEstimate("3.3e5")).toBeUndefined();
    expect(kyberGasEstimate(-1)).toBeUndefined();
    expect(kyberGasEstimate("10000000000")).toBeUndefined();
  });

  it("a route without gas gives a quote without an estimate, which stays valid", async () => {
    vi.stubGlobal("fetch", stub({tamperSummary: (s) => ({...s, gas: undefined})}));
    const q = await kyberswapProvider().getQuote(params() as QuoteParams);
    expect(q!.gasEstimate).toBeUndefined();
    expect(q!.gasEstimateSource).toBeUndefined();
    expect(quoteRejection(q!, params() as QuoteParams, "kyberswap")).toBeNull();
  });

  it("the stand-in API's route (gas 330498) reaches dry and execution quotes alike", async () => {
    vi.stubGlobal("fetch", stub());
    const dry = await kyberswapProvider().getQuote(params() as QuoteParams);
    expect([dry!.gasEstimate, dry!.gasEstimateSource]).toEqual(["330498", "venue"]);
    vi.stubGlobal("fetch", stub());
    const live = await kyberswapProvider({rpcUrls: {8453: ["https://rpc.test"]}}).getQuote(params({dry: false}) as QuoteParams);
    expect([live!.gasEstimate, live!.gasEstimateSource]).toEqual(["330498", "venue"]);
  });
});
