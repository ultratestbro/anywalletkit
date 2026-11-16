import {describe, expect, it, vi} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import {Swap2MaybeSentError} from "../src/errors.js";
import {Swap2OperationJournal, loadSwap2Operation, type Swap2Operation, type Swap2OperationStore} from "../src/operation.js";
import type {CrossChainProvider} from "../src/types.js";

function memoryStore(fail?: (next: Swap2Operation) => boolean): Swap2OperationStore {
  const rows = new Map<string, Swap2Operation>();
  return {
    load: async (id) => rows.has(id) ? structuredClone(rows.get(id)!) : null,
    compareAndSet: async (id, revision, next) => {
      if (fail?.(next)) throw new Error("storage offline");
      if ((rows.get(id)?.revision ?? null) !== revision) return false;
      rows.set(id, structuredClone(next)); return true;
    },
  };
}
const input = {id: "op-1", provider: "journal", intentId: "intent", sourceChain: "eip155:1", sender: "0x1111111111111111111111111111111111111111", request: {amountIn: "100"}};
const options = {fromToken: "USDC", toToken: "USDC", toChain: "eip155:8453", fromTokenAmount: 100n, minAmountOut: 90n, operationId: "op-1"};
const target = "0x2222222222222222222222222222222222222222";
const tx = {to: target, data: "0xdeadbeef", value: "0", approvalAddress: target, chainId: 1};
function setup(store: Swap2OperationStore, onSend?: (kind: string) => Promise<{hash?: string}>) {
  const sent: string[] = [];
  const track = vi.fn(async () => ({state: "completed" as const}));
  const provider: CrossChainProvider = {name: "journal", enabled: () => true, supportsRoute: () => true,
    getQuote: async (p) => ({provider: "journal", intentId: "intent", depositAddress: "", depositMemo: null, txRequest: tx, sourceAmount: p.amountIn, destAmount: "100", minDestAmount: "99", feeUsd: 0, etaSeconds: 10, reliability: 1, validUntilMs: Date.now() + 60_000}),
    buildDeposit: async () => ({...tx, chain: "eip155:1"}), trackIntent: track,
  };
  const account = {getAddress: async () => input.sender, getChainId: async () => 1, getAllowance: async () => 0n,
    sendTransaction: async (tx: {data?: string}) => {
      const kind = tx.data === "0xdeadbeef" ? "source" : "approval";
      const row = (await store.load(options.operationId))!;
      expect(row.steps.at(-1)?.state).toBe("pending");
      sent.push(kind);
      return onSend ? onSend(kind) : {hash: `0x${sent.length}`};
    }, waitForTransaction: async () => {},
  };
  class P extends SingleProviderSwap2 {
    protected provider = provider;
    protected chainSupported() { return true; }
  }
  const create = () => new P(account as never, {fromChain: "eip155:1", operationStore: store});
  return {api: create(), create, sent, track, provider};
}

describe("durable operation journal", () => {
  it("atomically claims an id across independent executors", async () => {
    const store = memoryStore();
    const results = await Promise.allSettled([Swap2OperationJournal.create(store, input), Swap2OperationJournal.create(store, input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await store.load(input.id))?.revision).toBe(0);
  });
  it("writes before a side effect and never saves signed data", async () => {
    const store = memoryStore(), journal = await Swap2OperationJournal.create(store, input);
    const signature = await journal.effect("order-sign", input.sourceChain, async () => {
      expect((await store.load(input.id))!.steps[0]!.state).toBe("pending");
      return "SECRET_SIGNATURE";
    }, {ambiguous: () => null});
    expect(signature).toBe("SECRET_SIGNATURE");
    expect(JSON.stringify(await store.load(input.id))).not.toContain(signature);
    expect(Object.isFrozen(journal.snapshot.steps)).toBe(true);
  });
  it("a post-send storage failure retains the write-ahead marker and reports ambiguity", async () => {
    const store = memoryStore((next) => next.steps.some((s) => s.state === "submitted"));
    const journal = await Swap2OperationJournal.create(store, input);
    await expect(journal.effect("source", input.sourceChain, async () => ({hash: "0xabc"}), {hash: (r) => r.hash, ambiguous: () => null})).rejects.toMatchObject({maybeSent: true, hash: "0xabc"});
    expect((await store.load(input.id))!.steps[0]!.state).toBe("pending");
    await expect(journal.effect("source", input.sourceChain, async () => ({}), {ambiguous: () => null})).rejects.toThrow(/reconcile/);
  });
  it("validates records loaded from storage before dispatch", async () => {
    const store = memoryStore(); await Swap2OperationJournal.create(store, input);
    const good = (await store.load(input.id))!;
    for (const record of [{...good, schemaVersion: 2}, {...good, id: "other"}, {...good, revision: -1}, {...good, steps: [{}]}]) {
      await expect(loadSwap2Operation({...store, load: async () => record as Swap2Operation}, input.id)).rejects.toThrow(/malformed/);
    }
  });
});

describe("durable swap execution and reconciliation", () => {
  it("persists approval/source hashes and resumes through the provider without another send", async () => {
    const store = memoryStore(), {api, create, sent, track} = setup(store);
    const result = await api.swap2(options);
    expect(result.id).toMatch(/^awk1\./);
    expect(sent).toEqual(["approval", "source"]);
    expect((await store.load(options.operationId))!.steps.map((s) => [s.kind, s.state, s.hash])).toEqual([["approval", "submitted", "0x1"], ["source", "submitted", "0x2"]]);
    const resumed = await create().resumeSwap2(options.operationId);
    expect(resumed.status.state).toBe("completed"); expect(resumed.id).toBe(result.id);
    expect(track).toHaveBeenCalledWith({intentId: "intent", sourceTxHash: "0x2"});
    await expect(create().swap2(options)).rejects.toThrow(/already exists/);
    expect(sent).toEqual(["approval", "source"]);
  });
  it.each(["create", "approval-marker"])("stops before signature when %s storage fails", async (phase) => {
    const store = memoryStore((r) => phase === "create" ? r.revision === 0 : r.steps.at(-1)?.kind === "approval");
    const {api, sent} = setup(store);
    await expect(api.swap2(options)).rejects.toThrow(/storage/);
    expect(sent).toEqual([]);
  });
  it("does not repeat an ambiguous approval after reopening", async () => {
    const store = memoryStore(), {api, create, sent, track} = setup(store, async () => { throw Object.assign(new Error("lost response"), {maybeSent: true, hash: "0xapproval"}); });
    await expect(api.swap2(options)).rejects.toMatchObject({maybeSent: true});
    expect((await store.load(options.operationId))!.phase).toBe("unknown");
    expect((await create().resumeSwap2(options.operationId)).status.state).toBe("unknown");
    await expect(create().swap2(options)).rejects.toThrow(/already exists/);
    expect(sent).toEqual(["approval"]); expect(track).not.toHaveBeenCalled();
  });
  it("preserves unknown source outcomes rather than inventing a refund", async () => {
    const store = memoryStore();
    const {api, create, sent, track} = setup(store, async (kind) => {
      if (kind === "source") throw Object.assign(new Error("lost response"), {maybeSent: true, hash: "0xsource"});
      return {hash: "0xapproval"};
    });
    await expect(api.swap2(options)).rejects.toBeInstanceOf(Swap2MaybeSentError);
    track.mockResolvedValue({state: "refunded"} as never);
    expect((await create().resumeSwap2(options.operationId)).status.state).toBe("unknown");
    track.mockResolvedValue({state: "completed"});
    expect((await create().resumeSwap2(options.operationId)).status.state).toBe("completed");
    expect(sent).toEqual(["approval", "source"]);
  });
  it("does not revoke or repeat a source send when saving its hash fails", async () => {
    const store = memoryStore((r) => r.steps.some((s) => s.kind === "source" && s.state === "submitted"));
    const {api, create, sent, track} = setup(store);
    await expect(api.swap2(options)).rejects.toMatchObject({maybeSent: true, hash: "0x2"});
    expect((await create().resumeSwap2(options.operationId)).status.state).toBe("unknown");
    expect(sent).toEqual(["approval", "source"]); expect(track).not.toHaveBeenCalled();
  });
  it("requires storage and application id together", async () => {
    const {api} = setup(memoryStore());
    const {operationId: _id, ...withoutId} = options;
    await expect(api.swap2(withoutId)).rejects.toThrow(/used together/);
  });
  it("keeps one journal through an approval-triggered re-quote", async () => {
    let now = 1_800_000_000_000, calls = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const store = memoryStore();
      const {api, provider, sent} = setup(store, async (kind) => { if (kind === "approval") now += 100; return {hash: `0x${kind}`}; });
      const getQuote = provider.getQuote;
      provider.getQuote = async (p) => ({...(await getQuote(p))!, routeId: "bus", intentId: `intent-${++calls}`, validUntilMs: now + (calls === 1 ? 50 : 60_000)});
      await api.swap2(options);
      expect(sent).toEqual(["approval", "source"]);
      const record = (await store.load(options.operationId))!;
      expect(record.intentId).toBe("intent-2"); expect(record.routeId).toBe("bus");
      expect(record.request.minAmountOut).toBe("90"); expect(record.steps).toHaveLength(2);
    } finally { clock.mockRestore(); }
  });
});
