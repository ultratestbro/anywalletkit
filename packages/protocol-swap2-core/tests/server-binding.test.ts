import {describe, expect, it} from "vitest";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler, type Swap2Call} from "../src/server.js";
import type {CrossChainProvider, IntentRef, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

// Audit 2026-10-25, finding 12: a sealed quote and an intent id were good for ANY caller — one
// user could build another's quote, and anyone could ask the server about any swap (deposit
// addresses are public on chain), notify it or register against it. Quotes are now sealed for
// the caller (`subject`), and every swap id carries an intent token the server checks.

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453",
  destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100000000",
  destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "mock", intentId: "intent-1", depositAddress: "0x2222222222222222222222222222222222222222", depositMemo: null,
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0.1,
  etaSeconds: 30, reliability: 0.97, validUntilMs: Date.now() + 600_000,
};
const TX: UnsignedTx = {chain: "eip155:1", to: "0x3333333333333333333333333333333333333333", value: "0", data: "0x", chainId: 1};

function mockProvider() {
  const seen: {built?: string; tracked?: IntentRef; claimed?: IntentRef; notified?: string; registered?: string} = {};
  const provider: CrossChainProvider = {
    name: "mock", enabled: () => true, supportsRoute: () => true,
    getQuote: async () => ({...QUOTE}),
    buildDeposit: async (q) => { seen.built = q.intentId; return TX; },
    trackIntent: async (ref) => { seen.tracked = ref; return {state: "completed"}; },
    buildClaim: async (ref) => { seen.claimed = ref; return null; },
    notifyDeposit: async (id) => { seen.notified = id; },
    registerSignedOrder: async (id) => { seen.registered = id; },
  };
  return {provider, seen};
}

/** The handler with callers identified by the context string ("" = anonymous). */
function handler(extra: Partial<Parameters<typeof createSwap2Handler<string>>[0]> = {}) {
  const {provider, seen} = mockProvider();
  const calls: Swap2Call[] = [];
  const handle = createSwap2Handler<string>({
    providers: [provider], sealSecret: SECRET, guard: (call) => { calls.push(call); },
    subject: (user) => user || undefined, ...extra,
  });
  return {handle, seen, calls};
}
const quoteFor = async (handle: ReturnType<typeof handler>["handle"], user: string) => (await handle("quote", {provider: "mock", params: PARAMS}, user)).body as Quote;

describe("swap2 server: quotes and swaps are bound to the caller", () => {
  it("a quote's intent id carries a token; the provider only ever sees its own id", async () => {
    const {handle, seen} = handler();
    const q = await quoteFor(handle, "alice");
    expect(q.intentId).toMatch(/^intent-1~[0-9a-f]{32}$/);
    expect((await handle("build", {provider: "mock", quote: q}, "alice")).status).toBe(200);
    expect(seen.built).toBe("intent-1");
    expect((await handle("track", {provider: "mock", ref: {intentId: q.intentId, sourceTxHash: "0xaa"}}, "alice")).status).toBe(200);
    expect(seen.tracked).toEqual({intentId: "intent-1", sourceTxHash: "0xaa"});
    await handle("claim", {provider: "mock", ref: {intentId: q.intentId}}, "alice");
    expect(seen.claimed).toEqual({intentId: "intent-1"});
    await handle("notify", {provider: "mock", intentId: q.intentId, txHash: "0xbb"}, "alice");
    expect(seen.notified).toBe("intent-1");
    await handle("register", {provider: "mock", intentId: q.intentId, signature: "0xabcd"}, "alice");
    expect(seen.registered).toBe("intent-1");
  });

  it("another caller's sealed quote and swap id are refused (403) before the provider sees them", async () => {
    const {handle, seen} = handler();
    const q = await quoteFor(handle, "alice");
    expect((await handle("build", {provider: "mock", quote: q}, "bob")).status).toBe(403);
    expect((await handle("preflight", {provider: "mock", quote: q, tx: TX}, "bob")).status).toBe(403);
    for (const [action, body] of [
      ["track", {ref: {intentId: q.intentId}}], ["claim", {ref: {intentId: q.intentId}}],
      ["notify", {intentId: q.intentId, txHash: "0xbb"}], ["register", {intentId: q.intentId, signature: "0xabcd"}],
    ] as const) {
      expect((await handle(action, {provider: "mock", ...body}, "bob")).status, action).toBe(403);
    }
    expect(seen).toEqual({});
  });

  it("an id without a token, or with a forged one, is refused", async () => {
    const {handle, seen} = handler();
    const q = await quoteFor(handle, "alice");
    expect((await handle("track", {provider: "mock", ref: {intentId: "intent-1"}}, "alice")).status).toBe(403);
    expect((await handle("track", {provider: "mock", ref: {intentId: `intent-1~${"0".repeat(32)}`}}, "alice")).status).toBe(403);
    expect((await handle("track", {provider: "mock", ref: {intentId: q.intentId.replace("intent-1", "intent-2")}}, "alice")).status).toBe(403);
    expect(seen.tracked).toBeUndefined();
  });

  it("without subject, the token is a bearer capability: whoever holds the id may follow that swap, nobody else", async () => {
    const {handle, seen} = handler({subject: () => undefined});
    const q = await quoteFor(handle, "");
    expect((await handle("build", {provider: "mock", quote: q}, "anyone")).status).toBe(200);
    expect((await handle("track", {provider: "mock", ref: {intentId: q.intentId}}, "anyone")).status).toBe(200);
    expect(seen.tracked).toEqual({intentId: "intent-1"});
    expect((await handle("track", {provider: "mock", ref: {intentId: "intent-1"}}, "anyone")).status).toBe(403);
  });

  it("moving from another backend: until the cutoff, track (only) accepts an id without a token", async () => {
    let now = 1_000;
    const {handle, seen} = handler({acceptUntokenedTrackUntil: 2_000, now: () => now});
    expect((await handle("track", {provider: "mock", ref: {intentId: "legacy-7"}}, "alice")).status).toBe(200);
    expect(seen.tracked).toEqual({intentId: "legacy-7"});
    expect((await handle("claim", {provider: "mock", ref: {intentId: "legacy-7"}}, "alice")).status).toBe(403);
    expect((await handle("notify", {provider: "mock", intentId: "legacy-7", txHash: "0xbb"}, "alice")).status).toBe(403);
    now = 2_001;
    expect((await handle("track", {provider: "mock", ref: {intentId: "legacy-7"}}, "alice")).status).toBe(403);
  });

  it("guard sees the validated request, with the provider's own intent id", async () => {
    const {handle, calls} = handler();
    const q = await quoteFor(handle, "alice");
    await handle("track", {provider: "mock", ref: {intentId: q.intentId}}, "alice");
    expect(calls[0]).toMatchObject({action: "quote", provider: "mock", dry: false, request: {params: {amountIn: "100000000", destAddress: PARAMS.destAddress}}});
    expect(calls[1]).toMatchObject({action: "track", request: {ref: {intentId: "intent-1"}}});
  });

  it("end to end through remoteProvider: the app keeps the id it got and tracks with it", async () => {
    const {handle, seen} = handler();
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const client = remoteProvider({name: "mock", baseUrl: "https://api.example.test/swap2", fetchImpl});
    const q = await client.getQuote(PARAMS);
    await client.buildDeposit(q!);
    await client.notifyDeposit!(q!.intentId, "0xbb");
    expect(await client.trackIntent({intentId: q!.intentId})).toEqual({state: "completed"});
    expect(seen).toMatchObject({built: "intent-1", notified: "intent-1", tracked: {intentId: "intent-1"}});
  });
});

describe("swap2 engine over the server: the swap id it hands the app keeps the token", () => {
  it("swap2() → status by the stored id; another user cannot follow it", async () => {
    const {SingleProviderSwap2} = await import("../src/swap2/single.js");
    const DEPOSIT = "0x5555555555555555555555555555555555555555";
    const tracked: IntentRef[] = [];
    const real: CrossChainProvider = {
      name: "edge", enabled: () => true, supportsRoute: () => true,
      getQuote: async (p) => ({...QUOTE, provider: "edge", intentId: "intent.with.dots/1", depositAddress: DEPOSIT, sourceAmount: p.amountIn, validUntilMs: Date.now() + 60_000}),
      buildDeposit: async (q) => ({chain: "eip155:1", to: q.depositAddress, value: q.sourceAmount}),
      trackIntent: async (ref) => { tracked.push(ref); return {state: "completed", destTxHash: "0xdest"}; },
    };
    const handle = createSwap2Handler<string>({providers: [real], sealSecret: SECRET, guard: () => {}, subject: (u) => u});
    const over = (user: string) => remoteProvider({
      // A deposit-address provider: the app opts this stub in (scan 2026-10-28 F9).
      name: "edge", baseUrl: "https://api.example.test/swap2", depositAddressRoutes: true,
      fetchImpl: (async (url: string, init: RequestInit) => {
        const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), user);
        return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
      }) as unknown as typeof fetch,
    });
    const engine = (p: CrossChainProvider) => {
      class P extends SingleProviderSwap2 {
        protected readonly provider = p;
        protected chainSupported(): boolean { return true; }
      }
      const account = {getAddress: async () => "0x4444444444444444444444444444444444444444", getChainId: async () => 1, sendTransaction: async () => ({hash: "0xsrc"}), waitForTransaction: async () => {}};
      return new P(account as never, {fromChain: "eip155:1"});
    };
    const options = {fromToken: "ETH", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 1_000_000n, minAmountOut: 1n};
    const result = await engine(over("alice")).swap2(options as never) as {id: string};
    const status = await engine(over("alice")).getSwap2Status(result.id);
    expect(status).toMatchObject({status: "completed"});
    expect(tracked).toEqual([{intentId: "intent.with.dots/1", sourceTxHash: "0xsrc"}]);
    await expect(engine(over("bob")).getSwap2Status(result.id)).rejects.toThrow(/403/);
  });
});
