import {describe, expect, it} from "vitest";
import {encodeFunctionData, parseAbi} from "viem";
import {createMockAccount} from "@anywalletkit/conformance";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, UnsignedTx} from "../src/types.js";

// Audit 2026-10-25 round 3, M24: claimSwap2 signed whatever calldata the provider's buildClaim
// returned, to whatever contract — and with a remote provider that is the server's word. A claim
// may now only call a contract the provider declares for that chain (`claimTargets`, kept on the
// client: CCTP's MessageTransmitter), and the calldata gets the source leg's decodeCall refusals:
// a claim never moves this account's tokens or grants an allowance.

const TRANSMITTER = "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64";
const ATTACKER = "0x9999999999999999999999999999999999999999";
const RECEIVE = "0x57ecfd28" + "00".repeat(64);
const erc20 = parseAbi(["function approve(address,uint256)", "function transfer(address,uint256)"]);
const claim = (over: Partial<UnsignedTx> = {}): UnsignedTx => ({chain: "eip155:42161", to: TRANSMITTER, value: "0", data: RECEIVE, chainId: 42161, gasLimit: "260000", ...over});

function provider(tx: UnsignedTx, targets: ((chain: string) => readonly string[]) | null = () => [TRANSMITTER.toLowerCase()]): CrossChainProvider {
  return {
    name: "two-phase", enabled: () => true, supportsRoute: () => true, getQuote: async () => null,
    buildDeposit: async () => { throw new Error("unused"); }, trackIntent: async () => ({state: "action-required"}),
    buildClaim: async () => tx, ...(targets ? {claimTargets: targets} : {}),
  };
}
class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}
const id = "awk1.two-phase.cctp%3A6%3A3%3A1000.0xabc";

describe("claimSwap2 calls only the provider's declared claim contracts", () => {
  it("a claim to another contract is refused", async () => {
    const dest = createMockAccount({chain: "eip155:42161"});
    await expect(new P(provider(claim({to: ATTACKER}))).claimSwap2(id, dest)).rejects.toThrow(/claim target/);
    expect(dest.sent).toHaveLength(0);
  });

  it("calldata that grants an allowance or moves tokens is refused, even to a declared contract", async () => {
    for (const data of [
      encodeFunctionData({abi: erc20, functionName: "approve", args: [ATTACKER, 2n ** 255n]}),
      encodeFunctionData({abi: erc20, functionName: "transfer", args: [ATTACKER, 1n]}),
    ]) {
      const dest = createMockAccount({chain: "eip155:42161"});
      await expect(new P(provider(claim({data}))).claimSwap2(id, dest)).rejects.toThrow(/claim/);
      expect(dest.sent).toHaveLength(0);
    }
  });

  it("a provider that declares no claim contracts cannot claim", async () => {
    await expect(new P(provider(claim(), null)).claimSwap2(id, createMockAccount({chain: "eip155:42161"}))).rejects.toThrow(/claimTargets/);
  });

  it("the declared contract (any letter case) with receiveMessage calldata is sent", async () => {
    const dest = createMockAccount({chain: "eip155:42161"});
    await expect(new P(provider(claim())).claimSwap2(id, dest)).resolves.toMatchObject({chain: "eip155:42161"});
    expect(dest.sent).toHaveLength(1);
  });
});
