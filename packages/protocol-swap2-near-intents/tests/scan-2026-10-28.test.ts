// Scan 2026-10-28, F9: a remote stub's deposit-address routes now need the app's opt-in (`depositAddressRoutes`).
// Every 1Click route is a deposit address minted per quote, so the app opens its NEAR Intents stub with
// nearIntentsPins; the corridors keep executing through the real provider behind the swap2 server handler,
// remoteProvider + nearIntentsPins, and the engine — an ERC-20 and a native EVM source, a Tron TRC-20 source and a
// Bitcoin source — and without the opt-in the same routes are refused.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, RemotePins} from "@anywalletkit/protocol-swap2-core/types";
import {nearIntentsPins} from "../src/config.js";
import {nearIntentsProvider} from "../src/provider.js";

const DEPOSIT = "0x5555555555555555555555555555555555555555";
const TRON_DEPOSIT = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const BTC_DEPOSIT = "bc1qyl7j673h6hlvvlgf3kj7s4ll5yfmxzzvk03qky";
const EVM_SELF = "0x4444444444444444444444444444444444444444";
const EVM_DEST = "0x3333333333333333333333333333333333333333";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";

beforeEach(() => {
  // 1Click: a live quote with a deposit address on the source chain, echoing the requested amount.
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (!String(url).endsWith("/quote")) return new Response("{}", {status: 404});
    const body = JSON.parse(String(init.body)) as {amount: string; originAsset: string};
    const origin = body.originAsset;
    const depositAddress = origin.includes("tron") ? TRON_DEPOSIT : origin.includes("btc") ? BTC_DEPOSIT : DEPOSIT;
    return new Response(JSON.stringify({quote: {depositAddress, amountIn: body.amount, amountOut: "990000", minAmountOut: "980000", deadline: new Date(Date.now() + 600_000).toISOString()}}));
  });
});
afterEach(() => vi.unstubAllGlobals());

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [nearIntentsProvider({apiUrl: "https://near.invalid"})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

function app(fromChain: string, self: string, pins: RemotePins = nearIntentsPins) {
  const sent: Array<{to?: string; data?: string; value?: bigint}> = [], transfers: unknown[] = [];
  const account = {
    getAddress: async () => self, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to?: string; data?: string; value?: bigint}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    transfer: async (t: unknown) => { transfers.push(t); return {hash: `t${transfers.length}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "near_intents", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl: realBackend(), ...pins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, transfers, swap2: new P(account as never, {fromChain, ...(fromChain.startsWith("eip155:") ? {} : {skipAccountChainCheck: true})} as never)};
}

describe("scan 2026-10-28 F9: NEAR Intents remote corridors with nearIntentsPins", () => {
  it("nearIntentsPins pin no contract and open the stub to deposit-address routes", () => {
    expect([nearIntentsPins.callTargets("eip155:1"), nearIntentsPins.spenders("eip155:1"), nearIntentsPins.depositAddressRoutes]).toEqual([[], [], true]);
  });

  it("corridor USDT Ethereum → Arbitrum: the engine writes transfer(deposit, amount) on the source token", async () => {
    const a = app("eip155:1", EVM_SELF);
    await a.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n} as never);
    expect(a.sent.map((t) => ({...t, to: t.to?.toLowerCase(), data: t.data?.toLowerCase()}))).toEqual([expect.objectContaining({to: USDT.toLowerCase(), data: `0xa9059cbb${DEPOSIT.slice(2).padStart(64, "0")}${(1_000_000n).toString(16).padStart(64, "0")}`, value: 0n})]);
  });

  it("corridor ETH Ethereum → Arbitrum: a plain send of the input to the deposit address", async () => {
    const a = app("eip155:1", EVM_SELF);
    await a.swap2.swap2({fromToken: "ETH", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 10n ** 16n, minAmountOut: 980_000n} as never);
    expect(a.sent.map((t) => ({...t, to: t.to?.toLowerCase()}))).toEqual([expect.objectContaining({to: DEPOSIT.toLowerCase(), value: 10n ** 16n})]);
  });

  it("corridor Tron USDT → Arbitrum: the TRC-20 transfer to the deposit address", async () => {
    const a = app("tron:728126428", "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL");
    await a.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n} as never);
    expect(a.transfers).toEqual([expect.objectContaining({recipient: TRON_DEPOSIT, amount: 1_000_000n})]);
  });

  it("corridor BTC → Arbitrum: a plain send to the deposit address", async () => {
    const a = app("bitcoin:mainnet", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    await a.swap2.swap2({fromToken: "BTC", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 100_000n, minAmountOut: 980_000n} as never);
    expect(a.sent).toEqual([expect.objectContaining({to: BTC_DEPOSIT, value: 100_000n})]);
  });

  it("without the opt-in the same deposit routes are refused before anything is sent", async () => {
    const closed = {callTargets: () => [], spenders: () => []};
    const evm = app("eip155:1", EVM_SELF, closed);
    await expect(evm.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n} as never)).rejects.toThrow(/did not allow deposit-address routes/);
    const tron = app("tron:728126428", "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL", closed);
    await expect(tron.swap2.swap2({fromToken: "USDT", toToken: ARB_USDC, toChain: 42161, recipient: EVM_DEST, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n} as never)).rejects.toThrow(/did not allow deposit-address routes/);
    expect([evm.sent, tron.transfers]).toEqual([[], []]);
  });
});
