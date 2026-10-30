import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {Buffer} from "buffer";
import {Address, beginCell, type Cell} from "@ton/core";
import {describe, expect, it} from "vitest";
import {checkTonSwapPayload, omnistonProvider, TonSwapPayloadError, type TonSwapCheckInput, type TonSwapLeg} from "../src/provider.js";
import {createOmnistonTonValidators} from "../src/validators/ton.js";

/** Real `tonBuildSwap` bodies (build-only, never signed or sent) with their quotes
 *  and the tonapi reads their legs need — see the file's `source`/`note`. */
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live-ton-swaps-2026-10-22.json", import.meta.url), "utf8")) as {
  cases: {
    pair: string; amount: string; protocols: string; trader: string; dest: string;
    quote: Record<string, any>;
    messages: {targetAddress: string; sendAmount: string; payload: string}[];
    expect: {layout?: string; minOut?: string; legs?: (TonSwapLeg & {ok?: boolean})[]; refused?: string};
  }[];
  tonapi: Record<string, unknown>;
};

const jettonOf = (asset: any): string | null | undefined =>
  asset?.chain?.value?.kind?.$case === "native" ? null : asset?.chain?.value?.kind?.value;

function inputFor(c: (typeof fixture.cases)[number], override: Partial<TonSwapCheckInput> = {}): TonSwapCheckInput {
  const m = c.messages[0]!;
  const swap = c.quote.settlementData.value;
  return {
    payloadHex: m.payload, targetAddress: m.targetAddress, sendAmount: BigInt(m.sendAmount), trader: c.trader, dest: c.dest,
    inputUnits: c.quote.inputUnits, minOutputAmount: swap.minOutputAmount,
    inputJetton: jettonOf(c.quote.inputAsset) ?? null, outputJetton: jettonOf(c.quote.outputAsset) ?? null,
    steps: swap.routes[0].steps.map((s: any) => ({protocol: s.chunks[0].protocol, inputJetton: jettonOf(s.inputAsset), outputJetton: jettonOf(s.outputAsset)})),
    ...override,
  };
}

const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    if (error instanceof TonSwapPayloadError) return error.reason;
    throw error;
  }
  return "passed";
};

/** Offline tonapi: serves the recorded reads, 404 for anything else. */
const replay = (overrides: Record<string, unknown> = {}) => (async (url: string) => {
  const path = String(url).replace(/^https:\/\/tonapi\.io/, "");
  const body = overrides[path] ?? fixture.tonapi[path];
  return body ? new Response(JSON.stringify(body), {status: 200}) : new Response("{}", {status: 404});
}) as unknown as typeof fetch;

const live = fixture.cases.filter((c) => !c.expect.refused);
const byLayout = (layout: string, pick: (c: (typeof live)[number]) => boolean = () => true) =>
  live.find((c) => c.expect.layout === layout && pick(c))!;

describe("TON swap payload decoder — real Omniston builds (2026-10-22)", () => {
  it("covers every layout seen live", () => {
    expect(new Set(live.map((c) => c.expect.layout))).toEqual(new Set(["stonfi-v1", "stonfi-v2", "dedust-v1", "dedust-v2"]));
    expect(live.some((c) => c.protocols === "StonFiV1" && c.pair === "GRAM>USDT")).toBe(true);
    expect(live.some((c) => c.quote.settlementData.value.routes[0].steps.length === 2)).toBe(true);
  });

  for (const c of live) {
    it(`${c.pair} ${c.amount} via ${c.protocols} passes with its quote`, async () => {
      const result = checkTonSwapPayload(inputFor(c));
      expect(result.layout).toBe(c.expect.layout);
      expect(String(result.minOut)).toBe(c.expect.minOut);
      expect(BigInt(c.expect.minOut!)).toBeGreaterThanOrEqual(BigInt(c.quote.settlementData.value.minOutputAmount));
      expect(result.legs).toEqual(c.expect.legs!.map(({ok: _ok, ...leg}) => leg));
      const validators = createOmnistonTonValidators({fetch: replay()});
      for (const leg of result.legs) expect(await validators.validateTonSwapLeg!(leg), JSON.stringify(leg)).toBe(true);
    });
  }

  it("refuses a protocol it cannot decode (SwapCoffee, seen live at 1 GRAM) by name", () => {
    const c = fixture.cases.find((x) => x.protocols === "SwapCoffee")!;
    expect(reason(() => checkTonSwapPayload(inputFor(c)))).toBe("unsupported-ton-route");
  });

  it("binds the body to the quote it was built for: another trader / destination / bigger minimum is refused", () => {
    const c = byLayout("stonfi-v2", (x) => x.pair === "USDT>GRAM");
    const attacker = ATTACKER;
    expect(reason(() => checkTonSwapPayload(inputFor(c, {dest: attacker})))).toBe("receiver-not-destination");
    expect(reason(() => checkTonSwapPayload(inputFor(c, {trader: attacker, dest: attacker})))).toMatch(/not-trader/);
    const higher = String(BigInt(c.quote.settlementData.value.minOutputAmount) + 1n);
    expect(reason(() => checkTonSwapPayload(inputFor(c, {minOutputAmount: higher})))).toBe("min-out-below-quote");
    expect(reason(() => checkTonSwapPayload(inputFor(c, {inputUnits: "1"})))).toBe("amount-mismatch");
  });

  it("refuses a body whose layout is not what the quoted protocol builds", () => {
    const dedust = byLayout("dedust-v1", (x) => x.pair === "USDT>GRAM");
    const steps = inputFor(dedust).steps.map((s) => ({...s, protocol: "StonFiV2"}));
    expect(reason(() => checkTonSwapPayload(inputFor(dedust, {steps})))).toBe("unknown-layout");
  });

  it("refuses split and multi-route quotes, and a hop count that differs from the route", () => {
    const c = byLayout("stonfi-v2", (x) => x.pair === "USDT>sUSDe");
    const steps = inputFor(c).steps;
    expect(reason(() => checkTonSwapPayload(inputFor(c, {steps: [steps[0]!]})))).toBe("unsupported-ton-route");
    expect(reason(() => checkTonSwapPayload(inputFor(c, {steps: [{...steps[0]!, protocol: "split(StonFiV2|DeDust)"}, steps[1]!]})))).toBe("unsupported-ton-route");
    expect(reason(() => checkTonSwapPayload(inputFor(c, {steps: [steps[0]!, {...steps[1]!, protocol: "DeDust"}]})))).toBe("unsupported-ton-route");
  });
});

// ── Synthetic bodies in the real layouts: one field changed at a time ─────────

const TRADER = "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq";
const ATTACKER = new Address(0, Buffer.alloc(32, 7)).toString({bounceable: false});
const USDT = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const POOL = "EQAH4MY1EbqP7Gg2wJkoZvoCG4BYPsEG5lVBXPZn0UqXNz4y";
const ROUTER = "EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt";
const ASK = "0:4eec921b9d4d56a0d94676016d49c26b39b1d7901a7e153e66033f146a0886f4";
const A = (s: string | null) => (s ? Address.parse(s) : null);

const nativeStep = (protocol: string) => [{protocol, inputJetton: null, outputJetton: USDT}];
const base = (payload: Cell, protocol: string, extra: Partial<TonSwapCheckInput> = {}): TonSwapCheckInput => ({
  payloadHex: payload.toBoc().toString("hex"), targetAddress: POOL, sendAmount: 1_100_000_000n, trader: TRADER, dest: TRADER,
  inputUnits: "1000000000", minOutputAmount: "1418292", inputJetton: null, outputJetton: USDT, steps: nativeStep(protocol), ...extra,
});

function dedustV2Native(o: {amount?: bigint; minOut?: bigint; next?: boolean; partner?: boolean; fulfill?: string | null; reject?: string | null; excess?: string | null} = {}): Cell {
  const payment = beginCell().storeUint(0xc442500f, 32).storeCoins(o.minOut ?? 1_418_292n).storeUint(0, 40)
    .storeMaybeRef(o.next ? beginCell().storeAddress(A(POOL)).storeCoins(0).storeUint(0, 40).storeMaybeRef(null).endCell() : null)
    .storeBit(o.partner ?? false);
  if (o.partner) payment.storeBuffer(Buffer.alloc(32), 32).storeUint(100, 16);
  payment.storeBit(false);
  const options = (b: ReturnType<typeof beginCell>, dest: string | null) => b.storeAddress(A(dest)).storeCoins(0).storeMaybeRef(null).storeBit(false);
  const payout = beginCell();
  options(payout, o.fulfill === undefined ? TRADER : o.fulfill);
  options(payout, o.reject === undefined ? TRADER : o.reject);
  payout.storeAddress(A(o.excess === undefined ? TRADER : o.excess));
  return beginCell().storeUint(0xa5a7cbf8, 32).storeUint(7, 64).storeCoins(o.amount ?? 1_000_000_000n).storeRef(payment.endCell()).storeRef(payout.endCell()).endCell();
}

function stonV1ViaPton(o: {amount?: bigint; to?: string; minOut?: bigint; response?: string; referral?: string | null; fwd?: bigint} = {}): Cell {
  const swap = beginCell().storeUint(0x25938561, 32).storeAddress(A(ASK)).storeCoins(o.minOut ?? 1_418_292n).storeAddress(A(o.to ?? TRADER));
  if (o.referral) swap.storeBit(true).storeAddress(A(o.referral)); else swap.storeBit(false);
  return beginCell().storeUint(0x0f8a7ea5, 32).storeUint(9, 64).storeCoins(o.amount ?? 1_000_000_000n).storeAddress(A(ROUTER))
    .storeAddress(A(o.response ?? TRADER)).storeMaybeRef(null).storeCoins(o.fwd ?? 100_000_000n).storeBit(true).storeRef(swap.endCell()).endCell();
}

function stonV2Hop(o: {minOut?: bigint; receiver?: string; refund?: string; excess?: string; custom?: Cell | null; fwdGas?: bigint; refFee?: number; refAddr?: string | null; refundPayload?: boolean} = {}): Cell {
  const body = beginCell().storeCoins(o.minOut ?? 1_418_292n).storeAddress(A(o.receiver ?? TRADER)).storeCoins(o.fwdGas ?? (o.custom ? 300_000_000n : 0n))
    .storeMaybeRef(o.custom ?? null).storeCoins(0).storeMaybeRef(o.refundPayload ? beginCell().endCell() : null).storeUint(o.refFee ?? 0, 16).storeAddress(A(o.refAddr ?? null));
  return beginCell().storeUint(0x6664de2a, 32).storeAddress(A(ASK)).storeAddress(A(o.refund ?? TRADER)).storeAddress(A(o.excess ?? TRADER))
    .storeUint(0xffffffffn, 64).storeRef(body.endCell()).endCell();
}

function ptonV2(o: {amount?: bigint; refund?: string; swap?: Cell} = {}): Cell {
  return beginCell().storeUint(0x01f3835d, 32).storeUint(3, 64).storeCoins(o.amount ?? 1_000_000_000n).storeAddress(A(o.refund ?? TRADER))
    .storeBit(true).storeRef(o.swap ?? stonV2Hop()).endCell();
}

function dedustV1Jetton(o: {recipient?: string | null; limit?: bigint; next?: boolean; kind?: number; referral?: string | null} = {}): Cell {
  const params = beginCell().storeUint(0, 32).storeAddress(A(o.recipient === undefined ? TRADER : o.recipient)).storeAddress(A(o.referral ?? null)).storeMaybeRef(null).storeMaybeRef(null);
  const forward = beginCell().storeUint(0xe3a0d482, 32).storeAddress(A(POOL)).storeUint(o.kind ?? 0, 1).storeCoins(o.limit ?? 730_000_000n)
    .storeMaybeRef(o.next ? beginCell().storeAddress(A(POOL)).storeUint(0, 1).storeCoins(0).storeMaybeRef(null).endCell() : null).storeRef(params.endCell());
  return beginCell().storeUint(0x0f8a7ea5, 32).storeUint(1, 64).storeCoins(1_000_000n).storeAddress(A(ROUTER)).storeAddress(A(TRADER))
    .storeMaybeRef(null).storeCoins(100_000_000n).storeBit(true).storeRef(forward.endCell()).endCell();
}
const jettonIn = {inputJetton: USDT, outputJetton: null, inputUnits: "1000000", minOutputAmount: "730000000", steps: [{protocol: "DeDust", inputJetton: USDT, outputJetton: null}]};

describe("TON swap payload decoder — attacks on each layout", () => {
  it("DeDust CPMM v2 native: the honest body passes; receiver / refund / excess / minimum / hops / fees are bound", () => {
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native(), "DeDustCPMMV2")))).toBe("passed");
    // addr_none = "the sender" is accepted only because the destination is the trader.
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({fulfill: null}), "DeDustCPMMV2")))).toBe("passed");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({fulfill: null}), "DeDustCPMMV2", {dest: "UQCK-8sWM1jrIL4a6bYQopOAONhKEIfn9JzMv4BG9ZyFn5M9"})))).toBe("receiver-not-destination");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({fulfill: ATTACKER}), "DeDustCPMMV2")))).toBe("receiver-not-destination");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({reject: ATTACKER}), "DeDustCPMMV2")))).toBe("refund-not-trader");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({excess: ATTACKER}), "DeDustCPMMV2")))).toBe("excess-not-trader");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({minOut: 0n}), "DeDustCPMMV2")))).toBe("min-out-zero");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({minOut: 1_418_291n}), "DeDustCPMMV2")))).toBe("min-out-below-quote");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({amount: 999_999_999n}), "DeDustCPMMV2")))).toBe("amount-mismatch");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({next: true}), "DeDustCPMMV2")))).toBe("unsupported-ton-route");
    expect(reason(() => checkTonSwapPayload(base(dedustV2Native({partner: true}), "DeDustCPMMV2")))).toBe("referral");
  });

  it("STON.fi v1 native (pTON v1): the honest body passes; receiver / minimum / referral / excess are bound", () => {
    const v1 = (o: Parameters<typeof stonV1ViaPton>[0] = {}, extra: Partial<TonSwapCheckInput> = {}) =>
      reason(() => checkTonSwapPayload(base(stonV1ViaPton(o), "StonFiV1", {targetAddress: "EQARULUYsmJq1RiZ-YiH-IJLcAZUVkVff-KBPwEmmaQGH6aC", ...extra})));
    expect(v1()).toBe("passed");
    expect(v1({to: ATTACKER})).toBe("receiver-not-destination");
    expect(v1({minOut: 0n})).toBe("min-out-zero");
    expect(v1({minOut: 1n})).toBe("min-out-below-quote");
    expect(v1({response: ATTACKER})).toBe("excess-not-trader");
    expect(v1({referral: ATTACKER})).toBe("referral");
    expect(v1({referral: ATTACKER}, {integratorAddress: ATTACKER})).toBe("passed");
    expect(v1({amount: 1n})).toBe("amount-mismatch");
  });

  it("STON.fi v2 native (pTON v2) and cross-swap: refund / excess / receiver / referral / layout are bound", () => {
    const v2 = (body: Cell, extra: Partial<TonSwapCheckInput> = {}) => reason(() => checkTonSwapPayload(base(body, "StonFiV2", extra)));
    expect(v2(ptonV2())).toBe("passed");
    expect(v2(ptonV2({refund: ATTACKER}))).toBe("refund-not-trader");
    expect(v2(ptonV2({amount: 1n}))).toBe("amount-mismatch");
    expect(v2(ptonV2({swap: stonV2Hop({receiver: ATTACKER})}))).toBe("receiver-not-destination");
    expect(v2(ptonV2({swap: stonV2Hop({refund: ATTACKER})}))).toBe("refund-not-trader");
    expect(v2(ptonV2({swap: stonV2Hop({excess: ATTACKER})}))).toBe("excess-not-trader");
    expect(v2(ptonV2({swap: stonV2Hop({minOut: 0n})}))).toBe("min-out-zero");
    expect(v2(ptonV2({swap: stonV2Hop({refAddr: ATTACKER, refFee: 100})}))).toBe("referral");
    expect(v2(ptonV2({swap: stonV2Hop({refundPayload: true})}))).toBe("unknown-layout");
    // The final hop must not carry a custom payload (it would be another swap).
    expect(v2(ptonV2({swap: stonV2Hop({custom: stonV2Hop()})}))).toBe("unsupported-ton-route");
    // Cross-swap: first hop pays the next router, the last one the trader; the last minimum is the one bound.
    const USDE = "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f";
    const twoSteps = [{protocol: "StonFiV2", inputJetton: null, outputJetton: USDE}, {protocol: "StonFiV2", inputJetton: USDE, outputJetton: USDT}];
    const cross = (last: Parameters<typeof stonV2Hop>[0]) => ptonV2({swap: stonV2Hop({receiver: ROUTER, minOut: 5n, custom: stonV2Hop(last)})});
    expect(v2(cross({}), {steps: twoSteps})).toBe("passed");
    expect(v2(cross({receiver: ATTACKER}), {steps: twoSteps})).toBe("receiver-not-destination");
    expect(v2(cross({minOut: 1n}), {steps: twoSteps})).toBe("min-out-below-quote");
    expect(v2(cross({refund: ATTACKER}), {steps: twoSteps})).toBe("refund-not-trader");
    const legs = checkTonSwapPayload(base(cross({}), "StonFiV2", {steps: twoSteps})).legs;
    expect(legs.map((l) => l.kind === "stonfi-router" && l.router)).toEqual([null, Address.parse(ROUTER).toString()]);
  });

  it("DeDust v1 jetton vault: recipient / minimum / multi-hop / kind / referral are bound", () => {
    const d = (o: Parameters<typeof dedustV1Jetton>[0] = {}) => reason(() => checkTonSwapPayload({...base(dedustV1Jetton(o), "DeDust"), ...jettonIn}));
    expect(d()).toBe("passed");
    expect(d({recipient: ATTACKER})).toBe("receiver-not-destination");
    expect(d({limit: 0n})).toBe("min-out-zero");
    expect(d({limit: 729_999_999n})).toBe("min-out-below-quote");
    expect(d({next: true})).toBe("unsupported-ton-route");
    expect(d({kind: 1})).toBe("unknown-layout");
    expect(d({referral: ATTACKER})).toBe("referral");
  });

  it("refuses unknown ops, trailing data and truncated bodies", () => {
    expect(reason(() => checkTonSwapPayload(base(beginCell().storeUint(0xdeadbeef, 32).storeUint(1, 64).endCell(), "DeDustCPMMV2")))).toBe("unknown-layout");
    const trailing = beginCell().storeSlice(dedustV2Native().beginParse()).storeUint(1, 8).endCell();
    expect(reason(() => checkTonSwapPayload(base(trailing, "DeDustCPMMV2")))).toBe("unknown-layout");
    // The old synthetic test body: right op, nothing after the query id.
    expect(() => checkTonSwapPayload(base(beginCell().storeUint(0xa5a7cbf8, 32).storeUint(1, 64).endCell(), "DeDustCPMMV2"))).toThrow();
  });
});

describe("validateTonSwapLeg (offline tonapi replay)", () => {
  const v1 = fixture.cases.find((c) => c.protocols === "StonFiV1" && c.pair === "GRAM>USDT")!;
  const v1Leg = v1.expect.legs![0]! as Extract<TonSwapLeg, {kind: "stonfi-router"}> & {ok?: boolean};
  const {ok: _ok, ...leg} = v1Leg;

  it("accepts the router's pTON v1 wallet naming that router, and the router's own ask wallet", async () => {
    expect(leg.proxyTonWallet).toBeDefined();
    expect(await createOmnistonTonValidators({fetch: replay()}).validateTonSwapLeg!(leg)).toBe(true);
  });

  it("refuses a pTON wallet owned by someone else, a wrong ask wallet, and a router that is not a STON.fi router", async () => {
    const validators = createOmnistonTonValidators({fetch: replay()});
    // The transfer names another router than the pTON wallet's owner.
    expect(await validators.validateTonSwapLeg!({...leg, router: "0:92e1411ae546892f33b2c8a89ea90390d8ff4cfbb917a643b91e73f706fdb9d1"})).toBe(false);
    expect(await validators.validateTonSwapLeg!({...leg, askWallet: ATTACKER})).toBe(false);
    expect(await validators.validateTonSwapLeg!({...leg, outputJetton: "EQD0Evpk4timFOHmy4Sv3l_KEUXlM-dN1_KhroTCfB2wkO89"})).toBe(false);
    expect(await validators.validateTonSwapLeg!({...leg, version: 2})).toBe(false);
    // A jetton wallet that is not a proxy-TON wallet (the trader's own USDT wallet shape).
    const walletPath = `/v2/blockchain/accounts/${encodeURIComponent(leg.proxyTonWallet!)}/methods/get_wallet_data`;
    const real = fixture.tonapi[walletPath] as {stack: {type: string; cell?: string}[]};
    const usdtMaster = beginCell().storeAddress(Address.parse(USDT)).endCell().toBoc().toString("hex");
    const forged = {...real, stack: [real.stack[0], real.stack[1], {type: "cell", cell: usdtMaster}, ...real.stack.slice(3)]};
    expect(await createOmnistonTonValidators({fetch: replay({[walletPath]: forged})}).validateTonSwapLeg!(leg)).toBe(false);
  });

  it("refuses a DeDust pool that trades another pair", async () => {
    const pool = fixture.cases.find((c) => c.expect.layout === "dedust-v1" && c.pair === "USDT>FDUSD")!.expect.legs![0]! as Extract<TonSwapLeg, {kind: "dedust-pool"}> & {ok?: boolean};
    const {ok: _o, ...dedust} = pool;
    const validators = createOmnistonTonValidators({fetch: replay()});
    expect(await validators.validateTonSwapLeg!(dedust)).toBe(true);
    expect(await validators.validateTonSwapLeg!({...dedust, outputJetton: null})).toBe(false);
    const v2 = fixture.cases.find((c) => c.expect.layout === "dedust-v2")!.expect.legs![0]! as Extract<TonSwapLeg, {kind: "dedust-pool"}> & {ok?: boolean};
    const {ok: _p, ...cpmm} = v2;
    expect(await validators.validateTonSwapLeg!(cpmm)).toBe(true);
    expect(await validators.validateTonSwapLeg!({...cpmm, outputJetton: "EQD0Evpk4timFOHmy4Sv3l_KEUXlM-dN1_KhroTCfB2wkO89"})).toBe(false);
    // The DeDust v2 pool is not a v1 pool and vice versa.
    expect(await validators.validateTonSwapLeg!({...cpmm, version: 1})).toBe(false);
  });
});

// ── Through the provider: build-only replays of the captured bodies ───────────

const SYMBOL: Record<string, string> = {
  "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs": "USDT",
  "EQD0Evpk4timFOHmy4Sv3l_KEUXlM-dN1_KhroTCfB2wkO89": "FDUSD",
};
const trusted = {"ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"]};

function replayClient(quote: Record<string, any>, messages: unknown[]) {
  const q = {...quote, rfqId: "rfq1", quoteTimestamp: Math.floor(Date.now() / 1000)};
  const once = <T>(events: T[]) => ({subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }});
  return {
    requestForQuote: () => once([{$case: "ack", value: {rfqId: "rfq1"}}, {$case: "quoteUpdated", rfqId: "rfq1", value: q}]),
    tonBuildSwap: async () => ({messages}),
    swapTrack: () => once([]), orderTrack() { throw new Error("no"); }, tonBuildEscrowTransfer() { throw new Error("no"); },
  };
}

async function buildCase(c: (typeof fixture.cases)[number], options: Record<string, unknown> = {}, messages = c.messages) {
  const events: {event: string; details?: Record<string, unknown>}[] = [];
  const legs: TonSwapLeg[] = [];
  const provider = omnistonProvider({
    client: replayClient(c.quote, messages) as never, enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0,
    validateTonJettonWallet: () => true, validateTonSwapTarget: () => true,
    validateTonSwapLeg: (leg) => { legs.push(leg); return true; },
    trace: (event, details) => events.push({event, ...(details ? {details} : {})}),
    ...options,
  });
  const input = jettonOf(c.quote.inputAsset);
  const output = jettonOf(c.quote.outputAsset);
  const symbol = (j: string | null | undefined) => (j ? SYMBOL[j] ?? j : "GRAM");
  const quote = await provider.getQuote({
    sourceChain: "ton:-239", sourceToken: symbol(input), destChain: "ton:-239", destToken: output ?? "",
    amountIn: c.quote.inputUnits, destAddress: c.dest, refundAddress: c.trader, dry: false,
  });
  if (!quote) throw new Error(`no quote for ${c.pair}`);
  return {build: () => provider.buildDeposit(quote), events, legs};
}

describe("buildSwapDeposit with the decoder (scan F11)", () => {
  const replayable = live.filter((c) => { const j = jettonOf(c.quote.inputAsset); return j === null || !!SYMBOL[j!]; });
  it("replays every captured body", () => expect(replayable.length).toBe(live.length));

  for (const c of replayable) {
    it(`builds the captured ${c.pair} ${c.amount} ${c.protocols} body`, async () => {
      const run = await buildCase(c);
      const tx = await run.build();
      expect(tx.to).toBe(c.messages[0]!.targetAddress);
      expect(tx.value).toBe(c.messages[0]!.sendAmount);
      expect(run.legs).toEqual(c.expect.legs!.map(({ok: _ok, ...leg}) => leg));
      expect(run.events.filter((e) => e.event === "ton-swap-payload")).toEqual([]);
    });
  }

  it("STON.fi v1 native input: the router's pTON v1 wallet builds; without the leg hook or with a foreign pTON wallet it is refused", async () => {
    const c = live.find((x) => x.protocols === "StonFiV1" && x.pair === "GRAM>USDT")!;
    await expect((await buildCase(c)).build()).resolves.toMatchObject({to: c.messages[0]!.targetAddress});
    // Without the leg hook the route is not advertised at all (scan 2026-10-30 F8); even in report mode pTON v1 needs it.
    await expect(buildCase(c, {validateTonSwapLeg: undefined})).rejects.toThrow(/no quote/);
    await expect((await buildCase(c, {validateTonSwapLeg: undefined, tonSwapPayloadCheck: "report"})).build()).rejects.toThrow(/validateTonSwapLeg/);
    const validators = createOmnistonTonValidators({fetch: replay()});
    await expect((await buildCase(c, {validateTonSwapLeg: validators.validateTonSwapLeg})).build()).resolves.toBeDefined();
    // Same body, but the message pays a pTON wallet the transfer's router does not own.
    const walletPath = `/v2/blockchain/accounts/${encodeURIComponent(c.messages[0]!.targetAddress)}/methods/get_wallet_data`;
    const real = fixture.tonapi[walletPath] as {stack: {type: string; cell?: string}[]};
    const stranger = beginCell().storeAddress(Address.parse(ATTACKER)).endCell().toBoc().toString("hex");
    const foreign = createOmnistonTonValidators({fetch: replay({[walletPath]: {...real, stack: [real.stack[0], {type: "cell", cell: stranger}, ...real.stack.slice(2)]}})});
    await expect((await buildCase(c, {validateTonSwapLeg: foreign.validateTonSwapLeg})).build()).rejects.toThrow(/ton-swap-payload leg-unverified/);
    // pTON v1 is enforced even in report mode.
    await expect((await buildCase(c, {validateTonSwapLeg: foreign.validateTonSwapLeg, tonSwapPayloadCheck: "report"})).build()).rejects.toThrow(/leg-unverified/);
  });

  it("enforce (default) refuses a tampered body; report traces it and still builds", async () => {
    const c = live.find((x) => x.protocols === "DeDustCPMMV2")!;
    const tampered = [{...c.messages[0]!, payload: dedustV2Native({amount: BigInt(c.quote.inputUnits), minOut: 0n}).toBoc().toString("hex")}];
    await expect((await buildCase(c, {}, tampered)).build()).rejects.toThrow(/ton-swap-payload min-out-zero/);
    const report = await buildCase(c, {tonSwapPayloadCheck: "report"}, tampered);
    await expect(report.build()).resolves.toBeDefined();
    expect(report.events).toContainEqual(expect.objectContaining({event: "ton-swap-payload", details: expect.objectContaining({reason: "min-out-zero", mode: "report"})}));
  });

  it("a failing leg check refuses in enforce mode; without the leg hook only the explicit report mode builds (scan 2026-10-30 F8)", async () => {
    const c = live.find((x) => x.protocols === "DeDustCPMMV2")!;
    await expect((await buildCase(c, {validateTonSwapLeg: () => false})).build()).rejects.toThrow(/leg-unverified/);
    // enforce (default) without the hook: same-chain TON is not advertised, so there is no quote to build.
    await expect(buildCase(c, {validateTonSwapLeg: undefined})).rejects.toThrow(/no quote/);
    const report = await buildCase(c, {validateTonSwapLeg: undefined, tonSwapPayloadCheck: "report"});
    await expect(report.build()).resolves.toBeDefined();
    expect(report.events).toContainEqual(expect.objectContaining({event: "ton-swap-payload", details: expect.objectContaining({reason: "legs-unverified", mode: "report"})}));
  });
});
