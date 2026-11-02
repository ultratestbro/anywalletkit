// A claim the destination account saw included and succeed rides in the status id (`.ok` after the claim
// hash) and reaches the provider as `destTxConfirmed`, through a remote backend too; a bare hash does not.
import {describe, expect, it} from "vitest";
import {createMockAccount} from "@anywalletkit/conformance";
import {remoteProvider} from "../src/remote.js";
import {createSwap2Handler} from "../src/server.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {CrossChainProvider, IntentRef, Quote, QuoteParams} from "../src/types.js";

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
const PARAMS: QuoteParams = {
  sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453",
  destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100000000",
  destAddress: "0x1111111111111111111111111111111111111111", refundAddress: "0x1111111111111111111111111111111111111111",
};
const QUOTE: Quote = {
  provider: "two-phase", intentId: "i", depositAddress: "0x2222222222222222222222222222222222222222", depositMemo: null,
  txRequest: {to: "0x3333333333333333333333333333333333333333", data: "0xdeadbeef", value: "0", chainId: 1, approvalAddress: "0x3333333333333333333333333333333333333333"},
  sourceAmount: "100000000", destAmount: "99900000", minDestAmount: "99800000", feeUsd: 0.1,
  fees: [{type: "protocol", amount: "100000", token: "eip155:1/erc20:0xa0b8", included: true}],
  etaSeconds: 30, reliability: 0.97, validUntilMs: Date.now() + 60_000,
};
const MT = "0x1a8aa7b2d1e4b0c1c0d7e5f6a7b8c9d0e1f2a3b4";

function twoPhase() {
  const tracked: IntentRef[] = [];
  const provider: CrossChainProvider = {
    name: "two-phase",
    enabled: () => true,
    supportsRoute: () => true,
    getQuote: async () => ({...QUOTE}),
    buildDeposit: async () => { throw new Error("unused"); },
    trackIntent: async (ref) => { tracked.push(ref); return {state: ref.destTxConfirmed ? "completed" : "pending", ...(ref.destTxHash ? {destTxHash: ref.destTxHash} : {})}; },
    buildClaim: async () => ({chain: "eip155:42161", to: MT, data: "0x57ecfd28" + "00".repeat(64), value: "0", chainId: 42161}),
    claimTargets: () => [MT],
  };
  return {provider, tracked};
}

class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}
const id = "awk1.two-phase.cctp%3A6%3A3%3A1000.0xabc";

describe("a confirmed claim reaches the provider as destTxConfirmed", () => {
  it("claimSwap2 with a wait that resolved → `.ok` id → trackIntent gets destTxConfirmed: true", async () => {
    const {provider, tracked} = twoPhase();
    const dest = createMockAccount({chain: "eip155:42161"});
    (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = async () => {};
    const out = await new P(provider).claimSwap2(id, dest);
    expect(out.id).toBe(`${id}.${out.hash}.ok`);
    expect((await new P(provider).getSwap2Status(out.id)).status).toBe("completed");
    expect(tracked.at(-1)).toEqual({intentId: "cctp:6:3:1000", sourceTxHash: "0xabc", destTxHash: out.hash, destTxConfirmed: true});
  });

  it("controls: an account without the wait gets the bare-hash id, and polling it passes no destTxConfirmed", async () => {
    const {provider, tracked} = twoPhase();
    const out = await new P(provider).claimSwap2(id, createMockAccount({chain: "eip155:42161"}));
    expect(out.id).toBe(`${id}.${out.hash}`);
    expect((await new P(provider).getSwap2Status(out.id)).status).toBe("pending");
    expect(tracked.at(-1)).toEqual({intentId: "cctp:6:3:1000", sourceTxHash: "0xabc", destTxHash: out.hash});
  });

  it("through a remote backend: the flag is forwarded with the hash, dropped without one, and only as `true`", async () => {
    const {provider, tracked} = twoPhase();
    const handle = createSwap2Handler({providers: [provider], sealSecret: SECRET, guard: () => {}});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "u");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const client = remoteProvider({name: "two-phase", baseUrl: "https://api.example.test/swap2", fetchImpl});
    const {intentId} = (await client.getQuote(PARAMS))!;
    expect((await client.trackIntent({intentId, destTxHash: "0xde", destTxConfirmed: true})).state).toBe("completed");
    expect(tracked.at(-1)).toEqual({intentId: "i", destTxHash: "0xde", destTxConfirmed: true});
    await client.trackIntent({intentId, destTxConfirmed: true});
    expect(tracked.at(-1)).toEqual({intentId: "i"});
    await handle("track", {provider: "two-phase", ref: {intentId, destTxHash: "0xde", destTxConfirmed: "yes"}}, "u");
    expect(tracked.at(-1)).toEqual({intentId: "i", destTxHash: "0xde"});
  });
});
