import {describe, expect, it} from "vitest";
import {slippageClassOf, suggestSlippage} from "../src/slippage.js";

const same = (from: string, to: string, extra = {}) => suggestSlippage({fromChain: "eip155:8453", toChain: "eip155:8453", fromSymbol: from, toSymbol: to, ...extra});
const cross = (from: string, to: string, eta: number, extra = {}) => suggestSlippage({fromChain: "eip155:1", toChain: "bitcoin:mainnet", fromSymbol: from, toSymbol: to, etaSeconds: eta, ...extra});

describe("suggestSlippage", () => {
  it("bases: stable ↔ stable 0.1%, majors 0.5%, everything else 1%", () => {
    expect(same("USDC", "USDT").bps).toBe(10);
    expect(same("ETH", "USDC").bps).toBe(50);
    expect(same("cbBTC", "WETH").bps).toBe(50);
    expect(same("AERO", "USDC").bps).toBe(100);
    expect(same("PEPE", "DEGEN")).toMatchObject({bps: 100, pair: "other"});
  });

  it("adds half the price impact (up to 1%)", () => {
    expect(same("ETH", "USDC", {priceImpactBps: 40}).bps).toBe(70);
    expect(same("ETH", "USDC", {priceImpactBps: 900}).parts.impact).toBe(100);
    expect(same("ETH", "USDC", {priceImpactBps: -20}).parts.impact).toBe(0);
  });

  it("adds time for cross-chain routes, more for long-tail tokens, none for stable ↔ stable", () => {
    expect(cross("ETH", "BTC", 30).bps).toBe(50);
    expect(cross("ETH", "BTC", 600).bps).toBe(70);
    expect(cross("ETH", "BTC", 2400).bps).toBe(110);
    expect(cross("AERO", "BTC", 2400).parts.time).toBe(90);
    expect(suggestSlippage({fromChain: "eip155:1", toChain: "eip155:8453", fromSymbol: "USDC", toSymbol: "USDC", etaSeconds: 1200}).bps).toBe(10);
  });

  it("adds a quarter of recent volatility (up to 1%)", () => {
    expect(same("ETH", "USDC", {volatilityBps: 200}).bps).toBe(100);
  });

  it("clamps to [min, max] and says when it capped", () => {
    expect(suggestSlippage({fromChain: "a", toChain: "b", fromSymbol: "PEPE", toSymbol: "BTC", etaSeconds: 3600, priceImpactBps: 400, volatilityBps: 800})).toMatchObject({bps: 300, capped: true});
    expect(same("USDC", "USDT", {}, ).bps).toBeGreaterThanOrEqual(5);
    expect(suggestSlippage({fromChain: "x", toChain: "x", fromSymbol: "USDC", toSymbol: "USDT"}, {minBps: 20}).bps).toBe(20);
    expect(suggestSlippage({fromChain: "x", toChain: "x", fromSymbol: "PEPE", toSymbol: "ETH", priceImpactBps: 400}, {maxBps: 120})).toMatchObject({bps: 120, capped: true});
  });

  it("classifies symbols case-insensitively; unknown is other", () => {
    expect(slippageClassOf("usdc")).toBe("stable");
    expect(slippageClassOf("USD₮0")).toBe("stable");
    expect(slippageClassOf("wsteth")).toBe("major");
    expect(slippageClassOf("XYZ")).toBe("other");
  });
});
