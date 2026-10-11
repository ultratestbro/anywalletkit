import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2ExecutionPlan} from "../src/swap2/base.js";
import type {CrossChainProvider} from "../src/types.js";

const txRequest = {
  to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE", data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "21000",
  approvalAddress: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
};
const provider = (ttlMs = 60_000): CrossChainProvider => ({
  name: "review", enabled: () => true, supportsRoute: () => true,
  getQuote: async (params) => ({
    provider: "review", intentId: "intent", depositAddress: "", depositMemo: null, txRequest,
    sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
    feeUsd: 0.2, etaSeconds: 20, reliability: 1, validUntilMs: Date.now() + ttlMs,
  }),
  buildDeposit: async () => ({chain: "eip155:1", ...txRequest}),
  trackIntent: async () => ({state: "pending"}),
});
const options = {
  fromToken: "USDT", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161,
  recipient: "0x3333333333333333333333333333333333333333", fromTokenAmount: 1_000_000n, minAmountOut: 980_000n,
};
function account(log: string[]) {
  return {
    getAddress: async () => "0x4444444444444444444444444444444444444444",
    getChainId: async () => 1,
    sendTransaction: async (tx: {data?: string}) => { log.push(tx.data === "0xdeadbeef" ? "deposit" : "approve"); return {hash: `0x${log.length}`}; },
    waitForTransaction: async () => {},
  };
}
function protocol(p: CrossChainProvider, acc: unknown, review: (plan: Swap2ExecutionPlan) => unknown) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(acc as never, {fromChain: "eip155:1", reviewExecution: review as never});
}

describe("reviewExecution gate", () => {
  it("shows exactly what will be signed before any approval or send", async () => {
    const log: string[] = [];
    let seen: Swap2ExecutionPlan | undefined;
    await protocol(provider(), account(log), (plan) => { seen = plan; log.push("review"); }).swap2(options);
    expect(log).toEqual(["review", "approve", "approve", "deposit"]);
    expect(seen).toMatchObject({
      provider: "review", fromChain: "eip155:1", destChain: "eip155:42161", recipient: "0x3333333333333333333333333333333333333333",
      sourceAmount: 1_000_000n, destAmount: 990_000n, minDestAmount: 980_000n,
      approvals: [{amount: 0n}, {amount: 1_000_000n, spender: txRequest.approvalAddress}],
      source: {kind: "call", to: txRequest.to, data: "0xdeadbeef", value: 0n, chainId: 1, gasLimit: 21000n},
    });
    expect(Object.isFrozen(seen) && Object.isFrozen(seen!.source)).toBe(true);
  });

  it("a declined review sends nothing", async () => {
    const log: string[] = [];
    await expect(protocol(provider(), account(log), () => { throw new Error("user cancelled"); }).swap2(options)).rejects.toThrow(/user cancelled/);
    expect(log).toEqual([]);
  });

  it("a quote that expires during review is refused before the first approval", async () => {
    const log: string[] = [];
    await expect(protocol(provider(50), account(log), () => new Promise((r) => setTimeout(r, 80))).swap2(options))
      .rejects.toThrow(/expired during review — nothing was signed/);
    expect(log).toEqual([]);
  });
});
