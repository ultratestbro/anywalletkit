import {describe, expect, it} from "vitest";
import {createMockAccount} from "@anywalletkit/conformance";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, IntentRef, UnsignedTx} from "../src/types.js";

// Audit 2026-10-25 round 3, M27: after a CCTP claim, a provider without a destination RPC can only
// learn that the delivery completed from the claim's hash (`trackIntent({ destTxHash })`). The id
// claimSwap2 returned was the old one and getSwap2Status never passed a destTxHash, so the status
// stayed "action-required" forever. The returned id now carries the claim hash, and status polls
// hand it to trackIntent.

const TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const CLAIM: UnsignedTx = {chain: "eip155:42161", to: TRANSMITTER, value: "0", data: "0x57ecfd28" + "00".repeat(64), chainId: 42161};

function provider() {
  const tracked: IntentRef[] = [];
  const p: CrossChainProvider = {
    name: "two-phase", enabled: () => true, supportsRoute: () => true, getQuote: async () => null,
    buildDeposit: async () => { throw new Error("unused"); },
    trackIntent: async (ref) => { tracked.push(ref); return ref.destTxHash ? {state: "completed", destTxHash: ref.destTxHash} : {state: "action-required"}; },
    buildClaim: async () => CLAIM, claimTargets: () => [TRANSMITTER],
  };
  return {p, tracked};
}
class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}
const id = "awk1.two-phase.cctp%3A6%3A3%3A1000.0xabc";

describe("after claimSwap2 the status id carries the claim hash", () => {
  it("the returned id names the claim; polling it passes destTxHash and reaches completed", async () => {
    const {p, tracked} = provider();
    const engine = new P(p);
    const out = await engine.claimSwap2(id, createMockAccount({chain: "eip155:42161"}));
    expect(out.id).not.toBe(id);
    const status = await engine.getSwap2Status(out.id);
    expect(tracked.at(-1)).toEqual({intentId: "cctp:6:3:1000", sourceTxHash: "0xabc", destTxHash: out.hash});
    expect(status.status).toBe("completed");
  });

  it("the original id still polls without a destTxHash", async () => {
    const {p, tracked} = provider();
    await new P(p).getSwap2Status(id);
    expect(tracked.at(-1)).toEqual({intentId: "cctp:6:3:1000", sourceTxHash: "0xabc"});
  });
});
