// Scan 2026-10-30 F3 (core rule): a remote stub's EVM calldata on a pinned contract was signed on the pin alone, but a
// pinned contract executes whatever its arguments say (a CCTP burn's mintRecipient, an OFT send's `to`). The router,
// the single-provider path and the engine now require the app's own check of the call — the provider's `verifyQuote`
// (shipped in its pins) or a `verifyBuild` the app supplies (omnistonVerifyBuild) — before such a route runs.
// Mocked backend + account only; every refusal asserts nothing was sent.
import {describe, expect, it} from "vitest";
import {remoteProvider, type RemoteProviderOptions} from "../src/remote.js";
import {remotePinRefusal} from "../src/validate.js";
import {SingleProviderSwap2} from "../src/swap2/single.js";
import type {Swap2EngineConfig} from "../src/swap2/base.js";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "../src/types.js";

const SELF = "0x4444444444444444444444444444444444444444";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const MESSENGER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const options = {fromToken: "USDC", toToken: "0xFd086bC7CD5C481DCC9C85EBE478A1C0b69FCbb9", toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n};
const route = {to: MESSENGER, data: "0xdeadbeef", value: "0", chainId: 1, gasLimit: "60000", approvalAddress: MESSENGER};
const pins = {callTargets: () => [MESSENGER], spenders: () => [MESSENGER]};

const quoteFor = (params: QuoteParams): Quote => ({
  provider: "scan", intentId: `intent-${Math.random()}`, depositAddress: "", depositMemo: null, txRequest: route,
  sourceAmount: params.amountIn, destAmount: "990000", minDestAmount: "980000", feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
} as Quote);
const fetchImpl = (async (url: string, init: {body: string}) => {
  const action = String(url).split("/").at(-1);
  const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
  const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
  if (action === "quote") return reply(quoteFor(body.params!));
  if (action === "build") return reply({...body.quote!.txRequest, chain: "eip155:1", to: MESSENGER, value: "0"} satisfies UnsignedTx);
  return reply({});
}) as unknown as typeof fetch;
const stub = (opts: Partial<RemoteProviderOptions> = {}) => remoteProvider({name: "scan", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...pins, ...opts});

function run(provider: CrossChainProvider) {
  const sent: Array<{to: string; data?: string}> = [];
  const account = {
    getAddress: async () => SELF, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string}) => { sent.push(tx); return {hash: `0x${sent.length}`}; },
  };
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap: () => new P(account as never, {fromChain: "eip155:1"} as Partial<Swap2EngineConfig> as never).swap2(options)};
}

describe("scan 2026-10-30 F3: remote calldata on a pinned contract needs the app's check of the call", () => {
  it("pins alone: refused before anything is approved or sent", async () => {
    const r = run(stub());
    await expect(r.swap()).rejects.toThrow(/calldata is not checked by the app \(remoteProvider verifyQuote \/ verifyBuild\)/);
    expect(r.sent).toEqual([]);
  });

  it("with the provider's verifyQuote, or a verifyBuild the app supplies, the route executes", async () => {
    for (const opts of [{verifyQuote: () => null}, {verifyBuild: () => null}] as Partial<RemoteProviderOptions>[]) {
      const r = run(stub(opts));
      await r.swap();
      expect(r.sent.map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), MESSENGER.toLowerCase()]);
    }
    expect(stub({verifyQuote: () => null})).toMatchObject({remote: true, verifiesQuotes: true});
    expect(stub({verifyBuild: () => null})).toMatchObject({remote: true, verifiesBuilds: true});
  });

  it("the engine checks again at execution, not only at quote time", async () => {
    // A provider object that claims a check while quoting and drops it before the build: the engine still refuses.
    const base = stub({verifyQuote: () => null});
    let reads = 0;
    const flaky = {...base, get verifiesQuotes() { return reads++ === 0; }} as CrossChainProvider;
    const r = run(flaky);
    await expect(r.swap()).rejects.toThrow(/with calldata the app does not check/);
    expect(r.sent).toEqual([]);
  });

  it("remotePinRefusal: local providers, non-EVM chains, deposit routes and checked stubs are not judged by this rule", () => {
    const q = {txRequest: route} as unknown as Quote;
    expect(remotePinRefusal({name: "x", ...pins}, q, "eip155:1")).toBeNull();
    expect(remotePinRefusal({name: "x", remote: true, ...pins}, q, "eip155:1")).toMatch(/calldata is not checked by the app/);
    expect(remotePinRefusal({name: "x", remote: true, verifiesQuotes: true, ...pins}, q, "eip155:1")).toBeNull();
    expect(remotePinRefusal({name: "x", remote: true, verifiesBuilds: true, ...pins}, q, "eip155:1")).toBeNull();
    expect(remotePinRefusal({name: "x", remote: true}, {txRequest: {serializedTx: "AQ==", value: "0"}} as unknown as Quote, "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBeNull();
    expect(remotePinRefusal({name: "x", remote: true, depositAddressRoutes: true}, {depositAddress: SELF} as unknown as Quote, "eip155:1")).toBeNull();
  });
});
