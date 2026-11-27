// Quote.gasEstimate on real Fynd answers (fixtures/quotes): recorded 2026-11-28 from the hosted API for a throwaway
// sender = receiver that holds nothing, each with the gas its transaction used when run with eth_simulateV1 right
// after the quote, at the chain's gas price and with the module's gas limit (the sender funded by a state override, a
// token input approved exactly in the same simulated block; nothing sent). No key, no headers in the recordings.
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import {gasEstimateProblem, quoteRejection} from "@anywalletkit/protocol-swap2-core/validate";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {FYND_GAS_ESTIMATE_OVERHEAD, fyndGasEstimate, fyndProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

interface Recording {
  name: string;
  request: {chainId: number; tokenIn: string; tokenOut: string; amountIn: string; sender: string; receiver: string; slippageBps: number};
  simulated: {method: string; status: string; gasUsed: string; gasLimit: string; gasPrice: string};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: {orders: Record<string, any>[]};
}

const dir = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));
const RECORDINGS: Recording[] = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => ({name: f.slice(0, -5), ...(JSON.parse(readFileSync(`${dir}${f}`, "utf8")) as Omit<Recording, "name">)}));

const paramsOf = (r: Recording): QuoteParams => ({
  sourceChain: `eip155:${r.request.chainId}`, destChain: `eip155:${r.request.chainId}`, sourceToken: r.request.tokenIn, destToken: r.request.tokenOut,
  amountIn: r.request.amountIn, destAddress: r.request.receiver, refundAddress: r.request.sender, slippageBps: r.request.slippageBps,
}) as QuoteParams;

/** The recorded body for the quote request; no RPC (the module then simulates nothing at quote time). */
function replay(body: unknown): typeof fetch {
  return vi.fn(async (url: string) => (String(url).includes("/quote") ? new Response(JSON.stringify(body)) : new Response("{}", {status: 404}))) as unknown as typeof fetch;
}

async function quoteOf(r: Recording, body: unknown = r.response) {
  vi.stubGlobal("fetch", replay(body));
  const refusals: string[] = [];
  const q = await fyndProvider({apiKey: "k"}).getQuote({...paramsOf(r), onRefusal: (why: string) => refusals.push(why)} as QuoteParams);
  return {q, refusals};
}

/**
 * Recordings the module refuses as they are, unchanged by this feature: Fynd's fee breakdown (router fee + client fee
 * + max slippage + minimum) came short of `amount_out` by 3 to 3 250 000 000 001 base units on these Base and BNB Chain
 * answers, and a breakdown that does not add up is refused (`price_check_failed`). Their simulations still count for
 * the overhead measurement: the transaction is Fynd's either way.
 */
const REFUSED = new Set(["base-eth-usdc", "base-eth-usdc-small", "base-usdc-cbbtc", "base-usdc-weth", "base-weth-usdc", "bsc-usdt-bnb"]);

const median = (xs: bigint[]): bigint => {
  const s = [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2n;
};

describe("fynd gasEstimate on recorded quotes", () => {
  it("has 20 recordings on 7 chains, each simulated successfully", () => {
    expect(RECORDINGS).toHaveLength(20);
    expect(new Set(RECORDINGS.map((r) => r.request.chainId))).toEqual(new Set([1, 8453, 42161, 56, 137, 130, 4663]));
    for (const r of RECORDINGS) expect([r.name, r.simulated.method, r.simulated.status]).toEqual([r.name, "eth_simulateV1", "0x1"]);
  });

  for (const r of RECORDINGS.filter((x) => REFUSED.has(x.name))) {
    it(`${r.name}: still refused for its fee breakdown, as before`, async () => {
      const {q, refusals} = await quoteOf(r);
      expect(q).toBeNull();
      expect(refusals).toEqual(["fynd: fee breakdown does not add up to the output"]);
      // what its estimate would be
      expect(fyndGasEstimate(r.response.orders[0]!.gas_estimate)).toBe(r.response.orders[0]!.gas_estimate);
    });
  }

  for (const r of RECORDINGS.filter((x) => !REFUSED.has(x.name))) {
    it(`${r.name}: gas_estimate + the measured overhead, from the venue, within the gas limit`, async () => {
      const {q, refusals} = await quoteOf(r);
      expect(refusals).toEqual([]);
      const venue = BigInt(r.response.orders[0]!.gas_estimate as string);
      const limit = BigInt(q!.txRequest!.gasLimit!);
      // the gas limit is untouched: gas_estimate × 1.3 + 80 000, so (limit − 80 000) / 1.3 gives gas_estimate back
      expect(limit).toBe((venue * 13n) / 10n + 80_000n);
      const recovered = ((limit - 80_000n) * 10n) / 13n;
      expect(venue - recovered >= 0n && venue - recovered <= 1n).toBe(true);
      // the estimate: that same figure plus the router overhead measured on these recordings (none)
      expect(q!.gasEstimate).toBe((venue + FYND_GAS_ESTIMATE_OVERHEAD).toString());
      expect(q!.gasEstimateSource).toBe("venue");
      expect(BigInt(q!.gasEstimate!) <= limit).toBe(true);
      expect(gasEstimateProblem(q!, paramsOf(r).sourceChain)).toBeNull();
      expect(quoteRejection(q!, paramsOf(r), "fynd")).toBeNull();
      // the recorded transaction was simulated with this very limit, and used less
      expect(r.simulated.gasLimit).toBe(limit.toString());
      expect(BigInt(r.simulated.gasUsed) < limit).toBe(true);
    });
  }

  it("the overhead matches the measurement: gas used minus gas_estimate has a median of -2 633, so nothing is added", () => {
    const excess = RECORDINGS.map((r) => BigInt(r.simulated.gasUsed) - BigInt(r.response.orders[0]!.gas_estimate as string));
    const m = median(excess);
    expect(m).toBe(-2633n);
    expect(FYND_GAS_ESTIMATE_OVERHEAD).toBe(m > 0n ? m : 0n);
    // the spread the README states
    const sorted = [...excess].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect([sorted[0], sorted.at(-1)]).toEqual([-152_010n, 73_820n]);
    // the old limit's 80 000 is not what the router adds: the largest shortfall of gas_estimate stays under it
    expect(sorted.at(-1)! < 80_000n).toBe(true);
  });
});

describe("fyndGasEstimate", () => {
  it("is Fynd's figure as canonical digits, or nothing when Fynd states none", () => {
    expect(fyndGasEstimate("150000")).toBe("150000");
    expect(fyndGasEstimate("0150000")).toBe("150000");
    expect(fyndGasEstimate(undefined)).toBeUndefined();
    expect(fyndGasEstimate("0")).toBeUndefined();
    expect(fyndGasEstimate("")).toBeUndefined();
    expect(fyndGasEstimate("1.5e5")).toBeUndefined();
    expect(fyndGasEstimate("0x249f0")).toBeUndefined();
    expect(fyndGasEstimate(150000)).toBeUndefined();
    expect(fyndGasEstimate("9999999999")).toBe("9999999999");
    expect(fyndGasEstimate("10000000000")).toBeUndefined();
  });

  it("a quote whose order states no gas_estimate carries no estimate (its gas limit stays the old 80 000)", async () => {
    const r = RECORDINGS.find((x) => x.name === "unichain-eth-usdc")!;
    const body = JSON.parse(JSON.stringify(r.response)) as Recording["response"];
    delete body.orders[0]!.gas_estimate;
    const {q} = await quoteOf(r, body);
    expect(q!.txRequest!.gasLimit).toBe("80000");
    expect(q!.gasEstimate).toBeUndefined();
    expect(q!.gasEstimateSource).toBeUndefined();
    expect(gasEstimateProblem(q!, paramsOf(r).sourceChain)).toBeNull();
  });

  it("a gas_estimate of 0 sets none either, so the quote stays valid", async () => {
    const r = RECORDINGS.find((x) => x.name === "ethereum-usdt-usdc")!;
    const body = JSON.parse(JSON.stringify(r.response)) as Recording["response"];
    body.orders[0]!.gas_estimate = "0";
    const {q} = await quoteOf(r, body);
    expect(q!.gasEstimate).toBeUndefined();
    expect(quoteRejection(q!, paramsOf(r), "fynd")).toBeNull();
  });
});
