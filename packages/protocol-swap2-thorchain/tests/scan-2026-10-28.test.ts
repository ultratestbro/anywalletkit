// Scan 2026-10-28, F9: a remote stub's deposit-address and plain-value routes skipped every pin, so a pinned stub
// could be made to pay any address the backend named. They now need the app's opt-in (`depositAddressRoutes`).
// thorchainPins opt in — the Tron vault is the one verifyBuild confirms with two THORNodes — so both THORChain
// corridors keep executing through the real provider behind the swap2 server handler, remoteProvider +
// thorchainPins, and the engine: a Tron USDT deposit to the vault with its memo, and an ETH router call.
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider} from "@anywalletkit/protocol-swap2-core/types";
import {thorchainPins, thorchainProvider} from "../src/provider.js";

const NODES = ["https://primary.invalid", "https://secondary.invalid"];
const TRON = "tron:728126428";
const TRON_VAULT = "TAewdzzZPbA8bUUoDqo1Ygh5CbCuq2hrLD";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TRON_SELF = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const ETH_VAULT = "0x1111111111111111111111111111111111111111";
const ETH_ROUTER = "0xD37BbE5744D730a1d98d8DC97c42F0Ca46aD7146";
const ETH_SELF = "0x4444444444444444444444444444444444444444";
const ETH_DEST = "0x9999999999999999999999999999999999999999";
const BTC_DEST = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const ATTACKER_TRON = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";

beforeEach(() => {
  // Both nodes answer the same inbound snapshot; the quote's memo names the request's destination and refund.
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/inbound_addresses")) {
      return new Response(JSON.stringify([
        {chain: "TRON", address: TRON_VAULT, halted: false, dust_threshold: "10000000"},
        {chain: "ETH", address: ETH_VAULT, router: ETH_ROUTER, halted: false, dust_threshold: "1000"},
        {chain: "BTC", address: "bc1qyl7j673h6hlvvlgf3kj7s4ll5yfmxzzvk03qky", halted: false, dust_threshold: "10000"},
      ]));
    }
    if (url.pathname.includes("/quote/swap")) {
      const tron = url.searchParams.get("from_asset")?.startsWith("TRON") ?? false;
      const target = [url.searchParams.get("destination"), url.searchParams.get("refund_address")].filter(Boolean).join("/");
      return new Response(JSON.stringify({
        expected_amount_out: tron ? "2061155" : "100000", inbound_address: tron ? TRON_VAULT : ETH_VAULT, ...(tron ? {} : {router: ETH_ROUTER}),
        memo: tron ? `=:e:${target}:2014026` : `=:b:${target}:95000`, expiry: Math.floor(Date.now() / 1000) + 3600, recommended_min_amount_in: "1000",
      }));
    }
    return new Response("nope", {status: 404});
  });
});
afterEach(() => vi.unstubAllGlobals());

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [thorchainProvider({nodeUrl: NODES, tronSource: true})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

function app(fromChain: string, self: string, fetchImpl: typeof fetch, pins: object = thorchainPins({nodeUrl: NODES})) {
  const sent: unknown[] = [], transfers: unknown[] = [];
  const account = {
    getAddress: async () => self, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: unknown) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
    transfer: async (t: unknown) => { transfers.push(t); return {hash: `t${transfers.length}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "thorchain", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...pins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, transfers, swap2: new P(account as never, {fromChain, ...(fromChain === TRON ? {skipAccountChainCheck: true} : {})} as never)};
}

describe("scan 2026-10-28 F9: THORChain remote corridors with thorchainPins", () => {
  it("thorchainPins open the stub to the Tron vault route", () => {
    expect(thorchainPins({nodeUrl: NODES}).depositAddressRoutes).toBe(true);
  });

  it("corridor Tron USDT → ETH: the TRC-20 transfer to the vault both nodes confirm, with the memo", async () => {
    const a = app(TRON, TRON_SELF, realBackend());
    await a.swap2.swap2({fromToken: "USDT", toToken: "0x0000000000000000000000000000000000000000", toChain: 1, recipient: ETH_DEST, fromTokenAmount: 50_000_000n, minAmountOut: 1n} as never);
    expect(a.transfers).toEqual([{token: TRON_USDT, recipient: TRON_VAULT, amount: 50_000_000n, memo: `=:ETH.ETH:${ETH_DEST}/${TRON_SELF}:2014026`}]);
  });

  it("corridor ETH → BTC: the router call, pinned and checked", async () => {
    const a = app("eip155:1", ETH_SELF, realBackend());
    await a.swap2.swap2({fromToken: "ETH", toToken: "BTC", toChain: "bitcoin:mainnet", recipient: BTC_DEST, fromTokenAmount: 50_000_000_000_000_000n, minAmountOut: 1n} as never);
    expect(a.sent.map((t) => (t as {to: string}).to.toLowerCase())).toEqual([ETH_ROUTER.toLowerCase()]);
  });

  it("without the opt-in the Tron deposit route is refused; with the opt-in an attacker vault still fails verifyBuild", async () => {
    const pins = thorchainPins({nodeUrl: NODES});
    const closed = app(TRON, TRON_SELF, realBackend(), {...pins, depositAddressRoutes: false});
    await expect(closed.swap2.swap2({fromToken: "USDT", toToken: "0x0000000000000000000000000000000000000000", toChain: 1, recipient: ETH_DEST, fromTokenAmount: 50_000_000n, minAmountOut: 1n} as never)).rejects.toThrow(/did not allow deposit-address routes/);
    expect(closed.transfers).toEqual([]);
    // A backend that swaps the vault for its own address: the nodes report another vault.
    const real = realBackend();
    const evil = (async (url: string, init: RequestInit) => {
      const action = String(url).split("/").pop();
      const reply = (x: unknown) => new Response(JSON.stringify(x), {status: 200, headers: {"content-type": "application/json"}});
      if (action === "quote") return reply({...(await (await real(url, init)).json() as object), depositAddress: ATTACKER_TRON});
      if (action === "build") {
        const {quote} = JSON.parse(String(init.body)) as {quote: {depositMemo: string; sourceAmount: string}};
        return reply({chain: TRON, to: ATTACKER_TRON, value: quote.sourceAmount, memo: quote.depositMemo});
      }
      return real(url, init);
    }) as unknown as typeof fetch;
    const open = app(TRON, TRON_SELF, evil);
    await expect(open.swap2.swap2({fromToken: "USDT", toToken: "0x0000000000000000000000000000000000000000", toChain: 1, recipient: ETH_DEST, fromTokenAmount: 50_000_000n, minAmountOut: 1n} as never)).rejects.toThrow(/fails this app's own check — a THORNode reports another inbound vault/);
    expect(open.transfers).toEqual([]);
  });
});
