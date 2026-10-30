// Scan 2026-10-30 [8]: a same-chain TON swap must not build without proving the DEX leg's real output token. The
// platform can answer a USDT → USDe request with a real STON.fi body whose ask wallet is the router's XAUt0 wallet:
// receiver, refund, input and numeric minimum all check out, only `validateTonSwapLeg` sees the wrong token. Without
// the hook, same-chain TON is no longer advertised (and a build is refused) unless the host explicitly opts into
// `tonSwapPayloadCheck: "report"`; the remote check (`omnistonVerifyBuild`) refuses a TON swap body without it. Every
// live layout (STON.fi v1/v2, DeDust v1/CPMM v2, cross-swap) still builds with the leg validator of `createOmnistonTonValidators()`,
// both locally and through the app-side remote check.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {Buffer} from "buffer";
import {describe, expect, it} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core";
import {omnistonProvider, omnistonVerifyBuild} from "../src/provider.js";
import {createOmnistonTonValidators} from "../src/validators/ton.js";

type Case = {pair: string; amount: string; protocols: string; trader: string; dest: string; quote: Record<string, any>;
  messages: {targetAddress: string; sendAmount: string; payload: string}[]; expect: {refused?: string}};
const fixture = JSON.parse(readFileSync(new URL("./fixtures/live-ton-swaps-2026-10-22.json", import.meta.url), "utf8")) as {cases: Case[]; tonapi: Record<string, unknown>};
const replay = (async (url: string) => {
  const body = fixture.tonapi[String(url).replace(/^https:\/\/tonapi\.io/, "")];
  return body ? new Response(JSON.stringify(body), {status: 200}) : new Response("{}", {status: 404});
}) as unknown as typeof fetch;
const USDE = "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f";
const SYMBOL: Record<string, string> = {"EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs": "USDT", "EQD0Evpk4timFOHmy4Sv3l_KEUXlM-dN1_KhroTCfB2wkO89": "FDUSD"};
const trusted = {"ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"]};
const jettonOf = (asset: any): string | null => (asset?.chain?.value?.kind?.$case === "native" ? null : asset?.chain?.value?.kind?.value);

/** The real USDT → XAUt0 quote and body, the quote relabelled as USDT → USDe (what the user asked for). */
function relabelled() {
  const c = fixture.cases.find((x) => x.pair === "USDT>XAUt0")!;
  const q = structuredClone(c.quote);
  q.outputAsset.chain.value.kind.value = USDE;
  for (const r of q.settlementData.value.routes) for (const s of r.steps) if (s.outputAsset?.chain?.value?.kind?.value) s.outputAsset.chain.value.kind.value = USDE;
  return {...c, quote: q};
}

async function prepare(c: Case, options: Record<string, unknown>) {
  const quote = {...c.quote, rfqId: "rfq1", quoteTimestamp: Math.floor(Date.now() / 1000)};
  const once = <T,>(events: T[]) => ({subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }});
  const events: string[] = [];
  const provider = omnistonProvider({
    client: {requestForQuote: () => once([{$case: "ack", value: {rfqId: "rfq1"}}, {$case: "quoteUpdated", rfqId: "rfq1", value: quote}]), tonBuildSwap: async () => ({messages: c.messages}),
      swapTrack: () => once([]), orderTrack() { throw new Error("no"); }, tonBuildEscrowTransfer() { throw new Error("no"); }} as never,
    enabled: true, trustedSettlementContracts: trusted, quoteSettleMs: 0,
    validateTonJettonWallet: () => true, validateTonSwapTarget: () => true, // the target is a genuine STON.fi router
    trace: (e, d) => events.push(`${e}:${String(d?.reason ?? "")}`),
    ...options,
  });
  const input = jettonOf(c.quote.inputAsset);
  const params = {sourceChain: "ton:-239", sourceToken: input ? SYMBOL[input] ?? input : "GRAM", destChain: "ton:-239", destToken: jettonOf(c.quote.outputAsset) ?? "",
    amountIn: c.quote.inputUnits, destAddress: c.dest, refundAddress: c.trader, dry: false} as QuoteParams;
  const got = await provider.getQuote(params);
  return {provider, got, params, events};
}

describe("scan 2026-10-30 [8]: a TON swap's output token is proven or the swap is not built", () => {
  it("control: with the SDK's leg validator the XAUt0 body for a USDe request is refused", async () => {
    const b = await prepare(relabelled(), {validateTonSwapLeg: createOmnistonTonValidators({fetch: replay}).validateTonSwapLeg});
    expect(b.got).not.toBeNull();
    await expect(b.provider.buildDeposit(b.got!)).rejects.toThrow(/leg-unverified/);
  });

  it("without the hook (enforce, the default) same-chain TON is not advertised and a build is refused", async () => {
    const b = await prepare(relabelled(), {validateTonSwapLeg: undefined});
    expect(b.got).toBeNull();
    expect(b.provider.supportsRoute({chain: "ton:-239", token: "USDT"}, {chain: "ton:-239", token: USDE})).toBe(false);
  });

  it("report mode stays an explicit opt-in: it builds and traces legs-unverified", async () => {
    const b = await prepare(relabelled(), {validateTonSwapLeg: undefined, tonSwapPayloadCheck: "report"});
    await expect(b.provider.buildDeposit(b.got!)).resolves.toBeDefined();
    expect(b.events).toContain("ton-swap-payload:legs-unverified");
  });

  it("the remote check refuses a TON swap body without validateTonSwapLeg, and the relabelled body with it", async () => {
    const wired = await prepare(relabelled(), {validateTonSwapLeg: () => true});
    const tx = await wired.provider.buildDeposit(wired.got!);
    const {validateTonSwapLeg: _leg, ...partial} = createOmnistonTonValidators({fetch: replay});
    expect(await omnistonVerifyBuild(partial)(wired.got!, tx, wired.params)).toMatch(/needs validateTonSwapLeg/);
    expect(await omnistonVerifyBuild({...createOmnistonTonValidators({fetch: replay})})(wired.got!, tx, wired.params)).toMatch(/leg not verified/);
  });

  const live = fixture.cases.filter((c) => !c.expect.refused);
  it(`all ${live.length} live TON swap bodies build with the SDK's leg validator, locally and through the remote check`, async () => {
    expect(new Set(live.map((c) => c.protocols))).toEqual(new Set(["DeDustCPMMV2", "StonFiV2", "DeDust", "StonFiV1"]));
    for (const c of live) {
      // The fixture recorded the reads every leg needs (not every swap target's account read; the target validator has
      // its own tests): the leg check is the SDK's, on the recorded chain state.
      const v = createOmnistonTonValidators({fetch: replay});
      const b = await prepare(c, {validateTonSwapLeg: v.validateTonSwapLeg});
      expect(b.got, c.pair).not.toBeNull();
      const tx = await b.provider.buildDeposit(b.got!).catch((e: Error) => { throw new Error(`${c.pair} ${c.amount} ${c.protocols}: ${e.message}`); });
      expect(tx.bodyBoc, `${c.pair} ${c.protocols}`).toBe(Buffer.from(c.messages[0]!.payload, "hex").toString("base64"));
      expect(b.events.filter((e) => e.startsWith("ton-swap-payload")), c.pair).toEqual([]);
      expect(await omnistonVerifyBuild({...v, validateTonSwapTarget: () => true})(b.got!, tx, b.params), `${c.pair} ${c.protocols} remote`).toBeNull();
    }
  });
});
