import {afterEach, describe, expect, it, vi} from "vitest";
import {nearIntentsProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("NEAR Intents provider contract", () => {
  it("binds non-EVM refunds to the caller's origin-chain address", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({quote: {depositAddress: "TDeposit", amountIn: "1000000", amountOut: "990000", minAmountOut: "980000", deadline: new Date(Date.now() + 60_000).toISOString()}}));
    });
    const provider = nearIntentsProvider({enabled: true, apiUrl: "https://near.invalid"});
    await provider.getQuote({sourceChain: "tron:728126428", sourceToken: "USDT", destChain: "eip155:1", destToken: "0xdac17f958d2ee523a2206206994597c13d831ec7", amountIn: "1000000", destAddress: "0x0000000000000000000000000000000000000001", refundAddress: "TUser", dry: false});
    expect(body).toMatchObject({refundType: "ORIGIN_CHAIN", refundTo: "TUser"});
  });

  it("rejects half-configured fees and unsafe API URLs", () => {
    expect(() => nearIntentsProvider({feeRecipient: "fees.near"})).toThrow(/configured together/);
    expect(() => nearIntentsProvider({feeRecipient: "fees.near", feeBps: 0})).toThrow(/between 1 and 10000/);
    expect(() => nearIntentsProvider({apiUrl: "file:///tmp/near"})).toThrow(/http or https/);
  });

  it("caps an upstream quote deadline to the local executable window", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({quote: {
      depositAddress: "0xdeposit", amountIn: "1000000", amountOut: "990000", minAmountOut: "980000",
      deadline: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    }})));
    const before = Date.now();
    const quote = await nearIntentsProvider({apiUrl: "https://near.invalid/"}).getQuote({
      sourceChain: "eip155:1", sourceToken: "USDT", destChain: "eip155:42161",
      destToken: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", amountIn: "1000000",
      destAddress: "0x0000000000000000000000000000000000000002", refundAddress: "0x0000000000000000000000000000000000000001", dry: false,
    });
    expect(quote!.validUntilMs).toBeGreaterThan(before);
    expect(quote!.validUntilMs).toBeLessThanOrEqual(before + 55_500);
  });

  it("rejects malformed intent ids before making a status request", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(nearIntentsProvider().trackIntent({intentId: "near1click:%ZZ|"})).rejects.toThrow(/malformed intent id/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("route claims cover both ends", () => {
  const p = nearIntentsProvider({enabled: true, apiUrl: "https://near.invalid"});
  const ZERO = "0x0000000000000000000000000000000000000000";
  it("claims BNB / Polygon USDC destinations (1Click ids in the catalog)", () => {
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:56", token: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d"})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:137", token: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359"})).toBe(true);
  });
  it("does not claim a destination 1Click doesn't list", () => {
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:130", token: ZERO})).toBe(false);
  });
  it("claims Plasma XPL / USDT0 (nep141 omft ids, 2026-10-17 token list)", () => {
    expect(p.supportsRoute({chain: "eip155:9745", token: "USDT0"}, {chain: "eip155:8453", token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:9745", token: ZERO})).toBe(true);
    expect(p.supportsChain!("eip155:9745")).toBe(true);
  });
});

// SDK-132: corridors 1Click cannot serve are refused by name BEFORE any wire
// call — the 2026-10-16 funded run spent 207 legs learning this the slow way.
describe("dead corridors are refused up front", () => {
  const p = nearIntentsProvider({enabled: true, apiUrl: "https://near.invalid"});
  const ZERO = "0x0000000000000000000000000000000000000000";
  const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  const quote = (params: Record<string, unknown>) => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const refusals: string[] = [];
    const result = p.getQuote({
      amountIn: "1000000", destAddress: ZERO, dry: true, onRefusal: (r: string) => refusals.push(r),
      ...params,
    } as never);
    return {result, refusals, fetchSpy};
  };

  it("a corridor the APP paused (suspendedChains) is refused by name without a wire call; the SDK itself pauses nothing", async () => {
    // TON is listed by 1Click (ids match /v0/tokens), so the SDK keeps declaring it …
    expect(p.supportsChain!("ton:-239")).toBe(true);
    expect(p.supportsRoute({chain: "ton:-239", token: "USDT"}, {chain: "eip155:8453", token: BASE_USDC})).toBe(true);
    // … and a plain provider goes to the wire for it.
    const plain = quote({sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: BASE_USDC});
    await plain.result.catch(() => null);
    expect(plain.fetchSpy).toHaveBeenCalled();
    // The wallet pauses the venue-side outage (2026-10-16: every HOT omni-bridge asset "not available") through config …
    const paused = nearIntentsProvider({enabled: true, apiUrl: "https://near.invalid", suspendedChains: {"ton:-239": "1Click HOT omni-bridge corridors not quoting since 2026-10-16"}});
    const fetchSpy = vi.fn(); vi.stubGlobal("fetch", fetchSpy);
    const refusals: string[] = [];
    const result = await paused.getQuote({sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:8453", destToken: BASE_USDC, amountIn: "1000000", destAddress: ZERO, dry: true, onRefusal: (r: string) => refusals.push(r)} as never);
    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(refusals[0]).toMatch(/^1Click corridor paused by the app: ton:-239 — .*HOT omni-bridge/);
    // … in either direction, and lifts it by dropping the entry — no release of the SDK.
    const r2: string[] = [];
    expect(await paused.getQuote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "ton:-239", destToken: "USDT", amountIn: "1000000", destAddress: ZERO, dry: true, onRefusal: (r: string) => r2.push(r)} as never)).toBeNull();
    expect(r2[0]).toMatch(/paused by the app: ton:-239/);
  });

  it("chains 1Click does not list (World Chain, Sei, Ink, Plume, X Layer) are not declared and never asked", async () => {
    for (const chain of ["eip155:480", "eip155:1329", "eip155:57073", "eip155:98866", "eip155:196"]) {
      expect(p.supportsChain!(chain)).toBe(false);
    }
    // Listed chains keep their capability — namespace alone no longer decides.
    for (const chain of ["eip155:1", "eip155:8453", "eip155:42161", "eip155:143", "eip155:9745", "bitcoin:mainnet", "solana:mainnet", "tron:728126428"]) {
      expect(p.supportsChain!(chain)).toBe(true);
    }
    const {result, refusals, fetchSpy} = quote({sourceChain: "eip155:480", sourceToken: "ETH", destChain: "eip155:8453", destToken: BASE_USDC});
    expect(await result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(refusals[0]).toMatch(/^1Click does not list eip155:480 \[/);
    const dest = quote({sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:57073", destToken: ZERO});
    expect(await dest.result).toBeNull();
    expect(dest.fetchSpy).not.toHaveBeenCalled();
    expect(dest.refusals[0]).toMatch(/^1Click does not list eip155:57073 \[/);
  });

  it("a catalog token without a 1Click id on a listed chain is refused by chain + token", async () => {
    // Ethereum BNB (ERC-20) is in the catalog for LI.FI only.
    const {result, refusals, fetchSpy} = quote({sourceChain: "eip155:1", sourceToken: "BNB", destChain: "eip155:8453", destToken: BASE_USDC});
    expect(await result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(refusals[0]).toMatch(/^1Click does not list eip155:1 BNB \[/);
  });
});
