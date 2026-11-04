// Watch 2026-11-04, routes:ni:base-usdc>bsc-usdt-1000-min: 1Click answers HTTP 400 "Temporary swap limits: minimum
// swap amount is $1,000" for BNB Chain quotes under $1,000 (and "$100" from Tron), and "Amount is too low for bridge,
// try at least <base units>" under its dust floor. The refusal used to reach the app as the raw 1Click text plus the
// "[dry=… src->dst amount=…]" debug suffix; a known floor now goes out as a stable, presentable reason
// ("near_intents: below the 1Click minimum ($1,000)"), while the server log line keeps the suffix.
import {afterEach, describe, expect, it, vi} from "vitest";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {nearIntentsProvider} from "../src/provider.js";

const EVM_DEST = "0x4444444444444444444444444444444444444444";
const BSC_USDT = "0x55d398326f99059ff775485246999027b3197955";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const BASE_TO_BSC = {sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:56", destToken: BSC_USDT, amountIn: "100000000", destAddress: EVM_DEST, dry: true, slippageBps: 100};

/** 1Click answering every quote with `status` and `message`, as the live API does. */
function oneClick(status: number, message: string) {
  const fetchSpy = vi.fn(async () => new Response(JSON.stringify({message}), {status, headers: {"content-type": "application/json"}}));
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

async function refusalOf(params: Record<string, unknown>) {
  const refusals: string[] = [];
  const quote = await nearIntentsProvider({apiUrl: "https://near.invalid"}).getQuote({...params, onRefusal: (r: string) => refusals.push(r)} as never);
  expect(quote).toBeNull();
  expect(refusals).toHaveLength(1);
  return refusals[0]!;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("watch 2026-11-04: 1Click amount floors are a stable, presentable refusal", () => {
  it("the exact $1,000 answer (Base USDC → BSC USDT at $100) names the floor, without the debug suffix, on one wire call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchSpy = oneClick(400, "Temporary swap limits: minimum swap amount is $1,000");
    expect(await refusalOf(BASE_TO_BSC)).toBe("near_intents: below the 1Click minimum ($1,000)");
    // A floor is not a liquidity flap: no retry.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The server log keeps the raw 1Click text and the debug suffix.
    expect(String(warn.mock.calls[0]?.[0])).toBe("near-intents: no quote — 1Click 400: Temporary swap limits: minimum swap amount is $1,000 [dry=true eip155:8453->eip155:56 amount=100000000]");
  });

  it("the Tron $100 floor uses the same wording and the same reason", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oneClick(400, "Temporary swap limits: minimum swap amount is $100");
    expect(await refusalOf({...BASE_TO_BSC, sourceChain: "tron:728126428", sourceToken: "USDT", destChain: "eip155:8453", destToken: BASE_USDC, amountIn: "10000000"}))
      .toBe("near_intents: below the 1Click minimum ($100)");
  });

  it("a sentence-final period or a cents part is read as 1Click wrote the amount", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oneClick(400, "Temporary swap limits: Minimum swap amount is $1,000.");
    expect(await refusalOf(BASE_TO_BSC)).toBe("near_intents: below the 1Click minimum ($1,000)");
    oneClick(400, "Temporary swap limits: minimum swap amount is $2,500.50");
    expect(await refusalOf(BASE_TO_BSC)).toBe("near_intents: below the 1Click minimum ($2,500.50)");
  });

  it("the dust floor in origin base units is shown in the origin token (live: 150000 on Base USDC)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oneClick(400, "Amount is too low for bridge, try at least 150000");
    expect(await refusalOf({...BASE_TO_BSC, destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "10000"}))
      .toBe("near_intents: below the 1Click minimum (at least 0.15 USDC)");
    // 18 decimals, exact digits: no float on the way.
    oneClick(400, "Amount is too low for bridge, try at least 2312500949629");
    expect(await refusalOf({...BASE_TO_BSC, sourceToken: "ETH", destChain: "eip155:42161", destToken: ARB_USDC, amountIn: "10000000000"}))
      .toBe("near_intents: below the 1Click minimum (at least 0.000002312500949629 ETH)");
  });

  it("any other 400 keeps the raw text and the suffix; a floor wording outside a 400 is not read as a floor", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oneClick(400, "Invalid recipient address");
    expect(await refusalOf(BASE_TO_BSC)).toBe("1Click 400: Invalid recipient address [dry=true eip155:8453->eip155:56 amount=100000000]");
    oneClick(403, "minimum swap amount is $1,000");
    expect(await refusalOf(BASE_TO_BSC)).toBe("1Click 403: minimum swap amount is $1,000 [dry=true eip155:8453->eip155:56 amount=100000000]");
    // No digits after the dollar sign: not a known floor.
    oneClick(400, "minimum swap amount is $,.");
    expect(await refusalOf(BASE_TO_BSC)).toBe("1Click 400: minimum swap amount is $,. [dry=true eip155:8453->eip155:56 amount=100000000]");
  });

  it("the app's backend forwards the reason as {noQuote} unchanged", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    oneClick(400, "Temporary swap limits: minimum swap amount is $1,000");
    const handle = createSwap2Handler<string>({providers: [nearIntentsProvider({apiUrl: "https://near.invalid"})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const res = await handle("quote", {provider: "near_intents", params: {...BASE_TO_BSC, dry: false, refundAddress: EVM_DEST}}, "alice");
    expect(res.body).toEqual({noQuote: "near_intents: below the 1Click minimum ($1,000)"});
  });
});
