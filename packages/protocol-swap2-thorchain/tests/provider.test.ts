import {afterEach, describe, expect, it, vi} from "vitest";
import {thorchainProvider} from "../src/provider.js";
import {ThorchainSwap2Protocol} from "../src/protocol.js";

afterEach(() => vi.unstubAllGlobals());

describe("THORChain provider contract", () => {
  const SOURCE_HASH = `0x${"a".repeat(64)}`;
  it("rejects half-configured affiliates", () => {
    expect(() => thorchainProvider({affiliate: "t"})).toThrow(/configured together/);
    expect(() => thorchainProvider({affiliate: "bad:name", affiliateBps: "10"})).toThrow(/memo characters/);
    expect(() => thorchainProvider({nodeUrl: "file:///tmp/thor"})).toThrow(/must use https/);
    // Plain http too (scan 2026-10-27 modules, F15): the vault and router come from these answers.
    expect(() => thorchainProvider({nodeUrl: "http://thor.invalid"})).toThrow(/must use https/);
    expect(() => thorchainProvider({nodeUrl: "http://localhost:1317", allowInsecureNodeUrl: true})).not.toThrow();
  });

  it("keeps the Tron source dark unless opted in", () => {
    expect(thorchainProvider().supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(false);
    expect(thorchainProvider({tronSource: true}).supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(true);
    // Other deposit-address chains stay off even when Tron is on.
    expect(thorchainProvider({tronSource: true}).supportsRoute({chain: "bitcoin:mainnet", token: "BTC"}, {chain: "eip155:1", token: "ETH"})).toBe(false);
  });

  it("claims routes per asset, not per chain: no pool → not claimed, named refusal", async () => {
    const p = thorchainProvider();
    // THORChain has no USDC pool on Solana: the chain pair alone must not make it a candidate.
    expect(p.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "solana:mainnet", token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "solana:mainnet", token: "0x0000000000000000000000000000000000000000"})).toBe(true);
    const reasons: string[] = [];
    await expect(p.getQuote({sourceChain: "eip155:1", sourceToken: "USDC", destChain: "solana:mainnet", destToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", amountIn: "1000000", destAddress: "x", onRefusal: (r) => reasons.push(r)})).resolves.toBeNull();
    expect(reasons[0]).toMatch(/no pool/);
  });

  it("names the 8-decimal precision limit instead of a silent null", async () => {
    const reasons: string[] = [];
    // 0.123456789012345678 ETH — finer than THORChain's 1e8 units.
    await expect(thorchainProvider().getQuote({sourceChain: "eip155:1", sourceToken: "ETH", destChain: "bitcoin:mainnet", destToken: "0x0000000000000000000000000000000000000000", amountIn: "123456789012345678", destAddress: "bc1q", onRefusal: (r) => reasons.push(r)})).resolves.toBeNull();
    expect(reasons[0]).toMatch(/8 decimals/);
  });

  it("refuses an 18-dp Max amount through swap2() before any request or signature", async () => {
    // Edge (layer C): the standalone protocol's no-route error keeps the 8-dp reason.
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const sent: unknown[] = [];
    const account = {getAddress: async () => "0x4444444444444444444444444444444444444444", getChainId: async () => 1, sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: "0x1"}; }};
    await expect(new ThorchainSwap2Protocol(account, {fromChain: "eip155:1"}).swap2({
      fromToken: "ETH", toToken: "0x0000000000000000000000000000000000000000", toChain: "bitcoin:mainnet",
      recipient: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", fromTokenAmount: 123_456_789_012_345_678n, minAmountOut: 1n,
    })).rejects.toThrow(/no route available.* :: thorchain: .*8 decimals/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
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
