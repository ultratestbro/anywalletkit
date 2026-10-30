// Scan 2026-10-30 [6]: a reused Omniston quote id must not replace an issued quote's terms. claimBuilt() used to
// overwrite the cached quote when the platform reused the id for the same trader/dest/chain/kind — with the atomic
// claim() and without it — and buildDeposit(quote A) then built against the cached quote B. Now the intent id carries
// a digest of the quote's terms: a held id is refreshed only by the same terms, a reused id with other terms is
// refused (the first quote kept), and a build whose cached quote differs from the caller's refuses with "quote was
// replaced". Ids from before the digest are refused on build ("request a fresh quote") but still tracked.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {inMemoryQuoteStore, inMemorySecretStore, omnistonProvider, type OmnistonQuoteStore} from "../src/provider.js";

const ee = JSON.parse(readFileSync(new URL("./fixtures/live-evm-evm-2026-10-20.json", import.meta.url), "utf8")).chains.baseToArbitrum;
const OWNER = "0x4444444444444444444444444444444444444444", DEST = "0x3333333333333333333333333333333333333333";
const LOP = "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E", BASE_FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
const ARB_FACTORY = "0xafCF681272AF10959736f45616eeCBC22D7095E2", USDT0_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const observable = <T,>(events: T[]) => ({subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }});
const quoteA = () => structuredClone(ee.quoteUpdated);
/** Same quote id, same trader/dest/chain/kind — but ~10% worse output and resolver amount. */
const quoteB = () => {
  const q = quoteA();
  q.outputUnits = String((BigInt(q.outputUnits) * 9n) / 10n);
  q.settlementData.value.resolverSendsUnits = String(BigInt(q.outputUnits) + BigInt(q.protocolFeeUnits) + BigInt(q.integratorFeeUnits));
  return q;
};

function setup(quoteStore: OmnistonQuoteStore) {
  vi.useFakeTimers({toFake: ["Date"], now: (quoteA().quoteTimestamp + 5) * 1000});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(Buffer.from("11".repeat(32), "hex").subarray(0, array.length)); return array; }) as never);
  let next = quoteA;
  const events: string[] = [];
  const refusals: string[] = [];
  const client = {
    requestForQuote() { const q = next(); return observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]); },
    async evmBuildOrderPayload() { return {typedData: ee.payload.typedData as string, orderExtension: new Uint8Array(Buffer.from(ee.payload.orderExtensionHex, "hex")), serializedOrderDetails: new Uint8Array(Buffer.from(ee.payload.serializedOrderDetailsHex, "hex"))}; },
    async orderRegisterSignedOrder() {},
    orderTrack() { return observable([]); },
    async orderDiscloseHtlcSecret() {},
    tonBuildEscrowTransfer() { throw new Error("not used"); },
  };
  const p = omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
    trustedSettlementContracts: {"eip155:8453": [BASE_FACTORY], "eip155:42161": [ARB_FACTORY]}, trustedEvmOrderProtocols: {"eip155:8453": [LOP]},
    validateEvmInputPosition: async () => true, validateEvmOutputPosition: async () => true,
    secretStore: inMemorySecretStore(), quoteStore, trace: (e: string, d?: Record<string, unknown>) => events.push(`${e}${d?.field ? `:${String(d.field)}` : ""}`),
  });
  const quote = () => p.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: USDT0_ARB, amountIn: "20000000", destAddress: DEST, refundAddress: OWNER, slippageBps: 100, dry: false, onRefusal: (r: string) => refusals.push(r)});
  return {p, events, refusals, quote, setNext: (f: typeof quoteA) => { next = f; }};
}

/** The id split the way apps released before this fix do (5 or 6 segments, the sixth only "swap"). */
function decodeAsReleasedApps(intentId: string) {
  const parts = intentId.split("|");
  if ((parts.length !== 5 && parts.length !== 6) || parts[0] !== "omn1") return null;
  const [, quoteId = "", trader = "", dest = "", srcChain = "", kind = ""] = parts.map(decodeURIComponent);
  if (!/^[0-9a-fA-F]{48,64}$/.test(quoteId) || !trader || !dest || !srcChain || (parts.length === 6 && kind !== "swap")) return null;
  return {quoteId, trader, srcChain, kind: parts.length === 6 ? "swap" : "order"};
}

describe("scan 2026-10-30 [6]: a reused Omniston quote id does not replace an issued quote's terms", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  for (const atomic of [true, false]) {
    it(`store ${atomic ? "with" : "without"} claim(): quote B under A's id is refused, A is kept and builds`, async () => {
      const raw = inMemoryQuoteStore();
      const store: OmnistonQuoteStore = atomic ? raw : {save: raw.save, load: raw.load, clear: raw.clear};
      const s = setup(store);
      const a = await s.quote();
      expect(a).not.toBeNull();
      s.setNext(quoteB);
      expect(await s.quote()).toBeNull(); // the platform answers a second, overlapping request with the same id and worse terms
      expect(s.refusals.at(-1)).toMatch(/reused a quote id that already holds another quote/);
      const stored = (JSON.parse(raw.load(quoteA().quoteId) as string) as {quote: {outputUnits: string}}).quote.outputUnits;
      expect(stored).toBe(quoteA().outputUnits);
      await expect(s.p.buildDeposit(a!)).resolves.toMatchObject({typedData: expect.any(String)});
    });
  }

  it("the same terms under the same id refresh the context (re-quote of the same request)", async () => {
    const raw = inMemoryQuoteStore();
    const s = setup(raw);
    const a = await s.quote();
    const again = await s.quote();
    expect(again).not.toBeNull();
    expect(again!.intentId).toBe(a!.intentId);
    await expect(s.p.buildDeposit(again!)).resolves.toBeDefined();
  });

  it("a cache that holds other terms than the caller's quote (replaced behind the claim) refuses the build", async () => {
    const raw = inMemoryQuoteStore();
    const s = setup(raw);
    const a = await s.quote();
    await s.p.buildDeposit(a!); // the signed-order context registration needs
    const entry = JSON.parse(raw.load(quoteA().quoteId) as string) as {quote: unknown};
    raw.save(quoteA().quoteId, JSON.stringify({...entry, quote: quoteB()}));
    await expect(s.p.buildDeposit(a!)).rejects.toThrow(/quote was replaced — request a fresh quote/);
    expect(s.events).toContain("intent-mismatch:digest");
    await expect(s.p.registerSignedOrder!(a!.intentId, "0x" + "11".repeat(65))).rejects.toThrow(/quote was replaced/);
  });

  it("an id issued before the digest: build refused with 'request a fresh quote', tracking still reads it", async () => {
    const raw = inMemoryQuoteStore();
    const s = setup(raw);
    const a = await s.quote();
    const parts = a!.intentId.split("|");
    parts[3] = encodeURIComponent(decodeURIComponent(parts[3]!).replace(/#[0-9a-f]{32}$/, ""));
    const old = parts.join("|");
    await expect(s.p.buildDeposit({...a!, intentId: old})).rejects.toThrow(/request a fresh quote/);
    await expect(s.p.trackIntent({intentId: old})).resolves.toEqual({state: "pending"});
  });

  it("apps released before this fix still read the new id (quote id, trader, source chain, kind)", async () => {
    const s = setup(inMemoryQuoteStore());
    const a = await s.quote();
    expect(decodeAsReleasedApps(a!.intentId)).toEqual({quoteId: quoteA().quoteId, trader: OWNER, srcChain: "eip155:8453", kind: "order"});
    // A malformed digest is a malformed id.
    await expect(s.p.trackIntent({intentId: a!.intentId.replace(/%23[0-9a-f]{32}/, "%23zz")})).rejects.toThrow(/malformed intent id/);
  });
});

// Same-chain TON (the report's strongest path): the swap intent carries the digest too.
const ton = JSON.parse(readFileSync(new URL("./fixtures/live-ton-swaps-2026-10-22.json", import.meta.url), "utf8")) as {cases: {pair: string; protocols: string; trader: string; dest: string; quote: Record<string, any>; messages: unknown[]}[]};
describe("scan 2026-10-30 [6]: TON swap quotes", () => {
  it("a swap whose cached quote was replaced (other output token, same input) is refused; the honest one builds", async () => {
    const c = ton.cases.find((x) => x.pair === "GRAM>USDT" && x.protocols === "DeDustCPMMV2")!;
    const once = <T,>(events: T[]) => ({subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }});
    const quote = {...c.quote, rfqId: "rfq1", quoteTimestamp: Math.floor(Date.now() / 1000)};
    const raw = inMemoryQuoteStore();
    const p = omnistonProvider({
      client: {requestForQuote: () => once([{$case: "ack", value: {rfqId: "rfq1"}}, {$case: "quoteUpdated", rfqId: "rfq1", value: quote}]), tonBuildSwap: async () => ({messages: c.messages}),
        swapTrack: () => once([]), orderTrack() { throw new Error("no"); }, tonBuildEscrowTransfer() { throw new Error("no"); }} as never,
      enabled: true, trustedSettlementContracts: {"ton:-239": ["UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ"]}, quoteSettleMs: 0, quoteStore: raw,
      validateTonJettonWallet: () => true, validateTonSwapTarget: () => true, validateTonSwapLeg: () => true,
    });
    const q = await p.getQuote({sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: c.quote.outputAsset.chain.value.kind.value, amountIn: c.quote.inputUnits, destAddress: c.dest, refundAddress: c.trader, dry: false});
    expect(q!.intentId.endsWith("|swap")).toBe(true);
    await expect(p.buildDeposit(q!)).resolves.toBeDefined();
    const id = String(c.quote.quoteId);
    const entry = JSON.parse(raw.load(id) as string) as {quote: Record<string, any>};
    entry.quote.outputAsset.chain.value.kind.value = "EQAIb6KmdfdDR7CN1GBqVJuP25iCnLKCvBlJ07Evuu2dzP5f";
    raw.save(id, JSON.stringify(entry));
    await expect(p.buildDeposit(q!)).rejects.toThrow(/quote was replaced/);
  });
});
