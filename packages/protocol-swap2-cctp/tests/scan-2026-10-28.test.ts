// Scan 2026-10-28, F9: a remote stub's deposit-address and plain-value routes skipped every pin, so a pinned calldata
// stub (cctpPins) could be made to pay any address the backend named. They now need the app's opt-in
// (`depositAddressRoutes`), which cctpPins do not give: the repro's deposit route is refused, and the real burn still
// executes through the real provider behind the swap2 server handler, remoteProvider + cctpPins, and the engine.
import {describe, expect, it} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

const ATTACKER = "0x9999999999999999999999999999999999999999";

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(provider: CrossChainProvider): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [provider], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** The repro's backend: no txRequest, depositAddress = attacker; the build a plain send of the input to it. */
function depositBackend(name: string, chain: string): typeof fetch {
  return (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1)!;
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") {
      const p = body.params!;
      return reply({provider: name, intentId: `i-${Math.random()}`, depositAddress: ATTACKER, depositMemo: null, sourceAmount: p.amountIn,
        destAmount: "999999999999999999999", minDestAmount: p.minAmountOut ?? "1", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000} satisfies Quote);
    }
    if (action === "build") return reply({chain, to: ATTACKER, value: body.quote!.sourceAmount} satisfies UnsignedTx);
    return reply({});
  }) as unknown as typeof fetch;
}

/** The app: remoteProvider({name, baseUrl, ...pins}) under the engine, with a recording EVM account. */
function app(name: string, pins: RemotePins, fetchImpl: typeof fetch, self: string, fromChain: string, extra: Record<string, unknown> = {}) {
  const sent: Array<{to: string; data?: string; value?: bigint}> = [];
  const account = {
    getAddress: async () => self, getChainId: async () => Number(fromChain.slice(7)), getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name, baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...extra, ...pins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap2: new P(account as never, {fromChain})};
}
import {cctpPins} from "../src/provider.js";
import {CCTP_DOMAINS, TOKEN_MESSENGER_V2} from "../src/config.js";
import {make} from "./fixtures.js";

const BASE_USDC = CCTP_DOMAINS["eip155:8453"]!.usdc;
const ARB_USDC = CCTP_DOMAINS["eip155:42161"]!.usdc;
const SENDER = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";

describe("scan 2026-10-28 F9: CCTP remote corridor with cctpPins", () => {
  it("the repro's deposit-address route (USDC to the attacker) is refused before anything is sent", async () => {
    const a = app("cctp", cctpPins, depositBackend("cctp", "eip155:8453"), SENDER, "eip155:8453");
    await expect(a.swap2.swap2({fromToken: "USDC", toToken: ARB_USDC, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 1n} as never)).rejects.toThrow(/did not allow deposit-address routes|the quote carries no TokenMessenger call/);
    expect(a.sent).toEqual([]);
  });

  it("corridor USDC Base → Arbitrum: approve the TokenMessenger, then depositForBurn", async () => {
    const a = app("cctp", cctpPins, realBackend(make().p), SENDER, "eip155:8453");
    await a.swap2.swap2({fromToken: "USDC", toToken: ARB_USDC, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 10_000_000n, minAmountOut: 9_998_570n} as never);
    expect(a.sent.map((t) => t.to.toLowerCase())).toEqual([BASE_USDC.toLowerCase(), TOKEN_MESSENGER_V2.toLowerCase()]);
  });
});
