// Review r2 of the EVM → Solana change (2026-11-13): a dry quote priced for a placeholder keeps only its price — no
// `txRequest` — and with it went `txRequest.nativeFee`, the native coin a bridge charges on top of the input (LayerZero's
// fee on Stargate, Arbitrum's retryable submission). The router's `usdValue` nets that fee out of a route's value, so in
// a dry auction without the sender (what a web app sends before a wallet is connected) a LI.FI route with a fee was
// valued on its gross output and could be tagged best. The price-only quote now declares the fee as
// `providerData.nativeFee`, which `usdValue` / `quoteValues` read when there is no transaction
// (@anywalletkit/protocol-swap2-router), and `lifiVerifyQuote` holds it to a base-unit integer.
// Live (2026-11-13, keyless li.quest/v1/quote, read-only): Base USDC → Arbitrum USDC through Stargate V2, dry without the
// sender: before, a price-only quote worth $99.19 (its minimum); now it declares 643262755910452 wei and is worth $97.26
// at ETH $3000 (fixtures-live-2026-11-13-evm-intents.json, `priceOnly`).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {lifiPins, lifiProvider, lifiVerifyQuote} from "../src/provider.js";

afterEach(() => vi.unstubAllGlobals());

type Answer = {tool?: string; action: {fromAddress: string; fromAmount: string}; transactionRequest: {value: string; data: string}};
type Corridor = {name: string; params: QuoteParams; response: Answer};
const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const stargate = (read("./fixtures-live-2026-11-13-evm-intents.json") as {priceOnly: Corridor}).priceOnly;
const nov02 = (read("./fixtures-live-2026-11-02.json") as {corridors: Corridor[]}).corridors;
const arbitrum = nov02.find((c) => c.name === "evm-eth-eth-arb-eth")!; // native ETH in, Arbitrum's retryable fee in value
const polymer = nov02.find((c) => c.name === "evm-base-usdc-arb-usdc")!; // no fee

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

function replay(answer: unknown) {
  vi.stubGlobal("fetch", async (u: URL | string) => {
    const url = new URL(String(u));
    const a = answer as {action: object};
    return new Response(JSON.stringify({...a, action: {...a.action, slippage: Number(url.searchParams.get("slippage"))}}));
  });
}
async function quote(answer: unknown, params: QuoteParams) {
  replay(answer);
  const reasons: string[] = [];
  const q = await lifiProvider().getQuote({...params, onRefusal: (r) => reasons.push(r)});
  return {q, reasons};
}
const noSender = (params: QuoteParams): QuoteParams => { const {refundAddress: _r, ...rest} = params; return {...rest, dry: true}; };

describe("a price-only LI.FI quote declares its native bridge fee (providerData.nativeFee)", () => {
  it("live Stargate V2 (token in): the LayerZero fee, the whole value, rides as providerData.nativeFee — the same figure a quote with a transaction declares", async () => {
    expect(stargate.response.tool).toBe("stargateV2");
    expect(stargate.response.action.fromAddress).toBe(EVM_PLACEHOLDER);
    const params = stargate.params;
    expect(params.refundAddress).toBeUndefined();
    const {q, reasons} = await quote(stargate.response, params);
    expect(reasons).toEqual([]);
    expect(q!.txRequest).toBeUndefined();
    expect(q!.providerData).toEqual({placeholder: "sender", nativeFee: BigInt(stargate.response.transactionRequest.value).toString()});
    expect(q!.providerData!.nativeFee).toBe("643262755910452");
    expect(lifiVerifyQuote(params, q!)).toBeNull();
    // With the sender named (the caller names that same address as its own), the transaction carries the same fee
    // where it always did.
    const full = await quote(stargate.response, {...params, refundAddress: EVM_PLACEHOLDER});
    expect(full.reasons).toEqual([]);
    expect(full.q!.txRequest!.nativeFee).toBe(q!.providerData!.nativeFee);
    expect(full.q!.providerData).toBeUndefined();
  });

  it("native ETH in (Arbitrum bridge, 2026-11-02): the fee is what the value adds to the input", async () => {
    const params = noSender(arbitrum.params);
    const {q, reasons} = await quote(arbitrum.response, params);
    expect(reasons).toEqual([]);
    const fee = BigInt(arbitrum.response.transactionRequest.value) - BigInt(params.amountIn);
    expect(fee).toBe(2995440599200n);
    expect([q!.txRequest, q!.providerData]).toEqual([undefined, {placeholder: "sender", nativeFee: fee.toString()}]);
    expect(lifiVerifyQuote(params, q!)).toBeNull();
  });

  it("a route without a fee declares none", async () => {
    const params = noSender(polymer.params);
    const {q} = await quote(polymer.response, params);
    expect([q!.txRequest, q!.providerData]).toEqual([undefined, {placeholder: "sender"}]);
  });

  it("lifiVerifyQuote: a price-only quote's declared fee must be a base-unit integer (new refusal); absent or digits pass", async () => {
    const params = stargate.params;
    const {q} = await quote(stargate.response, params);
    for (const bad of ["", "-1", "0x10", " 1", "1.5", "1e18", "1".repeat(81)]) {
      const forged = {...q!, providerData: {...q!.providerData!, nativeFee: bad}} as Quote;
      expect([bad, lifiVerifyQuote(params, forged)]).toEqual([bad, `the price-only quote declares a native fee of ${bad.slice(0, 40)}, not a base-unit integer`]);
    }
    expect(lifiVerifyQuote(params, {...q!, providerData: {placeholder: "sender", nativeFee: "0"}})).toBeNull();
    expect(lifiVerifyQuote(params, {...q!, providerData: {placeholder: "sender"}})).toBeNull();
    // The existing price-only checks still run, in their order: a deposit address first.
    expect(lifiVerifyQuote(params, {...q!, depositAddress: "0x9999999999999999999999999999999999999999", providerData: {nativeFee: "x"}}))
      .toBe("a LI.FI quote pays no deposit address, but this one names 0x9999999999999999999999999999999999999999");
  });

  it("the fee survives the swap2 server and remoteProvider + lifiPins (the path a web app's dry auction takes)", async () => {
    replay(stargate.response);
    const handle = createSwap2Handler<string>({providers: [lifiProvider()], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
      return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
    }) as unknown as typeof fetch;
    const stub = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, ...lifiPins});
    const q = await stub.getQuote(stargate.params);
    expect(q?.txRequest).toBeUndefined();
    expect(q?.providerData).toMatchObject({placeholder: "sender", nativeFee: "643262755910452"});
    // A backend that answers with a malformed fee never reaches the auction.
    const evil = remoteProvider({name: "lifi", baseUrl: "https://backend.example/api/v2/swap2", ...lifiPins,
      fetchImpl: (async () => new Response(JSON.stringify({...q!, providerData: {placeholder: "sender", nativeFee: "-643262755910452"}}), {status: 200})) as unknown as typeof fetch});
    await expect(evil.getQuote(stargate.params)).rejects.toThrow("lifi: the quote fails this app's own check — the price-only quote declares a native fee of -643262755910452, not a base-unit integer");
  });
});
