// Review 2026-10-31: a destination tx hash stood in for a mint. With a destination RPC configured but
// failing, trackIntent took any recorded claim hash as completion; and claimSwap2 put the claim hash
// into the returned id right after broadcast, without waiting for the claim's receipt, so a reverted
// claim polled as completed. Now a failing RPC keeps the swap pending (hash kept), and claimSwap2
// waits for the claim to be included and succeed (where the account can tell) before handing out the id; only a
// proven revert loses the hash, a timeout or RPC failure keeps it.
import {describe, expect, it} from "vitest";
import {type Hex} from "viem";
import {createMockAccount} from "@anywalletkit/conformance";
import {Swap2ExecutionError} from "@anywalletkit/protocol-swap2-core/errors";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {cctpProvider} from "../src/provider.js";
import {FINALITY_FAST} from "../src/config.js";
import {make, world} from "./fixtures.js";

const SRC_TX = "0x" + "ab".repeat(32);
const NONCE = ("0x" + "11".repeat(32)) as Hex;
const completeMessage = (over: Record<string, unknown> = {}) => ({
  message: "0x" + "22".repeat(200), attestation: "0x" + "33".repeat(130), status: "complete", cctpVersion: 2, eventNonce: "9682",
  decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {amount: "10000000", maxFee: "1430", feeExecuted: "1300", expirationBlock: "0"}},
  ...over,
});
const intentId = `cctp:6:3:${FINALITY_FAST}`;
const ref = {intentId, sourceTxHash: SRC_TX};
const CLAIM = "0x" + "de".repeat(32);
const id = `awk1.cctp.${encodeURIComponent(intentId)}.${SRC_TX}`;

class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}

/** The provider with an Arbitrum RPC that answers 502 to everything. */
function failingRpc(message: unknown = completeMessage()) {
  const w = world({message});
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) =>
    String(input instanceof Request ? input.url : input).startsWith("http://rpc.down") ? new Response("bad gateway", {status: 502}) : w.fetchImpl(input, init)) as typeof fetch;
  return cctpProvider({apiUrl: "https://iris.test", fetchImpl, rpcUrls: {"eip155:42161": "http://rpc.down"}});
}

describe("review 2026-10-31: a recorded claim hash is not a mint when the destination can be read", () => {
  it("destination RPC configured but failing: a recorded claim hash is pending (hash kept), never completed", async () => {
    const p = failingRpc();
    expect(await p.trackIntent(ref)).toMatchObject({state: "action-required", claim: {ready: true}});
    const s = await p.trackIntent({...ref, destTxHash: CLAIM});
    expect(s).toMatchObject({state: "pending", depositReceived: true, destTxHash: CLAIM, claim: {ready: false}});
    expect((await new P(p).getSwap2Status(`${id}.${CLAIM}`))).toEqual({status: "pending", transactions: [{hash: CLAIM, type: "destination"}]});
  });

  it("an RPC configured but a message without a readable nonce: the claim hash is not taken as the mint either", async () => {
    const p = make({message: completeMessage({decodedMessage: {sourceDomain: "6", destinationDomain: "3"}})}).p;
    expect(await p.trackIntent({...ref, destTxHash: CLAIM})).toMatchObject({state: "pending", destTxHash: CLAIM});
  });

  it("controls: the RPC reads the nonce used → completed; unused → action-required; no RPC at all → the recorded hash is the evidence", async () => {
    expect(await make({message: completeMessage(), usedNonce: 1n}).p.trackIntent({...ref, destTxHash: CLAIM})).toMatchObject({state: "completed", destTxHash: CLAIM});
    expect(await make({message: completeMessage()}).p.trackIntent({...ref, destTxHash: CLAIM})).toMatchObject({state: "action-required", claim: {ready: true}});
    const noRpc = cctpProvider({apiUrl: "https://iris.test", fetchImpl: world({message: completeMessage()}).fetchImpl});
    expect(await noRpc.trackIntent({...ref, destTxHash: CLAIM})).toMatchObject({state: "completed", destTxHash: CLAIM});
    expect(await noRpc.trackIntent(ref)).toMatchObject({state: "action-required"});
  });
});

describe("review 2026-10-31: claimSwap2 waits for the claim before handing out the completion id", () => {
  const provider = () => cctpProvider({apiUrl: "https://iris.test", fetchImpl: world({message: completeMessage()}).fetchImpl});

  it("a claim the account reports as reverted raises Swap2ExecutionError and returns no completion id", async () => {
    const dest = createMockAccount({chain: "eip155:42161"});
    const waited: string[] = [];
    (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = async (h) => { waited.push(h); throw new Error(`Transaction ${h} reverted on chain (block 123).`); };
    const err = await new P(provider()).claimSwap2(id, dest).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Swap2ExecutionError);
    expect(String((err as Error).message)).toMatch(/reverted/);
    expect((err as Error).cause).toBeInstanceOf(Error);
    expect(dest.sent).toHaveLength(1);
    expect(waited).toHaveLength(1);
  });

  it("a wait that times out or loses the RPC proves nothing: the id with the claim hash is returned, and the status decides", async () => {
    // viem's receipt timeout, and an RPC failure, as the account would surface them.
    const timeout = Object.assign(new Error("Timed out while waiting for transaction with hash \"0x…\" to be confirmed."), {name: "WaitForTransactionReceiptTimeoutError"});
    for (const failure of [timeout, new Error("HTTP request failed. Status: 502")]) {
      const dest = createMockAccount({chain: "eip155:42161"});
      (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = async () => { throw failure; };
      const out = await new P(provider()).claimSwap2(id, dest);
      expect(dest.sent).toHaveLength(1);
      expect(out.id).toBe(`${id}.${out.hash}`);
    }
    // With a destination RPC that cannot answer, that id polls as pending, not completed.
    const p = failingRpc();
    const dest = createMockAccount({chain: "eip155:42161"});
    (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = async () => { throw timeout; };
    const out = await new P(p).claimSwap2(id, dest);
    expect(await new P(p).getSwap2Status(out.id)).toMatchObject({status: "pending", transactions: [{hash: out.hash, type: "destination"}]});
  });

  it("an account error flagged code 'reverted' is a revert too", async () => {
    const dest = createMockAccount({chain: "eip155:42161"});
    (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = async () => { throw Object.assign(new Error("claim failed"), {code: "reverted"}); };
    await expect(new P(provider()).claimSwap2(id, dest)).rejects.toBeInstanceOf(Swap2ExecutionError);
  });

  it("control: a claim the account reports included is returned with the claim hash in the id, after the wait", async () => {
    const dest = createMockAccount({chain: "eip155:42161"});
    const order: string[] = [];
    (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = async (h) => { order.push(`wait ${h}`); };
    const out = await new P(provider()).claimSwap2(id, dest);
    expect(order).toEqual([`wait ${out.hash}`]);
    expect(out.id).toBe(`${id}.${out.hash}`);
    expect(await new P(provider()).getSwap2Status(out.id)).toMatchObject({status: "completed"});
  });

  it("control: an account without waitForTransaction keeps today's behaviour (id right after broadcast)", async () => {
    const dest = createMockAccount({chain: "eip155:42161"});
    expect((dest as {waitForTransaction?: unknown}).waitForTransaction).toBeUndefined();
    const out = await new P(provider()).claimSwap2(id, dest);
    expect(dest.sent).toHaveLength(1);
    expect(out.id).toBe(`${id}.${out.hash}`);
  });
});
