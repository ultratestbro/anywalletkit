// Regression tests for the independent review (2026-11-10). The orders in review-data/ are genuine: fetched keyless
// from https://api.relay.link/quote/v2 for one and the same user request (25 USDC Arbitrum -> USDC Base), signed by
// the pinned solver. Only the request options an answering side can add on the way to the real API differ:
//   base — what the module sends; appfee — + appFees (3 %); topup — + topupGas; slip — + slippageTolerance "4900".
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {forgetClearedOrders} from "../src/cleared.js";
import {relayProvider, type RelayClearedStore} from "../src/provider.js";
import {RELAY_DEFAULT_SLIPPAGE_BPS, relayClearOrder, relayPins, verifyRelayOrder, type RelayRequest} from "../src/verify.js";
import {loadQuote, type QuoteFixture} from "./fixtures.js";

interface Live {request: Omit<RelayRequest, "amount"> & {amount: string; nowMs: number}; response: any}
const load = (n: string): Live => JSON.parse(readFileSync(fileURLToPath(new URL(`./review-data/${n}.json`, import.meta.url)), "utf8")) as Live;
const req = (l: Live, over: Partial<RelayRequest> = {}): RelayRequest => ({...l.request, amount: BigInt(l.request.amount), ...over});
const dep = (l: Live) => l.response.steps.find((s: any) => s.id === "deposit").items[0].data;
type Fx = {request: {sourceChain: string; destChain: string; sourceToken: string; destToken: string; amount: string; recipient: string; depositor: string}};
const params = (l: Fx, over: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: l.request.sourceChain, destChain: l.request.destChain, sourceToken: l.request.sourceToken, destToken: l.request.destToken,
  amountIn: l.request.amount, destAddress: l.request.recipient, refundAddress: l.request.depositor, dry: false, ...over,
} as QuoteParams);
const serve = (body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), {status: 200})) as typeof fetch;
async function refusalOf(l: Live, over: Partial<QuoteParams> = {}): Promise<{quote: Quote | null; reasons: string[]}> {
  vi.setSystemTime(l.request.nowMs);
  const reasons: string[] = [];
  const quote = await relayProvider({fetchImpl: serve(l.response)}).getQuote({...params(l, over), onRefusal: (r) => reasons.push(r)});
  return {quote, reasons};
}

const USDC = "user.arb-usdc_base-usdc";

beforeEach(() => { vi.useFakeTimers({toFake: ["Date"]}); forgetClearedOrders(); });
afterEach(() => { vi.useRealTimers(); });

describe("extras added to the request on the way to Relay", () => {
  it("the honest order passes with no slippage named: its minimum is exactly the default below the expected amount", async () => {
    const base = load("base");
    const v = verifyRelayOrder(req(base), base.response.protocol.v2, dep(base));
    expect(v.expectedAmount).toBe(24_976_275n);
    expect(v.minimumAmount).toBe(24_476_750n);
    expect(RELAY_DEFAULT_SLIPPAGE_BPS).toBe(200);
    const {quote, reasons} = await refusalOf(base);
    expect(reasons).toEqual([]);
    expect(quote!.destAmount).toBe("24976275");
  });

  it("an app fee the response accounts for is refused (app-fee)", async () => {
    const {quote, reasons} = await refusalOf(load("appfee"));
    expect(quote).toBeNull();
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/\[app-fee\]$/);
  });

  it("a gas top-up the response accounts for is refused (gas-topup)", async () => {
    const {quote, reasons} = await refusalOf(load("topup"));
    expect(quote).toBeNull();
    expect(reasons[0]).toMatch(/\[gas-topup\]$/);
  });

  it("a minimum 49 % under the expected amount is refused when the caller named no slippage (output-minimum)", async () => {
    const l = load("slip");
    expect(() => verifyRelayOrder(req(l), l.response.protocol.v2, dep(l))).toThrow(/\[output-minimum\]$/);
    const {quote, reasons} = await refusalOf(l);
    expect(quote).toBeNull();
    expect(reasons[0]).toMatch(/\[output-minimum\]$/);
    // …and is the caller's to allow, up to the module's ceiling.
    expect(() => verifyRelayOrder(req(l, {slippageBps: 4_900}), l.response.protocol.v2, dep(l))).not.toThrow();
  });

  it("the slippage is always named in the request: the default, or the caller's", async () => {
    const base = load("base");
    vi.setSystemTime(base.request.nowMs);
    const bodies: any[] = [];
    const f = (async (_u: unknown, init?: RequestInit) => { bodies.push(JSON.parse(init!.body as string)); return new Response(JSON.stringify(base.response), {status: 200}); }) as typeof fetch;
    const p = relayProvider({fetchImpl: f});
    await p.getQuote(params(base));
    await p.getQuote(params(base, {slippageBps: 300}));
    expect(bodies.map((b) => b.slippageTolerance)).toEqual(["200", "300"]);
    for (const b of bodies) for (const k of ["appFees", "topupGas", "topupGasAmount", "referrer", "txs"]) expect(b).not.toHaveProperty(k);
  });

  it("KNOWN LIMIT: with the fee line stripped from the response a genuine lower order passes — only the caller's floor stops it", async () => {
    const l = load("appfee");
    delete l.response.fees.app;
    const open = await refusalOf(l);
    expect(open.reasons).toEqual([]);
    expect(open.quote!.destAmount).toBe("24226275"); // 0.75 USDC under the honest order, shown as it is
    const floored = await refusalOf(l, {minAmountOut: "24400000"});
    expect(floored.quote).toBeNull();
    expect(floored.reasons[0]).toMatch(/\[output-minimum\]$/);
  });
});

describe("one deposit per order", () => {
  const sign = async (p: ReturnType<typeof relayProvider>, f: QuoteFixture): Promise<UnsignedTx> => {
    const q = (await p.getQuote(params(f)))!;
    const tx = await p.buildDeposit(q);
    await p.preflightDeposit!(q, tx);
    return tx;
  };

  it("a second provider instance refuses the order the first one cleared, 9 minutes later", async () => {
    const f = loadQuote(USDC);
    vi.setSystemTime(f.request.nowMs);
    await sign(relayProvider({fetchImpl: serve(f.response)}), f);
    vi.setSystemTime(f.request.nowMs + 9 * 60_000);
    await expect(sign(relayProvider({fetchImpl: serve(f.response)}), f)).rejects.toThrow(/\[order-reused\]$/);
  });

  it("the record outlives the window in which the order is accepted at all", async () => {
    const f = loadQuote(USDC);
    vi.setSystemTime(f.request.nowMs - 4 * 60_000); // a device clock 4 minutes behind stretches the window
    await sign(relayProvider({fetchImpl: serve(f.response)}), f);
    vi.setSystemTime(f.request.nowMs + 9 * 60_000 + 30_000);
    await expect(sign(relayProvider({fetchImpl: serve(f.response)}), f)).rejects.toThrow(/\[order-reused\]$/);
    vi.setSystemTime(f.request.nowMs + 11 * 60_000);
    const reasons: string[] = [];
    expect(await relayProvider({fetchImpl: serve(f.response)}).getQuote({...params(f), onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons[0]).toMatch(/\[output-deadline\]$/); // too old to be accepted anywhere
  });

  it("the remote path: the client refuses a second build for the same order", async () => {
    const f = loadQuote(USDC);
    vi.setSystemTime(f.request.nowMs);
    const inner = relayProvider({fetchImpl: serve(f.response)});
    const quote = (await inner.getQuote(params(f)))!;
    const tx = await inner.buildDeposit(quote);
    const backend = (async (url: RequestInfo | URL) => {
      const action = String(url).split("/").pop()!;
      return new Response(JSON.stringify(action === "quote" ? quote : action === "build" ? tx : {}), {status: 200});
    }) as typeof fetch;
    const stub = remoteProvider({name: "relay", baseUrl: "https://backend.example/api", fetchImpl: backend, ...relayPins});
    const q1 = (await stub.getQuote(params(f)))!;
    expect((await stub.buildDeposit(q1)).data).toBe(tx.data);
    vi.setSystemTime(f.request.nowMs + 4 * 60_000);
    const other = remoteProvider({name: "relay", baseUrl: "https://backend.example/api", fetchImpl: backend, ...relayPins});
    const q2 = (await other.getQuote(params(f)))!;
    await expect(other.buildDeposit(q2)).rejects.toThrow(/order-reused/);
  });

  it("a server and its client in one realm do not trip each other: build and sign are recorded apart", () => {
    const id = `0x${"ab".repeat(32)}`;
    relayClearOrder(id, "build");
    expect(() => relayClearOrder(id, "sign")).not.toThrow();
    expect(() => relayClearOrder(id.toUpperCase().replace("0X", "0x"), "sign")).toThrow(/\[order-reused\]$/);
    expect(() => relayClearOrder(id, "build")).toThrow(/\[order-reused\]$/);
  });

  it("a full record refuses rather than forgets, and frees itself as entries expire", () => {
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < 4096; i++) relayClearOrder(`0x${i.toString(16).padStart(64, "0")}`, "sign", t0);
    expect(() => relayClearOrder(`0x${"ff".repeat(32)}`, "sign", t0 + 1)).toThrow(/\[order-reused\]$/);
    expect(() => relayClearOrder(`0x${"ff".repeat(32)}`, "sign", t0 + 30 * 60_000)).not.toThrow();
  });

  it("a durable store carries it across restarts: asked before, written with the order's deadline", async () => {
    const f = loadQuote(USDC);
    vi.setSystemTime(f.request.nowMs);
    const kept = new Map<string, number>();
    const store: RelayClearedStore = {has: (id) => kept.has(id), add: (id, until) => { kept.set(id, until); }};
    await sign(relayProvider({fetchImpl: serve(f.response), clearedStore: store}), f);
    expect(kept.size).toBe(1);
    const [id, until] = [...kept][0]!;
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    expect(until).toBeGreaterThan(f.request.nowMs + 6 * 86_400_000);
    forgetClearedOrders(); // the restart
    await expect(sign(relayProvider({fetchImpl: serve(f.response), clearedStore: store}), f)).rejects.toThrow(/\[order-reused\]$/);
  });

  it("a store that fails refuses the signature", async () => {
    const f = loadQuote(USDC);
    vi.setSystemTime(f.request.nowMs);
    const broken: RelayClearedStore = {has: () => { throw new Error("disk"); }, add: () => undefined};
    await expect(sign(relayProvider({fetchImpl: serve(f.response), clearedStore: broken}), f)).rejects.toThrow(/disk/);
    forgetClearedOrders();
    const half: RelayClearedStore = {has: () => false, add: async () => { throw new Error("full"); }};
    await expect(sign(relayProvider({fetchImpl: serve(f.response), clearedStore: half}), f)).rejects.toThrow(/full/);
  });
});

describe("values of a remote quote no order binds", () => {
  async function honest(): Promise<{f: QuoteFixture; quote: Quote}> {
    const f = loadQuote(USDC);
    vi.setSystemTime(f.request.nowMs);
    return {f, quote: (await relayProvider({fetchImpl: serve(f.response)}).getQuote(params(f)))!};
  }
  const MAX = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

  it("the honest quote passes", async () => {
    const {f, quote} = await honest();
    expect(await relayPins.verifyQuote!(params(f), quote)).toBeNull();
  });

  it.each<[string, (q: Quote, now: number) => Quote, RegExp]>([
    ["a gas limit that starves the deposit", (q) => ({...q, txRequest: {...q.txRequest!, gasLimit: "21000"}}), /\[quote-gas\]$/],
    ["a gas limit of 2^256-1", (q) => ({...q, txRequest: {...q.txRequest!, gasLimit: MAX}}), /\[quote-gas\]$/],
    ["a gas limit over the cap", (q) => ({...q, txRequest: {...q.txRequest!, gasLimit: "60000001"}}), /\[quote-gas\]$/],
    ["a hex gas limit", (q) => ({...q, txRequest: {...q.txRequest!, gasLimit: "0x30d40"}}), /\[quote-gas\]$/],
    ["a numeric gas limit", (q) => ({...q, txRequest: {...q.txRequest!, gasLimit: 200000 as never}}), /\[quote-gas\]$/],
    ["a life of a year", (q, now) => ({...q, validUntilMs: now + 365 * 86_400_000}), /\[quote-expiry\]$/],
    ["no expiry", (q) => { const {validUntilMs: _v, ...rest} = q; return rest as Quote; }, /\[quote-expiry\]$/],
    ["an id that is not its request id", (q) => ({...q, intentId: `relay:0x${"ab".repeat(32)}`}), /\[quote-shape\]$/],
    ["an id of the backend's liking", (q) => ({...q, intentId: "relay:anything", providerData: {...q.providerData!, requestId: "anything"}}), /\[quote-shape\]$/],
  ])("refuses %s", async (_n, edit, why) => {
    const {f, quote} = await honest();
    const forged = edit(quote, f.request.nowMs);
    expect(await relayPins.verifyQuote!(params(f), forged)).toMatch(why);
    const tx = {chain: f.request.sourceChain, ...(forged.txRequest as object)} as UnsignedTx;
    expect(await relayPins.verifyBuild!(forged, tx, params(f))).toMatch(why);
  });

  it("the native floor is lower than the ERC-20 one", async () => {
    const f = loadQuote("user.op-eth_base-eth");
    vi.setSystemTime(f.request.nowMs);
    const quote = (await relayProvider({fetchImpl: serve(f.response)}).getQuote(params(f)))!;
    expect(await relayPins.verifyQuote!(params(f), {...quote, txRequest: {...quote.txRequest!, gasLimit: "90000"}})).toBeNull();
    expect(await relayPins.verifyQuote!(params(f), {...quote, txRequest: {...quote.txRequest!, gasLimit: "89999"}})).toMatch(/\[quote-gas\]$/);
  });

  it("DISPLAY ONLY: fee, ETA and reliability are the answering side's word, and status is the endpoint's", async () => {
    const {f, quote} = await honest();
    expect(await relayPins.verifyQuote!(params(f), {...quote, feeUsd: 0, fees: [], etaSeconds: 1, reliability: 1})).toBeNull();
    const fake = `0x${"ee".repeat(32)}`;
    const said = await relayProvider({fetchImpl: serve({status: "success", txHashes: [fake]})})
      .trackIntent({intentId: `relay:0x${"cd".repeat(32)}`, sourceTxHash: `0x${"01".repeat(32)}`} as never);
    expect(said).toEqual({state: "completed", depositReceived: true, destTxHash: fake});
  });
});
