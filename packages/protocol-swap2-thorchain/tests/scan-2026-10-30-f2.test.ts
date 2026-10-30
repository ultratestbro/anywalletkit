// Scan 2026-10-30 F2: thorchainPins.verifyBuild accepted a memo whose output asset differed from the requested
// destination asset (verifiedMemo built the canonical memo, verifyBuild dropped it). Now the build's memo must be the
// canonical memo byte for byte. Honest corridors — Tron deposit and EVM router call, with and without affiliate —
// keep passing. Fake THORNodes, no network.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData} from "viem";
import type {Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {thorchainPins, thorchainProvider} from "../src/provider.js";

const NODES = ["https://primary.invalid", "https://secondary.invalid"];
const TRON = "tron:728126428";
const TRON_VAULT = "TAewdzzZPbA8bUUoDqo1Ygh5CbCuq2hrLD";
const TRON_SELF = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const ETH_DEST = "0x9999999999999999999999999999999999999999";
const SWAPPED = "ETH.USDC-0XA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48"; // another real asset on the same chain

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/inbound_addresses")) {
      return new Response(JSON.stringify([{chain: "TRON", address: TRON_VAULT, halted: false, dust_threshold: "10000000"}, {chain: "ETH", address: "0x1111111111111111111111111111111111111111", router: "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146", halted: false, dust_threshold: "1000"}]));
    }
    if (url.pathname.includes("/quote/swap")) {
      const target = [url.searchParams.get("destination"), url.searchParams.get("refund_address")].filter(Boolean).join("/");
      return new Response(JSON.stringify({
        expected_amount_out: "2061155", inbound_address: TRON_VAULT,
        memo: `=:e:${target}:2014026`, expiry: Math.floor(Date.now() / 1000) + 3600, recommended_min_amount_in: "1000",
      }));
    }
    return new Response("nope", {status: 404});
  });
});
afterEach(() => vi.unstubAllGlobals());

function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [thorchainProvider({nodeUrl: NODES, tronSource: true})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** Compromised backend: real quote, but the memo's output asset swapped in both quote and build. */
function evilBackend(): typeof fetch {
  const real = realBackend();
  const swap = (m: string) => m.replace(/^=:[^:]+:/, `=:${SWAPPED}:`);
  return (async (url: string, init: RequestInit) => {
    const action = String(url).split("/").pop();
    const reply = (x: unknown) => new Response(JSON.stringify(x), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") {
      const q = await (await real(url, init)).json() as {depositMemo: string; providerData: Record<string, string>};
      return reply({...q, depositMemo: swap(q.depositMemo), providerData: {...q.providerData, memo: swap(q.providerData.memo ?? "")}});
    }
    if (action === "build") {
      const {quote} = JSON.parse(String(init.body)) as {quote: {depositMemo: string; sourceAmount: string; depositAddress: string}};
      return reply({chain: TRON, to: quote.depositAddress, value: quote.sourceAmount, memo: quote.depositMemo});
    }
    if (action === "preflight") return reply({});
    if (action === "track") return reply({state: "pending"});
    return reply({});
  }) as unknown as typeof fetch;
}

function app(fetchImpl: typeof fetch) {
  const transfers: {memo?: string}[] = [];
  const account = {
    getAddress: async () => TRON_SELF, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async () => ({hash: `0x${"1".padStart(64, "0")}`}),
    transfer: async (t: {memo?: string}) => { transfers.push(t); return {hash: `t${transfers.length}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "thorchain", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...thorchainPins({nodeUrl: NODES})});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {transfers, swap2: new P(account as never, {fromChain: TRON, skipAccountChainCheck: true} as never)};
}
const REQ = {fromToken: "USDT", toToken: "0x0000000000000000000000000000000000000000", toChain: 1, recipient: ETH_DEST, fromTokenAmount: 50_000_000n, minAmountOut: 1n} as never;

describe("scan 2026-10-30 F2: remote THORChain memo output asset", () => {
  it("honest corridor Tron USDT → ETH still executes with the canonical memo", async () => {
    const a = app(realBackend());
    await a.swap2.swap2(REQ);
    expect(a.transfers.map((t) => t.memo)).toEqual([`=:ETH.ETH:${ETH_DEST}/${TRON_SELF}:2014026`]);
  });

  it("a memo that pays the user in ANOTHER asset (ETH.USDC instead of ETH.ETH) is refused before signing", async () => {
    const a = app(evilBackend());
    let err: unknown = null;
    try { await a.swap2.swap2(REQ); } catch (e) { err = e; }
    expect(a.transfers.map((t) => t.memo)).toEqual([]);
    expect(String(err)).toMatch(/fails this app's own check/);
  });
});

describe("scan 2026-10-30 F2: verifyBuild binds the memo to the canonical one", () => {
  const ROUTER = "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146";
  const VAULT = "0x1111111111111111111111111111111111111111";
  const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
  const ROUTER_ABI = [{type: "function", name: "depositWithExpiry", stateMutability: "payable", inputs: [{name: "vault", type: "address"}, {name: "asset", type: "address"}, {name: "amount", type: "uint256"}, {name: "memo", type: "string"}, {name: "expiry", type: "uint256"}], outputs: []}] as const;
  const evm = (memo: string): UnsignedTx => ({
    chain: "eip155:1", to: ROUTER, value: "50000000000000000", chainId: 1,
    data: encodeFunctionData({abi: ROUTER_ABI, functionName: "depositWithExpiry", args: [VAULT, "0x0000000000000000000000000000000000000000", 50_000_000_000_000_000n, memo, 9_999_999_999n]}),
  });
  const evmParams: QuoteParams = {sourceChain: "eip155:1", sourceToken: "ETH", destChain: "bitcoin:mainnet", destToken: "0x0000000000000000000000000000000000000000", amountIn: "50000000000000000", destAddress: BTC_DEST};
  const evmQuote = {sourceAmount: "50000000000000000", minDestAmount: "95000"} as Quote;
  const tronParams: QuoteParams = {sourceChain: TRON, sourceToken: "USDT", destChain: "eip155:1", destToken: "0x0000000000000000000000000000000000000000", amountIn: "50000000", destAddress: ETH_DEST, refundAddress: TRON_SELF};
  const tronQuote = {sourceAmount: "50000000", minDestAmount: "20140260000000000"} as Quote;
  const tron = (memo: string): UnsignedTx => ({chain: TRON, to: TRON_VAULT, value: "50000000", memo});

  it("EVM router deposit: the canonical memo passes, without and with this app's affiliate", async () => {
    await expect(thorchainPins({nodeUrl: NODES}).verifyBuild(evmQuote, evm(`=:BTC.BTC:${BTC_DEST}:95000`), evmParams)).resolves.toBeNull();
    const aff = thorchainPins({nodeUrl: NODES, affiliate: "vv", affiliateBps: "30"});
    await expect(aff.verifyBuild(evmQuote, evm(`=:BTC.BTC:${BTC_DEST}:95000:vv:30`), evmParams)).resolves.toBeNull();
  });

  it("Tron deposit: the canonical memo passes (base58 refund kept case-sensitive), without and with affiliate", async () => {
    await expect(thorchainPins({nodeUrl: NODES}).verifyBuild(tronQuote, tron(`=:ETH.ETH:${ETH_DEST}/${TRON_SELF}:2014026`), tronParams)).resolves.toBeNull();
    const aff = thorchainPins({nodeUrl: NODES, affiliate: "vv", affiliateBps: "30"});
    await expect(aff.verifyBuild(tronQuote, tron(`=:ETH.ETH:${ETH_DEST}/${TRON_SELF}:2014026:vv:30`), tronParams)).resolves.toBeNull();
    // An upper-cased Tron refund is another (invalid) address: refused.
    await expect(thorchainPins({nodeUrl: NODES}).verifyBuild(tronQuote, tron(`=:ETH.ETH:${ETH_DEST}/${TRON_SELF.toUpperCase()}:2014026`), tronParams)).resolves.toMatch(/not the canonical/);
  });

  it("another output asset or a fuzzy spelling is refused", async () => {
    const pins = thorchainPins({nodeUrl: NODES});
    await expect(pins.verifyBuild(tronQuote, tron(`=:${SWAPPED}:${ETH_DEST}/${TRON_SELF}:2014026`), tronParams)).resolves.toMatch(/not the canonical/);
    await expect(pins.verifyBuild(tronQuote, tron(`=:e:${ETH_DEST}/${TRON_SELF}:2014026`), tronParams)).resolves.toMatch(/not the canonical/);
    await expect(pins.verifyBuild(evmQuote, evm(`=:BTC.USDT:${BTC_DEST}:95000`), evmParams)).resolves.toMatch(/not the canonical/);
  });
});
