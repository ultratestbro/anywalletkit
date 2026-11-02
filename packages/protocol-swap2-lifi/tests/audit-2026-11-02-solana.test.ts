// A LI.FI Solana → EVM bridge: the API's metadata (action.toAddress) said the user's recipient, but nothing read the
// bytes the wallet signs for it, and the engine asked the account only for a SOL-out ceiling. Now Solana sources are
// quoted through Mayan only (its orders carry the recipient), the provider and the remote pin refuse a transaction that
// visibly is no bridge, and the engine hands the account `bridgeOut` {destChain, recipient} to prove.
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
// ONE instruction: a System transfer of 50_000_000 lamports from SOL_SENDER to Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS.
const THEFT_WIRE = "AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAQABA/A2J2JGp1ud4zSe1CsV4jL2UY/CD1/NTx1k6B+b0lj32gdcsv9exoF2E95TC2kqhzVHd2naR0MMvYFUM1xKgycAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIO/U8lswd7/sEOI0dsqBqnwiY65qQYRV3sGKjeiQHhbAQICAAEMAgAAAIDw+gIAAAAAAA==";

type Live = {name: string; params: QuoteParams; response: {tool?: string; transactionRequest?: {data?: string}}};
const live = (JSON.parse(readFileSync(new URL("./fixtures-live-2026-11-02.json", import.meta.url), "utf8")) as {corridors: Live[]}).corridors
  .filter((c) => c.params.sourceChain === "solana:mainnet");

const forged = () => ({
  type: "lifi", id: "q-evil", tool: "mayanFastMCTP",
  action: {
    fromToken: {address: SOL_NATIVE, chainId: SOL_CHAIN}, toToken: {address: BASE_USDC, chainId: 8453},
    fromAmount: "50000000", fromChainId: SOL_CHAIN, toChainId: 8453, slippage: 0.005,
    fromAddress: SOL_SENDER, toAddress: RECIPIENT,
  },
  estimate: {fromAmount: "50000000", toAmount: "9000000", toAmountMin: "8955000", executionDuration: 30},
  transactionRequest: {data: THEFT_WIRE},
});
const params = {sourceChain: "solana:mainnet", sourceToken: "SOL", destChain: "eip155:8453", destToken: BASE_USDC, amountIn: "50000000",
  destAddress: RECIPIENT, refundAddress: SOL_SENDER, slippageBps: 50, dry: false};

function account(sender: string, seen: {wire: string; expect: unknown}[]) {
  return {
    chain: "solana:mainnet",
    getAddress: async () => sender,
    getBalance: async () => 10_000_000_000n,
    sendTransaction: async () => { throw new Error("must not send a plain tx"); },
    transfer: async () => { throw new Error("must not transfer"); },
    sendSerializedTransaction: async (wire: string, expect: unknown) => { seen.push({wire, expect}); return {hash: "5".repeat(87)}; },
  };
}

describe("audit 2026-11-02: a LI.FI bridge out of Solana is bound to the reviewed recipient", () => {
  it("a serialized transaction that only pays another wallet is refused by the provider, the remote pin and the engine", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(forged())));
    const reasons: string[] = [];
    expect(await lifiProvider().getQuote({...params, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons).toEqual(["lifi: the Solana transaction transfers SOL to Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS, which is neither the sender nor LI.FI's fee wallet"]);
    const quote = {provider: "lifi", intentId: `lifi:${SOL_CHAIN}:8453`, depositAddress: "", depositMemo: null, sourceAmount: "50000000", destAmount: "9000000",
      minDestAmount: "8955000", feeUsd: 0, etaSeconds: 30, reliability: 1, validUntilMs: Date.now() + 1000, txRequest: {serializedTx: THEFT_WIRE, value: "50000000"}};
    expect(lifiVerifyQuote(params, quote)).toMatch(/transfers SOL to Fg6Pa/);

    const seen: {wire: string; expect: unknown}[] = [];
    const p = new LifiSwap2Protocol(account(SOL_SENDER, seen) as never, {fromChain: "solana:mainnet"});
    await expect(p.swap2({fromToken: "SOL", toToken: BASE_USDC, toChain: "eip155:8453", recipient: RECIPIENT, fromTokenAmount: 50_000_000n, minAmountOut: 1n})).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("a live Mayan route reaches the account with the destination chain and the recipient to prove", async () => {
    const c = live.find((k) => k.name === "w-sol-base-usdc-mayan")!;
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(c.response)));
    const seen: {wire: string; expect: unknown}[] = [];
    const p = new LifiSwap2Protocol(account(c.params.refundAddress!, seen) as never, {fromChain: "solana:mainnet"});
    await p.swap2({fromToken: "SOL", toToken: BASE_USDC, toChain: "eip155:8453", recipient: RECIPIENT, fromTokenAmount: BigInt(c.params.amountIn), minAmountOut: 1n});
    expect(seen).toHaveLength(1);
    expect(seen[0]!.wire).toBe(c.response.transactionRequest!.data);
    expect(seen[0]!.expect).toEqual({maxValueOut: (BigInt(c.params.amountIn) + 20_000_000n).toString(), bridgeOut: {destChain: "eip155:8453", recipient: RECIPIENT, destToken: BASE_USDC, minAmountOut: "46516587", destDecimals: 6}});
  });

  it("asks LI.FI for Mayan routes only from Solana, within whatever a route policy chose", async () => {
    const urls: URL[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", async (u: URL | string, init?: RequestInit) => {
      const url = new URL(String(u));
      urls.push(url);
      if (url.pathname.endsWith("/advanced/routes")) { bodies.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify({routes: []})); }
      return new Response(JSON.stringify(forged()));
    });
    await lifiProvider().getQuote(params);
    expect(urls[0]!.searchParams.getAll("allowBridges")).toEqual(["mayan", "mayanMCTP", "mayanFastMCTP"]);
    await lifiProvider({chooseRoute: () => ({allowBridges: ["near", "mayanFastMCTP"]})}).getQuote(params);
    expect(bodies[0]).toMatchObject({options: {bridges: {allow: ["mayan", "mayanMCTP", "mayanFastMCTP"]}}});
    // The routes call answered nothing usable: LI.FI's pick within the Mayan routes.
    expect(urls.at(-1)!.searchParams.getAll("allowBridges")).toEqual(["mayan", "mayanMCTP", "mayanFastMCTP"]);
  });

  it("the live Solana answers of 2026-11-02: Mayan passes provider and pin; NEAR Intents, LayerSwap, Relay and LI.FI Intents are refused", async () => {
    const got: Record<string, string> = {};
    for (const c of live) {
      // Recorded at 0.5 %; Mayan's two-step SOL routes then sit under the floor and the provider would re-quote. The
      // recorded answer stands in for that re-quote, echoing the slippage asked.
      vi.stubGlobal("fetch", async (u: URL) => new Response(JSON.stringify({...c.response, action: {...(c.response as {action: object}).action, slippage: Number(new URL(String(u)).searchParams.get("slippage"))}})));
      const reasons: string[] = [];
      const quote = await lifiProvider().getQuote({...c.params, slippageBps: 300, onRefusal: (r) => reasons.push(r)});
      got[c.name] = quote ? `pass${lifiVerifyQuote(c.params, quote) === null ? "" : " but pin refused"}` : reasons[0]!.replace(/ to [1-9A-HJ-NP-Za-km-z]{32,44},/, " to …,");
    }
    const tool = (name: string) => live.find((c) => c.name === name)!.response.tool!;
    for (const [name, outcome] of Object.entries(got)) {
      if (tool(name).startsWith("mayan")) expect([name, outcome]).toEqual([name, "pass"]);
      else expect([name, outcome]).toEqual([name, expect.stringMatching(/^lifi: the Solana transaction (calls no Mayan bridge program|transfers SOL to …, which is neither)/)]);
    }
    expect(Object.values(got).filter((o) => o === "pass")).toHaveLength(10);
  });
});
