/**
 * Tron as a SOURCE: a plain TRX send / TRC-20 transfer to the inbound vault
 * with the canonical memo attached on-chain. No router; the memo and the
 * vault are the whole execution, so both are pinned end to end.
 */
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";
import {thorchainProvider} from "../src/provider.js";
import type {Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swidge-core/types";

const NODE = "https://thor.invalid";
const TRON = "tron:728126428";
const TRON_VAULT = "TAewdzzZPbA8bUUoDqo1Ygh5CbCuq2hrLD";
const TRON_VAULT_ROTATED = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ETH_VAULT = "0x1111111111111111111111111111111111111111";
const ETH_ROUTER = "0xd37bbe5744d730a1d98d8dc97c42f0ca46ad7146";
const ETH_DEST = "0x9999999999999999999999999999999999999999";
const NATIVE = "0x0000000000000000000000000000000000000000";

const AMOUNT_TRX = "100000000000"; // 100 000 TRX in sun — exactly representable in 1e8 units
const AMOUNT_USDT = "50000000"; // 50 USDT (6 dp)
const LIMIT_WEI_1E8 = "2014026"; // ETH in 1e8 units

interface Gateway {quote: Record<string, unknown> | null; status: number; inbounds: Record<string, unknown>[] | null; urls: string[]}
let gw: Gateway;

const inbound = (tron: Record<string, unknown> = {}) => [
  {chain: "TRON", address: TRON_VAULT, halted: false, dust_threshold: "10000000", ...tron},
  {chain: "ETH", address: ETH_VAULT, router: ETH_ROUTER, halted: false, dust_threshold: "1000"},
];
const quoteBody = (memo: string, extra: Record<string, unknown> = {}) => ({
  expected_amount_out: "2061155",
  inbound_address: TRON_VAULT,
  memo,
  expiry: Math.floor(Date.now() / 1000) + 3600,
  recommended_min_amount_in: "1136204700",
  ...extra,
});
const params = (o: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: TRON, sourceToken: "USDT", destChain: "eip155:1", destToken: NATIVE,
  amountIn: AMOUNT_USDT, destAddress: ETH_DEST, ...o,
});

beforeEach(() => {
  gw = {quote: quoteBody(`=:e:${ETH_DEST}:${LIMIT_WEI_1E8}`), status: 200, inbounds: inbound(), urls: []};
  vi.stubGlobal("fetch", async (input: string | URL) => {
    const url = String(input);
    if (url.includes("/quote/swap")) {
      gw.urls.push(url);
      return new Response(JSON.stringify(gw.quote), {status: gw.status});
    }
    if (url.includes("/inbound_addresses")) {
      return gw.inbounds ? new Response(JSON.stringify(gw.inbounds)) : new Response("down", {status: 503});
    }
    return new Response("nope", {status: 404});
  });
});
afterEach(() => vi.unstubAllGlobals());

const on = () => thorchainProvider({nodeUrl: NODE, tronSource: true});

describe("Tron source via inbound vault + memo", () => {
  it("is dark by default: no quote, no build, no preflight", async () => {
    const off = thorchainProvider({nodeUrl: NODE});
    await expect(off.getQuote(params())).resolves.toBeNull();
    expect(gw.urls).toHaveLength(0);
    const q = (await on().getQuote(params()))!;
    await expect(off.buildDeposit(q)).rejects.toThrow(/opted-in Tron/);
    await expect(off.preflightDeposit!(q, {chain: TRON, to: TRON_VAULT, value: AMOUNT_USDT, memo: q.depositMemo!})).rejects.toThrow(/no executor/);
  });

  it("returns a deposit-address quote bound to the vault and the canonical memo", async () => {
    const q = await on().getQuote(params());
    expect(q).not.toBeNull();
    expect(q!.txRequest).toBeUndefined();
    expect(q!.depositAddress).toBe(TRON_VAULT);
    expect(q!.depositMemo).toBe(`=:ETH.ETH:${ETH_DEST}:${LIMIT_WEI_1E8}`); // not the gateway's "=:e:" spelling
    expect(q!.intentId).toBe("thorchain:TRON");
    expect(q!.minDestAmount).toBe("20140260000000000");
    expect(q!.providerData).toMatchObject({sourceChain: TRON, inboundAddress: TRON_VAULT, router: "", assetAddress: TRON_USDT, memo: q!.depositMemo});
    expect(new URL(gw.urls[0]!).searchParams.get("from_asset")).toBe("TRON.USDT-TR7NHQJEKQXGTCI8Q8ZY4PL8OTSZGJLJ6T");
  });

  it("quotes native TRX with the zero-address asset marker", async () => {
    gw.quote = quoteBody(`=:e:${ETH_DEST}:${LIMIT_WEI_1E8}`, {recommended_min_amount_in: "494088900"});
    const q = await on().getQuote(params({sourceToken: "TRX", amountIn: AMOUNT_TRX}));
    expect(q?.providerData?.assetAddress).toBe(NATIVE);
    expect(new URL(gw.urls[0]!).searchParams.get("from_asset")).toBe("TRON.TRX");
  });

  it("refuses a Tron quote that carries a router (execution model changed upstream)", async () => {
    gw.quote = quoteBody(`=:e:${ETH_DEST}:${LIMIT_WEI_1E8}`, {router: ETH_ROUTER});
    await expect(on().getQuote(params())).resolves.toBeNull();
  });

  it("refuses when the inbound vault differs, is halted, or cannot be fetched", async () => {
    gw.inbounds = inbound({address: TRON_VAULT_ROTATED});
    await expect(on().getQuote(params())).resolves.toBeNull();
    gw.inbounds = inbound({halted: true});
    await expect(on().getQuote(params())).resolves.toBeNull();
    gw.inbounds = null;
    await expect(on().getQuote(params())).resolves.toBeNull();
  });

  it("fails closed on dust and on amounts below THORChain's recommended minimum", async () => {
    const reasons: string[] = [];
    // 50 USDT = 5 000 000 000 (1e8) ≥ 1 136 204 700 recommended → ok
    await expect(on().getQuote(params({onRefusal: (r) => reasons.push(r)}))).resolves.not.toBeNull();
    // 5 USDT = 500 000 000 < recommended → refused
    await expect(on().getQuote(params({amountIn: "5000000", onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    // 0.1 USDT = 10 000 000 == dust threshold → refused
    gw.quote = quoteBody(`=:e:${ETH_DEST}:${LIMIT_WEI_1E8}`, {recommended_min_amount_in: "1"});
    await expect(on().getQuote(params({amountIn: "100000", onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: amount below THORChain recommended minimum", "thorchain: amount at or below THORChain dust threshold"]);
  });

  it("surfaces the node's own rejection through onRefusal", async () => {
    const reasons: string[] = [];
    gw.status = 400;
    gw.quote = {code: 3, message: "failed to simulate swap: pool TRON.USDT is halted"};
    await expect(on().getQuote(params({onRefusal: (r) => reasons.push(r)}))).resolves.toBeNull();
    expect(reasons).toEqual(["thorchain: failed to simulate swap: pool TRON.USDT is halted"]);
  });

  it("still applies the memo shape gate to Tron quotes", async () => {
    gw.quote = quoteBody(`=:e:${ETH_DEST}:${LIMIT_WEI_1E8}/3/0`);
    await expect(on().getQuote(params())).resolves.toBeNull();
    gw.quote = quoteBody(`=:e:0x8888888888888888888888888888888888888888:${LIMIT_WEI_1E8}`);
    await expect(on().getQuote(params())).resolves.toBeNull();
  });

  describe("build + preflight", () => {
    let provider: ReturnType<typeof thorchainProvider>;
    let quote: Quote;
    let tx: UnsignedTx;
    beforeEach(async () => {
      provider = on();
      quote = (await provider.getQuote(params()))!;
      tx = await provider.buildDeposit(quote);
    });

    it("builds a plain send of the exact amount to the vault with the memo, on the source chain", async () => {
      expect(tx).toEqual({chain: TRON, to: TRON_VAULT, value: AMOUNT_USDT, memo: quote.depositMemo});
      await expect(provider.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
    });

    it("rejects a send whose memo, destination or amount drifted", async () => {
      await expect(provider.preflightDeposit!(quote, {...tx, memo: `=:ETH.ETH:${ETH_DEST}:1`})).rejects.toThrow(/does not match/);
      await expect(provider.preflightDeposit!(quote, {...tx, to: TRON_VAULT_ROTATED})).rejects.toThrow(/does not match/);
      await expect(provider.preflightDeposit!(quote, {...tx, value: "49999999"})).rejects.toThrow(/does not match/);
      const {memo: _m, ...noMemo} = tx;
      await expect(provider.preflightDeposit!(quote, noMemo)).rejects.toThrow(/does not match/);
    });

    it("rejects any execution payload other than a plain send", async () => {
      await expect(provider.preflightDeposit!(quote, {...tx, data: "0xa9059cbb"})).rejects.toThrow(/plain send/);
      await expect(provider.preflightDeposit!(quote, {...tx, approvalAddress: TRON_USDT})).rejects.toThrow(/plain send/);
      await expect(provider.preflightDeposit!(quote, {...tx, bodyBoc: "te6"})).rejects.toThrow(/plain send/);
      await expect(provider.preflightDeposit!(quote, {...tx, chain: "eip155:1"})).rejects.toThrow(/does not match/);
    });

    it("rejects when the vault rotated or the chain halted before broadcast", async () => {
      gw.inbounds = inbound({address: TRON_VAULT_ROTATED});
      await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/vault rotated/);
      gw.inbounds = inbound({chain_trading_paused: true});
      await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/paused/);
      gw.inbounds = inbound({dust_threshold: "5000000000"});
      await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow(/dust/);
    });

    it("rejects an expired quote", async () => {
      const expired = {...quote, providerData: {...quote.providerData!, expiry: String(Math.floor(Date.now() / 1000) - 1)}};
      await expect(provider.preflightDeposit!(expired, tx)).rejects.toThrow(/expired/);
    });
  });
});
