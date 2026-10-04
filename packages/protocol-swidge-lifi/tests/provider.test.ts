import {afterEach, describe, expect, it, vi} from "vitest";
import {lifiProvider} from "../src/provider.js";

const DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const FROM_TOKEN = "0xdAC17F958D2ee523A2206206994597C13D831ec7";
const TO_TOKEN = "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9";
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const PARAMS = {
  sourceChain: "eip155:1",
  sourceToken: "USDT",
  destChain: "eip155:42161",
  destToken: TO_TOKEN,
  amountIn: "1000000",
  destAddress: RECIPIENT,
  refundAddress: SENDER,
  slippageBps: 50,
};

function response(overrides: Record<string, unknown> = {}) {
  return {
    type: "lifi",
    id: "quote-1",
    action: {
      fromToken: {address: FROM_TOKEN, chainId: 1},
      toToken: {address: TO_TOKEN, chainId: 42161},
      fromAmount: "1000000",
      fromChainId: 1,
      toChainId: 42161,
      slippage: 0.005,
      fromAddress: SENDER,
      toAddress: RECIPIENT,
    },
    estimate: {
      fromAmount: "1000000",
      toAmount: "990000",
      toAmountMin: "980000",
      approvalAddress: DIAMOND,
      executionDuration: 20,
    },
    transactionRequest: {
      from: SENDER,
      to: DIAMOND,
      data: "0xdeadbeef",
      value: "0x0",
      chainId: 1,
      gasLimit: "0x5208",
    },
    ...overrides,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("LI.FI provider security contract", () => {
  it("is explicitly configurable and excludes unsupported Tron execution", () => {
    expect(lifiProvider({enabled: false}).enabled()).toBe(false);
    expect(lifiProvider().supportsRoute({chain: "tron:728126428", token: "USDT"}, {chain: "eip155:1", token: "USDT"})).toBe(false);
  });

  it("binds action, chain, sender, recipient, tokens, target and spender", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    const before = Date.now();
    const quote = await lifiProvider().getQuote(PARAMS);
    expect(quote).toMatchObject({
      sourceAmount: "1000000",
      destAmount: "990000",
      minDestAmount: "980000",
      txRequest: {to: DIAMOND, approvalAddress: DIAMOND, chainId: 1},
    });
    expect(quote!.validUntilMs).toBeGreaterThan(before);
    expect(quote!.validUntilMs).toBeLessThanOrEqual(before + 60_000);
  });

  it("accepts a native source whose quote carries the diamond as approvalAddress, without propagating it", async () => {
    // Seen live 2026-09: every ETH-source quote ships estimate.approvalAddress
    // (the feeCollection step) — an approval is meaningless for the native
    // asset, so it must not veto the route, and must not reach the tx.
    const ZERO = "0x0000000000000000000000000000000000000000";
    const native = response({
      action: {...response().action, fromToken: {address: ZERO, chainId: 1}, fromAmount: "2000000000000000"},
      estimate: {...response().estimate, fromAmount: "2000000000000000", approvalAddress: DIAMOND},
      transactionRequest: {...response().transactionRequest, value: "0x71afd498d0000"},
    });
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(native)));
    const quote = await lifiProvider().getQuote({...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"});
    expect(quote).not.toBeNull();
    expect(quote!.txRequest!.approvalAddress).toBeUndefined();

    // …but an untrusted spender on a native quote is still refused.
    const evil = "0x9999999999999999999999999999999999999999";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({
      ...native, estimate: {...native.estimate, approvalAddress: evil},
    }))));
    expect(await lifiProvider().getQuote({...PARAMS, sourceToken: "ETH", amountIn: "2000000000000000"})).toBeNull();
  });

  it("rejects resolver payloads without a coherent action or required chain", async () => {
    const crafted = response();
    delete (crafted as {action?: unknown}).action;
    delete (crafted.transactionRequest as {chainId?: number}).chainId;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(crafted)));
    await expect(lifiProvider().getQuote(PARAMS)).resolves.toBeNull();
  });

  it("rejects untrusted execution targets and approval spenders", async () => {
    const evil = "0x2222222222222222222222222222222222222222";
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({
      estimate: {...response().estimate, approvalAddress: evil},
      transactionRequest: {...response().transactionRequest, to: evil},
    }))));
    await expect(lifiProvider().getQuote(PARAMS)).resolves.toBeNull();
  });

  it("uses the configured API base and preserves LI.FI refund lifecycle substatuses", async () => {
    const seen: string[] = [];
    const substatuses = ["REFUNDED", "EXPIRED", "NOT_PROCESSABLE_REFUND_NEEDED", "REFUND_IN_PROGRESS", "PARTIAL"];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo) => {
      seen.push(String(input));
      return new Response(JSON.stringify({status: substatuses.at(-1) === "PARTIAL" ? "DONE" : "FAILED", substatus: substatuses.shift()}));
    });
    const provider = lifiProvider({apiUrl: "https://proxy.invalid/lifi/"});
    const ref = {intentId: "lifi:1:42161", sourceTxHash: "0xsource"};
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "refunded"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "expired"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "action-required"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "refund-pending"});
    await expect(provider.trackIntent(ref)).resolves.toMatchObject({state: "partial"});
    expect(seen.every((url) => url.startsWith("https://proxy.invalid/lifi/status?"))).toBe(true);
  });

  it("rejects non-HTTP API endpoints", () => {
    expect(() => lifiProvider({apiUrl: "file:///tmp/lifi"})).toThrow(/http or https/);
    expect(() => lifiProvider({trustedTransactionTargets: {"eip155:1": ["invalid"]}})).toThrow(/invalid transaction target/);
  });

  it("snapshots nested execution allowlists at construction", async () => {
    const extra: string[] = [];
    const evil = "0x2222222222222222222222222222222222222222";
    const provider = lifiProvider({trustedTransactionTargets: {"eip155:1": extra}, trustedApprovalAddresses: {"eip155:1": extra}});
    extra.push(evil);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response({
      estimate: {...response().estimate, approvalAddress: evil},
      transactionRequest: {...response().transactionRequest, to: evil},
    }))));
    await expect(provider.getQuote(PARAMS)).resolves.toBeNull();
  });
});
