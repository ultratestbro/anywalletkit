import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

// Audit 2026-10-25 round 3, L15: a deposit-address quote (no txRequest) committed only `to` and the
// memo. The build could add calldata, a spender or a serialized transaction the quote never had —
// the engine then approved that spender and sent the calldata. Such a build is now refused.

const SELF = "0x4444444444444444444444444444444444444444";
const DEPOSIT = "0x5555555555555555555555555555555555555555";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const options = {fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: SELF, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};
const quote = (p: QuoteParams): Quote => ({
  provider: "dep", intentId: "i-1", depositAddress: DEPOSIT, depositMemo: null, sourceAmount: p.amountIn, destAmount: "990000", minDestAmount: "980000",
  feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
}) as Quote;

function run(extra: Partial<UnsignedTx>) {
  const log: string[] = [];
  const provider: CrossChainProvider = {
    name: "dep", enabled: () => true, supportsRoute: () => true, getQuote: async (p) => quote(p),
    buildDeposit: async () => ({chain: "eip155:1", to: DEPOSIT, value: "0", ...extra}),
    trackIntent: async () => ({state: "pending"}),
  };
  const account = {
    getAddress: async () => SELF, getChainId: async () => 1, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to?: string; data?: string}) => { log.push(tx.data?.startsWith("0x095ea7b3") ? `approve→${tx.data.slice(34, 74)}` : `send→${tx.to}`); return {hash: "0x1"}; },
  };
  class P extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  return {swap: () => new P(account as never, {fromChain: "eip155:1"}).swap2(options), log};
}

describe("a deposit-address build cannot add what the quote did not have", () => {
  for (const [name, extra] of [
    ["calldata and a spender", {data: "0xdeadbeef", approvalAddress: ATTACKER}],
    ["calldata alone", {data: "0xdeadbeef"}],
    ["a serialized transaction", {serializedTx: "AQID"}],
  ] as const) {
    it(`${name}: refused before anything is sent`, async () => {
      const r = run(extra as Partial<UnsignedTx>);
      // (a serialized tx on EVM is also refused by the execution-model check; either way nothing goes out)
      await expect(r.swap()).rejects.toThrow(/does not match the validated quote deposit|serialized execution/);
      expect(r.log).toEqual([]);
    });
  }

  it("the plain deposit still goes out as a token transfer to the deposit address", async () => {
    const r = run({});
    await r.swap();
    expect(r.log).toEqual(["send→0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"]);
  });
});
