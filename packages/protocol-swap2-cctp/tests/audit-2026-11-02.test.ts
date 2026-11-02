// Without a destination RPC, a recorded claim hash made trackIntent report `completed`: nothing had read the
// mint. Now the swap stays pending with the hash kept; only the destination's `usedNonces` makes it completed.
import {describe, expect, it} from "vitest";
import {type Hex} from "viem";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {cctpProvider} from "../src/provider.js";
import {FINALITY_FAST} from "../src/config.js";
import {make, world} from "./fixtures.js";

const SRC_TX = "0x" + "ab".repeat(32);
const NONCE = ("0x" + "11".repeat(32)) as Hex;
const completeMessage = () => ({
  message: "0x" + "22".repeat(200), attestation: "0x" + "33".repeat(130), status: "complete", cctpVersion: 2,
  decodedMessage: {sourceDomain: "6", destinationDomain: "3", nonce: NONCE, decodedMessageBody: {amount: "10000000", maxFee: "1430", feeExecuted: "1300", expirationBlock: "0"}},
});
const intentId = `cctp:6:3:${FINALITY_FAST}`;
const ref = {intentId, sourceTxHash: SRC_TX};
const CLAIM = "0x" + "de".repeat(32);
const id = `awk1.cctp.${encodeURIComponent(intentId)}.${SRC_TX}`;

class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:8453", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}

describe("cctp: a claim hash without a destination RPC is not a completed swap", () => {
  const noRpc = () => cctpProvider({apiUrl: "https://iris.test", fetchImpl: world({message: completeMessage()}).fetchImpl});
  const sourceRpcOnly = () => cctpProvider({apiUrl: "https://iris.test", fetchImpl: world({message: completeMessage()}).fetchImpl, rpcUrls: {"eip155:8453": "http://rpc.base"}});

  it("no RPC at all, or only the source chain's: pending, deposit received, hash kept, claim not ready", async () => {
    for (const p of [noRpc(), sourceRpcOnly()]) {
      expect(await p.trackIntent({...ref, destTxHash: CLAIM})).toEqual({state: "pending", depositReceived: true, destTxHash: CLAIM, claim: {chain: "eip155:42161", ready: false}});
      expect(await new P(p).getSwap2Status(`${id}.${CLAIM}`)).toEqual({status: "pending", transactions: [{hash: CLAIM, type: "destination"}]});
    }
  });

  it("controls: without a claim hash the attested message is ready to claim; the destination RPC reading the nonce used is completed", async () => {
    expect(await noRpc().trackIntent(ref)).toMatchObject({state: "action-required", depositReceived: true, claim: {ready: true}});
    expect(await make({message: completeMessage(), usedNonce: 1n}).p.trackIntent({...ref, destTxHash: CLAIM})).toMatchObject({state: "completed", destTxHash: CLAIM});
    expect(await make({message: completeMessage(), usedNonce: 1n}).p.trackIntent(ref)).toMatchObject({state: "completed"});
  });
});
