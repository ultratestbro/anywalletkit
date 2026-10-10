import {afterEach, describe, expect, it, vi} from "vitest";
import {thorchainProvider} from "../src/provider.js";
import {ThorchainSwap2Protocol} from "../src/protocol.js";

afterEach(() => vi.unstubAllGlobals());

describe("THORChain provider contract", () => {
  const SOURCE_HASH = `0x${"a".repeat(64)}`;
  it("rejects half-configured affiliates", () => {
    expect(() => thorchainProvider({affiliate: "t"})).toThrow(/configured together/);
    expect(() => thorchainProvider({affiliate: "bad:name", affiliateBps: "10"})).toThrow(/memo characters/);
    expect(() => thorchainProvider({nodeUrl: "file:///tmp/thor"})).toThrow(/http or https/);
  });

  it("keeps the Tron source dark unless opted in", () => {
    expect(thorchainProvider().supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(false);
    expect(thorchainProvider({tronSource: true}).supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(true);
    // Other deposit-address chains stay off even when Tron is on.
    expect(thorchainProvider({tronSource: true}).supportsRoute({chain: "bitcoin:mainnet", token: "BTC"}, {chain: "eip155:1", token: "ETH"})).toBe(false);
  });

  it("does not advertise tokens for an unimplemented standalone source pair", async () => {
    const protocol = new ThorchainSwap2Protocol(undefined, {fromChain: "tron:728126428"});
    await expect(protocol.getSupportedTokens({fromChain: "tron:728126428", toChain: "eip155:1"})).resolves.toEqual([]);
  });

  it("does not report completion without a classified observed outbound", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      stages: {inbound_observed: {completed: true}, outbound_signed: {completed: true}},
      planned_out_txs: [],
      out_txs: [],
    })));
    await expect(thorchainProvider({nodeUrl: "https://thor.invalid"}).trackIntent({
      intentId: "thor",
      sourceTxHash: SOURCE_HASH,
    })).resolves.toEqual({state: "pending", depositReceived: true});
  });

  it("classifies delivery and refunds only after an outbound hash is observed", async () => {
    let body: Record<string, unknown> = {
      stages: {outbound_signed: {completed: true}},
      planned_out_txs: [{refund: false}],
      out_txs: [{id: "DEST"}],
    };
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body)));
    const provider = thorchainProvider({nodeUrl: "https://thor.invalid"});
    await expect(provider.trackIntent({intentId: "thor", sourceTxHash: SOURCE_HASH})).resolves.toEqual({
      state: "completed", depositReceived: true, destTxHash: "DEST",
    });
    body = {
      stages: {outbound_signed: {completed: true}},
      planned_out_txs: [{refund: true}],
      out_txs: [{id: "REFUND"}],
    };
    await expect(provider.trackIntent({intentId: "thor", sourceTxHash: SOURCE_HASH})).resolves.toEqual({
      state: "refunded", depositReceived: true,
    });
  });

  it("rejects malformed source hashes before querying a gateway", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(thorchainProvider().trackIntent({intentId: "thor", sourceTxHash: "0xabc"}))
      .rejects.toThrow(/32-byte hex/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not attach an unclassified refund hash to a partial delivery", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({
      stages: {outbound_signed: {completed: true}},
      planned_out_txs: [{refund: false}, {refund: true}],
      out_txs: [{id: "REFUND", memo: "REFUND:reason"}],
    })));
    await expect(thorchainProvider({nodeUrl: "https://thor.invalid"}).trackIntent({intentId: "thor", sourceTxHash: SOURCE_HASH}))
      .resolves.toEqual({state: "partial", depositReceived: true});
  });
});
