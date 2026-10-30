// Scan 2026-10-28, F9: a pinned calldata stub (lifiPins) answered with no txRequest and depositAddress = attacker,
// or a plain value send, and the engine paid the attacker: the pins covered only builds with calldata. A remote
// stub's deposit-address and plain-value routes now need the app's opt-in (`depositAddressRoutes`), which lifiPins
// do not give: the attacks are refused before anything is sent, and the real Diamond route still executes through
// the real provider behind the swap2 server handler, remoteProvider + lifiPins, and the engine.
import {afterEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {lifiPins, lifiProvider} from "../src/provider.js";
import {DIAMOND, FROM_TOKEN, RECIPIENT, SENDER, TO_TOKEN, response} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const ATTACKER = "0x9999999999999999999999999999999999999999";

/** The repro's backend: no txRequest, depositAddress = attacker; or a txRequest that is a plain value send to it. */
function evilBackend(shape: "deposit" | "plain") {
  return (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1)!;
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") {
      const p = body.params!;
      return reply({
        provider: "lifi", intentId: `i-${Math.random()}`, depositAddress: shape === "deposit" ? ATTACKER : "", depositMemo: null,
        sourceAmount: p.amountIn, destAmount: "999999999999999999999", minDestAmount: p.minAmountOut ?? "1",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
        ...(shape === "plain" ? {txRequest: {to: ATTACKER, value: p.amountIn, chainId: 1}} : {}),
      } satisfies Quote);
    }
    if (action === "build") return reply({chain: "eip155:1", to: ATTACKER, value: body.quote!.sourceAmount, ...(shape === "plain" ? {chainId: 1} : {})} satisfies UnsignedTx);
    return reply({});
  }) as unknown as typeof fetch;
}

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [lifiProvider()], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** The app: remoteProvider({name: "lifi", baseUrl, ...lifiPins}) under the engine, with a recording account. */
function app(fetchImpl: typeof fetch) {
  const sent: Array<{to: string; data?: string; value?: bigint}> = [];
  const account = {
    getAddress: async () => SENDER, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...lifiPins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap2: new P(account as never, {fromChain: "eip155:1"})};
}

describe("scan 2026-10-28 F9: a pinned LI.FI stub gets no deposit-address or plain-value route", () => {
  for (const shape of ["deposit", "plain"] as const) {
    it(`${shape}: native and ERC-20 sources are refused before anything is sent`, async () => {
      for (const [fromToken, fromTokenAmount, toToken] of [["ETH", 10n ** 16n, "ETH"], ["USDT", 1_000_000n, TO_TOKEN]] as const) {
        const {sent, swap2} = app(evilBackend(shape));
        await expect(swap2.swap2({fromToken, toToken, toChain: 42161, recipient: RECIPIENT, fromTokenAmount, minAmountOut: 1n} as never), `${shape} ${fromToken}`)
          .rejects.toThrow(/did not allow deposit-address routes|the quote carries no (transaction|Diamond call)/);
        expect(sent, `${shape} ${fromToken}`).toEqual([]);
      }
    });
  }

  it("corridor USDT Ethereum → Arbitrum: the real Diamond route executes through remoteProvider + lifiPins and the engine", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(response())));
    const {sent, swap2} = app(realBackend());
    await swap2.swap2({fromToken: "USDT", toToken: TO_TOKEN, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 985_050n} as never);
    expect(sent.map((t) => t.to.toLowerCase())).toEqual([FROM_TOKEN.toLowerCase(), DIAMOND.toLowerCase()]);
  });
});
