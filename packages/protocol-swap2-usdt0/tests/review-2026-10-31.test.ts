// Review 2026-10-31: a PAYLOAD_STORED delivery is reported as action-required and buildClaim returns
// EndpointV2.lzReceive on the destination, but the provider (and usdt0Pins) declared no claimTargets,
// so the core's claimSwap2 refused every USDT0 claim before signing. Both now name the destination's
// endpoint, and nothing else: a claim to another contract is still refused.
import {describe, expect, it} from "vitest";
import {createMockAccount} from "@anywalletkit/conformance";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {USDT0_CHAINS, usdt0ClaimTargets, usdt0Pins} from "../src/config.js";
import {ARB, HYPE, SRC_TX, GUID, PAYLOAD, make} from "./fixtures.js";

const stored = {
  pathway: {srcEid: ARB.eid, dstEid: HYPE.eid, sender: {address: ARB.oft.toLowerCase()}, receiver: {address: HYPE.oft.toLowerCase()}, nonce: 4242},
  source: {status: "SUCCEEDED", tx: {txHash: SRC_TX, payload: PAYLOAD, options: {lzReceive: {gas: "80000", value: "0"}}}},
  destination: {status: "WAITING"},
  guid: GUID,
  status: {name: "PAYLOAD_STORED", message: "PAYLOAD_STORED"},
};
const intentId = `usdt0:${ARB.eid}:${HYPE.eid}`;
const id = `awk1.usdt0.${encodeURIComponent(intentId)}.${SRC_TX}`;
const ATTACKER = "0x9999999999999999999999999999999999999999";

class P extends SingleProviderSwap2 {
  constructor(readonly provider: CrossChainProvider) { super(undefined, {fromChain: "eip155:42161", skipAccountChainCheck: true}); }
  protected override chainSupported(): boolean { return true; }
}

/** A remote stub built from the app's pins, whose server answers `claim` with `tx`. */
function remote(tx: UnsignedTx) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify(tx), {status: 200, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
  return {provider: remoteProvider({name: "usdt0", baseUrl: "https://server.test", fetchImpl, ...usdt0Pins}), calls};
}

describe("review 2026-10-31: a USDT0 stored-payload claim goes through claimSwap2", () => {
  it("usdt0ClaimTargets names each listed chain's EndpointV2 and nothing elsewhere; the provider and the pins carry it", () => {
    for (const c of Object.values(USDT0_CHAINS)) expect(usdt0ClaimTargets(c.caip2)).toEqual([c.endpoint]);
    expect(usdt0ClaimTargets("eip155:56")).toEqual([]);
    expect(usdt0ClaimTargets("toString")).toEqual([]);
    expect(usdt0Pins.claimTargets(HYPE.caip2)).toEqual([HYPE.endpoint]);
    expect(make().p.claimTargets!(HYPE.caip2)).toEqual([HYPE.endpoint]);
  });

  it("local provider: trackIntent says action-required, and claimSwap2 sends lzReceive to the HyperEVM endpoint", async () => {
    const {p} = make({message: stored});
    expect(await p.trackIntent({intentId, sourceTxHash: SRC_TX})).toMatchObject({state: "action-required", claim: {chain: "eip155:999", ready: true}});
    const dest = createMockAccount({chain: "eip155:999"});
    const out = await new P(p).claimSwap2(id, dest);
    expect(dest.sent).toHaveLength(1);
    expect(dest.sent[0]).toMatchObject({to: HYPE.endpoint, value: 0n, chainId: 999});
    expect(out.id).toBe(`${id}.${out.hash}`);
  });

  it("remote stub with usdt0Pins: the server's lzReceive to the endpoint is sent; the same claim to another contract is refused", async () => {
    const tx = (await make({message: stored}).p.buildClaim!({intentId, sourceTxHash: SRC_TX}))!;
    expect(tx.to).toBe(HYPE.endpoint);

    const ok = remote(tx);
    const dest = createMockAccount({chain: "eip155:999"});
    await expect(new P(ok.provider).claimSwap2(id, dest)).resolves.toMatchObject({chain: "eip155:999"});
    expect(ok.calls).toEqual(["https://server.test/claim"]);
    expect(dest.sent).toHaveLength(1);
    expect(dest.sent[0]).toMatchObject({to: HYPE.endpoint});

    // The app's list, not the server's: a backend that names its own contract gets nothing signed.
    const bad = remote({...tx, to: ATTACKER});
    const dest2 = createMockAccount({chain: "eip155:999"});
    await expect(new P(bad.provider).claimSwap2(id, dest2)).rejects.toThrow(/claim target/);
    expect(dest2.sent).toHaveLength(0);
    // Nor the endpoint of another chain (Arbitrum's, on a HyperEVM claim).
    expect(ARB.endpoint.toLowerCase()).not.toBe(HYPE.endpoint.toLowerCase());
    const other = remote({...tx, to: ARB.endpoint});
    const dest3 = createMockAccount({chain: "eip155:999"});
    await expect(new P(other.provider).claimSwap2(id, dest3)).rejects.toThrow(/claim target/);
    expect(dest3.sent).toHaveLength(0);
  });
});
