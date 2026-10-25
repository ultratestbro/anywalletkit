import {describe, expect, it} from "vitest";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler, Swap2HandlerError, type Swap2Call} from "../src/server.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453",
  destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100000000",
  destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "mock", intentId: "intent-1", depositAddress: "0x2222222222222222222222222222222222222222", depositMemo: null,
  txRequest: {to: "0x3333333333333333333333333333333333333333", data: "0xdeadbeef", value: "0", chainId: 1, approvalAddress: "0x3333333333333333333333333333333333333333"},
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0.1,
  fees: [{type: "protocol", amount: "100000", token: "eip155:1/erc20:0xa0b8", included: true}],
  etaSeconds: 30, reliability: 0.97, validUntilMs: Date.now() + 60_000, providerData: {route: "r1"},
};
const TX: UnsignedTx = {chain: "eip155:1", to: "0x3333333333333333333333333333333333333333", value: "0", data: "0xdeadbeef", chainId: 1};

function mockProvider(over: Partial<CrossChainProvider> = {}) {
  const seen: {built?: Quote; preflight?: [Quote, UnsignedTx]} = {};
  const provider: CrossChainProvider = {
    name: "mock",
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => ({...QUOTE}),
    buildDeposit: async (q) => { seen.built = q; return TX; },
    preflightDeposit: async (q, tx) => { seen.preflight = [q, tx]; },
    trackIntent: async () => ({state: "completed", destTxHash: "0xabc"}),
    ...over,
  };
  return {provider, seen};
}

/** The real client, wired straight into the handler (no network). */
function wire(handle: ReturnType<typeof createSwap2Handler<string>>, ctx = "user-1") {
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const action = String(url).split("/").pop()!;
    const res = await handle(action, JSON.parse(String(init.body)), ctx);
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  return remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl});
}

const allow = () => {};

describe("swap2 server handler", () => {
  it("round trip through remoteProvider: quote is sealed, build/preflight get the provider's own quote back, track passes through", async () => {
    const {provider, seen} = mockProvider();
    const client = wire(createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: allow}));
    const q = await client.getQuote(PARAMS);
    expect(q?.providerData?.__remoteSeal).toMatch(/^[0-9a-f]{64}$/);
    expect(await client.buildDeposit(q!)).toEqual(TX);
    expect(seen.built).toEqual(QUOTE); // seal stripped, every field intact
    await client.preflightDeposit!(q!, {...TX, value: 0n as unknown as string});
    expect(seen.preflight![1].value).toBe("0");
    // the app tracks with the id it was given (the provider's id + this server's intent token)
    expect(await client.trackIntent({intentId: q!.intentId})).toEqual({state: "completed", destTxHash: "0xabc"});
  });

  it("refuses a tampered, unsealed or expired quote before the provider sees it", async () => {
    const {provider, seen} = mockProvider();
    let now = Date.now();
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: allow, now: () => now});
    const sealed = (await handle("quote", {provider: "mock", params: PARAMS}, "u")).body as Quote;
    const tampered = {...sealed, minDestAmount: "1"};
    expect(await handle("build", {provider: "mock", quote: tampered}, "u")).toEqual({status: 400, body: {error: "quote integrity check failed"}});
    expect((await handle("build", {provider: "mock", quote: QUOTE}, "u")).status).toBe(400);
    const otherSecret = createSwap2Handler({providers: [provider], sealSecret: SECRET + "x", guard: allow});
    expect((await otherSecret("build", {provider: "mock", quote: sealed}, "u")).status).toBe(400);
    now = sealed.validUntilMs + 1;
    expect((await handle("build", {provider: "mock", quote: sealed}, "u")).status).toBe(410);
    expect(seen.built).toBeUndefined();
  });

  it("validates every field: malformed bodies, unknown actions and providers, disabled providers", async () => {
    const {provider} = mockProvider();
    const off = mockProvider({}).provider;
    const handle = createSwap2Handler({providers: [provider, {...off, name: "off", enabled: () => false}], sealSecret: SECRET, guard: allow});
    expect((await handle("quote", {provider: "mock", params: {...PARAMS, amountIn: "1e18"}}, "u")).status).toBe(400);
    expect((await handle("quote", {provider: "mock", params: {...PARAMS, slippageBps: 1.5}}, "u")).status).toBe(400);
    expect((await handle("quote", {provider: "mock", params: {...PARAMS, destAddress: "x".repeat(121)}}, "u")).status).toBe(400);
    expect((await handle("quote", "nope", "u")).status).toBe(400);
    expect((await handle("track", {provider: "mock", ref: {}}, "u")).status).toBe(400);
    expect((await handle("register", {provider: "mock", intentId: "i", signature: "not-hex"}, "u")).status).toBe(400);
    expect((await handle("drop-tables", {provider: "mock"}, "u")).status).toBe(404);
    expect((await handle("quote", {provider: "nobody", params: PARAMS}, "u")).status).toBe(404);
    expect((await handle("quote", {provider: "off", params: PARAMS}, "u")).status).toBe(403);
  });

  it("passes the provider's named refusal through, with URLs redacted; other errors stay internal", async () => {
    const {provider} = mockProvider({
      getQuote: async (p) => { p.onRefusal?.("mock: below the minimum, see https://api.mock.test/v1?apiKey=SECRET"); return null; },
      buildDeposit: async () => { throw new Error("mock: route halted at https://rpc.mock.test/key/SECRET"); },
      trackIntent: async () => { throw new Error("socket hang up at https://rpc.mock.test/key/SECRET"); },
    });
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: allow});
    const client = wire(handle);
    const err = await client.getQuote(PARAMS).catch((e: Error) => e);
    expect(String((err as Error).message)).toContain("below the minimum");
    expect(String((err as Error).message)).not.toContain("SECRET");
    const good = mockProvider().provider;
    const sealed = (await createSwap2Handler({providers: [good], sealSecret: SECRET, guard: allow})("quote", {provider: "mock", params: PARAMS}, "u")).body;
    const built = await handle("build", {provider: "mock", quote: sealed}, "u");
    expect(built.status).toBe(422);
    expect(JSON.stringify(built.body)).not.toContain("SECRET");
    expect(await handle("track", {provider: "mock", ref: {intentId: (sealed as Quote).intentId}}, "u")).toEqual({status: 500, body: {error: "internal error"}});
    // a live quote refused without a reason is said so; a display quote may be a bare null
    const silent = createSwap2Handler({providers: [mockProvider({getQuote: async () => null}).provider], sealSecret: SECRET, guard: allow});
    expect((await silent("quote", {provider: "mock", params: {...PARAMS, dry: false}}, "u")).body).toEqual({noQuote: "mock refused without naming a reason"});
    expect((await silent("quote", {provider: "mock", params: {...PARAMS, dry: true}}, "u")).body).toBeNull();
  });

  it("guard sees every call (with dry for display quotes) and can refuse it; it is required", async () => {
    const calls: Swap2Call[] = [];
    const {provider} = mockProvider();
    const handle = createSwap2Handler<string>({
      providers: [provider], sealSecret: SECRET,
      guard: (call, user) => { calls.push(call); if (user === "anon") throw new Swap2HandlerError(401, "sign in first"); },
    });
    expect(await handle("quote", {provider: "mock", params: PARAMS}, "anon")).toEqual({status: 401, body: {error: "sign in first"}});
    await handle("quote", {provider: "mock", params: {...PARAMS, dry: true}}, "u")
    expect(calls.map((c) => [c.action, c.provider, c.dry])).toEqual([["quote", "mock", false], ["quote", "mock", true]]);
    expect(() => createSwap2Handler({providers: [provider], sealSecret: SECRET} as never)).toThrow(/guard is required/);
    expect(() => createSwap2Handler({providers: [provider], sealSecret: "short", guard: allow})).toThrow(/32 bytes/);
  });

  it("refuses to seal a provider quote outside the schema (502), and answers supports from supportsRoute", async () => {
    const {provider} = mockProvider({getQuote: async () => ({...QUOTE, intentId: "x".repeat(2001)}), supportsRoute: (_f, to) => to.chain === "eip155:8453"});
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: allow});
    expect((await handle("quote", {provider: "mock", params: PARAMS}, "u")).status).toBe(502);
    expect((await handle("supports", {provider: "mock", from: {chain: "eip155:1", token: "USDC"}, to: {chain: "eip155:8453", token: "USDC"}}, "u")).body).toEqual({supported: true});
    expect((await handle("supports", {provider: "mock", from: {chain: "eip155:1", token: "USDC"}, to: {chain: "eip155:10", token: "USDC"}}, "u")).body).toEqual({supported: false});
  });
});
