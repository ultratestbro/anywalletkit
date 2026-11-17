import {describe, expect, it, vi} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import {createSwap2Handler} from "../src/server.js";
import {remoteProvider} from "../src/remote.js";
import type {Swap2Operation, Swap2OperationStore} from "../src/operation.js";
import type {CrossChainProvider, Quote, RecoveryQuote} from "../src/types.js";

const actor = "0x1111111111111111111111111111111111111111";
const target = "0x2222222222222222222222222222222222222222";
const id = "awk1.recover.intent.0xsource";
const offer = (chain = "eip155:1"): RecoveryQuote => ({id: "drive-queue-7", kind: "drive-bus", description: "Drive the pending queue", validUntilMs: Date.now() + 60_000,
  tx: {chain, chainId: Number(chain.slice(7)), to: target, data: "0xdeadbeef", value: "5", gasLimit: "250000"}});
function storage(fail?: (record: Swap2Operation) => boolean): Swap2OperationStore {
  const records = new Map<string, Swap2Operation>();
  return {load: async (id) => records.get(id) ?? null, compareAndSet: async (id, rev, next) => {
    if (fail?.(next)) throw new Error("storage unavailable");
    if ((records.get(id)?.revision ?? null) !== rev) return false;
    records.set(id, structuredClone(next)); return true;
  }};
}
function setup(q = offer(), store = storage()) {
  const verify = vi.fn(async () => null as string | null);
  const provider: CrossChainProvider = {name: "recover", enabled: () => true, supportsRoute: () => true, getQuote: async () => null,
    buildDeposit: async () => q.tx, trackIntent: vi.fn(async () => ({state: "pending" as const})),
    getRecoveryQuotes: async () => [q], recoveryTargets: () => [target], verifyRecovery: verify,
    buildClaim: async () => q.tx, claimTargets: () => [target],
  };
  class P extends SingleProviderSwap2 { protected provider = provider; protected chainSupported() { return true; } }
  const api = new P(undefined, {fromChain: "eip155:1", operationStore: store, skipAccountChainCheck: true});
  const send = vi.fn(async () => ({hash: "0xrecovery"}));
  const account = {getAddress: async () => actor, getChainId: async () => Number(q.tx.chain.slice(7)), sendTransaction: send};
  const review = vi.fn(async (_q: Readonly<RecoveryQuote>) => {});
  const options = {operationId: "recovery-1", maxNativeValue: 5n, review};
  const run = () => api.recoverSwap2(id, q.id, account as never, options);
  return {api, provider, verify, send, account, review, options, run, store};
}

describe("explicit paid EVM recovery", () => {
  it.each(["eip155:1", "eip155:8453"])("reviews and journals recovery on %s with current on-chain validation", async (chain) => {
    const {run, send, review, verify, store, api, provider} = setup(offer(chain));
    expect(await run()).toEqual({hash: "0xrecovery", chain, operationId: "recovery-1"});
    expect(review).toHaveBeenCalledOnce(); expect(verify).toHaveBeenCalledTimes(2);
    expect(review.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]!);
    expect(verify.mock.calls[0]).toEqual([{intentId: "intent", sourceTxHash: "0xsource"}, expect.objectContaining({id: "drive-queue-7"}), actor]);
    expect(send).toHaveBeenCalledWith({to: target, data: "0xdeadbeef", value: 5n, chainId: Number(chain.slice(7)), gasLimit: 250000n});
    expect((await store.load("recovery-1"))!.phase).toBe("submitted");
    await api.resumeSwap2("recovery-1");
    expect(provider.trackIntent).toHaveBeenCalledWith({intentId: "intent", sourceTxHash: "0xsource", recoveryTxHash: "0xrecovery", recoveryChain: chain, recoveryActionId: "drive-queue-7"});
    await expect(run()).rejects.toThrow(/already exists/); expect(send).toHaveBeenCalledOnce();
  });
  it("cannot relax the legacy zero-value claim", async () => {
    const {api, account, send} = setup();
    await expect(api.claimSwap2(id, account as never)).rejects.toThrow(/native value/);
    expect(send).not.toHaveBeenCalled();
  });
  it.each([
    {value: "6"}, {value: "-1"}, {value: "0x5"}, {chainId: 2}, {to: actor},
    {data: "0x12"}, {approvalAddress: target}, {typedData: "{}"}, {serializedTx: "AA=="}, {stateInitBoc: "AA=="}, {gasLimit: "0"},
    {data: `0x095ea7b3${"0".repeat(24)}${target.slice(2)}${"0".repeat(63)}1`},
  ])("rejects unsafe recovery transaction %j", async (change) => {
    const q = offer(); q.tx = {...q.tx, ...change};
    const {run, send, review} = setup(q);
    await expect(run()).rejects.toThrow(); expect(send).not.toHaveBeenCalled(); expect(review).not.toHaveBeenCalled();
  });
  it("checks the actual recovery account chain even when source chain checks were opted out", async () => {
    const {run, account, send} = setup(); account.getChainId = async () => 56;
    await expect(run()).rejects.toThrow(/wrong chain/); expect(send).not.toHaveBeenCalled();
  });
  it("a declined review signs nothing", async () => {
    const {run, review, send} = setup(); review.mockRejectedValue(new Error("cancelled"));
    await expect(run()).rejects.toThrow(/cancelled/); expect(send).not.toHaveBeenCalled();
  });
  it("refuses a queue/commitment that changed while the review was open", async () => {
    const {run, verify, send} = setup(); verify.mockResolvedValueOnce(null).mockResolvedValueOnce("queue prefix changed");
    await expect(run()).rejects.toThrow(/queue prefix/); expect(send).not.toHaveBeenCalled();
  });
  it("requires the provider's client validator as well as address pins", async () => {
    const {run, provider, send} = setup(); delete provider.verifyRecovery;
    await expect(run()).rejects.toThrow(/calldata validator/); expect(send).not.toHaveBeenCalled();
  });
  it("retains an unknown recovery when the post-send write fails", async () => {
    const {run, send, store} = setup(offer(), storage((r) => r.phase === "submitted"));
    await expect(run()).rejects.toMatchObject({maybeSent: true, hash: "0xrecovery"});
    expect((await store.load("recovery-1"))!.steps[0]!.state).toBe("pending");
    await expect(run()).rejects.toThrow(/already exists/); expect(send).toHaveBeenCalledOnce();
  });
});

describe("remote recovery discovery", () => {
  it("requires an issued intent token and keeps signing validators on the client", async () => {
    const {provider} = setup();
    const params = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: actor, amountIn: "100", destAddress: actor};
    provider.getQuote = async () => ({provider: "recover", intentId: "intent", depositAddress: target, depositMemo: null, sourceAmount: "100", destAmount: "100", minDestAmount: "99", validUntilMs: Date.now() + 60_000, feeUsd: 0, reliability: 1, etaSeconds: 10});
    const handle = createSwap2Handler({providers: [provider], sealSecret: "recovery-secret-at-least-32-bytes-for-test", guard: () => {}});
    const issued = (await handle("quote", {provider: "recover", params}, null)).body as Quote;
    expect((await handle("recoveries", {provider: "recover", ref: {intentId: "intent"}}, null)).status).toBe(403);
    const fetchImpl: typeof fetch = async (url, init) => {
      const out = await handle(String(url).split("/").pop()!, JSON.parse(String(init!.body)), null);
      return new Response(JSON.stringify(out.body), {status: out.status});
    };
    const verify = vi.fn(async () => null);
    const remote = remoteProvider({name: "recover", baseUrl: "https://example.test", fetchImpl, recoveryTargets: () => [target], verifyRecovery: verify});
    expect((await remote.getRecoveryQuotes!({intentId: issued.intentId}))[0]!.id).toBe("drive-queue-7");
    expect(verify).not.toHaveBeenCalled(); // discovery is not execution validation
    expect(remote.verifyRecovery).toBe(verify);
    expect(remoteProvider({name: "recover", baseUrl: "https://example.test", fetchImpl}).getRecoveryQuotes).toBeUndefined();
  });
});
