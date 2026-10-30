// Scan 2026-10-30 [10]: an Omniston tracking feed that says TRADE_STATUS_FULLY_FILLED is not proof. trackIntent
// reports `completed` — and deletes the HTLC secrets and quote context — only when every execution's secret was
// disclosed (in this poll or an earlier one; a terminal snapshot that lists no executions counts a recorded
// disclosure) or a delivery locator found the payout. Otherwise the order stays pending with its secrets, so the
// resolver's real execution is still disclosed when it shows up, and a disclosure that failed is retried.
import "../src/buffer-global.js";
import {readFileSync} from "node:fs";
import {keccak256} from "viem";
import {afterEach, describe, expect, it, vi} from "vitest";
import {inMemoryQuoteStore, inMemorySecretStore, omnistonProvider, type OmnistonProviderOptions} from "../src/provider.js";

const SECRET = Buffer.from("11".repeat(32), "hex");
const ee = JSON.parse(readFileSync(new URL("./fixtures/live-evm-evm-2026-10-20.json", import.meta.url), "utf8")).chains.baseToArbitrum;
const OWNER = "0x4444444444444444444444444444444444444444", DEST = "0x3333333333333333333333333333333333333333";
const LOP = "0xe7405fAcDEDB2512e91F2886BDff13231343aF5E", BASE_FACTORY = "0xACa3E2F9b61a44892926bC6c3e104192E7D1c3cd";
const ARB_FACTORY = "0xafCF681272AF10959736f45616eeCBC22D7095E2", USDT0_ARB = "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9";
const SRC_POSITION = "0x0CD4d5758313baAdB792c51175B383Bb64Ea6909", DST_POSITION = "0x1111111111111111111111111111111111111111";
const observable = <T,>(events: T[]) => ({subscribe(o: {next: (e: T) => void; complete?: () => void}) { for (const e of events) o.next(e); o.complete?.(); return {unsubscribe() {}}; }});
const q0 = () => structuredClone(ee.quoteUpdated);
const execution = (phase = "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION") => ({index: 0, secretHash: new Uint8Array(Buffer.from(keccak256(SECRET).slice(2), "hex")), inputUnits: "20000000", outputUnits: q0().outputUnits,
  resolverSendsUnits: q0().settlementData.value.resolverSendsUnits, inputPositionAddress: {chain: {$case: "base", value: SRC_POSITION}},
  outputPositionAddress: {chain: {$case: "arbitrum", value: DST_POSITION}}, outputPositionPhase: phase});
const snap = (status: string, executions: unknown[]) => ({quoteId: q0().quoteId, status, executions});
const FILLED = "TRADE_STATUS_FULLY_FILLED", ACTIVE = "ORDER_STATUS_ACTIVE";

async function setup(extra: Partial<OmnistonProviderOptions> = {}) {
  vi.useFakeTimers({toFake: ["Date"], now: (q0().quoteTimestamp + 5) * 1000});
  vi.spyOn(crypto, "getRandomValues").mockImplementation(((a: Uint8Array) => { a.set(SECRET.subarray(0, a.length)); return a; }) as never);
  const state = {snapshot: null as unknown, discloseFails: false, disclosed: [] as unknown[], events: [] as string[]};
  const client = {
    requestForQuote() { const q = q0(); return observable([{$case: "ack", value: {rfqId: q.rfqId}}, {$case: "quoteUpdated", rfqId: q.rfqId, value: q}]); },
    async evmBuildOrderPayload() { return {typedData: ee.payload.typedData as string, orderExtension: new Uint8Array(Buffer.from(ee.payload.orderExtensionHex, "hex")), serializedOrderDetails: new Uint8Array(Buffer.from(ee.payload.serializedOrderDetailsHex, "hex"))}; },
    async orderRegisterSignedOrder() {},
    orderTrack() { return observable([{$case: "order", value: state.snapshot}]); },
    async orderDiscloseHtlcSecret(r: unknown) { if (state.discloseFails) throw new Error("omniston backend down"); state.disclosed.push(r); },
    tonBuildEscrowTransfer() { throw new Error("not used"); },
  };
  const secretStore = inMemorySecretStore(), quoteStore = inMemoryQuoteStore();
  const p = omnistonProvider({
    client: client as never, quoteSettleMs: 0, maxHtlcExecutions: 1,
    trustedSettlementContracts: {"eip155:8453": [BASE_FACTORY], "eip155:42161": [ARB_FACTORY]}, trustedEvmOrderProtocols: {"eip155:8453": [LOP]},
    validateEvmInputPosition: async () => true, validateEvmOutputPosition: async () => true,
    secretStore, quoteStore, trace: (e) => state.events.push(e), ...extra,
  });
  const quote = await p.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:42161", destToken: USDT0_ARB, amountIn: "20000000", destAddress: DEST, refundAddress: OWNER, slippageBps: 100, dry: false});
  await p.buildDeposit(quote!);
  const ref = {intentId: quote!.intentId, sourceTxHash: "0x" + "ab".repeat(32)};
  const quoteId = q0().quoteId as string;
  return {p, state, secretStore, quoteStore, quoteId, poll: () => p.trackIntent(ref), kept: async () => (await secretStore.load(quoteId))?.length ?? 0};
}

describe("scan 2026-10-30 [10]: an unproven FULLY_FILLED does not delete a live order's HTLC secrets", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("FULLY_FILLED with no executions is pending, keeps the secret, and the real execution afterwards is disclosed", async () => {
    const s = await setup();
    s.state.snapshot = snap(FILLED, []);
    expect(await s.poll()).toEqual({state: "pending", depositReceived: false});
    expect(await s.kept()).toBe(1);
    expect(await s.quoteStore.load(s.quoteId)).toBeDefined();
    expect(s.state.events).toContain("completion-unproven");
    s.state.snapshot = snap(ACTIVE, [execution()]);
    expect(await s.poll()).toMatchObject({state: "pending"});
    expect(s.state.disclosed).toHaveLength(1);
    // Now proven: the terminal snapshot completes and clears everything.
    s.state.snapshot = snap(FILLED, [execution("EXECUTION_PHASE_COMPLETED")]);
    expect(await s.poll()).toEqual({state: "completed", depositReceived: true});
    expect(await s.kept()).toBe(0);
    expect(await s.quoteStore.load(s.quoteId)).toBeUndefined();
  });

  it("FULLY_FILLED naming an execution whose secret never went out is pending", async () => {
    const s = await setup();
    s.state.snapshot = snap(FILLED, [execution("EXECUTION_PHASE_COMPLETED")]);
    expect(await s.poll()).toEqual({state: "pending", depositReceived: true});
    expect(await s.kept()).toBe(1);
    expect(s.state.disclosed).toHaveLength(0);
  });

  it("honest fill: disclosed, then FULLY_FILLED completes — also when the terminal snapshot lists no executions", async () => {
    for (const terminal of [[execution("EXECUTION_PHASE_COMPLETED")], []]) {
      const s = await setup();
      s.state.snapshot = snap(ACTIVE, [execution()]);
      await s.poll();
      expect(s.state.disclosed).toHaveLength(1);
      s.state.snapshot = snap(FILLED, terminal);
      expect(await s.poll()).toEqual({state: "completed", depositReceived: true});
      expect(await s.kept()).toBe(0);
      expect(await s.secretStore.load(`${s.quoteId}#disclosed-indices`)).toBeUndefined();
      vi.restoreAllMocks();
    }
  });

  it("honest fill disclosed and filled in the same poll completes", async () => {
    const s = await setup();
    s.state.snapshot = snap(FILLED, [execution()]);
    expect(await s.poll()).toEqual({state: "completed", depositReceived: true});
    expect(s.state.disclosed).toHaveLength(1);
    expect(await s.kept()).toBe(0);
  });

  it("a failed disclosure in the FULLY_FILLED poll keeps the secret; the retry discloses and completes", async () => {
    const s = await setup();
    s.state.snapshot = snap(FILLED, [execution()]);
    s.state.discloseFails = true;
    expect(await s.poll()).toEqual({state: "pending", depositReceived: true});
    expect(s.state.events).toContain("disclose-failed");
    expect(await s.kept()).toBe(1);
    s.state.discloseFails = false;
    expect(await s.poll()).toEqual({state: "completed", depositReceived: true});
    expect(s.state.disclosed).toHaveLength(1);
    expect(await s.kept()).toBe(0);
  });

  it("a delivery the locator finds is proof on its own", async () => {
    const locate = vi.fn(async () => "0x" + "cd".repeat(32));
    const s = await setup({locateEvmDelivery: locate});
    s.state.snapshot = snap(FILLED, [execution("EXECUTION_PHASE_COMPLETED")]);
    expect(await s.poll()).toEqual({state: "completed", depositReceived: true, destTxHash: "0x" + "cd".repeat(32)});
    expect(await s.kept()).toBe(0);
    // Nothing found: not proof.
    const none = await setup({locateEvmDelivery: async () => null});
    none.state.snapshot = snap(FILLED, [execution("EXECUTION_PHASE_COMPLETED")]);
    expect(await none.poll()).toEqual({state: "pending", depositReceived: true});
    expect(await none.kept()).toBe(1);
  });

  it("an order disclosed by the previous version (disclosure mark without indices) still completes", async () => {
    const s = await setup();
    await s.secretStore.save(`${s.quoteId}#disclosed`, ["1"]);
    s.state.snapshot = snap(FILLED, [execution("EXECUTION_PHASE_COMPLETED")]);
    expect(await s.poll()).toEqual({state: "completed", depositReceived: true});
    expect(await s.kept()).toBe(0);
  });

  it("without secrets on file the feed status is read as before", async () => {
    const s = await setup();
    await s.secretStore.clear(s.quoteId);
    s.state.snapshot = snap(FILLED, [execution("EXECUTION_PHASE_COMPLETED")]);
    expect(await s.poll()).toEqual({state: "completed", depositReceived: true});
  });
});
