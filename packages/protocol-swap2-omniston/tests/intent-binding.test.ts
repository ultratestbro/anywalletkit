import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {keccak256} from "viem";
import {Address as TonAddress} from "@ton/core";
import {inMemoryQuoteStore, inMemorySecretStore, omnistonProvider, type OmnistonProviderOptions} from "../src/provider.js";

/**
 * Scan F3/F15: the intentId is an unsigned caller-supplied string. The HTLC
 * secret must be released only against the trader/dest/source chain/kind bound
 * when the quote was minted, and a second build must never replace a secret
 * an earlier build handed out. Live fixtures as in the per-direction suites.
 */
const SECRET = Buffer.from("11".repeat(32), "hex");
const OTHER = Buffer.from("22".repeat(32), "hex");
const SECRET_HASH = Buffer.from(keccak256(SECRET).slice(2), "hex");
const ATTACKER_EVM = "0x9999999999999999999999999999999999999999";
const ATTACKER_TON = "UQBvW8Z5huBkMJYdnfAEM5JqTNkuWX3diqYENkWsIL0XggGG";
const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const enc = (parts: string[]) => parts.map(encodeURIComponent).join("|");

function observable<T>(events: T[]) {
  return {subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }};
}

let fill = SECRET;
function pinSecret(now: number) {
  fill = SECRET;
  vi.useFakeTimers({toFake: ["Date"], now});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(fill.subarray(0, array.length)); return array; }) as never);
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── EVM → EVM (live 2026-10-20, Base USDC → Arbitrum USDT0) ────────────────
const ee = JSON.parse(readFileSync(new URL("./fixtures/live-evm-evm-2026-10-20.json", import.meta.url), "utf8")).chains.baseToArbitrum;
const EE = {
  OWNER: "0x4444444444444444444444444444444444444444",
  DEST: "0x3333333333333333333333333333333333333333",
  LOP: "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  BASE_FACTORY: "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd",
  ARB_FACTORY: "0xafCF681272AF10959736f45616eeCBC22D7095E2",
  USDT0_ARB: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
  SRC_POSITION: "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909",
  DST_POSITION: "0x1111111111111111111111111111111111111111",
};
const eeQuote = () => structuredClone(ee.quoteUpdated);
const eePayload = () => ({typedData: ee.payload.typedData as string, orderExtension: hex(ee.payload.orderExtensionHex), serializedOrderDetails: hex(ee.payload.serializedOrderDetailsHex)});
const eeSnapshot = (status = "ORDER_STATUS_ACTIVE", phase = "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION") => ({
  quoteId: eeQuote().quoteId, status,
  executions: [{
    index: 0, secretHash: new Uint8Array(SECRET_HASH), inputUnits: "20000000", outputUnits: eeQuote().outputUnits,
    resolverSendsUnits: eeQuote().settlementData.value.resolverSendsUnits,
    inputPositionAddress: {chain: {$case: "base", value: EE.SRC_POSITION}},
    outputPositionAddress: {chain: {$case: "arbitrum", value: EE.DST_POSITION}}, outputPositionPhase: phase,
  }],
});

function evmClient(q: unknown, snapshot: unknown = null) {
  const calls: Record<string, unknown[]> = {};
  const client = {
    calls,
    buildFails: false,
    requestForQuote() { return observable([{$case: "ack", value: {rfqId: (q as {rfqId: string}).rfqId}}, {$case: "quoteUpdated", rfqId: (q as {rfqId: string}).rfqId, value: q}]); },
    async evmBuildOrderPayload(request: unknown) {
      (calls.evmBuildOrderPayload ??= []).push(request);
      if (client.buildFails) throw new Error("omniston backend down");
      return eePayload();
    },
    async orderRegisterSignedOrder(request: unknown) { (calls.orderRegisterSignedOrder ??= []).push(request); },
    orderTrack(request: unknown) { (calls.orderTrack ??= []).push(request); return observable(snapshot ? [{$case: "order", value: snapshot}] : []); },
    async orderDiscloseHtlcSecret(request: unknown) { (calls.orderDiscloseHtlcSecret ??= []).push(request); },
    tonBuildEscrowTransfer() { throw new Error("not used"); },
  };
  return client;
}

function eeSetup(snapshot: unknown = eeSnapshot(), extra: Partial<OmnistonProviderOptions> = {}) {
  pinSecret((eeQuote().quoteTimestamp + 5) * 1000);
  const client = evmClient(eeQuote(), snapshot);
  const secretStore = inMemorySecretStore();
  const quoteStore = inMemoryQuoteStore();
  const input = vi.fn(async () => true);
  const output = vi.fn(async () => true);
  const events: [string, Record<string, unknown> | undefined][] = [];
  const p = omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
    trustedSettlementContracts: {"eip155:8453": [EE.BASE_FACTORY], "eip155:42161": [EE.ARB_FACTORY]},
    trustedEvmOrderProtocols: {"eip155:8453": [EE.LOP]},
    validateEvmInputPosition: input, validateEvmOutputPosition: output,
    secretStore, quoteStore, trace: (event, details) => events.push([event, details]),
    ...extra,
  });
  const quote = () => p.getQuote({
    sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: EE.USDT0_ARB,
    amountIn: "20000000", destAddress: EE.DEST, refundAddress: EE.OWNER, slippageBps: 100, dry: false,
  });
  return {p, client, secretStore, quoteStore, input, output, events, quote, quoteId: eeQuote().quoteId as string};
}

describe("intent binding: EVM → EVM", () => {
  it("refuses the report's forged intentId (victim trader, resolver as dest) — no validator runs, nothing is disclosed", async () => {
    const s = eeSetup();
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    const forged = enc(["omn1", s.quoteId, EE.OWNER, ATTACKER_EVM, "eip155:8453"]);
    await expect(s.p.trackIntent({intentId: forged})).rejects.toThrow(/does not match the quote it was issued for \(dest\)/);
    expect(s.input).not.toHaveBeenCalled();
    expect(s.output).not.toHaveBeenCalled();
    expect(s.client.calls.orderDiscloseHtlcSecret).toBeUndefined();
    expect(s.events).toContainEqual(["intent-mismatch", {quoteId: s.quoteId, where: "trackIntent", field: "dest"}]);
    // Forged trader / source chain are refused the same way.
    await expect(s.p.trackIntent({intentId: enc(["omn1", s.quoteId, ATTACKER_EVM, EE.DEST, "eip155:8453"])})).rejects.toThrow(/\(trader\)/);
    await expect(s.p.trackIntent({intentId: enc(["omn1", s.quoteId, EE.OWNER, EE.DEST, "eip155:42161"])})).rejects.toThrow(/\(srcChain\)/);
    await expect(s.p.trackIntent({intentId: enc(["omn1", s.quoteId, EE.OWNER, EE.DEST, "eip155:8453", "swap"])})).resolves.toEqual({state: "pending"});
    expect(s.client.calls.orderDiscloseHtlcSecret).toBeUndefined();
    // The honest intent still discloses afterwards.
    await s.p.trackIntent({intentId: q!.intentId});
    expect(s.client.calls.orderDiscloseHtlcSecret).toEqual([{quoteId: s.quoteId, executionIndex: 0, secret: new Uint8Array(SECRET)}]);
  });

  it("passes only the stored trader/dest to the validators (an intent in another address spelling still resolves to them)", async () => {
    const s = eeSetup();
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    const respelled = enc(["omn1", s.quoteId, EE.OWNER.toUpperCase().replace("0X", "0x"), EE.DEST.toLowerCase(), "eip155:8453"]);
    await s.p.trackIntent({intentId: respelled});
    expect(s.input).toHaveBeenCalledWith(expect.objectContaining({ownerAddress: EE.OWNER}));
    expect(s.output).toHaveBeenCalledWith(expect.objectContaining({recipientAddress: EE.DEST}));
    expect(s.client.calls.orderTrack).toEqual([{quoteId: s.quoteId, traderAddress: {chain: {$case: "base", value: EE.OWNER}}}]);
    expect(s.client.calls.orderDiscloseHtlcSecret).toHaveLength(1);
  });

  it("buildDeposit and registerSignedOrder refuse a forged intent; the build re-save keeps the binding", async () => {
    const s = eeSetup();
    const q = await s.quote();
    await expect(s.p.buildDeposit({...q!, intentId: enc(["omn1", s.quoteId, EE.OWNER, ATTACKER_EVM, "eip155:8453"])})).rejects.toThrow(/\(dest\)/);
    expect(s.client.calls.evmBuildOrderPayload).toBeUndefined();
    expect(await s.secretStore.load(s.quoteId)).toBeUndefined();
    await s.p.buildDeposit(q!);
    const entry = JSON.parse((await s.quoteStore.load(s.quoteId))!);
    expect(entry.bound).toEqual({trader: EE.OWNER, dest: EE.DEST, srcChain: "eip155:8453", kind: "order"});
    expect(entry.evmOrder.owner).toBe(EE.OWNER);
    const sig = `0x${"ab".repeat(65)}`;
    await expect(s.p.registerSignedOrder!(enc(["omn1", s.quoteId, EE.OWNER, ATTACKER_EVM, "eip155:8453"]), sig)).rejects.toThrow(/\(dest\)/);
    await s.p.registerSignedOrder!(q!.intentId, sig);
    expect(s.client.calls.orderRegisterSignedOrder).toHaveLength(1);
  });

  it("a rebuild of the same quoteId reuses the secret; a failed rebuild does not clear it", async () => {
    const s = eeSetup();
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    fill = OTHER; // a fresh secret would no longer match the payload Omniston committed to
    await expect(s.p.buildDeposit(q!)).resolves.toMatchObject({chain: "eip155:8453"});
    const [first, second] = s.client.calls.evmBuildOrderPayload as {htlcSecrets: unknown}[];
    expect(second!.htlcSecrets).toEqual(first!.htlcSecrets);
    expect(await s.secretStore.load(s.quoteId)).toEqual(["11".repeat(32)]);
    expect(s.events.some(([e]) => e === "secret-reused")).toBe(true);
    s.client.buildFails = true;
    await expect(s.p.buildDeposit(q!)).rejects.toThrow(/backend down/);
    expect(await s.secretStore.load(s.quoteId)).toEqual(["11".repeat(32)]);
    await s.p.trackIntent({intentId: q!.intentId});
    expect(s.client.calls.orderDiscloseHtlcSecret).toEqual([{quoteId: s.quoteId, executionIndex: 0, secret: new Uint8Array(SECRET)}]);
  });

  it("a first build that fails still clears the secret it created", async () => {
    const s = eeSetup();
    const q = await s.quote();
    s.client.buildFails = true;
    await expect(s.p.buildDeposit(q!)).rejects.toThrow(/backend down/);
    expect(await s.secretStore.load(s.quoteId)).toBeUndefined();
  });

  it("legacy entry (no bound fields): discloses within the window with a trace, refuses after it, refuses a trader other than the signed owner", async () => {
    const strip = async (s: ReturnType<typeof eeSetup>, age = 0) => {
      const entry = JSON.parse((await s.quoteStore.load(s.quoteId))!);
      delete entry.bound;
      entry.at = Date.now() - age;
      await s.quoteStore.save(s.quoteId, JSON.stringify(entry));
    };
    const fresh = eeSetup();
    const q = await fresh.quote();
    await fresh.p.buildDeposit(q!);
    await strip(fresh);
    await expect(fresh.p.trackIntent({intentId: enc(["omn1", fresh.quoteId, ATTACKER_EVM, EE.DEST, "eip155:8453"])})).rejects.toThrow(/\(owner\)/);
    await fresh.p.trackIntent({intentId: q!.intentId});
    expect(fresh.events.some(([e]) => e === "legacy-intent")).toBe(true);
    expect(fresh.client.calls.orderDiscloseHtlcSecret).toHaveLength(1);
    expect(fresh.input).toHaveBeenCalledWith(expect.objectContaining({ownerAddress: EE.OWNER}));

    const old = eeSetup();
    const q2 = await old.quote();
    await old.p.buildDeposit(q2!);
    await strip(old, 6 * 60 * 60 * 1000 + 1000);
    await expect(old.p.trackIntent({intentId: q2!.intentId})).resolves.toEqual({state: "pending", depositReceived: true});
    expect(old.client.calls.orderDiscloseHtlcSecret).toBeUndefined();
    expect(old.input).not.toHaveBeenCalled();
  });

  it("status reads without a cached context are unchanged: uncached intent, completed order", async () => {
    // Never quoted here (TTL / another instance): the feed status, no throw, no disclosure.
    const bare = eeSetup();
    const forged = enc(["omn1", bare.quoteId, EE.OWNER, ATTACKER_EVM, "eip155:8453"]);
    await expect(bare.p.trackIntent({intentId: forged})).resolves.toEqual({state: "pending", depositReceived: true});
    expect(bare.client.calls.orderTrack).toEqual([{quoteId: bare.quoteId, traderAddress: {chain: {$case: "base", value: EE.OWNER}}}]);
    expect(bare.client.calls.orderDiscloseHtlcSecret).toBeUndefined();

    const done = eeSetup(eeSnapshot("TRADE_STATUS_FULLY_FILLED", "EXECUTION_PHASE_COMPLETED"));
    const q = await done.quote();
    await done.p.buildDeposit(q!);
    await expect(done.p.trackIntent({intentId: q!.intentId})).resolves.toEqual({state: "completed", depositReceived: true});
    expect(await done.quoteStore.load(done.quoteId)).toBeUndefined();
    // After completion the cache is gone: any later read is a plain status read.
    await expect(done.p.trackIntent({intentId: q!.intentId})).resolves.toEqual({state: "completed", depositReceived: true});
    await expect(done.p.trackIntent({intentId: enc(["omn1", done.quoteId, EE.OWNER, ATTACKER_EVM, "eip155:8453"])})).resolves.toEqual({state: "completed", depositReceived: true});
  });
});

// ── EVM → TON (live 2026-10-16, Base USDT → TON USDT) ──────────────────────
const et = JSON.parse(readFileSync(new URL("./fixtures/live-evm-ton-2026-10-16.json", import.meta.url), "utf8")).chains.base;
const ET = {
  OWNER: et.buildRequest.ownerSrcAddress as string,
  TRADER_TON: et.buildRequest.traderDstAddress as string,
  SECRET: Buffer.from(et.buildRequest.secretHex, "hex"),
  LOP: "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E",
  FACTORY: "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd",
  TON_FACTORY: "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ",
  USDT_TON: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs",
  SRC_POSITION: "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909",
  TON_POSITION: "EQAbT3jirqSDgQG-_AyNuaGO0YTWHw2sZK8wPApw8x40VV2C",
};

describe("intent binding: EVM → TON", () => {
  function setup() {
    const q = structuredClone(et.quoteUpdated);
    vi.useFakeTimers({toFake: ["Date"], now: (q.quoteTimestamp + 5) * 1000});
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => { array.set(ET.SECRET); return array; }) as never);
    const hash = new Uint8Array(Buffer.from(keccak256(ET.SECRET).slice(2), "hex"));
    const s = q.settlementData.value;
    const snapshot = {
      status: "TRADE_STATUS_PARTIALLY_FILLED",
      executions: [{
        index: 0, inputUnits: "20000000", outputUnits: "20344594", resolverSendsUnits: s.resolverSendsUnits, secretHash: hash,
        inputPositionAddress: {chain: {$case: "base", value: ET.SRC_POSITION}},
        outputPositionAddress: {chain: {$case: "ton", value: ET.TON_POSITION}}, outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
      }],
    };
    const calls: Record<string, unknown[]> = {};
    const client = {
      requestForQuote() { return observable([{$case: "ack", value: {rfqId: (q as {rfqId: string}).rfqId}}, {$case: "quoteUpdated", rfqId: (q as {rfqId: string}).rfqId, value: q}]); },
      async evmBuildOrderPayload() { return {typedData: et.payload.typedData, orderExtension: hex(et.payload.orderExtensionHex), serializedOrderDetails: hex(et.payload.serializedOrderDetailsHex)}; },
      orderTrack() { return observable([{$case: "order", value: snapshot}]); },
      async orderDiscloseHtlcSecret(request: unknown) { (calls.disclose ??= []).push(request); },
    };
    const ton = vi.fn(async () => true);
    const p = omnistonProvider({
      client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
      trustedSettlementContracts: {"ton:-239": [ET.TON_FACTORY], "eip155:8453": [ET.FACTORY]},
      trustedEvmOrderProtocols: {"eip155:8453": [ET.LOP]},
      validateEvmInputPosition: () => true, validateTonOutputPosition: ton,
    });
    const quote = () => p.getQuote({
      sourceChain: "eip155:8453", sourceToken: "USDT", destChain: "ton:-239", destToken: ET.USDT_TON,
      amountIn: "20000000", destAddress: ET.TRADER_TON, refundAddress: ET.OWNER, slippageBps: 100, dry: false,
    });
    return {p, calls, ton, quote, quoteId: q.quoteId as string};
  }

  it("refuses the forged intent naming the attacker's TON address; the honest one (any TON notation) discloses against the stored recipient", async () => {
    const s = setup();
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    await expect(s.p.trackIntent({intentId: enc(["omn1", s.quoteId, ET.OWNER, ATTACKER_TON, "eip155:8453"])})).rejects.toThrow(/\(dest\)/);
    expect(s.ton).not.toHaveBeenCalled();
    expect(s.calls.disclose).toBeUndefined();
    const raw = TonAddress.parse(ET.TRADER_TON).toRawString();
    await s.p.trackIntent({intentId: enc(["omn1", s.quoteId, ET.OWNER, raw, "eip155:8453"])});
    expect(s.ton).toHaveBeenCalledWith(expect.objectContaining({recipientAddress: ET.TRADER_TON}));
    expect(s.calls.disclose).toHaveLength(1);
  });
});

// ── TON → EVM (live 2026-10-10, TON USDT → Base USDC) ──────────────────────
const te = JSON.parse(readFileSync(new URL("./fixtures/live-2026-10-10.json", import.meta.url), "utf8")).baseUsdc;
const TE = {
  TRADER: "UQCbXJ1-Hd_CyyAt3TNgircduNIn5QH5dj1_LBNz__y4fQaq",
  RECIPIENT: "0x8AbE813577E47415A3CD0Bbc68c7ABCa2c4c55bA",
  BASE_USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  BASE_FACTORY: "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd",
  TON_FACTORY: "EQAbWJ3Y1HgIIvcMq1prG1anlDC0T3cZlAU7luPT6LmTpmrZ",
  POSITION: "0x1111111111111111111111111111111111111111",
};

describe("intent binding: TON → EVM", () => {
  function setup() {
    const q = structuredClone(te.quoteUpdated.value);
    const now = Math.floor(Date.now() / 1000);
    q.quoteTimestamp = now;
    q.settlementData.value.tradeStartDeadline = now + 300;
    pinSecret(Date.now());
    const s = q.settlementData.value;
    const snapshot = {
      status: "ORDER_STATUS_ACTIVE",
      executions: [{
        index: 0, inputUnits: q.inputUnits, outputUnits: q.outputUnits, resolverSendsUnits: s.resolverSendsUnits,
        secretHash: new Uint8Array(SECRET_HASH),
        outputPositionAddress: {chain: {$case: "base", value: TE.POSITION}}, outputPositionPhase: "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
      }],
    };
    const calls: Record<string, unknown[]> = {};
    const client = {
      requestForQuote() { return observable([{$case: "ack", value: {rfqId: (q as {rfqId: string}).rfqId}}, {$case: "quoteUpdated", rfqId: (q as {rfqId: string}).rfqId, value: q}]); },
      async tonBuildEscrowTransfer(request: unknown) { (calls.build ??= []).push(request); return structuredClone(te.escrowResponse); },
      orderTrack(request: unknown) { (calls.track ??= []).push(request); return observable([{$case: "order", value: snapshot}]); },
      async orderDiscloseHtlcSecret(request: unknown) { (calls.disclose ??= []).push(request); },
    };
    const output = vi.fn(async () => true);
    const secretStore = inMemorySecretStore();
    const p = omnistonProvider({
      client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1, secretStore,
      trustedSettlementContracts: {"ton:-239": [TE.TON_FACTORY], "eip155:8453": [TE.BASE_FACTORY]},
      validateTonJettonWallet: ({walletAddress}) => walletAddress === te.escrowResponse.messages[0].targetAddress,
      validateTonEscrowPayload: () => true,
      validateEvmOutputPosition: output,
    });
    const quote = () => p.getQuote({
      sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: TE.BASE_USDC,
      amountIn: "5000000", destAddress: TE.RECIPIENT, refundAddress: TE.TRADER, slippageBps: 100, dry: true,
    });
    return {p, calls, output, quote, secretStore, quoteId: q.quoteId as string};
  }

  it("refuses a forged recipient on build and track; the honest intent discloses to the stored recipient; a rebuild reuses the secret", async () => {
    const s = setup();
    const q = await s.quote();
    const forged = enc(["omn1", s.quoteId, TE.TRADER, ATTACKER_EVM, "ton:-239"]);
    await expect(s.p.buildDeposit({...q!, intentId: forged})).rejects.toThrow(/\(dest\)/);
    expect(s.calls.build).toBeUndefined();
    await s.p.buildDeposit(q!);
    fill = OTHER;
    await s.p.buildDeposit(q!);
    const [a, b] = s.calls.build as {htlcSecrets: unknown}[];
    expect(b!.htlcSecrets).toEqual(a!.htlcSecrets);
    expect(await s.secretStore.load(s.quoteId)).toEqual(["11".repeat(32)]);
    await expect(s.p.trackIntent({intentId: forged})).rejects.toThrow(/\(dest\)/);
    expect(s.output).not.toHaveBeenCalled();
    await s.p.trackIntent({intentId: q!.intentId});
    expect(s.output).toHaveBeenCalledWith(expect.objectContaining({recipientAddress: TE.RECIPIENT}));
    expect(s.calls.disclose).toEqual([{quoteId: s.quoteId, executionIndex: 0, secret: new Uint8Array(SECRET)}]);
  });
});

describe("scan 2026-10-23 F6: the platform-chosen quoteId never decides which preimage an order locks to", () => {
  const VICTIM = "0x5555555555555555555555555555555555555555";
  const VICTIM_DEST = "0x6666666666666666666666666666666666666666";

  it("a disclosed preimage is never locked into a new order: the reused quote id is refused at quote time and at build time", async () => {
    const s = eeSetup();
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    await s.p.trackIntent({intentId: q!.intentId}); // discloses; not FULLY_FILLED, so the secret stays on file
    expect(s.client.calls.orderDiscloseHtlcSecret).toHaveLength(1);
    expect(await s.secretStore.load(`${s.quoteId}#disclosed`)).toEqual(["1"]);
    // The platform answers a later (victim's) request with the same quoteId: refused before any context is overwritten.
    const refusals: string[] = [];
    const again = await s.p.getQuote({
      sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: EE.USDT0_ARB,
      amountIn: "20000000", destAddress: VICTIM_DEST, refundAddress: VICTIM, slippageBps: 100, dry: false,
      onRefusal: (r) => refusals.push(r),
    });
    expect(again).toBeNull();
    expect(refusals.join(" ")).toMatch(/reused a quote id/);
    // Even for the original order, a build after disclosure gets no secret.
    await expect(s.p.buildDeposit(q!)).rejects.toThrow(/already belongs to another order/);
    expect(s.client.calls.evmBuildOrderPayload).toHaveLength(1);
  });

  it("a stored secret is reused only for the exact order it was made for", async () => {
    const s = eeSetup();
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    // Same order again: reused (covered above). A secret on file bound to something else is refused.
    await s.secretStore.save(`${s.quoteId}#bind`, ["00".repeat(32)]);
    await expect(s.p.buildDeposit(q!)).rejects.toThrow(/already belongs to another order/);
    expect(s.events.some(([e]) => e === "secret-reuse-refused")).toBe(true);
    // A secret with no binding at all (written before this fix) is not served to a new build either.
    await s.secretStore.clear(`${s.quoteId}#bind`);
    await expect(s.p.buildDeposit(q!)).rejects.toThrow(/already belongs to another order/);
    // The order's own secret is untouched by the refusals.
    expect(await s.secretStore.load(s.quoteId)).toEqual(["11".repeat(32)]);
  });

  it("completion clears the secret together with its binding and disclosure marks", async () => {
    const s = eeSetup(eeSnapshot("TRADE_STATUS_FULLY_FILLED", "EXECUTION_PHASE_COMPLETED"));
    const q = await s.quote();
    await s.p.buildDeposit(q!);
    await s.p.trackIntent({intentId: q!.intentId});
    expect(await s.secretStore.load(s.quoteId)).toBeUndefined();
    expect(await s.secretStore.load(`${s.quoteId}#bind`)).toBeUndefined();
    expect(await s.secretStore.load(`${s.quoteId}#disclosed`)).toBeUndefined();
  });
})
