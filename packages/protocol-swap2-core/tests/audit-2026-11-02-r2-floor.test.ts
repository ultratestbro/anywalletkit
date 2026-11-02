// A provider's minimum a few base units under floor(dest × (1 − slippage)) — float rounding on an 18-decimal output,
// LI.FI's Mayan answers of 2026-11-02 — was refused by the engine's quote check as "exceeds caller slippage". The
// engine now allows the request plus SLIPPAGE_ROUNDING_BPS, the same rule as validQuote and the providers.
import {describe, expect, it} from "vitest";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import {SLIPPAGE_ROUNDING_BPS, slippageFloor} from "../src/validate.js";
import type {CrossChainProvider, Quote, QuoteParams} from "../src/types.js";

const RECIPIENT = "0x3333333333333333333333333333333333333333";
const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const options = {fromToken: "USDC", toToken: "0x0000000000000000000000000000000000000000", toChain: 1, recipient: RECIPIENT, fromTokenAmount: 1_000_000n};

function protocol(min: (dest: bigint, params: QuoteParams) => bigint) {
  const dest = 81811777162793400n;
  const p: CrossChainProvider = {
    name: "edge", enabled: () => true, supportsRoute: () => true,
    getQuote: async (params): Promise<Quote> => ({
      provider: "edge", intentId: "i", depositAddress: "", depositMemo: null,
      txRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "21000", approvalAddress: DIAMOND},
      sourceAmount: params.amountIn, destAmount: dest.toString(), minDestAmount: min(dest, params).toString(),
      feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
    }),
    buildDeposit: async () => { throw new Error("not built"); },
    trackIntent: async () => ({state: "pending"}),
  };
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P({getAddress: async () => RECIPIENT, getChainId: async () => 1} as never, {fromChain: "eip155:8453"});
}

describe("audit 2026-11-02 r2: the engine's slippage check tolerates the providers' rounding only", () => {
  it("LI.FI's 81402718276979400 for 81811777162793400 at 0.5 % passes; 1 bp past the tolerance does not", async () => {
    expect(SLIPPAGE_ROUNDING_BPS).toBe(1);
    await expect(protocol(() => 81402718276979400n).quoteSwap2({...options, slippage: 0.005})).resolves.toMatchObject({toTokenAmountMin: 81402718276979400n});
    await expect(protocol((d) => slippageFloor(d, 50)).quoteSwap2({...options, slippage: 0.005})).resolves.toBeDefined();
    await expect(protocol((d) => slippageFloor(d, 50) - 1n).quoteSwap2({...options, slippage: 0.005})).rejects.toThrow();
    await expect(protocol((d) => (d * 9_948n) / 10_000n).quoteSwap2({...options, slippage: 0.005})).rejects.toThrow();
  });
});
