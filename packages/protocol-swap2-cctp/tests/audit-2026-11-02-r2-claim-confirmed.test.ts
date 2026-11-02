// With no destination RPC, a CCTP swap whose claim was sent stayed pending forever, though the route was
// quoted and claimSwap2 had waited for the claim's receipt. Now claimSwap2 marks a claim the account saw
// included and succeed in the id it returns, and trackIntent takes that as the mint: completed without a
// destination read, pending (never a fresh claim) while a destination read lags behind it. A bare claim
// hash still proves nothing.
import {describe, expect, it} from "vitest";
import {type Hex} from "viem";
import {createMockAccount} from "@anywalletkit/conformance";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {cctpProvider} from "../src/provider.js";
import {FINALITY_FAST} from "../src/config.js";
import {make, world} from "./fixtures.js";

const SRC_TX = "0x" + "ab".repeat(32);
const NONCE = ("0x" + "11".repeat(32)) as Hex;
const message = (destinationDomain = "3") => ({
  message: "0x" + "22".repeat(200), attestation: "0x" + "33".repeat(130), status: "complete", cctpVersion: 2,
  decodedMessage: {sourceDomain: "6", destinationDomain, nonce: NONCE, decodedMessageBody: {amount: "10000000", maxFee: "1430", feeExecuted: "1300", expirationBlock: "0"}},
});
const intentId = `cctp:6:3:${FINALITY_FAST}`;
const id = `awk1.cctp.${encodeURIComponent(intentId)}.${SRC_TX}`;
const CLAIM = "0x" + "de".repeat(32);

class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}

const destAccount = (wait?: (h: string) => Promise<void>) => {
  const dest = createMockAccount({chain: "eip155:42161"});
  if (wait) (dest as unknown as {waitForTransaction: (h: string) => Promise<void>}).waitForTransaction = wait;
  return dest;
};

describe("cctp: a claim the account saw succeed completes the swap without a destination RPC", () => {
  const noRpc = () => cctpProvider({apiUrl: "https://iris.test", fetchImpl: world({message: message()}).fetchImpl});
  const sourceRpcOnly = () => cctpProvider({apiUrl: "https://iris.test", fetchImpl: world({message: message()}).fetchImpl, rpcUrls: {"eip155:8453": "http://rpc.base"}});

  it("no RPC at all, or only the source chain's: claimSwap2 → the returned id polls as completed", async () => {
    for (const p of [noRpc(), sourceRpcOnly()]) {
      const engine = new P(p);
      const out = await engine.claimSwap2(id, destAccount(async () => {}));
      expect(out.id).toBe(`${id}.${out.hash}.ok`);
      expect(await engine.getSwap2Status(out.id)).toEqual({status: "completed", transactions: [{hash: out.hash, type: "destination"}]});
      expect(await p.trackIntent({intentId, sourceTxHash: SRC_TX, destTxHash: CLAIM, destTxConfirmed: true})).toEqual({state: "completed", destTxHash: CLAIM, claim: {chain: "eip155:42161", ready: false}});
    }
  });

  it("a route to a destination with no RPC (Base → Linea) reaches completed through the claim", async () => {
    const p = cctpProvider({apiUrl: "https://iris.test", rpcUrls: {"eip155:8453": "http://rpc.base"}, fetchImpl: world({domain: 6, message: message("11")}).fetchImpl});
    const ref = {intentId: `cctp:6:11:${FINALITY_FAST}`, sourceTxHash: SRC_TX, destTxHash: CLAIM};
    expect((await p.trackIntent(ref)).state).toBe("pending");
    expect((await p.trackIntent({...ref, destTxConfirmed: true})).state).toBe("completed");
  });

  it("a destination RPC that does not show the confirmed claim's mint yet: pending with the hash, not a claim to send again", async () => {
    const lagging = make({message: message()}).p; // usedNonces reads 0
    const s = await lagging.trackIntent({intentId, sourceTxHash: SRC_TX, destTxHash: CLAIM, destTxConfirmed: true});
    expect(s).toEqual({state: "pending", depositReceived: true, destTxHash: CLAIM, claim: {chain: "eip155:42161", ready: false}});
    expect(await new P(lagging).getSwap2Status(`${id}.${CLAIM}.ok`)).toEqual({status: "pending", transactions: [{hash: CLAIM, type: "destination"}]});
    // Once it reads the nonce used: completed.
    expect(await make({message: message(), usedNonce: 1n}).p.trackIntent({intentId, sourceTxHash: SRC_TX, destTxHash: CLAIM, destTxConfirmed: true})).toMatchObject({state: "completed"});
  });

  it("controls: a bare claim hash (no wait, a wait that timed out) stays pending; with a reading RPC, an unconfirmed unused claim is action-required", async () => {
    const p = noRpc();
    const noWait = await new P(p).claimSwap2(id, destAccount());
    expect(noWait.id).toBe(`${id}.${noWait.hash}`);
    expect((await new P(p).getSwap2Status(noWait.id)).status).toBe("pending");
    const timedOut = await new P(p).claimSwap2(id, destAccount(async () => { throw Object.assign(new Error("Timed out while waiting"), {name: "WaitForTransactionReceiptTimeoutError"}); }));
    expect(timedOut.id).toBe(`${id}.${timedOut.hash}`);
    expect((await new P(p).getSwap2Status(timedOut.id)).status).toBe("pending");
    expect(await make({message: message()}).p.trackIntent({intentId, sourceTxHash: SRC_TX, destTxHash: CLAIM})).toMatchObject({state: "action-required", claim: {ready: true}});
  });

  it("the confirmed segment is only `ok`, only after a claim hash", async () => {
    const engine = new P(noRpc());
    await expect(engine.getSwap2Status(`${id}.${CLAIM}.yes`)).rejects.toThrow(/malformed swap2 status id/);
    await expect(engine.getSwap2Status(`${id}.${CLAIM}.ok.ok`)).rejects.toThrow(/malformed swap2 status id/);
  });
});
