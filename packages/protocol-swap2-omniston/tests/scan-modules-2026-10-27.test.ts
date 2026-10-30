// Scan 2026-10-27 (modules), F4: the engine now signs a provider's EIP-712 payload only when it is the swap's own
// Limit Order Protocol order (maker = this account, the source token, the exact input, the approved settlement
// contract). The live Omniston orders captured on 2026-10-16 and 2026-10-20 must still be signed as they are — hex
// amounts, lowercase addresses, hex chain ids — and the same orders with another maker must not.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {omnistonPins, validateEvmTypedOrder} from "../src/provider.js";

type Fixture = {chains: Record<string, {payload?: {typedData?: string}}>};
const load = (file: string) => JSON.parse(readFileSync(new URL(`./fixtures/${file}`, import.meta.url), "utf8")) as Fixture;
const orders = [...Object.entries(load("live-evm-ton-2026-10-16.json").chains), ...Object.entries(load("live-evm-evm-2026-10-20.json").chains)]
  .filter(([, c]) => c.payload?.typedData)
  .map(([name, c]) => {
    const typedData = c.payload!.typedData!;
    const td = JSON.parse(typedData) as {domain: {chainId: string; verifyingContract: string}; message: {maker: string; makerAsset: string; makingAmount: string}};
    return {name, typedData, chain: `eip155:${Number(td.domain.chainId)}`, lop: td.domain.verifyingContract, maker: td.message.maker, token: td.message.makerAsset, amount: BigInt(td.message.makingAmount)};
  });
const ATTACKER = "0x9999999999999999999999999999999999999999";

/** The engine over a provider that answers the live order as its build, for an account `address`. */
function run(o: (typeof orders)[number], address: string, typedData = o.typedData) {
  const signed: unknown[] = [], sent: unknown[] = [], registered: string[] = [];
  const provider: CrossChainProvider = {
    name: "omniston", enabled: () => true, supportsRoute: () => true, supportsSameChain: true, trackIntent: async () => ({state: "pending"}),
    getQuote: async (params: QuoteParams) => ({
      provider: "omniston", intentId: `omniston:${o.name}`, depositAddress: "", depositMemo: null, sourceAmount: params.amountIn, destAmount: "1000", minDestAmount: "990",
      feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000,
    }) as Quote,
    buildDeposit: async () => ({chain: o.chain, to: o.lop, value: "0", chainId: Number(o.chain.slice(7)), approvalAddress: o.lop, typedData}),
    registerSignedOrder: async (_id, sig) => { registered.push(sig); },
  };
  const account = {
    getAddress: async () => address, getChainId: async () => Number(o.chain.slice(7)), getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
    signTypedData: async (td: unknown) => { signed.push(td); return "0x" + "11".repeat(65); },
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const p = new P(account as never, {fromChain: o.chain, allowUnlistedTokens: true} as never);
  const swap = () => p.swap2({fromToken: o.token, fromTokenDecimals: 6, toToken: o.token, toChain: o.chain, recipient: address, fromTokenAmount: o.amount, minAmountOut: 990n});
  return {signed, sent, registered, swap};
}

describe("live Omniston orders through the engine's typed-order gate (scan 2026-10-27 modules, F4)", () => {
  it(`all ${orders.length} live orders are approved for the input, signed and registered`, async () => {
    expect(orders.length).toBeGreaterThanOrEqual(8);
    for (const o of orders) {
      const r = run(o, o.maker);
      await r.swap();
      expect(r.signed, o.name).toHaveLength(1);
      expect(r.registered, o.name).toHaveLength(1);
      expect((r.signed[0] as {domain: {chainId: unknown}}).domain.chainId, o.name).toBe(Number(o.chain.slice(7)));
    }
  });

  it("the same orders are refused for any other account, and when the backend swaps the maker", async () => {
    for (const o of orders) {
      const other = run(o, ATTACKER);
      await expect(other.swap(), o.name).rejects.toThrow(/typed order refused — the maker is not this account/);
      expect([other.signed, other.sent], o.name).toEqual([[], []]);
      const td = JSON.parse(o.typedData) as {message: Record<string, unknown>};
      td.message.maker = ATTACKER;
      const swapped = run(o, o.maker, JSON.stringify(td));
      await expect(swapped.swap(), o.name).rejects.toThrow(/the maker is not this account/);
      expect([swapped.signed, swapped.sent], o.name).toEqual([[], []]);
    }
  });

  it("omnistonPins: the app's audited order protocols are the only spenders a remote order may name", () => {
    const pins = omnistonPins({"eip155:8453": ["0xe7405facdedb2512e91f2886bdff13231343af5e"], "eip155:1": ["0xb5810aCfD45D85Eaa938bF90a5857295513DA7E9"]});
    expect(pins.spenders("eip155:8453")).toEqual(["0xe7405fAcDEDB2512e91F2886BDff13231343aF5E"]);
    expect(pins.spenders("eip155:137")).toEqual([]);
    expect(pins.callTargets("eip155:8453")).toEqual([]);
    expect(() => omnistonPins({"eip155:1": ["not an address"]})).toThrow();
    expect(typeof validateEvmTypedOrder).toBe("function");
  });
});

// ── G5 (F7, F13, F18, F19): a TON cell-body build is bound to the swap on the client ───────────────────────────────────
import {Address, Cell, beginCell} from "@ton/core";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {omnistonVerifyBuild} from "../src/provider.js";

type TonCase = {pair: string; protocols: string; trader: string; quote: {inputUnits: string; inputAsset: {chain: {value: {kind: {$case: string}}}}}; messages: Array<{targetAddress: string; sendAmount: string; payload: string}>};
const tonCases = (JSON.parse(readFileSync(new URL("./fixtures/live-ton-swaps-2026-10-22.json", import.meta.url), "utf8")) as {cases: TonCase[]}).cases;
const TON_ATTACKER = new Address(0, Buffer.alloc(32, 0x99)).toString({bounceable: false});
const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

/** The engine over a provider whose build is `build`, for the case's trader; plans are recorded. */
function tonRun(c: TonCase, build: {to: string; value: string; bodyBoc: string}, opts: {ownWallet?: string | null; provider?: CrossChainProvider} = {}) {
  const sent: unknown[] = [], plans: unknown[] = [];
  const native = c.quote.inputAsset.chain.value.kind.$case === "native";
  const [from, to] = c.pair.split(">") as [string, string];
  const provider: CrossChainProvider = opts.provider ?? {
    name: "omniston", enabled: () => true, supportsRoute: () => true, supportsSameChain: true, trackIntent: async () => ({state: "pending"}),
    getQuote: async (params: QuoteParams) => ({provider: "omniston", intentId: "omniston:live", depositAddress: "", depositMemo: null, sourceAmount: params.amountIn,
      destAmount: "1000", minDestAmount: "990", feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000}) as Quote,
    buildDeposit: async () => ({chain: "ton:-239", ...build}),
  };
  const account = {
    getAddress: async () => c.trader, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `h${sent.length}`}; },
    ...(opts.ownWallet === null ? {} : {getJettonWalletAddress: async () => Address.parse(opts.ownWallet ?? c.messages[0]!.targetAddress)}),
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  const p = new P(account as never, {fromChain: "ton:-239", skipAccountChainCheck: true, decodeTonBody: (boc: string) => Cell.fromBase64(boc), reviewExecution: (plan: unknown) => { plans.push(plan); }} as never);
  const swap = () => p.swap2({fromToken: from, toToken: from === "GRAM" ? "USDT" : "GRAM", toChain: "ton:-239", recipient: c.trader, fromTokenAmount: BigInt(c.quote.inputUnits), minAmountOut: 990n});
  return {sent, plans, swap, native};
}
const live = (c: TonCase) => ({to: c.messages[0]!.targetAddress, value: c.messages[0]!.sendAmount, bodyBoc: b64(c.messages[0]!.payload)});
const jettonCase = tonCases.find((c) => c.pair.startsWith("USDT>"))!;
const nativeCase = tonCases.find((c) => c.pair.startsWith("GRAM>"))!;
/** A TEP-74 transfer body: `amount` to `destination`, excess to `response`. */
const jettonTransfer = (amount: bigint, destination: string, response: string, forwardTon = 100_000_000n) => beginCell()
  .storeUint(0x0f8a7ea5, 32).storeUint(0, 64).storeCoins(amount).storeAddress(Address.parse(destination)).storeAddress(Address.parse(response))
  .storeMaybeRef(null).storeCoins(forwardTon).storeMaybeRef(null).endCell().toBoc().toString("base64");

describe("live TON swap messages through the engine's cell-body gate (scan 2026-10-27 modules, F7/F13/F18/F19)", () => {
  it(`all ${tonCases.length} live messages are sent as built; a jetton source's transfer reaches the review decoded`, async () => {
    expect(tonCases.length).toBeGreaterThanOrEqual(18);
    for (const c of tonCases) {
      const r = tonRun(c, live(c));
      await r.swap();
      expect(r.sent, c.pair).toHaveLength(1);
      const source = (r.plans[0] as {source: {cellBody?: boolean; cellBodyDecoded?: {jettonTransfer?: {amount: bigint}}}}).source;
      expect(source.cellBody, c.pair).toBe(true);
      if (!r.native) expect(source.cellBodyDecoded?.jettonTransfer?.amount, c.pair).toBe(BigInt(c.quote.inputUnits));
    }
  });
});

describe("TON cell-body builds that are not the swap are refused (scan 2026-10-27 modules, F7/F13/F18/F19)", () => {
  it("{to: attacker, value: the whole balance, bodyBoc} is refused: more TON than the input plus the gas ceiling", async () => {
    const r = tonRun(nativeCase, {to: TON_ATTACKER, value: "500000000000000", bodyBoc: b64(nativeCase.messages[0]!.payload)});
    await expect(r.swap()).rejects.toThrow(/TON cell-body build refused — it attaches 500000000000000 nanoTON/);
    expect(r.sent).toHaveLength(0);
  });

  it("{to: the user's USDT jetton wallet, bodyBoc: transfer(everything → attacker)} is refused", async () => {
    const r = tonRun(jettonCase, {to: jettonCase.messages[0]!.targetAddress, value: "260000000", bodyBoc: jettonTransfer(10n ** 15n, TON_ATTACKER, jettonCase.trader)});
    await expect(r.swap()).rejects.toThrow(/the jetton transfer moves 1000000000000000, not the swap's/);
    expect(r.sent).toHaveLength(0);
  });

  it("the input to the attacker with the excess to the attacker, another jetton wallet, too much gas, or no way to name the wallet: refused", async () => {
    const input = BigInt(jettonCase.quote.inputUnits);
    const target = jettonCase.messages[0]!.targetAddress;
    const cases: Array<[string, ReturnType<typeof tonRun>, RegExp]> = [
      ["excess elsewhere", tonRun(jettonCase, {to: target, value: "260000000", bodyBoc: jettonTransfer(input, TON_ATTACKER, TON_ATTACKER)}), /returns its excess to another wallet/],
      ["not our jetton wallet", tonRun(jettonCase, {to: target, value: "260000000", bodyBoc: b64(jettonCase.messages[0]!.payload)}, {ownWallet: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}), /not this account's USDT jetton wallet/],
      ["gas over the ceiling", tonRun(jettonCase, {to: target, value: "5000000000", bodyBoc: b64(jettonCase.messages[0]!.payload)}), /more than the 1000000000 gas ceiling/],
      ["account cannot name its wallet", tonRun(jettonCase, live(jettonCase), {ownWallet: null}), /cannot name its own jetton wallet/],
      ["not a jetton transfer", tonRun(jettonCase, {to: target, value: "260000000", bodyBoc: beginCell().storeUint(0x12345678, 32).endCell().toBoc().toString("base64")}), /must be a jetton transfer/],
    ];
    for (const [what, r, why] of cases) {
      await expect(r.swap(), what).rejects.toThrow(why);
      expect(r.sent, what).toHaveLength(0);
    }
  });
});

describe("remote TON cell bodies need the app's own check (scan 2026-10-27 modules, F18/F19)", () => {
  /** A remote stub whose backend answers the live quote and message. */
  const stub = (c: TonCase, build: ReturnType<typeof live>, verifyBuild?: Parameters<typeof remoteProvider>[0]["verifyBuild"]) => {
    const fetchImpl = (async (url: string, init: {body: string}) => {
      const action = String(url).split("/").at(-1);
      const body = JSON.parse(init.body) as {params?: QuoteParams};
      const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
      if (action === "quote") return reply({provider: "omniston", intentId: "omniston:remote", depositAddress: "", depositMemo: null, sourceAmount: body.params!.amountIn, destAmount: "1000", minDestAmount: "990",
        feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 60_000, providerData: {settlement: "swap", protocols: c.protocols, routeSteps: JSON.stringify([{protocol: c.protocols, inputJetton: null, outputJetton: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}])}});
      if (action === "build") return reply({chain: "ton:-239", ...build});
      return reply({});
    }) as unknown as typeof fetch;
    return remoteProvider({name: "omniston", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...(verifyBuild ? {verifyBuild} : {})});
  };

  it("without verifyBuild a remote cell body is refused; nothing is sent", async () => {
    const r = tonRun(nativeCase, live(nativeCase), {provider: stub(nativeCase, live(nativeCase))});
    await expect(r.swap()).rejects.toThrow(/needs the app's own validator/);
    expect(r.sent).toHaveLength(0);
  });

  it("omnistonVerifyBuild opens the body against the app's request and asks the app's validator about the DEX", async () => {
    const targets: string[] = [];
    const verify = omnistonVerifyBuild({validateTonSwapTarget: ({address}) => { targets.push(address); return true; }, validateTonSwapLeg: () => true});
    const ok = tonRun(nativeCase, live(nativeCase), {provider: stub(nativeCase, live(nativeCase), verify)});
    await ok.swap();
    expect(ok.sent).toHaveLength(1);
    expect(targets).toEqual([nativeCase.messages[0]!.targetAddress]);
    // The validator says no: refused before anything is signed.
    const no = tonRun(nativeCase, live(nativeCase), {provider: stub(nativeCase, live(nativeCase), omnistonVerifyBuild({validateTonSwapTarget: () => false, validateTonSwapLeg: () => true}))});
    await expect(no.swap()).rejects.toThrow(/is not a recognized DEX contract/);
    expect(no.sent).toHaveLength(0);
    // checkTonSwapPayload on the client: a body whose on-chain minimum is below the quote, or for another trader, is refused.
    const params = {sourceChain: "ton:-239", sourceToken: "GRAM", destChain: "ton:-239", destToken: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", amountIn: nativeCase.quote.inputUnits, destAddress: nativeCase.trader, refundAddress: nativeCase.trader} as QuoteParams;
    const quote = {sourceAmount: nativeCase.quote.inputUnits, minDestAmount: "990", providerData: {settlement: "swap", protocols: nativeCase.protocols, routeSteps: JSON.stringify([{protocol: nativeCase.protocols, inputJetton: null, outputJetton: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"}])}} as unknown as Quote;
    const tx = {chain: "ton:-239", ...live(nativeCase)};
    expect(await verify(quote, tx, params)).toBeNull();
    expect(await verify({...quote, minDestAmount: "999999999999"} as Quote, tx, params)).toMatch(/min/i);
    expect(await verify(quote, tx, {...params, destAddress: TON_ATTACKER, refundAddress: TON_ATTACKER})).toMatch(/receiver|refund|trader|dest/i);
    // Not a swap body and not TON → EVM (these params are TON → TON): nothing on the client can open it.
    expect(await verify({...quote, providerData: {settlement: "escrow"}} as unknown as Quote, tx, params)).toMatch(/only TON swap and TON → EVM escrow bodies/);
    expect(await verify(quote, tx, undefined)).toMatch(/request this quote answered is unknown/);
  });
});

// ── G10 (F27): a reused quote id cannot rebind an order's context after its HTLC secret exists ─────────────────────────
import {keccak256} from "viem";
import {vi} from "vitest";
import {inMemoryQuoteStore, inMemorySecretStore, omnistonProvider, type OmnistonQuoteStore} from "../src/provider.js";

const G10_SECRET = Buffer.from("11".repeat(32), "hex");
const ee = JSON.parse(readFileSync(new URL("./fixtures/live-evm-evm-2026-10-20.json", import.meta.url), "utf8")).chains.baseToArbitrum;
const EE = {OWNER: "0x4444444444444444444444444444444444444444", DEST: "0x3333333333333333333333333333333333333333", LOP: "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  BASE_FACTORY: "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd", ARB_FACTORY: "0xafCF681272AF10959736f45616eeCBC22D7095E2", USDT0_ARB: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  SRC_POSITION: "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909", DST_POSITION: "0x1111111111111111111111111111111111111111"};
const ATTACKER_EVM = "0x9999999999999999999999999999999999999999";
const enc = (parts: string[]) => parts.map(encodeURIComponent).join("|");
const observable = <T,>(events: T[]) => ({subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }});
const eeQuote = () => structuredClone(ee.quoteUpdated);
const snapshot = () => ({
  quoteId: eeQuote().quoteId, status: "ORDER_STATUS_ACTIVE",
  executions: [{index: 0, secretHash: new Uint8Array(Buffer.from(keccak256(G10_SECRET).slice(2), "hex")), inputUnits: "20000000", outputUnits: eeQuote().outputUnits,
    resolverSendsUnits: eeQuote().settlementData.value.resolverSendsUnits, inputPositionAddress: {chain: {$case: "base", value: EE.SRC_POSITION}},
    outputPositionAddress: {chain: {$case: "arbitrum", value: EE.DST_POSITION}}, outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION"}],
});
/** An async KV over the in-memory store (every call a separate turn), with or without an atomic claim. */
function asyncStore(atomic: boolean): OmnistonQuoteStore & {raw: OmnistonQuoteStore} {
  const raw = inMemoryQuoteStore();
  const tick = () => new Promise((r) => setTimeout(r, 0));
  return {
    raw,
    save: async (id, v) => { await tick(); raw.save(id, v); },
    load: async (id) => { await tick(); return raw.load(id); },
    clear: async (id) => { await tick(); raw.clear(id); },
    ...(atomic ? {claim: async (id: string, v: string) => { await tick(); return raw.claim!(id, v); }} : {}),
  };
}
function g10Setup(quoteStore: OmnistonQuoteStore) {
  vi.useFakeTimers({toFake: ["Date"], now: (eeQuote().quoteTimestamp + 5) * 1000});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(G10_SECRET.subarray(0, array.length)); return array; }) as never);
  const calls: Record<string, unknown[]> = {};
  let nextQuote = eeQuote;
  const client = {
    requestForQuote() { const q = nextQuote(); return observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]); },
    async evmBuildOrderPayload() { return {typedData: ee.payload.typedData as string, orderExtension: new Uint8Array(Buffer.from(ee.payload.orderExtensionHex, "hex")), serializedOrderDetails: new Uint8Array(Buffer.from(ee.payload.serializedOrderDetailsHex, "hex"))}; },
    async orderRegisterSignedOrder() {},
    orderTrack() { return observable([{$case: "order", value: snapshot()}]); },
    async orderDiscloseHtlcSecret(request: unknown) { (calls.disclose ??= []).push(request); },
    tonBuildEscrowTransfer() { throw new Error("not used"); },
  };
  const events: string[] = [];
  const p = omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
    trustedSettlementContracts: {"eip155:8453": [EE.BASE_FACTORY], "eip155:42161": [EE.ARB_FACTORY]}, trustedEvmOrderProtocols: {"eip155:8453": [EE.LOP]},
    validateEvmInputPosition: async () => true, validateEvmOutputPosition: async () => true,
    secretStore: inMemorySecretStore(), quoteStore, trace: (event, d) => events.push(`${event}${d?.gate ? `:${d.gate}` : ""}`),
  });
  const quote = (dest = EE.DEST, owner = EE.OWNER) => p.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: EE.USDT0_ARB, amountIn: "20000000", destAddress: dest, refundAddress: owner, slippageBps: 100, dry: false});
  return {p, calls, events, quote, quoteId: eeQuote().quoteId as string, setNext: (f: typeof eeQuote) => { nextQuote = f; }};
}

describe("Omniston: a reused quote id cannot rebind an order after its secret exists (scan 2026-10-27 modules, F27)", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("the race won anyway: an attacker context saved after the victim's secret gets no disclosure (async store)", async () => {
    const store = asyncStore(false);
    const s = g10Setup(store);
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    // The attacker's quote under the same id lands after the victim's build created and locked the secret.
    const victim = JSON.parse((await store.load(s.quoteId))!) as {bound: Record<string, string>};
    await store.save(s.quoteId, JSON.stringify({...victim, bound: {...victim.bound, dest: ATTACKER_EVM}}));
    await s.p.trackIntent({intentId: enc(["omn1", s.quoteId, EE.OWNER, ATTACKER_EVM, "eip155:8453"]), sourceTxHash: null} as never);
    expect(s.calls.disclose ?? []).toHaveLength(0);
    expect(s.events).toContain("disclosure-skipped:binding");
    // The victim's own context still discloses once restored.
    await store.save(s.quoteId, JSON.stringify(victim));
    await s.p.trackIntent({intentId: q!.intentId, sourceTxHash: null} as never);
    expect(s.calls.disclose ?? []).toHaveLength(1);
  });

  it("claiming the quote id: another user's quote under a held id is refused; the same user's re-quote refreshes it only with the same terms (scan 2026-10-30 F6)", async () => {
    for (const atomic of [true, false]) {
      const store = asyncStore(atomic);
      const s = g10Setup(store);
      expect(await s.quote(), `atomic=${atomic}`).not.toBeNull();
      // The platform answers another user with the same quote id: refused, the stored context untouched.
      const before = await store.load(s.quoteId);
      expect(await s.quote(ATTACKER_EVM, ATTACKER_EVM), `atomic=${atomic}`).toBeNull();
      expect(await store.load(s.quoteId)).toBe(before);
      const first = await s.quote();
      expect(first, `atomic=${atomic}`).not.toBeNull();
      // The same user, the same id, other terms (10% less output): refused, the first quote kept and still buildable.
      const held = await store.load(s.quoteId);
      s.setNext(() => { const q = eeQuote(); q.outputUnits = String((BigInt(q.outputUnits) * 9n) / 10n); return q; });
      expect(await s.quote(), `atomic=${atomic}`).toBeNull();
      expect(await store.load(s.quoteId)).toBe(held);
      await expect(s.p.buildDeposit(first!)).resolves.toBeDefined();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

// ── Follow-up (2026-10-28): remote TON → EVM works again — the escrow body is checked on the client ──────────────────
// G5 made a remote TON cell body need the app's own check, and omnistonVerifyBuild could only open TON → TON swap
// bodies: every TON → EVM order through a remote stub was refused, so the route went dark in apps on 0.3.0. The live
// TON → EVM escrows captured on 2026-10-10 (USDT on TON → USDC on Base and on BNB) must pass, and the same bodies
// against another destination, owner, amount, chain, floor or protocol pin must not.
import {createOmnistonTonValidators} from "../src/validators/index.js";

type EscrowLive = {quoteUpdated: {value: {inputUnits: string; outputAsset: {chain: {value: {kind: {value: string}}}}; settlementData: {value: {resolverSendsUnits: string}}}};
  escrowRequest: {ownerSrcAddress: {chain: {value: string}}; traderDstAddress: {chain: {value: string}}}; escrowResponse: {messages: Array<{targetAddress: string; sendAmount: string; payload: string}>}};
const escrowLive = JSON.parse(readFileSync(new URL("./fixtures/live-2026-10-10.json", import.meta.url), "utf8")) as Record<"baseUsdc" | "bnbUsdc", EscrowLive>;
const escrowCases = ([["baseUsdc", "eip155:8453"], ["bnbUsdc", "eip155:56"]] as const).map(([key, chain]) => {
  const c = escrowLive[key];
  return {
    key, chain, message: c.escrowResponse.messages[0]!,
    expect: {
      payloadBocHex: c.escrowResponse.messages[0]!.payload, ownerAddress: c.escrowRequest.ownerSrcAddress.chain.value, inputUnits: c.quoteUpdated.value.inputUnits,
      destinationChain: chain as string, destinationAddress: c.escrowRequest.traderDstAddress.chain.value, outputTokenAddress: c.quoteUpdated.value.outputAsset.chain.value.kind.value,
      minResolverSendsUnits: c.quoteUpdated.value.settlementData.value.resolverSendsUnits,
    },
  };
});

describe("remote TON → EVM: the escrow body is checked on the client (2026-10-28 follow-up to F18/F19)", () => {
  const v = createOmnistonTonValidators();

  it("the live TON → EVM escrows (Base and BNB) pass with what the app knows", () => {
    for (const c of escrowCases) expect(v.verifyTonEscrowBuild(c.expect), c.key).toBeNull();
  });

  it("another destination, owner, amount, chain, token, a floor above the delivery, or an untrusted protocol: refused", () => {
    const c = escrowCases[0]!;
    const no = (patch: Partial<typeof c.expect>) => v.verifyTonEscrowBuild({...c.expect, ...patch});
    expect(no({destinationAddress: ATTACKER})).toMatch(/not this swap's/);
    expect(no({ownerAddress: TON_ATTACKER})).toMatch(/not this swap's/);
    expect(no({inputUnits: "5000001"})).toMatch(/moves 5000000, not the 5000001/);
    expect(no({destinationChain: "eip155:1"})).toMatch(/not this swap's/);
    expect(no({destinationChain: "eip155:10"})).toMatch(/not this swap's/);
    expect(no({outputTokenAddress: ATTACKER})).toMatch(/not this swap's/);
    expect(no({minResolverSendsUnits: (BigInt(c.expect.minResolverSendsUnits) + 1n).toString()})).toMatch(/bound to deliver .* under the quote's minimum/);
    expect(no({payloadBocHex: "b5ee9c72"})).toMatch(/not an Omniston escrow transfer/);
    expect(createOmnistonTonValidators({trustedProtocolAddresses: [TON_ATTACKER]}).verifyTonEscrowBuild(c.expect)).toMatch(/not an Omniston protocol contract this app trusts/);
    expect(createOmnistonTonValidators({escrowCodeHashes: ["00".repeat(32)]}).verifyTonEscrowBuild(c.expect)).toMatch(/audited escrow/);
  });

  it("end to end: a remote Omniston stub's TON → EVM order is built and sent; without the escrow check it is refused", async () => {
    for (const c of escrowCases) {
      const [toChainId] = [Number(c.chain.slice(7))];
      const stubFor = (verifyBuild: Parameters<typeof remoteProvider>[0]["verifyBuild"]) => {
        const fetchImpl = (async (url: string, init: {body: string}) => {
          const action = String(url).split("/").at(-1);
          const body = JSON.parse(init.body) as {params?: QuoteParams};
          const reply = (x: unknown) => new Response(JSON.stringify(x), {status: 200, headers: {"content-type": "application/json"}});
          // An order quote carries no providerData, as the provider sends it.
          if (action === "quote") return reply({provider: "omniston", intentId: "omniston:order", depositAddress: "", depositMemo: null, sourceAmount: body.params!.amountIn,
            destAmount: c.expect.minResolverSendsUnits, minDestAmount: c.expect.minResolverSendsUnits, feeUsd: 0, etaSeconds: 60, reliability: 1, validUntilMs: Date.now() + 60_000});
          if (action === "build") return reply({chain: "ton:-239", to: c.message.targetAddress, value: c.message.sendAmount, bodyBoc: b64(c.message.payload)});
          return reply({});
        }) as unknown as typeof fetch;
        return remoteProvider({name: "omniston", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...(verifyBuild ? {verifyBuild} : {})});
      };
      const runWith = (provider: CrossChainProvider) => {
        const sent: unknown[] = [];
        const account = {
          getAddress: async () => c.expect.ownerAddress, waitForTransaction: async () => {},
          sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `h${sent.length}`}; },
          getJettonWalletAddress: async () => Address.parse(c.message.targetAddress),
        };
        class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
        const p = new P(account as never, {fromChain: "ton:-239", skipAccountChainCheck: true, decodeTonBody: (boc: string) => Cell.fromBase64(boc)} as never);
        const swap = () => p.swap2({fromToken: "USDT", toToken: c.expect.outputTokenAddress, toChain: toChainId, recipient: c.expect.destinationAddress,
          fromTokenAmount: BigInt(c.expect.inputUnits), minAmountOut: BigInt(c.expect.minResolverSendsUnits)});
        return {sent, swap};
      };
      const ok = runWith(stubFor(omnistonVerifyBuild({...createOmnistonTonValidators()})));
      await ok.swap();
      expect(ok.sent, c.key).toHaveLength(1);
      // The validators without the escrow check (an app wiring them one by one): refused, nothing sent.
      const partial = runWith(stubFor(omnistonVerifyBuild({validateTonSwapTarget: () => true})));
      await expect(partial.swap()).rejects.toThrow(/needs verifyTonEscrowBuild/);
      expect(partial.sent).toHaveLength(0);
    }
  });
});
