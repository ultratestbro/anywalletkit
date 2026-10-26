// Tokens the swap catalog does not list (a user's own tokens): off by default, and when an app
// turns them on, named by address only, with decimals read from the chain. Mocked provider and
// account — no network, no keys.
import {describe, expect, it} from "vitest";
import {decodeFunctionData, parseAbi} from "viem";
import {Swap2ValidationError} from "../src/errors.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2EngineConfig} from "../src/swap2/base.js";
import {sourceAssetOf} from "../src/util.js";
import {createSwap2Handler} from "../src/server.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const ROUTER = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const PEPE = "0x6982508145454Ce325dDbE47a25d4ec3d2311933"; // not in the catalog
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const txRequest = {to: ROUTER, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "210000", approvalAddress: ROUTER};

function quote(params: QuoteParams): Quote {
  return {
    provider: "open", intentId: "intent-1", depositAddress: "", depositMemo: null, txRequest,
    sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000",
    feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
  } as Quote;
}
function provider(seen: QuoteParams[]): CrossChainProvider {
  return {
    name: "open", enabled: () => true, supportsRoute: () => true, supportsSameChain: true,
    getQuote: async (params) => { seen.push(params); return quote(params); },
    buildDeposit: async (q): Promise<UnsignedTx> => ({...q.txRequest!, chain: "eip155:1", to: q.txRequest!.to!, value: "0"}),
    trackIntent: async () => ({state: "pending"}),
  };
}
const APPROVE = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);
function account(sent: Array<{to?: string; data?: string}>, over: Record<string, unknown> = {}) {
  return {
    getAddress: async () => SELF,
    getChainId: async () => 1,
    getAllowance: async () => 0n,
    sendTransaction: async (tx: {to?: string; data?: string}) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
    waitForTransaction: async () => {},
    ...over,
  };
}
function protocol(p: CrossChainProvider, acc: unknown, config: Partial<Swap2EngineConfig> = {}) {
  class P extends SingleProviderSwap2 {
    protected readonly provider = p;
    protected chainSupported(): boolean { return true; }
  }
  return new P(acc as never, {fromChain: "eip155:1", ...config});
}
const sell = {fromToken: PEPE, toToken: USDC_ETH, fromTokenAmount: 10n ** 24n, minAmountOut: 1n};

describe("unlisted source tokens", () => {
  it("are refused by default — the engine never asks the provider with an unknown token's decimals", async () => {
    const seen: QuoteParams[] = [];
    await expect(protocol(provider(seen), account([])).quoteSwap2(sell)).rejects.toThrow(/unknown source token/);
    expect(seen[0]?.sourceDecimals).toBeUndefined();
  });

  it("with allowUnlistedTokens: decimals read once from the chain, the provider gets the contract + decimals", async () => {
    const seen: QuoteParams[] = [];
    let reads = 0;
    const acc = account([], {getTokenInfo: async (t: string) => { reads++; expect(t).toBe(PEPE); return {decimals: 18}; }});
    const p = protocol(provider(seen), acc, {allowUnlistedTokens: true});
    await p.quoteSwap2(sell);
    await p.quoteSwap2(sell);
    expect(seen[0]).toMatchObject({sourceToken: PEPE, sourceDecimals: 18, destToken: USDC_ETH});
    expect(reads).toBe(1);
  });

  it("swap2 approves exactly the amount, on the token the user named, to the quoted spender", async () => {
    const sent: Array<{to?: string; data?: string}> = [];
    const acc = account(sent, {getTokenInfo: async () => ({decimals: 18})});
    await protocol(provider([]), acc, {allowUnlistedTokens: true}).swap2(sell);
    const [approve, swap] = sent;
    expect(approve!.to!.toLowerCase()).toBe(PEPE.toLowerCase());
    const {args} = decodeFunctionData({abi: APPROVE, data: approve!.data as `0x${string}`});
    expect(args).toEqual([ROUTER, 10n ** 24n]);
    expect(swap).toMatchObject({to: ROUTER, data: "0xdeadbeef"});
  });

  it("a caller's fromTokenDecimals that disagrees with the chain is refused; without getTokenInfo it is required", async () => {
    const withInfo = account([], {getTokenInfo: async () => ({decimals: 18})});
    await expect(protocol(provider([]), withInfo, {allowUnlistedTokens: true}).quoteSwap2({...sell, fromTokenDecimals: 6})).rejects.toThrow(Swap2ValidationError);
    await expect(protocol(provider([]), account([]), {allowUnlistedTokens: true}).quoteSwap2(sell)).rejects.toThrow(/pass fromTokenDecimals/);
    const seen: QuoteParams[] = [];
    await protocol(provider(seen), account([]), {allowUnlistedTokens: true}).quoteSwap2({...sell, fromTokenDecimals: 18});
    expect(seen[0]).toMatchObject({sourceToken: PEPE, sourceDecimals: 18});
  });

  it("a catalog token stays a catalog token: symbol and contract both resolve to it, no decimals sent", async () => {
    const seen: QuoteParams[] = [];
    const acc = account([], {getTokenInfo: async () => { throw new Error("must not read a listed token"); }});
    const p = protocol(provider(seen), acc, {allowUnlistedTokens: true});
    await p.quoteSwap2({...sell, fromToken: "USDC", fromTokenAmount: 1_000_000n});
    await p.quoteSwap2({...sell, fromToken: USDC_ETH, fromTokenAmount: 1_000_000n, fromTokenDecimals: 18});
    expect(seen.map((s) => [s.sourceToken, s.sourceDecimals])).toEqual([["USDC", undefined], ["USDC", undefined]]);
  });

  it("an unlisted Solana destination mint needs the flag", async () => {
    const seen: QuoteParams[] = [];
    const cross = {fromToken: "USDC", toToken: BONK, toChain: "solana:mainnet", recipient: "2tKRnQTAXmryVYxDNSajdZg1DfX2FbHKNboWr5EBiKhW", fromTokenAmount: 1_000_000n, minAmountOut: 1n};
    await expect(protocol(provider(seen), account([])).quoteSwap2(cross)).rejects.toThrow(/unknown destination token/);
    await protocol(provider(seen), account([]), {allowUnlistedTokens: true}).quoteSwap2(cross);
    expect(seen[0]).toMatchObject({destChain: "solana:mainnet", destToken: BONK});
  });
});

describe("sourceAssetOf (providers)", () => {
  it("unlisted only when the engine sent decimals", () => {
    expect(sourceAssetOf({sourceChain: "eip155:1", sourceToken: PEPE})).toBeUndefined();
    expect(sourceAssetOf({sourceChain: "eip155:1", sourceToken: PEPE, sourceDecimals: 18})).toMatchObject({contract: PEPE, decimals: 18, unlisted: true});
    expect(sourceAssetOf({sourceChain: "eip155:1", sourceToken: "USDC", sourceDecimals: 18})).toMatchObject({symbol: "USDC", decimals: 6});
  });
});

describe("server handler", () => {
  const PARAMS = {sourceChain: "eip155:1", sourceToken: PEPE, sourceDecimals: 18, destChain: "eip155:1", destToken: USDC_ETH, amountIn: "1000", destAddress: SELF};
  const run = async (allowUnlistedTokens?: boolean) => {
    const seen: QuoteParams[] = [];
    const handle = createSwap2Handler<string>({providers: [provider(seen)], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, ...(allowUnlistedTokens !== undefined ? {allowUnlistedTokens} : {})});
    const res = await handle("quote", {provider: "open", params: PARAMS}, "user");
    return {res, seen};
  };
  it("drops sourceDecimals unless allowUnlistedTokens; validates it when allowed", async () => {
    expect((await run()).seen[0]?.sourceDecimals).toBeUndefined();
    expect((await run(true)).seen[0]?.sourceDecimals).toBe(18);
    const seen: QuoteParams[] = [];
    const handle = createSwap2Handler<string>({providers: [provider(seen)], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, allowUnlistedTokens: true});
    expect((await handle("quote", {provider: "open", params: {...PARAMS, sourceDecimals: 78}}, "user")).status).toBe(400);
    expect((await handle("quote", {provider: "open", params: {...PARAMS, sourceDecimals: 1.5}}, "user")).status).toBe(400);
    expect(seen).toHaveLength(0);
  });
});
