import {describe, expect, it} from "vitest";
import {ccChain} from "@anywalletkit/swap2-assets";
import {Swap2ValidationError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider} from "../src/types.js";

// Audit 2026-10-25 round 3, M25: getSupportedTokens() handed out `token: a.assetId`, which is ""
// for most EVM catalog entries, and an empty token ref resolved to the native coin: passing the
// listed identifier back as fromToken / toToken quoted ETH instead of the token. The list now
// gives the contract (or the symbol for the native coin), and "" is refused.

const SELF = "0x4444444444444444444444444444444444444444";
const provider: CrossChainProvider = {
  name: "p", enabled: () => true, supportsRoute: () => true,
  getQuote: async () => { throw new Error("no quote in this test"); },
  buildDeposit: async () => { throw new Error("no build"); }, trackIntent: async () => ({state: "pending"}),
};
function engine() {
  class P extends SingleProviderSwap2 {
    protected readonly provider = provider;
    protected chainSupported(): boolean { return true; }
  }
  return new P({getAddress: async () => SELF, getChainId: async () => 1} as never, {fromChain: "eip155:1"});
}

describe("supported tokens are identifiers the engine takes back", () => {
  it("no empty token: a token's contract, the native coin's symbol", async () => {
    const list = await engine().getSupportedTokens({fromChain: 1, toChain: 1});
    expect(list.length).toBeGreaterThan(0)
    expect(list.filter((t) => t.token === "")).toEqual([]);
    const usdc = ccChain("eip155:1")!.assets.find((a) => a.symbol === "USDC")!;
    expect(list.find((t) => t.symbol === "USDC" && t.chain === "eip155:1")!.token).toBe(usdc.contract);
    expect(list.find((t) => t.symbol === "ETH" && t.chain === "eip155:1")!.token).toBe("ETH");
  });

  it('an empty fromToken / toToken is refused, not read as the native coin', async () => {
    const base = {fromToken: "USDC", toToken: "USDC", toChain: 42161, recipient: SELF, fromTokenAmount: 1_000_000n};
    await expect(engine().quoteSwap2({...base, fromToken: ""})).rejects.toBeInstanceOf(Swap2ValidationError);
    await expect(engine().quoteSwap2({...base, toToken: ""})).rejects.toBeInstanceOf(Swap2ValidationError);
    await expect(engine().quoteSwap2({...base, toToken: "  "})).rejects.toBeInstanceOf(Swap2ValidationError);
  });
});
