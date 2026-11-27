// Quote.gasEstimate (2026-11-28): LI.FI's own figure for the gas its transaction uses — `estimate.gasCosts[type =
// "SEND"].estimate`, documented as "Estimated units of gas the transaction consumes" (the entry's `limit`, the
// transaction's gasLimit, is that plus LI.FI's safety buffer) — carried as gasEstimate with gasEstimateSource "venue",
// only when LI.FI reports it simulated the transaction (`stepSimulation.gasSource: "simulation"`; the other documented
// value, "tool", is a per-tool table). Never on a Solana source, never above the transaction's gas limit.
// Recordings: fixtures-live-2026-11-04.json, fixtures-live-2026-11-13-evm-intents.json (corridors and the price-only
// Stargate V2 answer), and fixtures-live-2026-11-28-gas.json — 13 answers of 2026-11-28 through the built provider,
// each transaction simulated right after it was quoted (eth_simulateV1 gasUsed, eth_estimateGas; state override on the
// sender, nothing sent). The older recordings (10-30, 11-02, 11-12) were stored without gasCosts: no estimate.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {gasEstimateProblem} from "@anywalletkit/protocol-swap2-core/validate";
import {LIFI_GAS_LIMIT_BILLED_CHAINS, lifiGasEstimate, lifiPins, lifiProvider, lifiVerifyQuote, type LifiProviderConfig} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

type GasCost = {type: string; estimate: string; limit: string};
type Answer = {tool?: string; estimate: {gasCosts?: GasCost[]}; stepSimulation?: unknown; transactionRequest?: {gasLimit?: string}; action: object};
type Corridor = {name: string; params: QuoteParams; config?: LifiProviderConfig; status?: number; response: Answer; simulated?: {gasUsed: string; estimateGas: string}};
const read = <T>(file: string): T => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as T;
const nov04 = read<{corridors: Corridor[]}>("./fixtures-live-2026-11-04.json").corridors;
const nov13 = read<{corridors: Corridor[]; priceOnly: Corridor}>("./fixtures-live-2026-11-13-evm-intents.json");
const nov28 = read<{corridors: Corridor[]}>("./fixtures-live-2026-11-28-gas.json").corridors;
const stripped = [
  ...read<{corridors: {name: string; params: QuoteParams; responses: {status: number; body: Answer | null}[]}[]}>("./fixtures-live-2026-10-30.json").corridors
    .filter((c) => c.responses.at(-1)?.status === 200).map((c) => ({name: `10-30 ${c.name}`, params: c.params, response: c.responses.at(-1)!.body!})),
  ...read<{corridors: Corridor[]}>("./fixtures-live-2026-11-02.json").corridors.map((c) => ({...c, name: `11-02 ${c.name}`})),
  ...read<{corridors: Corridor[]}>("./fixtures-live-2026-11-12-evm-solana.json").corridors.map((c) => ({...c, name: `11-12 ${c.name}`})),
];

/** LI.FI answers with `answer`, echoing the slippage asked (as LI.FI does). */
async function quote(answer: unknown, params: QuoteParams, config: LifiProviderConfig = {}) {
  vi.stubGlobal("fetch", async (u: URL | string) => {
    const url = new URL(String(u));
    if (url.pathname.endsWith("/advanced/routes")) return new Response(JSON.stringify({routes: []}));
    const a = answer as {action: object};
    const slippage = url.searchParams.get("slippage");
    return new Response(JSON.stringify(slippage === null ? a : {...a, action: {...a.action, slippage: Number(slippage)}}));
  });
  const reasons: string[] = [];
  const q = await lifiProvider({integrator: "awk-probe", ...config}).getQuote({...params, onRefusal: (r) => reasons.push(r)});
  return {q, reasons};
}
const send = (a: Answer): GasCost => {
  const s = (a.estimate.gasCosts ?? []).filter((g) => g.type === "SEND");
  expect(s).toHaveLength(1);
  return s[0]!;
};

describe("LI.FI gasEstimate: the SEND gas cost's estimate, from LI.FI's simulation of the transaction", () => {
  it("every recorded answer with gas costs that the provider quotes carries it, as 'venue', within the transaction's gas limit", async () => {
    const recorded: Corridor[] = [
      ...nov04.map((c) => ({...c, name: `11-04 ${c.name}`})),
      ...nov13.corridors.filter((c) => c.status === 200).map((c) => ({...c, name: `11-13 ${c.name}`})),
      ...nov28.map((c) => ({...c, name: `11-28 ${c.name}`})),
    ];
    expect(recorded).toHaveLength(4 + 13 + 13);
    for (const c of recorded) {
      const {q, reasons} = await quote(c.response, c.params, c.config);
      expect(reasons, c.name).toEqual([]);
      const cost = send(c.response);
      expect(c.response.stepSimulation, c.name).toEqual({status: "success", gasSource: "simulation"});
      expect(q!.gasEstimate, c.name).toBe(cost.estimate);
      expect(q!.gasEstimateSource, c.name).toBe("venue");
      expect(gasEstimateProblem(q!, c.params.sourceChain), c.name).toBeNull();
      // LI.FI's own limit for the same entry is the transaction's gas limit; the estimate sits under it.
      expect(q!.txRequest!.gasLimit, c.name).toBe(BigInt(cost.limit).toString());
      expect(BigInt(q!.gasEstimate!) <= BigInt(q!.txRequest!.gasLimit!), c.name).toBe(true);
      expect(BigInt(q!.gasEstimate!) < BigInt(q!.txRequest!.gasLimit!), c.name).toBe(true);
      expect(lifiVerifyQuote(c.params, q!), c.name).toBeNull();
    }
  });

  it("a price-only quote (dry, no sender) keeps the estimate of the route, bounded by the limit LI.FI built the transaction with", async () => {
    const c = nov13.priceOnly;
    const {q, reasons} = await quote(c.response, c.params);
    expect(reasons).toEqual([]);
    expect(q!.txRequest).toBeUndefined();
    expect(q!.gasEstimate).toBe("534038");
    expect(q!.gasEstimateSource).toBe("venue");
    expect(BigInt(q!.gasEstimate!) <= BigInt(c.response.transactionRequest!.gasLimit!)).toBe(true);
    expect(gasEstimateProblem(q!, c.params.sourceChain)).toBeNull();
    expect(lifiVerifyQuote(c.params, q!)).toBeNull();
  });

  it("the 2026-11-28 answers against a simulation of the same transaction: LI.FI's figure is 12–26 % above the gas used, and under its gas limit", () => {
    expect(nov28).toHaveLength(13);
    const ratios = nov28.map((c) => Number(send(c.response).estimate) / Number(c.simulated!.gasUsed));
    for (const [i, r] of ratios.entries()) {
      expect(r, nov28[i]!.name).toBeGreaterThan(1.1);
      expect(r, nov28[i]!.name).toBeLessThan(1.27);
      expect(BigInt(send(nov28[i]!.response).estimate) < BigInt(nov28[i]!.response.transactionRequest!.gasLimit!), nov28[i]!.name).toBe(true);
    }
    const sorted = [...ratios].sort((a, b) => a - b);
    expect(sorted[6]).toBeCloseTo(1.195, 2); // median of 13
  });

  it("recordings stored without gas costs, and every Solana source, carry no estimate", async () => {
    expect(stripped.length).toBeGreaterThan(20);
    let quoted = 0;
    for (const c of stripped) {
      expect(c.response.estimate.gasCosts, c.name).toBeUndefined();
      const {q} = await quote(c.response, c.params);
      if (!q) continue;
      quoted++;
      expect(q.gasEstimate, c.name).toBeUndefined();
      expect(q.gasEstimateSource, c.name).toBeUndefined();
    }
    expect(quoted).toBeGreaterThan(10);
    // A Solana-source answer with a SEND gas cost and a simulation report (constructed from a recorded answer, not a
    // recording): the EVM-only rule holds before the figure is read.
    const solana = read<{corridors: Corridor[]}>("./fixtures-live-2026-11-02.json").corridors.find((c) => c.name === "w-sol-base-usdc-mayan")!;
    const {q} = await quote({...solana.response, stepSimulation: {status: "success", gasSource: "simulation"}, estimate: {...solana.response.estimate, gasCosts: [{type: "SEND", estimate: "200000", limit: "300000"}]}}, solana.params);
    expect(q).not.toBeNull();
    expect(q!.gasEstimate).toBeUndefined();
    expect(q!.gasEstimateSource).toBeUndefined();
  });

  it("no figure without LI.FI's simulation, a single SEND entry and canonical gas units under the limit", async () => {
    const sim = {status: "success", gasSource: "simulation"};
    const cost = (estimate: unknown, type = "SEND") => ({type, price: "6000000", estimate, limit: "632707"});
    expect(lifiGasEstimate([cost("179005")], sim, "632707")).toBe("179005");
    expect(lifiGasEstimate([cost("632707")], sim, "632707")).toBe("632707"); // equal to the limit is fine
    expect(lifiGasEstimate([cost("179005"), cost("40000", "APPROVE")], sim, "632707")).toBe("179005"); // the approval is never counted
    expect(lifiGasEstimate([cost("179005")], sim, undefined)).toBe("179005");
    for (const s of [undefined, null, {}, {status: "success", gasSource: "tool"}, {status: "failed", gasSource: "simulation"}, {status: "not-attempted", disabledReason: "skip_requested"}, "simulation"]) {
      expect(lifiGasEstimate([cost("179005")], s, "632707"), JSON.stringify(s)).toBeUndefined();
    }
    for (const bad of ["0", "0179005", "179005.0", "1e5", " 179005", "-179005", "0x2bb3d", "12345678901", 179005, null, undefined]) {
      expect(lifiGasEstimate([cost(bad)], sim, "632707"), String(bad)).toBeUndefined();
    }
    expect(lifiGasEstimate([cost("632708")], sim, "632707")).toBeUndefined(); // above LI.FI's own limit
    expect(lifiGasEstimate([cost("179005"), cost("1000")], sim, "632707")).toBeUndefined(); // two SEND entries: whose?
    expect(lifiGasEstimate([cost("179005", "APPROVE")], sim, "632707")).toBeUndefined();
    expect(lifiGasEstimate([], sim, "632707")).toBeUndefined();
    expect(lifiGasEstimate({type: "SEND", estimate: "179005"}, sim, "632707")).toBeUndefined();
    expect(lifiGasEstimate([null, cost("179005")], sim, "632707")).toBe("179005");
    // Through the provider: a recorded answer whose simulation report says "tool" quotes as before, without a figure.
    const c = nov28[0]!;
    const plain = await quote(c.response, c.params);
    const tool = await quote({...c.response, stepSimulation: {status: "success", gasSource: "tool"}}, c.params);
    expect(plain.q!.gasEstimate).toBe("179005");
    const {gasEstimate: _e, gasEstimateSource: _s, validUntilMs: _v1, ...rest} = plain.q!;
    const {validUntilMs: _v2, ...without} = tool.q!;
    expect(without).toEqual(rest);
  });

  it("on a chain that bills the whole gas limit (Monad) the quote carries no estimate: the limit LI.FI sends is the cost", async () => {
    expect([...LIFI_GAS_LIMIT_BILLED_CHAINS]).toEqual(["eip155:143"]);
    // A recorded native-source answer (base-eth>arb-eth, LayerSwap) moved to Monad — its own Diamond, MON in, the
    // simulation report and gas costs as recorded. Constructed from a recording, not a recording.
    const c = nov28.find((x) => x.name === "base-eth>arb-eth")!;
    const MONAD_DIAMOND = "0x026F252016A7C47CDEf1F05a3Fc9E20C92a49C37";
    const r = c.response as Answer & {action: {fromToken: object}; estimate: {approvalAddress?: string}; transactionRequest: Record<string, unknown>};
    const monad = {
      ...r,
      action: {...r.action, fromChainId: 143, fromToken: {...r.action.fromToken, chainId: 143, symbol: "MON"}},
      estimate: {...r.estimate, approvalAddress: MONAD_DIAMOND},
      transactionRequest: {...r.transactionRequest, to: MONAD_DIAMOND, chainId: 143},
    };
    const params = {...c.params, sourceChain: "eip155:143", sourceToken: "MON"};
    const base = await quote(c.response, c.params);
    expect(base.q!.gasEstimate).toBe(send(c.response).estimate);
    const {q, reasons} = await quote(monad, params);
    expect(reasons).toEqual([]);
    expect(q).not.toBeNull();
    expect(q!.txRequest!.gasLimit).toBe(BigInt(send(c.response).limit).toString());
    expect(q!.gasEstimate).toBeUndefined();
    expect(q!.gasEstimateSource).toBeUndefined();
    // Nothing else of the quote changes there.
    const {gasEstimate: _e, gasEstimateSource: _s, validUntilMs: _v, intentId: _i, txRequest: _t, ...rest} = base.q!;
    const {validUntilMs: _v2, intentId: _i2, txRequest: _t2, ...onMonad} = q!;
    expect(Object.keys(onMonad).sort()).toEqual(Object.keys(rest).sort());
  });

  it("a swap2 server seals the figure and the remote stub (lifiPins) receives it unchanged", async () => {
    const c = nov28.find((x) => x.name === "base-usdc>arb-usdc")!;
    vi.stubGlobal("fetch", async (u: URL | string) => {
      const url = new URL(String(u));
      const a = c.response as {action: object};
      return new Response(JSON.stringify({...a, action: {...a.action, slippage: Number(url.searchParams.get("slippage"))}}));
    });
    const handle = createSwap2Handler<string>({providers: [lifiProvider()], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...lifiPins});
    const q = (await stub.getQuote(c.params)) as Quote;
    expect(q.gasEstimate).toBe(send(c.response).estimate);
    expect(q.gasEstimateSource).toBe("venue");
  });
});
