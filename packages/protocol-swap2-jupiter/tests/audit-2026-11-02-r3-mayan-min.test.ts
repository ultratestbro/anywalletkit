// The engine took a bridge's destination decimals from the asset catalog only, and serializedGuardFromExecution dropped
// the reviewed minimum without them. A token the catalog does not list (any 0x address passed as the destination) thus
// left a Mayan order's minimum unchecked: amountOutMin = 1 passed. The app's verified decimals (`toTokenDecimals`) now
// fill the gap, and a Mayan order with no reviewed minimum or token is refused.
import {describe, expect, it} from "vitest";
import {WalletManagerSolana, serializedGuardFromExecution} from "@anywalletkit/wallet-solana";
import {ADDR0, BASE_USDC, INPUT, MIN, MIN_OUT, MY_USDC, RECIPIENT, SEED, STATE, UNLISTED, USDC, VAULT, bridgeWire, fakeRpc, swap, sys, tokenAccount} from "./mayan-order.js";

describe("audit 2026-11-02 r3: a Mayan order to a token the catalog does not list is still held to the reviewed minimum", () => {
  it("the app's decimals reach bridgeOut, so an order asking for 1 base unit is refused and the real minimum passes", async () => {
    const short = await swap(bridgeWire(UNLISTED, 1n), 18, {toTokenDecimals: 18});
    expect(short.seen[0]!.bridgeOut).toEqual({destChain: "eip155:8453", recipient: RECIPIENT, destToken: UNLISTED, minAmountOut: MIN_OUT.toString(), destDecimals: 18, slippageBps: 50});
    expect(short.outcome).toMatch(/bridge-min/);
    expect(short.sent).toHaveLength(0);
    // Mayan keeps 8 decimals: the reviewed minimum at that precision.
    const real = await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n), 18, {toTokenDecimals: 18});
    expect(real.outcome).toBe("sent");
    expect(real.sent).toHaveLength(1);
  });

  it("without decimals from the catalog or the app the order has no reviewed minimum and is refused, not passed", async () => {
    const unknown = await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n));
    expect(unknown.seen[0]!.bridgeOut).not.toHaveProperty("destDecimals");
    expect(serializedGuardFromExecution(unknown.seen[0]!).expect.bridgeOut).not.toHaveProperty("minAmountOut");
    expect(unknown.outcome).toMatch(/bridge-min/);
    expect(unknown.sent).toHaveLength(0);
    // The quote's own decimals do not stand in for them, in range or not.
    expect((await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n), 18)).outcome).toMatch(/bridge-min/);
    expect((await swap(bridgeWire(UNLISTED, MIN_OUT / 10n ** 10n), 99)).outcome).toMatch(/bridge-min/);
  });

  it("a guard that names no destination token refuses the order too", async () => {
    const f = fakeRpc({[ADDR0]: sys(10n ** 9n), [MY_USDC]: tokenAccount(USDC, ADDR0, 100_000_000n), [VAULT]: tokenAccount(USDC, STATE, 0n)});
    const solana = await new WalletManagerSolana(SEED, {provider: f.rpc}).getAccount(0);
    const expect_ = {maxLamportsOut: 20_000_000n, maxTokenOut: {mint: USDC, amount: INPUT}};
    const wire = bridgeWire(BASE_USDC, MIN);
    await expect(solana.checkSerialized(wire, {expect: {...expect_, bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, minAmountOut: MIN, destDecimals: 6}}})).rejects.toMatchObject({code: "bridge-token"});
    await expect(solana.checkSerialized(wire, {expect: {...expect_, bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC}}})).rejects.toMatchObject({code: "bridge-min"});
    await expect(solana.checkSerialized(wire, {expect: {...expect_, bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: MIN, destDecimals: 6}}})).resolves.toBeDefined();
  });
});
