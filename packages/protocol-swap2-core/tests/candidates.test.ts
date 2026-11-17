import {describe, expect, it} from "vitest";
import {createSwap2Handler} from "../src/server.js";
import {remoteProvider} from "../src/remote.js";
import {validQuote} from "../src/validate.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../src/types.js";

const params: QuoteParams = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: "USDC", amountIn: "100", destAddress: "0x1111111111111111111111111111111111111111", dry: true};
function q(routeId: string): Quote {
  return {provider: "multi", routeId, intentId: "shared-id", depositAddress: "0x2222222222222222222222222222222222222222", depositMemo: null, sourceAmount: "100", destAmount: "100", minDestAmount: "99", feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000};
}
function setup(over: Partial<CrossChainProvider> = {}, multiple = true) {
  const built: Quote[] = [], requests: QuoteParams[] = [];
  const provider: CrossChainProvider = {name: "multi", enabled: () => true, supportsRoute: () => true,
    getQuote: async (p) => { requests.push(p); return q(p.routeId ?? "taxi"); },
    getQuotes: async () => [q("taxi"), q("bus")],
    buildDeposit: async (quote) => { built.push(quote); return {chain: params.sourceChain, to: quote.depositAddress, value: "100"}; },
    trackIntent: async () => ({state: "pending"}), ...over};
  if (!multiple) delete provider.getQuotes;
  const handle = createSwap2Handler({providers: [provider], sealSecret: "candidate-tests-secret-at-least-32-bytes", guard: () => {}, subject: (who: string) => who});
  const fetchImpl: typeof fetch = async (url, init) => {
    const response = await handle(String(url).split("/").pop()!, JSON.parse(String(init!.body)), "alice");
    return new Response(JSON.stringify(response.body), {status: response.status});
  };
  return {handle, built, requests, fetchImpl};
}

describe("candidate quote wire contract", () => {
  it("preserves route identity across normalized requests, seals and builds", async () => {
    const {fetchImpl, built, requests} = setup();
    const client = remoteProvider({name: "multi", baseUrl: "https://example.test", multiQuotes: true, fetchImpl});
    const candidates = await client.getQuotes!(params);
    expect(candidates.map((c) => c.routeId)).toEqual(["taxi", "bus"]);
    expect(candidates.every((c) => /^[0-9a-f]{64}$/.test(c.providerData!.__remoteSeal!))).toBe(true);
    const selected = await client.getQuote({...params, dry: false, routeId: "bus"});
    expect(requests[0]).toMatchObject({dry: false, routeId: "bus"});
    await client.buildDeposit(selected!);
    expect(built[0]!.routeId).toBe("bus");
    expect(built[0]!.intentId).toBe("shared-id");
    expect(built[0]!.providerData).toBeUndefined();
  });

  it("refuses route alteration/removal, wrong subjects and expired sealed candidates", async () => {
    const {handle, built} = setup();
    const candidates = (await handle("quotes", {provider: "multi", params}, "alice")).body as Quote[];
    const quote = candidates[0]!;
    for (const tampered of [{...quote, routeId: "bus"}, {...quote, routeId: undefined}, {...quote, validUntilMs: 1}]) {
      expect((await handle("build", {provider: "multi", quote: tampered}, "alice")).status).toBe(403);
    }
    expect((await handle("build", {provider: "multi", quote}, "bob")).status).toBe(403);
    expect(built).toEqual([]);
  });

  it("validates selectors and isolates bad siblings without creating live candidate quotes", async () => {
    const {handle} = setup({getQuotes: async () => [q("good"), q("dup"), q("dup"), {...q("expired"), validUntilMs: 1}, {...q("bad"), sourceAmount: "101"}]});
    expect(((await handle("quotes", {provider: "multi", params}, "alice")).body as Quote[]).map((c) => c.routeId)).toEqual(["good"]);
    expect((await handle("quotes", {provider: "multi", params: {...params, dry: false}}, "alice")).status).toBe(400);
    for (const routeId of ["", "\n", "x".repeat(257), 7]) {
      expect((await handle("quote", {provider: "multi", params: {...params, routeId}}, "alice")).status).toBe(400);
    }
    expect((await setup({getQuotes: async () => Array.from({length: 33}, (_, i) => q(String(i)))}).handle("quotes", {provider: "multi", params}, "alice")).status).toBe(502);
  });

  it("requires a client opt-in for new servers and keeps legacy quotes unchanged", async () => {
    const {fetchImpl} = setup({getQuote: async () => { const {routeId: _id, ...quote} = q("taxi"); return quote; }}, false);
    const client = remoteProvider({name: "multi", baseUrl: "https://example.test", fetchImpl});
    expect(client.getQuotes).toBeUndefined();
    expect((await client.getQuote(params))?.routeId).toBeUndefined();
    await expect(client.getQuote({...params, routeId: "bus"})).rejects.toThrow();
  });

  it("client-side validation refuses backend route substitution and validates every candidate", async () => {
    const seen: string[] = [];
    const client = remoteProvider({name: "multi", baseUrl: "https://example.test", multiQuotes: true,
      fetchImpl: async (url) => new Response(JSON.stringify(String(url).endsWith("/quotes") ? [q("taxi"), q("bus")] : q("taxi"))),
      verifyQuote: (_p, quote) => { seen.push(quote.routeId!); return quote.routeId === "taxi" ? "wrong payload for route" : null; },
    });
    expect((await client.getQuotes!(params)).map((c) => c.routeId)).toEqual(["bus"]);
    expect(seen).toEqual(["taxi", "bus"]);
    await expect(client.getQuote({...params, routeId: "bus"})).rejects.toThrow(/changed the selected routeId/);
    expect(validQuote(q("taxi"), {...params, routeId: "bus"}, "multi")).toBe(false);
  });

  it("requires the default quote of a multi-route provider to identify its path", async () => {
    const {routeId: _id, ...missing} = q("taxi");
    const {handle} = setup({getQuote: async () => missing});
    expect((await handle("quote", {provider: "multi", params}, "alice")).status).toBe(502);
    const client = remoteProvider({name: "multi", baseUrl: "https://example.test", multiQuotes: true,
      fetchImpl: async () => new Response(JSON.stringify(missing)),
    });
    await expect(client.getQuote(params)).rejects.toThrow(/routeId/);
  });

  it("keeps verifyBuild requests separate when modes share an upstream intent id", async () => {
    const {fetchImpl} = setup();
    const checked: (string | undefined)[] = [];
    const client = remoteProvider({name: "multi", baseUrl: "https://example.test", fetchImpl,
      verifyBuild: (quote, _tx, p) => { checked.push(p?.routeId); return p?.routeId === quote.routeId ? null : "wrong request"; },
    });
    const [taxi, bus] = await Promise.all([client.getQuote({...params, routeId: "taxi"}), client.getQuote({...params, routeId: "bus"})]);
    await client.buildDeposit(taxi!); await client.buildDeposit(bus!);
    expect(checked).toEqual(["taxi", "bus"]);
  });
});
