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

  it("quotes Solana sources as a guarded serialized transaction and names the chain on build", async () => {
    const SOL_CHAIN = 1151111081099710;
    const SOL_NATIVE = "11111111111111111111111111111111";
    const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const SOL_SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
    const WIRE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
    const solana = (overrides: Record<string, unknown> = {}) => ({
      type: "lifi", id: "q-sol",
      action: {
        fromToken: {address: SOL_NATIVE, chainId: SOL_CHAIN}, toToken: {address: SOL_USDC, chainId: SOL_CHAIN},
        fromAmount: "50000000", fromChainId: SOL_CHAIN, toChainId: SOL_CHAIN, slippage: 0.005,
        fromAddress: SOL_SENDER, toAddress: SOL_SENDER,
      },
      estimate: {fromAmount: "50000000", toAmount: "990000", toAmountMin: "980000", executionDuration: 5},
      transactionRequest: {data: WIRE},
      ...overrides,
    });
    const params = {
      sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "solana:mainnet", destToken: SOL_USDC,
      amountIn: "50000000", destAddress: SOL_SENDER, refundAddress: SOL_SENDER, slippageBps: 50,
    };
    const requests: string[] = [];
    vi.stubGlobal("fetch", async (url: URL) => { requests.push(String(url)); return new Response(JSON.stringify(solana())); });
    const provider = lifiProvider();
    expect(provider.supportsRoute({chain: "solana:mainnet", token: "SOL"}, {chain: "eip155:1", token: "USDT"})).toBe(true);
    expect(provider.supportsChain!("solana:mainnet")).toBe(true);
    const quote = await provider.getQuote(params);
    expect(quote).toMatchObject({sourceAmount: "50000000", minDestAmount: "980000", txRequest: {serializedTx: WIRE, value: "50000000"}});
    expect(quote!.txRequest!.to).toBeUndefined();
    expect(requests[0]).toContain(`fromChain=${SOL_CHAIN}`);
    expect(requests[0]).toContain(`fromToken=${SOL_NATIVE}`);
    await expect(provider.buildDeposit(quote!)).resolves.toEqual({chain: "solana:mainnet", to: "", value: "50000000", serializedTx: WIRE});

    // A token source lets no native value through; a native DEST maps to the Solana sentinel.
    const usdcSource = solana({
      action: {...solana().action, fromToken: {address: SOL_USDC, chainId: SOL_CHAIN}, toToken: {address: SOL_NATIVE, chainId: SOL_CHAIN}, fromAmount: "1000000"},
      estimate: {fromAmount: "1000000", toAmount: "50000000", toAmountMin: "49000000"},
    });
    vi.stubGlobal("fetch", async (url: URL) => { requests.push(String(url)); return new Response(JSON.stringify(usdcSource)); });
    const q2 = await provider.getQuote({...params, sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1000000"});
    expect(q2).toMatchObject({txRequest: {serializedTx: WIRE, value: "0"}});
    expect(requests.at(-1)).toContain(`toToken=${SOL_NATIVE}`);

    // Refusals: EVM-shaped payload on a Solana source, non-base64 data.
    for (const bad of [
      solana({transactionRequest: {to: DIAMOND, data: "0xdeadbeef", value: "0x0", chainId: 1, gasLimit: "0x5208"}}),
      solana({transactionRequest: {data: "not base64!!"}}),
    ]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(bad)));
      expect(await provider.getQuote(params)).toBeNull();
    }
    // LI.FI reports its EVM diamond as `approvalAddress` on Solana Mayan routes
    // (live 2026-10-09). Solana has no allowances: the quote stands, and the
    // address never reaches the txRequest.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(solana({estimate: {...solana().estimate, approvalAddress: DIAMOND}}))));
    const withApproval = await provider.getQuote(params);
    expect(withApproval).toMatchObject({txRequest: {serializedTx: WIRE, value: "50000000"}});
    expect(withApproval!.txRequest!.approvalAddress).toBeUndefined();
    // EVM routes are untouched by the Solana path.
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    await expect(provider.getQuote(PARAMS)).resolves.toMatchObject({txRequest: {to: DIAMOND, chainId: 1}});
  });
});
