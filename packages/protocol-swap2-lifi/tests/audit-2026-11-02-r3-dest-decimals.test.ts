// The engine holds a Mayan order to the reviewed minimum only with the destination token's decimals, which it took from
// the asset catalog alone. LI.FI's quote carries them (action.toToken.decimals): the provider now passes them on as
// `destDecimals`, whole numbers in 0..36 only.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {lifiProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

type Live = {name: string; params: QuoteParams; response: {action: {toToken: object; slippage?: number}}};
const c = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: Live[]}).corridors
  .find((k) => k.name === "w-sol-base-usdc-mayan")!;

async function quoteWith(decimals: unknown) {
  vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...c.response,
    action: {...c.response.action, toToken: {...c.response.action.toToken, decimals}, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}})));
  return lifiProvider().getQuote({...c.params, slippageBps: 300});
}

describe("audit 2026-11-02 r3: a LI.FI quote carries the destination token's decimals", () => {
  it("passes toToken.decimals on as destDecimals; a missing or malformed value is left out", async () => {
    expect((await quoteWith(6))!.destDecimals).toBe(6);
    expect((await quoteWith(18))!.destDecimals).toBe(18);
    for (const bad of [undefined, "6", 6.5, -1, 99]) expect(await quoteWith(bad)).not.toHaveProperty("destDecimals");
  });
});
