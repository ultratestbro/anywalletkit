// LI.FI's Mayan answers carry a minimum a few base units under floor(toAmount × (1 − slippage)) on 18-decimal outputs
// (50.0000000001 bps at a requested 50): the provider's per-step floor check and the engine's quote check refused
// them as "0.50% under the quote — more than the requested 0.5%", which lost half the recorded Mayan routes at the
// default slippage. A minimum within the request plus SLIPPAGE_ROUNDING_BPS now passes; a real excess is still refused.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {SLIPPAGE_ROUNDING_BPS, slippageFloor, validQuote} from "@anywalletkit/protocol-swap2-core/validate";
import {lifiProvider} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

type Live = {name: string; params: QuoteParams; response: {tool?: string; action?: object; estimate: {toAmount: string; toAmountMin: string}}};
const mayan = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: Live[]}).corridors
  .filter((c) => c.params.sourceChain === "solana:mainnet" && c.response.tool!.startsWith("mayan"));

/** Quote every recorded Mayan answer at `bps` (undefined = the provider's default, 50); the stub echoes the slippage asked. */
async function quoteAll(bps: number | undefined): Promise<Record<string, string>> {
  const got: Record<string, string> = {};
  for (const c of mayan) {
    vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...c.response, action: {...c.response.action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}})));
    const reasons: string[] = [];
    const {slippageBps: _s, ...p} = c.params;
    const q = await lifiProvider().getQuote({...p, ...(bps !== undefined ? {slippageBps: bps} : {}), onRefusal: (r) => reasons.push(r)});
    got[c.name] = q ? (validQuote(q, {...p, slippageBps: bps ?? 50}, "lifi") ? "pass" : "engine refused") : reasons[0]!;
  }
  return got;
}

describe("audit 2026-11-02 r2: a minimum at the requested slippage is not refused for its rounding", () => {
  it("the recorded Mayan answers at the default 50 bps: the rounded ones pass, the one 4 bps past the request does not", async () => {
    expect(mayan.length).toBe(10);
    const at50 = await quoteAll(undefined);
    expect(await quoteAll(50)).toEqual(at50);
    const refused = Object.entries(at50).filter(([, r]) => r !== "pass");
    // Mayan Fast MCTP USDC → USDC: toAmountMin is 54.07 bps under toAmount — a real excess over 50 (+1 rounding).
    expect(refused).toEqual([["w-usdc-base-usdc-mayanFastMCTP", expect.stringContaining("0.54% under the quote")]]);
    for (const name of ["w-sol-arb-eth-deny", "w-sol-base-eth-deny", "w-sol-bsc-bnb-deny", "w-sol-eth-eth-deny"]) expect(at50[name]).toBe("pass");
  });

  it("the floor is the requested slippage plus one rounding bp, never more", () => {
    expect(SLIPPAGE_ROUNDING_BPS).toBe(1);
    // w-sol-eth-eth-deny: 81811777162793400 at 50 bps → exact floor 81402718276979433, LI.FI says …979400.
    const dest = 81811777162793400n;
    expect((dest * 9_950n) / 10_000n).toBe(81402718276979433n);
    expect(slippageFloor(dest, 50)).toBe((dest * 9_949n) / 10_000n);
    expect(81402718276979400n >= slippageFloor(dest, 50)).toBe(true);
    // 51.01 bps under is past the tolerance.
    expect(dest - (dest * 5_101n) / 1_000_000n < slippageFloor(dest, 50)).toBe(true);
    expect(slippageFloor(dest, 9_999)).toBe(0n);
    expect(slippageFloor(10_000n, 0)).toBe(9_999n);
  });

  it("the provider still refuses a minimum more than the rounding bp past the request", async () => {
    const c = mayan.find((k) => k.name === "w-sol-eth-eth-deny")!;
    const toAmount = BigInt(c.response.estimate.toAmount);
    const tooLow = ((toAmount * 9_948n) / 10_000n).toString();
    const reasons: string[] = [];
    vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...c.response, estimate: {...c.response.estimate, toAmountMin: tooLow}, action: {...c.response.action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}})));
    expect(await lifiProvider().getQuote({...c.params, slippageBps: 50, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons[0]).toContain("0.52% under the quote");
  });
});
