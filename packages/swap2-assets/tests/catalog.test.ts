import {describe, expect, it} from "vitest";
import {CC_SOURCE_CHAINS, ccAsset, ccAssetByToken, ccChain, isTokenAddress, isUnlisted, resolveAsset, unlistedAsset} from "../src/index.js";

const EVM = /^0x[0-9a-fA-F]{40}$/;

describe("catalog invariants", () => {
  it("every chain id is unique and every asset symbol is unique within its chain", () => {
    const ids = CC_SOURCE_CHAINS.map((c) => c.caip2);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CC_SOURCE_CHAINS) {
      const symbols = c.assets.map((a) => a.symbol);
      expect(new Set(symbols).size, `${c.caip2} has a duplicate symbol`).toBe(symbols.length);
      for (const a of c.assets) {
        if (c.caip2.startsWith("eip155:") && a.contract) expect(a.contract, `${c.caip2} ${a.symbol}`).toMatch(EVM);
        expect(Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 30, `${c.caip2} ${a.symbol} decimals`).toBe(true);
      }
    }
  });
});

describe("2026-10-14 batch: Arc, Mantle, Katana, Morph, Flare", () => {
  it.each([
    ["eip155:5042", "Arc", "USDC", 6],
    ["eip155:5000", "Mantle", "MNT", 18],
    ["eip155:747474", "Katana", "ETH", 18],
    ["eip155:2818", "Morph", "ETH", 18],
    ["eip155:14", "Flare", "FLR", 18],
  ])("%s resolves as %s with %s (%i decimals) leading", (caip2, label, lead, decimals) => {
    const c = ccChain(caip2)!;
    expect(c).toBeDefined();
    expect(c.label).toBe(label);
    expect(c.assets[0]).toMatchObject({symbol: lead, decimals});
    expect(c.hidden ?? false).toBe(false);
    expect(c.offrampOnly ?? false).toBe(false);
  });

  it.each([
    ["eip155:5000", "WMNT", "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"],
    ["eip155:747474", "WETH", "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62"],
    ["eip155:2818", "WETH", "0x5300000000000000000000000000000000000011"],
    ["eip155:14", "WFLR", "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d"],
  ])("%s: the native asset is contract-less and the wrapped native %s is pinned", (caip2, wrapped, contract) => {
    expect(ccAssetByToken(caip2, "")).toMatchObject({decimals: 18});
    expect(ccAssetByToken(caip2, "")!.contract).toBeUndefined();
    expect(ccAsset(caip2, wrapped)).toMatchObject({contract, decimals: 18});
    expect(ccAssetByToken(caip2, contract.toLowerCase())!.symbol).toBe(wrapped);
  });

  it("Arc: USDC is the 6-decimal ERC-20 interface at 0x3600…, and there is deliberately no contract-less native entry", () => {
    const usdc = ccAsset("eip155:5042", "USDC")!;
    expect(usdc).toMatchObject({contract: "0x3600000000000000000000000000000000000000", decimals: 6});
    expect(ccAssetByToken("eip155:5042", "0x3600000000000000000000000000000000000000")).toBe(usdc);
    expect(ccAssetByToken("eip155:5042", "")).toBeUndefined();
    expect(ccAssetByToken("eip155:5042", "0x0000000000000000000000000000000000000000")).toBeUndefined();
    expect(ccChain("eip155:5042")!.assets.every((a) => a.contract)).toBe(true);
  });

  it("Circle-native USDC is pinned where CCTP mints it (Arc, Morph) and absent elsewhere in the batch", () => {
    expect(ccAsset("eip155:2818", "USDC")!.contract).toBe("0xCfb1186F4e93D60E60a8bDd997427D1F33bc372B");
    expect(ccAsset("eip155:2818", "USDC.e")!.contract).toBe("0xe34c91815d7fc18A9e2148bcD4241d0a5848b693");
    expect(ccAsset("eip155:747474", "USDC")).toBeUndefined(); // Katana's is Vault Bridge USDC → listed as USDC.e
    expect(ccAsset("eip155:14", "USDC")).toBeUndefined(); // Flare's is Stargate-bridged → USDC.e
    expect(ccAsset("eip155:5000", "USDC")!.contract).toBe("0x09Bc4E0D864854c6aFB6eB9A9cdF58aC190D0dF9"); // bridged "USD Coin", not CCTP
  });
});

describe("2026-10-26: LDO, SKY, COW", () => {
  it.each([
    ["eip155:1", "LDO", "0x5a98fcbea516cf06857215779fd812ca3bef1b32"],
    ["eip155:1", "SKY", "0x56072c95faa701256059aa122697b133aded9279"],
    ["eip155:1", "COW", "0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab"],
    ["eip155:42161", "LDO", "0x13ad51ed4f1b7e9dc168d8a00cb3f4ddd85efa60"],
    ["eip155:42161", "COW", "0xcb8b5cd20bdcaea9a010ac1f8d835824f5c87a04"],
    ["eip155:8453", "COW", "0xc694a91e6b071bf030a18bd3053a7fe09b6dae69"],
    ["eip155:100", "COW", "0x177127622c4a00f3d409b75571e12cb3c8973d3c"],
  ])("%s %s is pinned to %s (18 decimals) and found by its contract", (caip2, symbol, contract) => {
    expect(ccAsset(caip2, symbol)).toMatchObject({contract, decimals: 18});
    expect(ccAssetByToken(caip2, contract)!.symbol).toBe(symbol);
  });
});

describe("unlisted tokens", () => {
  const PEPE = "0x6982508145454ce325ddbe47a25d4ec3d2311933";
  const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
  it("isTokenAddress: EVM contracts and Solana mints only", () => {
    expect(isTokenAddress("eip155:1", PEPE)).toBe(true);
    expect(isTokenAddress("eip155:1", "0x0000000000000000000000000000000000000000")).toBe(false);
    expect(isTokenAddress("eip155:1", "0x123")).toBe(false);
    expect(isTokenAddress("solana:mainnet", BONK)).toBe(true);
    expect(isTokenAddress("solana:mainnet", "11111111111111111111111111111111")).toBe(false); // System program, the native placeholder
    expect(isTokenAddress("solana:mainnet", "1111111111111111111111111111111111")).toBe(false); // 34 zero bytes, not 32
    expect(isTokenAddress("solana:mainnet", "0OIl" + BONK.slice(4))).toBe(false); // not base58
    expect(isTokenAddress("ton:-239", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")).toBe(false);
  });
  it("resolveAsset: the catalog always wins; unlisted needs allowUnlisted and decimals", () => {
    expect(resolveAsset("eip155:1", "USDC")!.contract).toBe("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    expect(resolveAsset("eip155:1", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", {allowUnlisted: true, decimals: 18})).toMatchObject({symbol: "USDC", decimals: 6});
    expect(resolveAsset("eip155:1", "")!.symbol).toBe("ETH");
    expect(resolveAsset("eip155:1", PEPE)).toBeUndefined();
    expect(resolveAsset("eip155:1", PEPE, {allowUnlisted: true})).toBeUndefined();
    const pepe = resolveAsset("eip155:1", PEPE, {allowUnlisted: true, decimals: 18});
    expect(pepe).toEqual({symbol: PEPE, assetId: "", contract: PEPE, decimals: 18, unlisted: true});
    expect(isUnlisted(pepe)).toBe(true);
    expect(isUnlisted(ccAsset("eip155:1", "USDC"))).toBe(false);
    expect(resolveAsset("solana:mainnet", BONK, {allowUnlisted: true, decimals: 5})).toMatchObject({contract: BONK, decimals: 5, unlisted: true});
    expect(unlistedAsset("eip155:1", PEPE, 78)).toBeUndefined();
    expect(unlistedAsset("eip155:1", PEPE, 1.5)).toBeUndefined();
    // an unlisted token can never be reached by a symbol, even one it might report
    expect(resolveAsset("eip155:1", "PEPE", {allowUnlisted: true, decimals: 18})).toBeUndefined();
  });
});

// Audit 2026-10-25 round 3, L18: one EVM contract address, deployed the same way on several chains,
// should have one `decimals`. Exceptions are listed here, each read from the contract on chain.
describe("one EVM address, one decimals", () => {
  /** Same address, different decimals — verified with eth_call decimals() on 2026-10-26. */
  const VERIFIED_EXCEPTIONS: Record<string, Record<string, number>> = {
    // USD1: 6 on Monad, 18 on Plume (same 2 491-byte proxy code, different implementations).
    "0x111111d2bf19e43c34263401e0cad979ed1cdb61": {"eip155:143": 6, "eip155:98866": 18},
  };

  it("every contract has one decimals across EVM chains, except the verified exceptions", () => {
    const seen = new Map<string, Array<{chain: string; decimals: number}>>();
    for (const c of CC_SOURCE_CHAINS) {
      if (!c.caip2.startsWith("eip155:")) continue;
      for (const a of c.assets) {
        if (!a.contract) continue;
        const k = a.contract.toLowerCase();
        seen.set(k, [...(seen.get(k) ?? []), {chain: c.caip2, decimals: a.decimals}]);
      }
    }
    const mismatched: string[] = [];
    for (const [address, uses] of seen) {
      const exception = VERIFIED_EXCEPTIONS[address];
      if (exception) {
        for (const u of uses) expect(u.decimals, `${address} on ${u.chain}`).toBe(exception[u.chain]);
        continue;
      }
      if (new Set(uses.map((u) => u.decimals)).size > 1) mismatched.push(`${address}: ${uses.map((u) => `${u.chain}=${u.decimals}`).join(", ")}`);
    }
    expect(mismatched).toEqual([]);
  });
});
