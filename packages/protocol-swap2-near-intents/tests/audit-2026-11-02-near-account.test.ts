// INTENTS / CONFIDENTIAL_INTENTS credit only an intents.near account someone can sign for: a named account, an
// implicit 64-hex id or an implicit 0x + 40-hex id. A dot-less id that merely passes NEAR syntax (a pasted bech32
// Bitcoin address, a padded 0x…, a top-level name) is refused before any request; DESTINATION_CHAIN is unchanged.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {nearIntentsProvider} from "../src/provider.js";

const NEAR_USDC = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
let bodies: Record<string, unknown>[] = [];

beforeEach(() => {
  bodies = [];
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {amount: string};
    bodies.push(body);
    return new Response(JSON.stringify({quote: {depositAddress: "0xdeposit", amountIn: body.amount, amountOut: "4999000", minAmountOut: "4949000", deadline: new Date(Date.now() + 60_000).toISOString()}}));
  });
});
afterEach(() => vi.unstubAllGlobals());

async function intentsQuote(destAddress: string, recipientType: "INTENTS" | "CONFIDENTIAL_INTENTS" = "INTENTS") {
  const refusals: string[] = [];
  const quote = await nearIntentsProvider({apiUrl: "https://near.invalid", recipientType, jwt: "partner"}).getQuote({
    sourceChain: "eip155:1", sourceToken: "USDT", destChain: "near:mainnet", destToken: NEAR_USDC,
    amountIn: "5000000", destAddress, dry: true, onRefusal: (r: string) => refusals.push(r),
  });
  return {quote, refusals};
}

describe("intents recipients are accounts someone can sign for", () => {
  it.each([
    ["bech32 Bitcoin address", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    ["0x id that is not 40 hex", `0x${"ab".repeat(31)}`],
    ["checksummed 0x address", "0x63428E70a8016d10e8e2f7da440c898063afa299"],
    ["64 chars that are not hex", "z".repeat(64)],
    ["top-level name", "aurora"],
  ])("refuses a %s without a wire call", async (_label, id) => {
    for (const mode of ["INTENTS", "CONFIDENTIAL_INTENTS"] as const) {
      const {quote, refusals} = await intentsQuote(id, mode);
      expect(quote).toBeNull();
      expect(refusals[0]).toMatch(/NEAR Intents account id/);
    }
    expect(bodies).toHaveLength(0);
  });

  it.each([
    ["implicit 0x id (near.com nearcom:0x…)", "0x63428e70a8016d10e8e2f7da440c898063afa299"],
    ["implicit ed25519 id", "98793cd91a3f870fb126f66285808c7e094afcfc4eda8a970f6648cdf0dbd6de"],
    ["named account", "alice.near"],
    ["named sub-account", "jar-1.nearjar.near"],
  ])("credits an %s", async (_label, id) => {
    const {quote} = await intentsQuote(id);
    expect(quote).not.toBeNull();
    expect(bodies[0]).toMatchObject({recipient: id, recipientType: "INTENTS", destinationAsset: NEAR_USDC});
  });

  it("DESTINATION_CHAIN does not apply the intents account rule", async () => {
    await nearIntentsProvider({apiUrl: "https://near.invalid"}).getQuote({
      sourceChain: "eip155:1", sourceToken: "USDT", destChain: "bitcoin:mainnet", destToken: "",
      amountIn: "5000000", destAddress: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", dry: true,
    });
    expect(bodies[0]).toMatchObject({recipient: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", recipientType: "DESTINATION_CHAIN"});
  });
});
