import {afterEach, describe, expect, it, vi} from "vitest";
import {nearIntentsProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

describe("NEAR Intents provider contract", () => {
  it("binds TON refunds to the caller's origin-chain address", async () => {
    let body: Record<string, unknown> | undefined;
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({quote: {depositAddress: "EQdeposit", amountIn: "1000000", amountOut: "990000", minAmountOut: "980000", deadline: new Date(Date.now() + 60_000).toISOString()}}));
    });
    const provider = nearIntentsProvider({enabled: true, apiUrl: "https://near.invalid"});
    await provider.getQuote({sourceChain: "ton:-239", sourceToken: "USDT", destChain: "eip155:1", destToken: "0xdac17f958d2ee523a2206206994597c13d831ec7", amountIn: "1000000", destAddress: "0x0000000000000000000000000000000000000001", refundAddress: "UQuser", dry: false});
    expect(body).toMatchObject({refundType: "ORIGIN_CHAIN", refundTo: "UQuser"});
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
      sourceChain: "eip155:1", sourceToken: "USDT", destChain: "ton:-239",
      destToken: "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs", amountIn: "1000000",
      destAddress: "UQdest", refundAddress: "0x0000000000000000000000000000000000000001", dry: false,
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
