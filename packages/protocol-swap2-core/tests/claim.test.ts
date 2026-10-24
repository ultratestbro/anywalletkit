import {describe, expect, it} from "vitest";
import {createMockAccount} from "@forgewallet/conformance";
import {Swap2StatusError, Swap2UnsupportedOperationError, Swap2ExecutionError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, IntentRef, UnsignedTx} from "../src/types.js";

const CLAIM: UnsignedTx = {chain: "eip155:42161", to: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", value: "0", data: "0x57ecfd28" + "00".repeat(64), chainId: 42161, gasLimit: "260000"};

function provider(claim: UnsignedTx | null | (() => never), name = "two-phase"): CrossChainProvider & {claims: IntentRef[]} {
  const claims: IntentRef[] = [];
  return {
    name, claims,
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => null,
    buildDeposit: async () => { throw new Error("unused"); },
    trackIntent: async () => ({state: "action-required", claim: {chain: "eip155:42161", ready: true}}),
    async buildClaim(ref) { claims.push(ref); return typeof claim === "function" ? claim() : claim; },
  };
}

class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}

const id = "awk1.two-phase.cctp%3A6%3A3%3A1000.0xabc";

describe("claimSwap2 (two-phase delivery)", () => {
  it("sends the provider's claim through a destination-chain account and reports the hash", async () => {
    const prov = provider(CLAIM);
    const p = new P(prov);
    const dest = createMockAccount({chain: "eip155:42161"});
    const out = await p.claimSwap2(id, dest);
    expect(out).toMatchObject({chain: "eip155:42161", id});
    expect(out.hash).toMatch(/^0x/);
    expect(prov.claims).toEqual([{intentId: "cctp:6:3:1000", sourceTxHash: "0xabc"}]);
    expect(dest.sent).toHaveLength(1);
    expect(dest.sent[0]).toMatchObject({to: CLAIM.to, data: CLAIM.data, value: 0n, chainId: 42161, gasLimit: 260000n});
  });

  it("refuses an id under any other prefix — nothing is sent", async () => {
    const prov = provider(CLAIM);
    const p = new P(prov);
    const dest = createMockAccount({chain: "eip155:42161"});
    await expect(p.claimSwap2(`xyz1${id.slice(4)}`, dest)).rejects.toThrow(/malformed swap2 status id/);
    expect(prov.claims).toEqual([]);
    expect(dest.sent).toHaveLength(0);
  });

  it("not ready → Swap2StatusError; nothing is sent", async () => {
    const p = new P(provider(null));
    const dest = createMockAccount({chain: "eip155:42161"});
    await expect(p.claimSwap2(id, dest)).rejects.toBeInstanceOf(Swap2StatusError);
    expect(dest.sent).toHaveLength(0);
  });

  it("refuses an account on another chain, a read-only account, a provider without claims, and non-EVM / non-calldata claims", async () => {
    await expect(new P(provider(CLAIM)).claimSwap2(id, createMockAccount({chain: "eip155:8453"}))).rejects.toThrow(/bound to eip155:8453/);
    await expect(new P(provider(CLAIM)).claimSwap2(id, createMockAccount({chain: "eip155:42161"}).toReadOnlyAccount())).rejects.toBeInstanceOf(Swap2ExecutionError);
    const noClaim = provider(CLAIM);
    delete (noClaim as Partial<CrossChainProvider>).buildClaim;
    await expect(new P(noClaim).claimSwap2(id, createMockAccount({chain: "eip155:42161"}))).rejects.toBeInstanceOf(Swap2UnsupportedOperationError);
    await expect(new P(provider({...CLAIM, chain: "solana:mainnet"})).claimSwap2(id, createMockAccount({chain: "eip155:42161"}))).rejects.toBeInstanceOf(Swap2UnsupportedOperationError);
    await expect(new P(provider({...CLAIM, value: "5"})).claimSwap2(id, createMockAccount({chain: "eip155:42161"}))).rejects.toThrow(/native value/);
    await expect(new P(provider({...CLAIM, approvalAddress: CLAIM.to})).claimSwap2(id, createMockAccount({chain: "eip155:42161"}))).rejects.toThrow(/plain calldata/);
    await expect(new P(provider({...CLAIM, chainId: 1})).claimSwap2(id, createMockAccount({chain: "eip155:42161"}))).rejects.toThrow(/chainId 1/);
  });

  it("getSwap2Status surfaces action-required for the app to offer the claim", async () => {
    const p = new P(provider(CLAIM));
    expect(await p.getSwap2Status(id)).toEqual({status: "action-required"});
  });
});
