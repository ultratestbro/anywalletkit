// From Solana, LI.FI was asked for Mayan's routes only and refused any transaction that called no Mayan program, which
// took away the Relay, LayerSwap, NEAR Intents and LI.FI Intents corridors (Solana → HyperEVM, SOL → most EVM chains at
// LI.FI's best price). They are offered again as before: no bridge restriction from Solana, and the provider and the
// remote pin read only what the bytes show for every route (paid by the sender) plus, on a Mayan route, that no SOL is
// paid directly to another wallet. A Mayan order's recipient is proven by the account (wallet-solana `bridgeOut`); the
// other Solana bridges are held there to the SOL and token ceilings only. EVM sources still route around Relay and Garden.
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {LifiSwap2Protocol} from "../src/protocol.js";
import {lifiProvider, lifiVerifyQuote} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

const SOL_CHAIN = 1151111081099710;
const SOL_NATIVE = "11111111111111111111111111111111";
const SOL_SENDER = "HAgk14JpMQLgt6rVgv7cBQFJWFto5Dqxi472uT3DKpqk";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECIPIENT = "0x3333333333333333333333333333333333333333";
const FEE_WALLET = "34FKjAdVcTax2DHqV2XnbXa9J3zmyKcFuFKWbcmgxjgm";
// ONE instruction: a System transfer of 50_000_000 lamports from SOL_SENDER to Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS.
const DEPOSIT_WIRE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABA/A2J2JGp1ud4zSe1CsV4jL2UY/CD1/NTx1k6B+b0lj32gdcsv9exoF2E95TC2kqhzVHd2naR0MMvYFUM1xKgycAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIO/U8lswd7/sEOI0dsqBqnwiY65qQYRV3sGKjeiQHhbAQICAAEMAgAAAIDw+gIAAAAAAA==";

type Live = {name: string; params: QuoteParams; response: {tool?: string; action?: object; transactionRequest?: {data?: string}}};
const live = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: Live[]}).corridors
  .filter((c) => c.params.sourceChain === "solana:mainnet");

const answer = (wire: string, tool = "near") => ({
  type: "lifi", id: "q-1", tool,
  action: {
    fromToken: {address: SOL_NATIVE, chainId: SOL_CHAIN}, toToken: {address: BASE_USDC, chainId: 8453},
    fromAmount: "50000000", fromChainId: SOL_CHAIN, toChainId: 8453, slippage: 0.005, fromAddress: SOL_SENDER, toAddress: RECIPIENT,
  },
  estimate: {fromAmount: "50000000", toAmount: "9000000", toAmountMin: "8955000", executionDuration: 30},
  transactionRequest: {data: wire},
});
const params = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "eip155:8453", destToken: BASE_USDC, amountIn: "50000000",
  destAddress: RECIPIENT, refundAddress: SOL_SENDER, slippageBps: 50, dry: false};
const asQuote = (wire: string) => ({provider: "lifi", intentId: `lifi:${SOL_CHAIN}:8453`, depositAddress: "", depositMemo: null, sourceAmount: "50000000", destAmount: "9000000",
  minDestAmount: "8955000", feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 1000, txRequest: {serializedTx: wire, value: "50000000"}});

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const key = (s: string) => { let n = 0n; for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch)); return Buffer.from(n.toString(16).padStart(64, "0"), "hex"); };

describe("audit 2026-11-02 r3: LI.FI's Solana bridges are offered as before", () => {
  it("every recorded Solana answer (Mayan, Relay, LayerSwap, NEAR Intents, LI.FI Intents) passes the provider and the remote pin", async () => {
    const got: Record<string, string> = {};
    for (const c of live) {
      // Recorded at 0.5 %; the provider may re-quote at a scaled slippage. The recorded answer stands in for it, echoing the slippage asked.
      vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...c.response, action: {...c.response.action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}})));
      const reasons: string[] = [];
      const quote = await lifiProvider().getQuote({...c.params, slippageBps: 300, onRefusal: (r) => reasons.push(r)});
      got[c.name] = quote ? (lifiVerifyQuote(c.params, quote) ?? "pass") : reasons[0]!;
    }
    expect(Object.keys(got)).toHaveLength(16);
    for (const [name, outcome] of Object.entries(got)) expect([name, outcome]).toEqual([name, "pass"]);
    expect(new Set(live.map((c) => c.response.tool))).toEqual(new Set(["mayan", "mayanMCTP", "mayanFastMCTP", "relaydepository", "layerswap", "near", "lifiIntents"]));
  });

  it("a plain deposit to an address passes and reaches the account with bridgeOut; a Mayan route that also pays SOL to another wallet does not", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(answer(DEPOSIT_WIRE))));
    expect(await lifiProvider().getQuote(params)).not.toBeNull();
    expect(lifiVerifyQuote(params, asQuote(DEPOSIT_WIRE))).toBeNull();
    const seen: {wire: string; expect: unknown}[] = [];
    const p = new LifiSwap2Protocol({chain: "solana:mainnet", getAddress: async () => SOL_SENDER, getBalance: async () => 10_000_000_000n,
      sendTransaction: async () => { throw new Error("no plain tx"); }, transfer: async () => { throw new Error("no transfer"); },
      sendSerializedTransaction: async (wire: string, expect: unknown) => { seen.push({wire, expect}); return {hash: "5".repeat(87)}; }} as never, {fromChain: "solana:mainnet"});
    await p.swap2({fromToken: "SOL", toToken: BASE_USDC, toChain: "eip155:8453", recipient: RECIPIENT, fromTokenAmount: 50_000_000n, minAmountOut: 1n});
    expect(seen[0]!.expect).toMatchObject({bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT}});

    // The recorded LayerSwap route pays its deposit address directly; with its memo program swapped for Mayan's CPI
    // proxy it reads as a Mayan route, which must not pay SOL to another wallet.
    const c = live.find((k) => k.name === "w-sol-base-usdc-layerswap")!;
    const bytes = Buffer.from(c.response.transactionRequest!.data!, "base64");
    const at = bytes.indexOf(key("Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"));
    expect(at).toBeGreaterThan(0);
    bytes.set(key("D8C8iW6zmoKg5TRr8nQ7h14TMWqQX8FiBdj2ju5MF3wa"), at);
    const tampered = bytes.toString("base64");
    vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...c.response, action: {...c.response.action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}, transactionRequest: {data: tampered}})));
    const reasons: string[] = [];
    expect(await lifiProvider().getQuote({...c.params, slippageBps: 300, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons[0]).toMatch(/^lifi: the Solana transaction transfers SOL to \w+, which is neither the sender nor LI\.FI's fee wallet$/);
    expect(lifiVerifyQuote(c.params, asQuote(tampered))).toMatch(/transfers SOL to/);
    // Paid by another account: refused for every bridge.
    expect(lifiVerifyQuote({...params, refundAddress: "Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS"}, asQuote(DEPOSIT_WIRE))).toMatch(/is paid by HAgk14/);
  });

  it("asks LI.FI for every bridge from Solana and passes a route policy's choice through, Relay included; EVM still denies Relay and Garden", async () => {
    const urls: URL[] = [];
    const bodies: {options?: {bridges?: unknown}}[] = [];
    let offered: string[] = [];
    const routes = {routes: ["relaydepository", "mayan"].map((tool) => ({toAmount: "9000000", toAmountMin: "8955000", steps: [{tool, estimate: {executionDuration: 5}}]}))};
    vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
      const url = new URL(String(u));
      urls.push(url);
      if (url.pathname.endsWith("/advanced/routes")) { bodies.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify(routes)); }
      return new Response(JSON.stringify(answer(DEPOSIT_WIRE, "relaydepository")));
    });
    await lifiProvider().getQuote(params);
    expect(urls[0]!.searchParams.getAll("allowBridges")).toEqual([]);
    expect(urls[0]!.searchParams.getAll("denyBridges")).toEqual([]);
    expect(await lifiProvider({chooseRoute: (r) => { offered = r.map((o) => o.tool); return {allowBridges: ["relaydepository"]}; }}).getQuote(params)).not.toBeNull();
    expect(bodies[0]!.options!.bridges).toBeUndefined();
    expect(offered).toEqual(["relaydepository", "mayan"]);
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual(["relaydepository"]);
    expect(urls.at(-1)!.searchParams.getAll("denyBridges")).toEqual([]);

    // From an EVM chain the deny list stays (the Diamond check refuses Relay's and Garden's calls by name).
    urls.length = 0; bodies.length = 0;
    const evm = {...params, sourceChain: "eip155:42161", sourceToken: "ETH", refundAddress: `0x${"11".repeat(20)}`};
    await lifiProvider({chooseRoute: (r) => { offered = r.map((o) => o.tool); return {allowBridges: ["relaydepository", "mayan"]}; }}).getQuote(evm);
    expect(bodies[0]!.options!.bridges).toEqual({deny: ["relaydepository", "garden", "squid", "symbiosis", "lifiIntents"]});
    expect(offered).toEqual(["mayan"]);
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual(["mayan"]);
    expect(urls.at(-1)!.searchParams.getAll("denyBridges")).toEqual(["relaydepository", "garden", "squid", "symbiosis", "lifiIntents"]);
  });
});
