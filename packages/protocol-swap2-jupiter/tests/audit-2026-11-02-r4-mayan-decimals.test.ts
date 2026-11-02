// A quote's `destDecimals` is the provider's word, not checked against the token. Inflated (36 for an 18-decimal token)
// it scaled the reviewed minimum down to 0 at Mayan's 8-decimal precision, so a Swift order asking for 1 base unit
// passed. The reviewed minimum's decimals now come from the asset catalog, else from the app (`toTokenDecimals`, which
// a quote that disagrees with is refused); with neither, a Mayan order to that token is refused.
import {describe, expect, it} from "vitest";
import {serializedGuardFromExecution} from "@anywalletkit/wallet-solana";
import {BASE_USDC, MIN_OUT, RECIPIENT, UNLISTED, bridgeWire, swap} from "./mayan-order.js";

/** MIN_OUT at Mayan's 8-decimal precision for the 18-decimal UNLISTED token. */
const REAL = MIN_OUT / 10n ** 10n;

describe("audit 2026-11-02 r4: a quote's own destDecimals never set a Mayan order's floor", () => {
  it("an inflated quote value (36) alone leaves no reviewed minimum: an order asking for 1 is refused, not sent", async () => {
    const r = await swap(bridgeWire(UNLISTED, 1n), 36);
    expect(r.seen[0]!.bridgeOut).not.toHaveProperty("destDecimals");
    expect(r.outcome).toMatch(/bridge-min/);
    expect(r.sent).toHaveLength(0);
  });

  it("a plausible quote value (18) alone is not enough either: an unlisted destination needs the app's decimals", async () => {
    const r = await swap(bridgeWire(UNLISTED, REAL), 18);
    expect(r.seen[0]!.bridgeOut).not.toHaveProperty("destDecimals");
    expect(serializedGuardFromExecution(r.seen[0]!).expect.bridgeOut).not.toHaveProperty("minAmountOut");
    expect(r.outcome).toMatch(/bridge-min/);
    expect(r.sent).toHaveLength(0);
  });

  it("the app's toTokenDecimals hold the order: 1 base unit is refused, the real minimum is sent", async () => {
    const short = await swap(bridgeWire(UNLISTED, 1n), undefined, {toTokenDecimals: 18});
    expect(short.seen[0]!.bridgeOut).toEqual({destChain: "eip155:8453", recipient: RECIPIENT, destToken: UNLISTED, minAmountOut: MIN_OUT.toString(), destDecimals: 18, slippageBps: 50});
    expect(short.outcome).toMatch(/bridge-min/);
    const real = await swap(bridgeWire(UNLISTED, REAL), 18, {toTokenDecimals: 18});
    expect(real.outcome).toBe("sent");
    expect(real.sent).toHaveLength(1);
  });

  it("a quote whose destDecimals disagree with the app's is refused before anything is signed", async () => {
    const r = await swap(bridgeWire(UNLISTED, REAL), 36, {toTokenDecimals: 18});
    expect(r.outcome).toBe("VALIDATION");
    expect(r.message).toMatch(/destDecimals 36 .*toTokenDecimals 18/);
    expect(r.seen).toHaveLength(0);
    expect(r.sent).toHaveLength(0);
  });

  it("toTokenDecimals that are not whole decimals in 0..36 are refused", async () => {
    for (const bad of [6.5, -1, 37]) {
      const r = await swap(bridgeWire(UNLISTED, REAL), undefined, {toTokenDecimals: bad});
      expect(r.outcome).toBe("VALIDATION");
      expect(r.message).toMatch(/toTokenDecimals must be whole decimals/);
      expect(r.sent).toHaveLength(0);
    }
  });

  it("control: a catalog-listed destination keeps the catalog's decimals whatever the quote says", async () => {
    const real = await swap(bridgeWire(BASE_USDC, MIN_OUT), 36, {toToken: BASE_USDC});
    expect(real.seen[0]!.bridgeOut).toMatchObject({destToken: BASE_USDC, destDecimals: 6});
    expect(real.outcome).toBe("sent");
    expect((await swap(bridgeWire(BASE_USDC, 1n), 36, {toToken: BASE_USDC})).outcome).toMatch(/bridge-min/);
  });
});
