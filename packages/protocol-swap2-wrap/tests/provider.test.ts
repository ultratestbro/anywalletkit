import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters} from "viem";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {wrapPins, wrapProvider, WRAPPED_NATIVE} from "../src/provider.js";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

import {WrapSwap2Protocol} from "../src/protocol.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

afterEach(() => vi.unstubAllGlobals());

const WETH = WRAPPED_NATIVE[1]!.address;
const ME = "0x4444444444444444444444444444444444444444";
const OTHER = "0x3333333333333333333333333333333333333333";
const RPC = {1: ["https://rpc.test"]};
const ZERO = "0x0000000000000000000000000000000000000000";

/** WETH9 on chain 1: symbol/decimals answer, receipts by status. */
function stub(o: {symbol?: string; receipt?: string | null} = {}): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const req = JSON.parse(String(init?.body)) as {method: string; params: [{data: string}]};
    if (req.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({result: o.receipt == null ? null : {status: o.receipt}}));
    const sel = req.params[0].data;
    const result = sel === "0x95d89b41" ? encodeAbiParameters([{type: "string"}], [o.symbol ?? "WETH"]) : encodeAbiParameters([{type: "uint8"}], [18]);
    return new Response(JSON.stringify({result}));
  }) as typeof fetch;
}
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME, amountIn: "1000000000000000"};

describe("wrap provider", () => {
  it("wraps: deposit() with value, 1:1, no approval", async () => {
    vi.stubGlobal("fetch", stub());
    const q = await wrapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "ETH", destToken: WETH});
    expect(q).toMatchObject({provider: "wrap", destAmount: base.amountIn, minDestAmount: base.amountIn, txRequest: {to: WETH, data: "0xd0e30db0", value: base.amountIn}});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
  });

  it("unwraps: withdraw(amount), no value, no approval", async () => {
    vi.stubGlobal("fetch", stub());
    const q = await wrapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "WETH", destToken: ZERO});
    expect(q!.txRequest).toMatchObject({to: WETH, value: "0", data: "0x2e1a7d4d" + BigInt(base.amountIn).toString(16).padStart(64, "0")});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
  });

  it("refuses, by name: another pair, another recipient, a token that is not the canonical one", async () => {
    const reasons: string[] = [];
    const on = (r: string) => reasons.push(r);
    vi.stubGlobal("fetch", stub());
    const p = wrapProvider({rpcUrls: RPC});
    await p.getQuote({...base, sourceToken: "USDC", destToken: WETH, onRefusal: on});
    await p.getQuote({...base, sourceToken: "ETH", destToken: WETH, destAddress: OTHER, onRefusal: on});
    await p.getQuote({...base, sourceToken: "ETH", destToken: WETH, destChain: "eip155:10", onRefusal: on});
    vi.stubGlobal("fetch", stub({symbol: "FAKE"}));
    await wrapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "ETH", destToken: WETH, onRefusal: on});
    expect(reasons).toEqual([
      "wrap: only ETH ↔ WETH",
      "wrap: wrapping pays the sender's own address — send the result separately",
      "wrap: same-chain only",
      `wrap: ${WETH} on chain 1 is not WETH — refusing`,
    ]);
  });

  it("tracks by receipt", async () => {
    const p = wrapProvider({rpcUrls: RPC});
    vi.stubGlobal("fetch", stub({receipt: "0x1"}));
    expect(await p.trackIntent({intentId: "wrap:1", sourceTxHash: "0xab"})).toEqual({state: "completed", destTxHash: "0xab"});
    vi.stubGlobal("fetch", stub({receipt: "0x0"}));
    expect(await p.trackIntent({intentId: "wrap:1", sourceTxHash: "0xab"})).toEqual({state: "failed"});
  });
});

describeProtocolModule("protocol-swap2-wrap", {
  type: "swap2",
  activity,
  Protocol: WrapSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, rpcUrls: RPC},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

describeProtocolBehaviour("protocol-swap2-wrap", {
  type: "swap2",
  Protocol: WrapSwap2Protocol,
  config: {fromChain: "eip155:1", rpcUrls: RPC},
  fixtures: [
    {name: "ETH → WETH (deposit with value)", options: {fromToken: "ETH", toToken: WETH, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 10n ** 15n}, fetch: stub(), account: {address: ME}, own: [ME]},
    {name: "WETH → ETH (withdraw)", options: {fromToken: "WETH", toToken: ZERO, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 10n ** 15n}, fetch: stub(), account: {address: ME}, own: [ME], sourceToken: WETH},
  ],
});

describe("wrapped-native table (2026-10-14 batch)", () => {
  it.each([
    ["eip155:5000", 5000, "WMNT", "0x78c1b0C915c4FAA5FffA6CAbf0219DA63d7f4cb8"],
    ["eip155:747474", 747474, "vbETH", "0xEE7D8BCFb72bC1880D0Cf19822eB0A2e6577aB62"],
    ["eip155:2818", 2818, "WETH", "0x5300000000000000000000000000000000000011"],
    ["eip155:14", 14, "WFLR", "0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d"],
  ])("%s resolves to %s and is a same-chain venue once an RPC is configured", (caip2, chainId, symbol, address) => {
    expect(WRAPPED_NATIVE[chainId]).toEqual({address, symbol});
    const p = wrapProvider({rpcUrls: {[chainId]: ["https://rpc.test"]}});
    expect(p.supportsChain?.(caip2)).toBe(true);
    expect(p.supportsChainPair?.(caip2, caip2)).toBe(true);
    expect(p.supportsChainPair?.(caip2, "eip155:1")).toBe(false);
    expect(wrapProvider({rpcUrls: {}}).supportsChain?.(caip2)).toBe(false);
  });

  it("Arc has no wrapped native (its USDC gas token is already an ERC-20)", () => {
    expect(WRAPPED_NATIVE[5042]).toBeUndefined();
    expect(wrapProvider({rpcUrls: {5042: ["https://rpc.test"]}}).supportsChain?.("eip155:5042")).toBe(false);
  });
});

// Scan 2026-10-28, F9: a remote stub's deposit-address routes now need the app's opt-in (`depositAddressRoutes`),
// which wrapPins do not give. The repro's deposit route is refused; the real wrap and unwrap still execute through
// the real provider behind the swap2 server handler, remoteProvider + wrapPins, and the engine.
describe("scan 2026-10-28 F9: wrap remote corridor with wrapPins", () => {
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

  it("the repro's deposit-address route (the ETH to the attacker) is refused before anything is sent", async () => {
    const a = app("wrap", wrapPins, depositBackend("wrap", "eip155:1"), ME, "eip155:1", {supportsSameChain: true});
    await expect(a.swap2.swap2({fromToken: "ETH", toToken: WETH, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 1n} as never)).rejects.toThrow(/did not allow deposit-address routes/);
    expect(a.sent).toEqual([]);
  });

  it("corridor wrap and unwrap on Ethereum: deposit() with the value, withdraw(amount) on WETH", async () => {
    vi.stubGlobal("fetch", stub());
    const wrap = app("wrap", wrapPins, realBackend(wrapProvider({rpcUrls: RPC})), ME, "eip155:1", {supportsSameChain: true});
    await wrap.swap2.swap2({fromToken: "ETH", toToken: WETH, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 10n ** 15n} as never);
    expect(wrap.sent.map((t) => [t.to.toLowerCase(), t.data, t.value])).toEqual([[WETH.toLowerCase(), "0xd0e30db0", 10n ** 15n]]);
    const unwrap = app("wrap", wrapPins, realBackend(wrapProvider({rpcUrls: RPC})), ME, "eip155:1", {supportsSameChain: true});
    await unwrap.swap2.swap2({fromToken: "WETH", toToken: ZERO, toChain: 1, recipient: ME, fromTokenAmount: 10n ** 15n, minAmountOut: 10n ** 15n} as never);
    expect(unwrap.sent.map((t) => t.to.toLowerCase())).toEqual([WETH.toLowerCase()]);
  });
});
