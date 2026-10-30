import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {keccak256} from "viem";
import {inMemorySecretStore, omnistonProvider, type OmnistonProviderOptions} from "../src/provider.js";

/**
 * EVM → TON gasless orders against responses captured live on 2026-10-16
 * (resolver Arbiter, SDK 0.8.11, Base USDT → TON USDT, 20 USDT). The order
 * payload was built with a FIXED test secret (no funds involved); the clock is
 * pinned near the quote so every timestamp the resolver signed stays valid.
 */
const live = JSON.parse(readFileSync(new URL("./fixtures/live-evm-ton-2026-10-16.json", import.meta.url), "utf8"));
const BASE = live.chains.base;
const OWNER = BASE.buildRequest.ownerSrcAddress as string;
const TRADER_TON = BASE.buildRequest.traderDstAddress as string;
const SECRET = Buffer.from(BASE.buildRequest.secretHex, "hex");
const SECRET_HASH = Buffer.from(keccak256(SECRET).slice(2), "hex");
const LOP = "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E";
const FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
const TON_FACTORY = "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ";
const RESOLVER = "0x2b654E50C83801AC79CE3011Ff94245E2937b1B7";
const USDT_BASE = "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2";
const USDT_TON = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
const SRC_POSITION = "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909";
const TON_POSITION = "EQAbT3jirqSDgQG-_AyNuaGO0YTWHw2sZK8wPApw8x40VV2C";
const TRUSTED = {"ton:-239": [TON_FACTORY], "eip155:8453": [FACTORY]};
const PROTOCOLS = {"eip155:8453": [LOP]};
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));

type Quote = Record<string, unknown> & {quoteId: string; quoteTimestamp: number; settlementData: {value: Record<string, unknown>}};
const quote = (): Quote => structuredClone(BASE.quoteUpdated);
const payload = () => ({
  typedData: BASE.payload.typedData as string,
  orderExtension: hex(BASE.payload.orderExtensionHex),
  serializedOrderDetails: hex(BASE.payload.serializedOrderDetailsHex),
});

function observable<T>(events: T[]) {
  return {
    subscribe(observer: {next: (e: T) => void; error?: (e: unknown) => void; complete?: () => void}) {
      for (const e of events) observer.next(e);
      observer.complete?.();
      return {unsubscribe() {}};
    },
  };
}

function clientFor(q: Quote | null, built = payload(), snapshot: unknown = null) {
  const calls: Record<string, unknown[]> = {};
  return {
    calls,
    requestForQuote(request: unknown) {
      (calls.requestForQuote ??= []).push(request);
      return observable([{$case: "ack", value: {rfqId: q?.rfqId ?? "r"}}, ...(q ? [{$case: "quoteUpdated", rfqId: q.rfqId, value: q}] : [])]);
    },
    async evmBuildOrderPayload(request: unknown) { (calls.evmBuildOrderPayload ??= []).push(request); return built; },
    async orderRegisterSignedOrder(request: unknown) { (calls.orderRegisterSignedOrder ??= []).push(request); },
    orderTrack(request: unknown) { (calls.orderTrack ??= []).push(request); return observable(snapshot ? [{$case: "order", value: snapshot}] : []); },
    async orderDiscloseHtlcSecret(request: unknown) { (calls.orderDiscloseHtlcSecret ??= []).push(request); },
    tonBuildEscrowTransfer() { throw new Error("EVM-source orders never build a TON escrow"); },
  };
}

function provider(client: ReturnType<typeof clientFor>, extra: Partial<OmnistonProviderOptions> = {}) {
  return omnistonProvider({
    client: client as never,
    quoteSettleMs: 0,
    maxHtlcExecutions: 1,
    trustedSettlementContracts: TRUSTED,
    trustedEvmOrderProtocols: PROTOCOLS,
    validateEvmInputPosition: () => true,
    validateTonOutputPosition: () => true,
    ...extra,
  });
}

const params = (extra: Record<string, unknown> = {}) => ({
  sourceChain: "eip155:8453", sourceToken: "USDT", destChain: "ton:-239", destToken: USDT_TON,
  amountIn: "20000000", destAddress: TRADER_TON, refundAddress: OWNER, slippageBps: 100, dry: false, ...extra,
});

const EVM = {chain: "eip155:8453", token: "USDT"};
const TON = {chain: "ton:-239", token: "USDT"};

beforeEach(() => {
  // The resolver signed timestamps relative to the live quote; pin the clock 5 s after it.
  vi.useFakeTimers({toFake: ["Date"], now: (quote().quoteTimestamp + 5) * 1000});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(SECRET); return array; }) as never);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Omniston EVM → TON orders (live 2026-10-16 fixtures)", () => {
  it("advertises EVM→TON only with a trusted order protocol AND both position validators", () => {
    expect(provider(clientFor(null)).supportsRoute(EVM, TON)).toBe(true);
    expect(provider(clientFor(null), {trustedEvmOrderProtocols: {}}).supportsRoute(EVM, TON)).toBe(false);
    expect(provider(clientFor(null), {validateEvmInputPosition: undefined} as never).supportsRoute(EVM, TON)).toBe(false);
    expect(provider(clientFor(null), {validateTonOutputPosition: undefined} as never).supportsRoute(EVM, TON)).toBe(false);
    expect(provider(clientFor(null), {trustedEvmOrderProtocols: {"eip155:1": [LOP]}}).supportsRoute(EVM, TON)).toBe(false);
    // The order-protocol table never stands in for the escrow factory table.
    expect(provider(clientFor(null), {trustedSettlementContracts: {"ton:-239": [TON_FACTORY]}}).supportsRoute(EVM, TON)).toBe(false);
    expect(() => omnistonProvider({trustedEvmOrderProtocols: {"ton:-239": [TON_FACTORY]}})).toThrow(/invalid trusted EVM order protocol/);
  });

  it("quotes Base USDT → TON USDT from the live response", async () => {
    const q = await provider(clientFor(quote())).getQuote(params());
    expect(q).toMatchObject({provider: "omniston", sourceAmount: "20000000", destAmount: "20344594", minDestAmount: "20344594", depositAddress: ""});
    expect(q!.fees).toEqual([{type: "protocol", amount: "2034", token: expect.any(String), included: true}]);
  });

  it("names its refusals: untrusted order protocol, missing trader address, non-TON destination", async () => {
    const reasons = async (extra: Partial<OmnistonProviderOptions> = {}, p = params()) => {
      const refusals: string[] = [];
      await provider(clientFor(quote()), extra).getQuote({...p, onRefusal: (r: string) => refusals.push(r)});
      return refusals;
    };
    expect(await reasons({trustedEvmOrderProtocols: {"eip155:8453": ["0x0000000000000000000000000000000000000001"]}}))
      .toEqual([`omniston: untrusted eip155:8453 order protocol ${LOP}`]);
    expect(await reasons({}, params({refundAddress: undefined}))).toEqual(["omniston: execution quote needs the trader's EVM address (refundAddress)"]);
    expect(await reasons({}, params({refundAddress: TRADER_TON}))).toEqual(["omniston: refundAddress is not an EVM address"]);
    expect(await reasons({}, params({destAddress: OWNER}))).toEqual(["omniston: destination is not a TON address"]);
    expect(await reasons({trustedEvmOrderProtocols: {}})).toEqual(["omniston: no trusted EVM order protocol configured for eip155:8453"]);
  });

  it("builds the gasless typed order: the order protocol is the spender, the secret hash is what Omniston committed to", async () => {
    const client = clientFor(quote());
    const p = provider(client);
    const q = await p.getQuote(params());
    const tx = await p.buildDeposit(q!);
    // The wallet signs the domain with a NUMERIC chainId (Omniston sends "0x2105").
    const normalized = JSON.parse(BASE.payload.typedData);
    normalized.domain.chainId = 8453;
    // The order extension rides along for an app that checks a remote build itself (scan 2026-10-28 F6).
    expect(tx).toEqual({chain: "eip155:8453", to: LOP, value: "0", chainId: 8453, approvalAddress: LOP, typedData: JSON.stringify(normalized), orderExtension: `0x${BASE.payload.orderExtensionHex}`});
    expect(client.calls.evmBuildOrderPayload).toEqual([{
      quoteId: quote().quoteId,
      ownerSrcAddress: {chain: {$case: "base", value: OWNER}},
      traderDstAddress: {chain: {$case: "ton", value: TRADER_TON}},
      htlcSecrets: {secretMode: {$case: "provided", value: {hashes: [new Uint8Array(SECRET_HASH)]}}},
    }]);
  });

  const flip = (bytes: Uint8Array, at: number) => { bytes[at] = (bytes[at] ?? 0) ^ 1; };

  it("refuses to hand over a payload whose signed bytes drift from the quote, and forgets the secret", async () => {
    const cases: [string, () => ReturnType<typeof payload>, RegExp][] = [
      // Any extension byte changes keccak256(extension), which the signed salt commits to — caught before the HTLC decoder.
      ["hashlock in the extension", () => { const b = payload(); flip(b.orderExtension, 32 + 160 + 83); return b; }, /order fields/],
      ["TON recipient in the extension", () => { const b = payload(); flip(b.orderExtension, b.orderExtension.length - 131 + 34); return b; }, /order fields/],
      ["maker in the typed data", () => { const b = payload(); const td = JSON.parse(b.typedData); td.message.maker = RESOLVER; b.typedData = JSON.stringify(td); return b; }, /order fields/],
      ["taking amount in the typed data", () => { const b = payload(); const td = JSON.parse(b.typedData); td.message.takingAmount = "0x1"; b.typedData = JSON.stringify(td); return b; }, /order fields/],
      ["verifying contract in the typed data", () => { const b = payload(); const td = JSON.parse(b.typedData); td.domain.verifyingContract = FACTORY; b.typedData = JSON.stringify(td); return b; }, /order fields/],
      ["serialized order details", () => { const b = payload(); b.serializedOrderDetails = b.serializedOrderDetails.slice(0, -1); return b; }, /order details|protobuf/],
    ];
    for (const [label, mutate, pattern] of cases) {
      const store = inMemorySecretStore();
      const clear = vi.spyOn(store, "clear");
      const p = provider(clientFor(quote(), mutate()), {secretStore: store});
      const q = await p.getQuote(params());
      await expect(p.buildDeposit(q!), label).rejects.toThrow(pattern);
      expect(clear, label).toHaveBeenCalledWith(quote().quoteId);
      expect(await store.load(quote().quoteId), label).toBeUndefined();
    }
  });

  it("registers the wallet's signature over exactly the validated order, extension and details", async () => {
    const client = clientFor(quote());
    const p = provider(client);
    const q = await p.getQuote(params());
    await p.buildDeposit(q!);
    const signature = `0x${"ab".repeat(65)}`;
    await p.registerSignedOrder!(q!.intentId, signature);
    const [call] = client.calls.orderRegisterSignedOrder as [{quoteId: string; ownerSrcAddress: unknown; signedOrder: {order: {$case: string; value: {encodedOrder: Uint8Array; signature: Uint8Array; orderExtension: Uint8Array}}}; serializedOrderDetails: Uint8Array}];
    expect(call.quoteId).toBe(quote().quoteId);
    expect(call.ownerSrcAddress).toEqual({chain: {$case: "base", value: OWNER}});
    expect(call.signedOrder.order.$case).toBe("evmV1");
    expect(call.signedOrder.order.value.encodedOrder).toHaveLength(8 * 32);
    expect(Buffer.from(call.signedOrder.order.value.signature).toString("hex")).toBe("ab".repeat(65));
    expect(Buffer.from(call.signedOrder.order.value.orderExtension).toString("hex")).toBe(BASE.payload.orderExtensionHex);
    expect(Buffer.from(call.serializedOrderDetails).toString("hex")).toBe(BASE.payload.serializedOrderDetailsHex);
    await expect(p.registerSignedOrder!(q!.intentId, "0x1234")).rejects.toThrow(/malformed order signature/);
    await expect(p.registerSignedOrder!(q!.intentId.replace(quote().quoteId, "ff".repeat(32)), signature)).rejects.toThrow(/no signed-order context/);
  });

  function snapshot(overrides: Record<string, unknown> = {}) {
    const s = quote().settlementData.value;
    return {
      status: "TRADE_STATUS_PARTIALLY_FILLED",
      executions: [{
        index: 0, inputUnits: "20000000", outputUnits: "20344594", resolverSendsUnits: s.resolverSendsUnits,
        secretHash: new Uint8Array(SECRET_HASH),
        inputPositionAddress: {chain: {$case: "base", value: SRC_POSITION}}, inputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
        outputPositionAddress: {chain: {$case: "ton", value: TON_POSITION}}, outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
        ...overrides,
      }],
    };
  }

  it("discloses the secret only after BOTH the EVM source fill and the TON output position are proven", async () => {
    const evm = vi.fn(async () => true);
    const ton = vi.fn(async () => true);
    const client = clientFor(quote(), payload(), snapshot());
    const p = provider(client, {validateEvmInputPosition: evm, validateTonOutputPosition: ton});
    const q = await p.getQuote(params());
    await p.buildDeposit(q!);
    await expect(p.trackIntent({intentId: q!.intentId})).resolves.toEqual({state: "pending", depositReceived: true});
    const s = quote().settlementData.value;
    expect(evm).toHaveBeenCalledWith({
      chain: "eip155:8453", positionAddress: SRC_POSITION, factoryAddress: FACTORY, orderProtocolAddress: LOP,
      ownerAddress: OWNER, resolverAddress: RESOLVER, inputTokenAddress: USDT_BASE,
      inputUnits: "20000000", resolverSendsUnits: s.resolverSendsUnits, srcHtlcSecurityDepositUnits: s.srcHtlcSecurityDepositUnits,
      quoteTimestamp: quote().quoteTimestamp, secretHash: new Uint8Array(SECRET_HASH),
    });
    expect(ton).toHaveBeenCalledWith({
      positionAddress: TON_POSITION, protocolAddress: TON_FACTORY, outputJettonMasterAddress: USDT_TON, recipientAddress: TRADER_TON,
      quoteId: quote().quoteId, quoteTimestamp: quote().quoteTimestamp, inputUnits: "20000000", outputUnits: "20344594",
      resolverSendsUnits: s.resolverSendsUnits, dstSecurityDepositUnits: s.dstSecurityDepositUnits, secretHash: new Uint8Array(SECRET_HASH),
    });
    expect(client.calls.orderDiscloseHtlcSecret).toEqual([{quoteId: quote().quoteId, executionIndex: 0, secret: new Uint8Array(SECRET)}]);
    expect(client.calls.orderTrack).toEqual([{quoteId: quote().quoteId, traderAddress: {chain: {$case: "base", value: OWNER}}}]);
  });

  it("a completed TON-destination order reports the delivery the TON locator finds", async () => {
    const locate = vi.fn(async () => "28dd10c6234062c29ed3dfec25817a870d8cfc2fc6f6bf77352dce6845a0b8c0");
    const client = clientFor(quote(), payload(), {...snapshot({outputPositionPhase: "EXECUTION_PHASE_COMPLETED", inputPositionPhase: "EXECUTION_PHASE_COMPLETED"}), status: "TRADE_STATUS_FULLY_FILLED"});
    const p = provider(client, {locateTonDelivery: locate});
    const q = await p.getQuote(params());
    await p.buildDeposit(q!);
    await expect(p.trackIntent({intentId: q!.intentId})).resolves.toEqual({state: "completed", depositReceived: true, destTxHash: "28dd10c6234062c29ed3dfec25817a870d8cfc2fc6f6bf77352dce6845a0b8c0"});
    expect(locate).toHaveBeenCalledWith({positionAddress: TON_POSITION, recipientAddress: TRADER_TON, jettonMasterAddress: USDT_TON, minUnits: "20344594"});
    // A locator that finds nothing (or throws), with the secret never disclosed here: the feed's FULLY_FILLED is not
    // proof, so the order stays pending and keeps its secret (scan 2026-10-30 F10).
    const none = provider(clientFor(quote(), payload(), {...snapshot({outputPositionPhase: "EXECUTION_PHASE_COMPLETED"}), status: "TRADE_STATUS_FULLY_FILLED"}), {locateTonDelivery: async () => { throw new Error("tonapi down"); }});
    const q2 = await none.getQuote(params());
    await none.buildDeposit(q2!);
    await expect(none.trackIntent({intentId: q2!.intentId})).resolves.toEqual({state: "pending", depositReceived: true});
  });

  it("keeps the secret when the EVM proof fails, the output is not locked, or the fill is partial", async () => {
    const run = async (snap: unknown, extra: Partial<OmnistonProviderOptions> = {}) => {
      const ton = vi.fn(async () => true);
      const client = clientFor(quote(), payload(), snap);
      const p = provider(client, {validateTonOutputPosition: ton, ...extra});
      const q = await p.getQuote(params());
      await p.buildDeposit(q!);
      await p.trackIntent({intentId: q!.intentId});
      return {disclosed: client.calls.orderDiscloseHtlcSecret ?? [], tonCalls: ton.mock.calls.length};
    };
    expect(await run(snapshot(), {validateEvmInputPosition: () => false})).toEqual({disclosed: [], tonCalls: 0});
    expect(await run(snapshot(), {validateEvmInputPosition: () => { throw new Error("rpc down"); }})).toEqual({disclosed: [], tonCalls: 0});
    expect(await run(snapshot(), {validateTonOutputPosition: () => false})).toMatchObject({disclosed: []});
    expect(await run(snapshot({outputPositionPhase: "EXECUTION_PHASE_CREATED"}))).toEqual({disclosed: [], tonCalls: 0});
    expect(await run(snapshot({inputUnits: "19000000"}))).toEqual({disclosed: [], tonCalls: 0});
    expect(await run(snapshot({secretHash: new Uint8Array(32)}))).toEqual({disclosed: [], tonCalls: 0});
    expect(await run(snapshot({inputPositionAddress: undefined}))).toEqual({disclosed: [], tonCalls: 0});
  });
});

describe("Omniston EVM→TON signed extension: live timing windows", () => {
  it("accepts every live chain's extension against its own quote (allowedTime 14–18 s before the quote, auction start ±1 s)", async () => {
    const {validateEvmToTonOrderExtension} = await import("../src/provider.js");
    for (const [name, chain] of Object.entries(live.chains as Record<string, typeof BASE>)) {
      const q = chain.quoteUpdated, s = q.settlementData.value, td = JSON.parse(chain.payload.typedData);
      await expect(validateEvmToTonOrderExtension(hex(chain.payload.orderExtensionHex), {
        quoteId: q.quoteId, quoteTimestamp: q.quoteTimestamp, tradeStartDeadline: s.tradeStartDeadline,
        protocolFeePips: s.protocolFeePips, integratorFeePips: s.integratorFeePips ?? 0,
        initialResolverAddress: s.srcInitialResolverAddress.chain.value, outputTokenAddress: USDT_TON, traderDstAddress: TRADER_TON,
        takerAsset: td.message.takerAsset, srcSecurityDepositUnits: s.srcHtlcSecurityDepositUnits, dstSecurityDepositUnits: "0",
        secretHash: SECRET_HASH, trustedTarget: () => true,
      }), name).resolves.toBeUndefined();
      // Shift the quote 61 s later: allowedTime falls outside the window.
      await expect(validateEvmToTonOrderExtension(hex(chain.payload.orderExtensionHex), {
        quoteId: q.quoteId, quoteTimestamp: q.quoteTimestamp + 61, tradeStartDeadline: s.tradeStartDeadline,
        protocolFeePips: s.protocolFeePips, integratorFeePips: s.integratorFeePips ?? 0,
        initialResolverAddress: s.srcInitialResolverAddress.chain.value, outputTokenAddress: USDT_TON, traderDstAddress: TRADER_TON,
        takerAsset: td.message.takerAsset, srcSecurityDepositUnits: s.srcHtlcSecurityDepositUnits, dstSecurityDepositUnits: "0",
        secretHash: SECRET_HASH, trustedTarget: () => true,
      }), name).rejects.toThrow(/pinned v1beta8 profile/);
    }
  });
});
