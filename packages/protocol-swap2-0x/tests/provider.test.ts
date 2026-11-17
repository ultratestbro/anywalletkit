import {afterEach, describe, expect, it, vi} from "vitest";
import {readPermit2Transfer, type Quote, type UnsignedTx} from "@anywalletkit/protocol-swap2-core";
import {ZEROEX_CHAINS, ZEROEX_NATIVE, ZEROEX_PERMIT2, ZEROEX_SETTLER_REGISTRY} from "../src/chains.js";
import {ZEROEX_DEFAULT_BASE_URL, zeroExFees, zeroExProvider, type ZeroExProviderConfig} from "../src/provider.js";
import {decodeSettlerExecute} from "../src/settler.js";
import {AMOUNT, DAI, KEY, ME, OLDER_SETTLER, OTHER, OUT, PREV_SETTLER, RPC, SETTLER, USDC, WETH, ZERO, getKey, stub, type ApiStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const BASE = "eip155:8453";
const params = (over: Record<string, unknown> = {}) => ({
  sourceChain: BASE, sourceToken: "USDC", destChain: BASE, destToken: ZERO, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, slippageBps: 100, ...over,
});
type Calls = NonNullable<ApiStub["calls"]>;
/** A provider over a stubbed API and RPC, the refusals it gave, and every request it made. */
function setup(o: ApiStub = {}, config: Partial<ZeroExProviderConfig> = {}) {
  const calls: Calls = [];
  vi.stubGlobal("fetch", stub({...o, calls}));
  const reasons: string[] = [];
  const provider = zeroExProvider({apiKey: getKey, rpcUrls: RPC, ...config});
  const quote = (over: Record<string, unknown> = {}) => provider.getQuote(params({onRefusal: (r: string) => reasons.push(r), ...over}) as never);
  const api = () => calls.filter((c) => c.method === "GET");
  const rpc = () => calls.filter((c) => c.method === "POST");
  return {provider, quote, reasons, calls, api, rpc};
}
const live = {dry: false};

describe("zeroExProvider — routes", () => {
  it("is named zeroex, same-chain only, and serves a chain only when it is in the table and a key is there", () => {
    const p = zeroExProvider({apiKey: getKey});
    expect(p.name).toBe("zeroex");
    expect(p.supportsSameChain).toBe(true);
    expect(p.enabled()).toBe(true);
    expect(zeroExProvider({apiKey: getKey, enabled: false}).enabled()).toBe(false);
    for (const id of [1, 10, 56, 137, 8453, 42161, 43114]) {
      expect(p.supportsChain!(`eip155:${id}`), String(id)).toBe(true);
      expect(p.supportsChainPair!(`eip155:${id}`, `eip155:${id}`)).toBe(true);
    }
    expect(p.supportsChain!("eip155:100")).toBe(false);
    expect(p.supportsChain!("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toBe(false);
    expect(p.supportsChainPair!("eip155:1", "eip155:8453")).toBe(false);
    expect(p.supportsRoute({chain: BASE} as never, {chain: BASE} as never)).toBe(true);
    expect(p.supportsRoute({chain: BASE} as never, {chain: "eip155:1"} as never)).toBe(false);
  });

  it("without a key serves no route and asks nothing", async () => {
    for (const apiKey of [undefined, () => undefined, () => "", () => "has space", () => { throw new Error("vault locked"); }] as ZeroExProviderConfig["apiKey"][]) {
      const s = setup({}, {apiKey});
      expect(s.provider.supportsChain!(BASE)).toBe(false);
      expect(s.provider.supportsRoute({chain: BASE} as never, {chain: BASE} as never)).toBe(false);
      expect(await s.quote()).toBeNull();
      expect(s.reasons).toEqual(["zeroex: no 0x API key is configured"]);
      expect(s.calls).toHaveLength(0);
    }
  });

  it("the chain table is config", () => {
    const p = zeroExProvider({apiKey: getKey, chains: {130: {name: "Unichain", registry: ZEROEX_SETTLER_REGISTRY, newestLiveNonce: 4, previousLiveNonce: 3}, 56: null}});
    expect(p.supportsChain!("eip155:130")).toBe(true);
    expect(p.supportsChain!("eip155:56")).toBe(false);
  });

  it("takes only an https API origin (http on this machine), since the key is sent to it", () => {
    for (const baseUrl of ["http://api.0x.org", "ftp://api.0x.org", "https://user@api.0x.org", "https://api.0x.org?x=1", "api.0x.org", ""]) {
      expect(() => zeroExProvider({apiKey: getKey, baseUrl}), baseUrl).toThrow(/baseUrl must be an https:\/\/ origin/);
    }
    expect(() => zeroExProvider({apiKey: getKey, baseUrl: "http://localhost:8787/zeroex/"})).not.toThrow();
    expect(() => zeroExProvider({apiKey: getKey, baseUrl: "https://proxy.example/zeroex"})).not.toThrow();
  });
});

describe("zeroExProvider — request", () => {
  it("an indicative quote asks /swap/permit2/price with the key in a header only, and reads no chain", async () => {
    const s = setup();
    const q = (await s.quote())!;
    expect(s.reasons).toEqual([]);
    expect(s.rpc()).toHaveLength(0);
    expect(s.api()).toHaveLength(1);
    const call = s.api()[0]!;
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(`${ZEROEX_DEFAULT_BASE_URL}/swap/permit2/price`);
    expect(Object.fromEntries(url.searchParams)).toEqual({chainId: "8453", sellToken: USDC, buyToken: ZEROEX_NATIVE, sellAmount: "1000000", slippageBps: "100", taker: ME});
    expect(call.headers).toEqual({accept: "application/json", "0x-api-key": KEY, "0x-version": "v2"});
    expect(call.url).not.toContain(KEY);
    expect(JSON.stringify(q)).not.toContain(KEY);
    expect(q.txRequest).toBeUndefined();
  });

  it("an indicative quote without any account sends no taker", async () => {
    const s = setup();
    expect(await s.quote({destAddress: undefined, refundAddress: undefined})).not.toBeNull();
    expect(new URL(s.api()[0]!.url).searchParams.has("taker")).toBe(false);
  });

  it("a live quote reads the registry (and the Settlers' code) first, then asks /swap/permit2/quote", async () => {
    const s = setup();
    expect(await s.quote(live)).not.toBeNull();
    expect(s.calls.map((c) => (c.method === "POST" ? (c.body as {method: string}).method : c.method))).toEqual(["eth_call", "eth_getCode", "eth_call", "eth_getCode", "GET"]);
    const url = new URL(s.api()[0]!.url);
    expect(url.pathname).toBe("/swap/permit2/quote");
    expect(url.searchParams.get("taker")).toBe(ME);
    expect(url.searchParams.has("recipient")).toBe(false);
  });

  it("names the recipient only when it is not the taker", async () => {
    const s = setup();
    const q = (await s.quote({...live, destAddress: OTHER}))!;
    const url = new URL(s.api()[0]!.url);
    expect(url.searchParams.get("taker")).toBe(ME);
    expect(url.searchParams.get("recipient")).toBe(OTHER);
    expect(decodeSettlerExecute(q.txRequest!.data!).recipient).toBe(OTHER);
  });

  for (const [id, chain] of Object.entries(ZEROEX_CHAINS)) {
    it(`asks for ${chain.name} by its chain id (${id})`, async () => {
      const s = setup();
      const caip = `eip155:${id}`;
      const q = await s.quote({sourceChain: caip, destChain: caip, sourceToken: DAI, sourceDecimals: 18, destToken: USDC});
      expect(s.reasons).toEqual([]);
      const query = new URL(s.api()[0]!.url).searchParams;
      expect(query.get("chainId")).toBe(id);
      expect(query.get("sellToken")).toBe(DAI);
      expect(query.get("buyToken")).toBe(USDC);
      expect(q!.intentId.startsWith(`zeroex:${id}:`)).toBe(true);
    });
  }

  it("uses the default slippage, a custom origin, and passes excluded sources that look like source names", async () => {
    const s = setup({}, {baseUrl: "https://proxy.example/zeroex/", defaultSlippageBps: 30, excludedSources: ["Uniswap_V2", "bad&name=1", "Curve"]});
    expect(await s.quote({slippageBps: undefined})).not.toBeNull();
    const url = new URL(s.api()[0]!.url);
    expect(url.origin + url.pathname).toBe("https://proxy.example/zeroex/swap/permit2/price");
    expect(url.searchParams.get("slippageBps")).toBe("30");
    expect(url.searchParams.get("excludedSources")).toBe("Uniswap_V2,Curve");
  });

  const refusedBeforeAsking: [string, Record<string, unknown>, string][] = [
    ["a flexible amount", {flex: true}, "amount-flexible deposits are not supported"],
    ["another destination chain", {destChain: "eip155:1"}, "same-chain swaps only"],
    ["a chain outside the table", {sourceChain: "eip155:100", destChain: "eip155:100"}, "0x is not configured for eip155:100"],
    ["an unknown source token", {sourceToken: "NOPE"}, "unknown source token NOPE"],
    ["a destination that is not an address", {destToken: "ETH"}, "destination token must be an EVM address"],
    ["the same token", {destToken: USDC}, "same token in and out"],
    ["native for native", {sourceToken: "ETH", destToken: ZEROEX_NATIVE}, "same token in and out"],
    ["wrapping", {sourceToken: "ETH", destToken: WETH}, "wrapping and unwrapping are not 0x swaps"],
    ["unwrapping", {sourceToken: WETH, sourceDecimals: 18, destToken: ZERO}, "wrapping and unwrapping are not 0x swaps"],
    ["an amount that is not an integer", {amountIn: "1.5"}, "amount is not an integer"],
    ["a zero amount", {amountIn: "0"}, "amount must be positive"],
    ["a negative amount", {amountIn: "-5"}, "amount must be positive"],
    ["slippage of 100%", {slippageBps: 10_000}, "invalid slippage"],
    ["fractional slippage", {slippageBps: 0.5}, "invalid slippage"],
    ["a floor that is not an integer", {minAmountOut: "1e9"}, "minimum output is not an integer"],
    ["a live quote without a recipient", {dry: false, destAddress: "not-an-address"}, "recipient must be an EVM address"],
  ];
  for (const [name, over, why] of refusedBeforeAsking) {
    it(`refuses ${name} without a request`, async () => {
      const s = setup();
      expect(await s.quote(over)).toBeNull();
      expect(s.reasons).toEqual([`zeroex: ${why}`]);
      expect(s.calls).toHaveLength(0);
    });
  }
});

describe("zeroExProvider — indicative quote", () => {
  it("carries the amounts, the minimum, the fees and where the liquidity is", async () => {
    const q = (await setup().quote())!;
    expect(q).toMatchObject({
      provider: "zeroex", depositAddress: "", depositMemo: null, sourceAmount: "1000000", destAmount: OUT.toString(), minDestAmount: "396000000000000",
      feeUsd: 0, etaSeconds: 15,
      providerData: {minOut: "396000000000000", slippageBps: "100", sender: ME, zid: "0x111111111111111111111111", sources: "Uniswap_V3,Aerodrome_V3", issues: "allowance"},
    });
    expect(q.fees).toEqual([
      {type: "protocol", amount: "600000000000", token: "native", included: true, description: "0x fee (taken on-chain, already out of the quoted amount)"},
      {type: "network", amount: "3150000000000", token: "native", included: false, description: "Estimated network fee (gas × gas price, as 0x reports it)"},
    ]);
    expect(q.validUntilMs).toBeGreaterThan(Date.now() + 115_000);
    expect(q.validUntilMs).toBeLessThanOrEqual(Date.now() + 120_000);
    expect(q.providerData).not.toHaveProperty("settler");
  });

  it("quotes a native sale and a token → token swap", async () => {
    const s = setup({out: 2_500_000n});
    const q = (await s.quote({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"}))!;
    expect(new URL(s.api()[0]!.url).searchParams.get("sellToken")).toBe(ZEROEX_NATIVE);
    expect(q.destAmount).toBe("2500000");
    expect(q.fees![0]).toMatchObject({type: "protocol", token: USDC});
    const t = setup({out: 999_000_000_000_000_000n});
    expect((await t.quote({destToken: DAI}))!.minDestAmount).toBe("989010000000000000");
    expect(t.reasons).toEqual([]);
  });

  it("accepts the 0xEeee… spelling of the native coin as the token bought", async () => {
    const s = setup();
    expect(await s.quote({destToken: ZEROEX_NATIVE})).not.toBeNull();
    expect(new URL(s.api()[0]!.url).searchParams.get("buyToken")).toBe(ZEROEX_NATIVE);
  });
});

describe("zeroExProvider — refusals of what the API answers", () => {
  const cases: [string, ApiStub, string | RegExp, Record<string, unknown>?][] = [
    ["no liquidity", {tamper: () => ({liquidityAvailable: false})}, "no liquidity for this pair and amount"],
    ["an answer without the liquidity flag", {tamper: (b) => ({...b, liquidityAvailable: "yes"})}, "malformed API response (liquidity)"],
    ["a body that is not JSON", {raw: "<html>gateway</html>"}, "malformed API response"],
    ["a body that is an array", {raw: "[]"}, "malformed API response"],
    ["an oversized body", {raw: `{"x":"${"a".repeat(600_001)}"}`}, "the API answer is larger than any quote"],
    ["an exact-output quote", {tamper: (b) => ({...b, mode: "exact-out"})}, "the API answered a quote that is not exact-input"],
    ["another sell token", {tamper: (b) => ({...b, sellToken: DAI.toLowerCase()})}, "the API quoted other tokens than the ones asked for"],
    ["another buy token", {tamper: (b) => ({...b, buyToken: USDC.toLowerCase()})}, "the API quoted other tokens than the ones asked for"],
    ["amounts that are not integers", {tamper: (b) => ({...b, buyAmount: "4e14"})}, "malformed quote amounts"],
    ["numeric amounts", {tamper: (b) => ({...b, minBuyAmount: 396000000000000})}, "malformed quote amounts"],
    ["a larger sell amount", {tamper: (b) => ({...b, sellAmount: "2000000"})}, "quoted 2000000, not the requested 1000000"],
    ["a zero minimum", {tamper: (b) => ({...b, minBuyAmount: "0"})}, "the quoted minimum is not between zero and the quoted output"],
    ["a minimum above the output", {tamper: (b) => ({...b, minBuyAmount: (OUT + 1n).toString()})}, "the quoted minimum is not between zero and the quoted output"],
    ["a minimum below the requested slippage", {tamper: (b) => ({...b, minBuyAmount: "380000000000000"})}, /^zeroex: the quoted minimum 380000000000000 is below the requested slippage \(100 bps of 400000000000000\)$/],
    ["a minimum below the caller's floor", {}, "floor breach (min=396000000000000 < floor=399000000000000)", {minAmountOut: "399000000000000"}],
    ["a buy token that taxes buys", {tamper: (b) => ({...b, tokenMetadata: {buyToken: {buyTaxBps: "300", sellTaxBps: "0", transferTaxBps: "0"}, sellToken: {}}})}, "the token being bought taxes transfers — the amount received cannot be guaranteed"],
    ["a buy token that taxes transfers", {tamper: (b) => ({...b, tokenMetadata: {buyToken: {buyTaxBps: null, transferTaxBps: 100}}})}, "the token being bought taxes transfers — the amount received cannot be guaranteed"],
    ["a tax that cannot be read", {tamper: (b) => ({...b, tokenMetadata: {buyToken: {buyTaxBps: "lots"}}})}, "malformed API response (token tax)"],
    ["missing fees", {tamper: ({fees: _, ...b}) => b}, "the quote's fees are missing"],
    ["fees that do not say what 0x charges", {tamper: (b) => ({...b, fees: {integratorFee: null, gasFee: null}})}, "the quote does not say what 0x charges"],
    ["a 0x fee without a token", {tamper: (b) => ({...b, fees: {...b.fees, zeroExFee: {amount: "5"}}})}, "the 0x fee cannot be read"],
    ["a 0x fee that is not an integer", {zeroExFee: {amount: "0.15", token: USDC}}, "the 0x fee cannot be read"],
    ["an integrator fee", {tamper: (b) => ({...b, fees: {...b.fees, integratorFee: {amount: "1000", token: USDC, type: "volume"}}})}, "the quote carries an integrator fee this wallet did not ask for"],
    ["an integrator fee in the list form", {tamper: (b) => ({...b, fees: {...b.fees, integratorFees: [{amount: "1", token: USDC}]}})}, "the quote carries an integrator fee this wallet did not ask for"],
    ["an unreadable integrator fee", {tamper: (b) => ({...b, fees: {...b.fees, integratorFee: "none"}})}, "the integrator fee cannot be read"],
    ["an unreadable gas fee", {tamper: (b) => ({...b, fees: {...b.fees, gasFee: {amount: "x", token: USDC}}})}, "the gas fee cannot be read"],
    ["an unreadable network fee", {tamper: (b) => ({...b, totalNetworkFee: "0x12"})}, "the network fee cannot be read"],
    ["an unreadable gas estimate", {tamper: (b) => ({...b, totalNetworkFee: null, gas: "many"})}, "the gas estimate cannot be read"],
    ["an allowance asked for another spender", {tamper: (b) => ({...b, issues: {...b.issues, allowance: {actual: "0", spender: OTHER}}})}, "the API asks for an allowance to something other than canonical Permit2"],
    ["an allowance target that is not Permit2", {tamper: (b) => ({...b, allowanceTarget: SETTLER})}, "the API asks for an allowance to something other than canonical Permit2"],
    ["a token allowance on a native sale", {tamper: (b) => ({...b, allowanceTarget: OTHER})}, "the API asks for a token allowance on a native-coin sale", {sourceToken: "ETH", destToken: USDC}],
    ["an excluded source 0x does not know (it would not be excluded)", {tamper: (b) => ({...b, issues: {...b.issues, invalidSourcesPassed: ["NotARealSource_xyz"]}})}, "0x does not know the excluded source NotARealSource_xyz — they would not be excluded"],
    ["several excluded sources 0x does not know, names it cannot show left out", {tamper: (b) => ({...b, issues: {...b.issues, invalidSourcesPassed: ["Uni_V9", "<b>", "Curve_X", "A", "B"]}})}, "0x does not know the excluded sources Uni_V9, Curve_X, A and more — they would not be excluded"],
  ];
  for (const [name, o, why, over] of cases) {
    it(`refuses ${name}`, async () => {
      const s = setup(o);
      expect(await s.quote(over)).toBeNull();
      expect(s.reasons).toHaveLength(1);
      if (typeof why === "string") expect(s.reasons[0]).toBe(`zeroex: ${why}`);
      else expect(s.reasons[0]).toMatch(why);
    });
  }

  const errors: [string, ApiStub, string][] = [
    ["a named 0x error", {http: 400, error: {name: "TOKEN_NOT_SUPPORTED", message: "x", data: {zid: "0x1"}}}, "0x does not support one of these tokens (TOKEN_NOT_SUPPORTED)"],
    ["an invalid-input error", {http: 400, error: {name: "INPUT_INVALID", message: "x"}}, "0x rejected the request as invalid (INPUT_INVALID)"],
    ["an account 0x does not serve", {http: 403, error: {name: "TAKER_NOT_AUTHORIZED_FOR_TRADE"}}, "0x does not serve this account (TAKER_NOT_AUTHORIZED_FOR_TRADE)"],
    ["a rejected key", {http: 401, error: {message: "Invalid API key"}}, "API key rejected (HTTP 401)"],
    ["a forbidden key", {http: 403, error: {}}, "API key rejected (HTTP 403)"],
    ["a rate limit", {http: 429, error: {message: "Too many"}}, "rate limited (HTTP 429)"],
    ["a server error", {http: 502, error: {}}, "API answered HTTP 502"],
    ["an error name it does not know (never echoed)", {http: 400, error: {name: `<script>${KEY}</script>`}}, "API answered HTTP 400"],
    ["a prototype name as the error", {http: 400, error: {name: "constructor"}}, "API answered HTTP 400"],
  ];
  for (const [name, o, why] of errors) {
    it(`reports ${name}`, async () => {
      const s = setup(o);
      expect(await s.quote()).toBeNull();
      expect(s.reasons).toEqual([`zeroex: ${why}`]);
    });
  }

  it("reports an unreachable API by error name only — never the URL or the key", async () => {
    vi.stubGlobal("fetch", (async () => { throw new TypeError(`fetch failed for https://api.0x.org/?k=${KEY}`); }) as never);
    const reasons: string[] = [];
    expect(await zeroExProvider({apiKey: getKey}).getQuote(params({onRefusal: (r: string) => reasons.push(r)}) as never)).toBeNull();
    expect(reasons).toEqual(["zeroex: API unreachable (TypeError)"]);
  });

  it("stops when the caller aborts", async () => {
    const s = setup();
    const c = new AbortController();
    c.abort();
    vi.stubGlobal("fetch", (async (_: unknown, init: {signal: AbortSignal}) => { if (init.signal.aborted) throw new DOMException("aborted", "AbortError"); return new Response("{}"); }) as never);
    expect(await s.provider.getQuote(params({onRefusal: (r: string) => s.reasons.push(r)}) as never, c.signal)).toBeNull();
    expect(s.reasons).toEqual(["zeroex: API unreachable (AbortError)"]);
  });
});

describe("zeroExFees", () => {
  const base = {fees: {integratorFee: null, integratorFees: null, zeroExFee: null, gasFee: null}, totalNetworkFee: null};
  it("no 0x fee and no gas figure: no fee entries, and the network fee is marked unknown", () => {
    expect(zeroExFees(base, {gas: null, gasPrice: null})).toEqual({fees: [], networkFeeKnown: false});
  });
  it("falls back to gas × gas price when 0x gives no total", () => {
    expect(zeroExFees(base, {gas: "200000", gasPrice: "1000000000"})).toEqual({fees: [{type: "network", amount: "200000000000000", token: "native", included: false, description: "Estimated network fee (gas × gas price, as 0x reports it)"}], networkFeeKnown: true});
  });
  it("shows a 0x fee in the sell token, a gas fee taken inside the trade, and zero-amount integrator entries as nothing", () => {
    const r = zeroExFees({fees: {zeroExFee: {amount: "1500", token: USDC.toLowerCase(), type: "volume"}, integratorFee: {amount: "0", token: USDC}, integratorFees: [{amount: "0", token: USDC}], gasFee: {amount: "20", token: ZEROEX_NATIVE}}, totalNetworkFee: "7"}, {gas: null, gasPrice: null});
    expect(r).toEqual({networkFeeKnown: true, fees: [
      {type: "protocol", amount: "1500", token: USDC, included: true, description: "0x fee (taken on-chain, already out of the quoted amount)"},
      {type: "network", amount: "20", token: "native", included: true, description: "Gas charged by 0x inside the trade"},
      {type: "network", amount: "7", token: "native", included: false, description: "Estimated network fee (gas × gas price, as 0x reports it)"},
    ]});
  });
  it("a zero 0x fee is no entry; a quote marks an unknown network fee in providerData", async () => {
    const s = setup({zeroExFee: {amount: "0", token: USDC}, tamper: ({gas: _g, gasPrice: _p, ...b}) => ({...b, totalNetworkFee: null})});
    const q = (await s.quote())!;
    expect(q.fees).toEqual([]);
    expect(q.providerData!.networkFee).toBe("unknown");
  });
});

describe("zeroExProvider — live quote (what will be signed)", () => {
  it("a token sale carries the Settler call, the Permit2 allowance target and the rebuilt typed data", async () => {
    const s = setup();
    const q = (await s.quote(live))!;
    expect(s.reasons).toEqual([]);
    const tx = q.txRequest!;
    expect(tx).toMatchObject({to: SETTLER, value: "0", chainId: 8453, gasLimit: "272000", approvalAddress: ZEROEX_PERMIT2});
    expect(q.providerData).toMatchObject({settler: SETTLER, sender: ME});
    const e = decodeSettlerExecute(tx.data!);
    expect(e).toMatchObject({recipient: ME, buyToken: ZEROEX_NATIVE, minAmountOut: 396_000_000_000_000n});
    // the payload handed to the signer is the locally rebuilt one: exactly this swap's token, amount and spender
    const permit = readPermit2Transfer(tx.permit2Transfer!, {chainId: 8453, token: USDC, amount: AMOUNT, spender: SETTLER});
    expect(Object.keys(JSON.parse(tx.permit2Transfer!) as object).sort()).toEqual(["domain", "message", "primaryType", "types"]);
    // the quote lapses before the signature does
    expect(BigInt(q.validUntilMs)).toBeLessThanOrEqual(permit.deadline * 1000n - 20_000n);
    expect(q.validUntilMs).toBeGreaterThan(Date.now());
  });

  it("a native sale is accepted with 0x's allowance target (canonical Permit2, as every real answer names it) and asks for no allowance", async () => {
    const s = setup({tamper: (b) => { expect(b.allowanceTarget).toBe(ZEROEX_PERMIT2); expect(b.permit2).toBeNull(); return b; }});
    const q = await s.quote({...live, sourceToken: "ETH", destToken: USDC});
    expect(s.reasons).toEqual([]);
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    expect(q!.txRequest!.permit2Transfer).toBeUndefined();
    expect(q!.txRequest!.value).toBe(AMOUNT.toString());
  });

  it("a native sale carries value = the amount sold and neither allowance nor signature request", async () => {
    const s = setup({out: 2_500_000n});
    const q = (await s.quote({...live, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"}))!;
    expect(s.reasons).toEqual([]);
    expect(q.txRequest).toMatchObject({to: SETTLER, value: "1000000000000000", chainId: 8453});
    expect(q.txRequest).not.toHaveProperty("approvalAddress");
    expect(q.txRequest).not.toHaveProperty("permit2Transfer");
    expect(decodeSettlerExecute(q.txRequest!.data!)).toMatchObject({recipient: ME, buyToken: USDC, minAmountOut: 2_475_000n});
  });

  it("accepts the registry's previous Settler and a VIP first action", async () => {
    expect((await setup({settler: PREV_SETTLER}).quote(live))!.txRequest!.to).toBe(PREV_SETTLER);
    const s = setup({first: "uniswapV3"});
    expect(await s.quote(live)).not.toBeNull();
    expect(s.reasons).toEqual([]);
  });

  it("when 0x quotes a Settler newer than the cached read, reads the registry once more and accepts it", async () => {
    // The rotation that really happened on Base: {21, 20} → {22, 21}; 0x already quotes 22.
    const s = setup({onRegistryRead: (n) => (n === 1 ? {current: PREV_SETTLER, prev: OLDER_SETTLER} : {current: SETTLER, prev: PREV_SETTLER})});
    const q = (await s.quote(live))!;
    expect(q.txRequest!.to).toBe(SETTLER);
    // read 1: ownerOf → 21, its code, prev → 20 (older than the pinned previous: left out, its code never read);
    // read 2: ownerOf → 22, its code, prev → 21 (code already seen)
    expect(s.rpc()).toHaveLength(6);
  });

  const cases: [string, ApiStub, string | RegExp, Record<string, unknown>?][] = [
    ["a target the registry does not know (after a second read)", {settler: OTHER}, /^zeroex: the transaction target 0x9999999999999999999999999999999999999999 is not a 0x Settler from the on-chain registry$/],
    ["no transaction", {tamper: ({transaction: _, ...b}) => b}, "the quote carries no transaction"],
    ["a transaction without data", {tamper: (b) => ({...b, transaction: {...b.transaction, data: null}})}, "malformed quote transaction"],
    ["a transaction with a hex value", {tamper: (b) => ({...b, transaction: {...b.transaction, value: "0x0"}})}, "malformed quote transaction"],
    ["native coin attached to a token sale", {tamper: (b) => ({...b, transaction: {...b.transaction, value: "1000"}})}, "the transaction sends native coin with a token sale"],
    ["no Permit2 payload", {tamper: (b) => ({...b, permit2: null})}, "the quote carries no Permit2 payload to sign"],
    ["a Permit2 hash that is not the payload's", {tamper: (b) => ({...b, permit2: {...b.permit2, hash: `0x${"ab".repeat(32)}`}})}, "the Permit2 payload does not hash to what the API says is being signed"],
    ["a permit for more than the input", {tamper: (b) => { b.permit2.eip712.message.permitted.amount = "115792089237316195423570985008687907853269984665640564039457584007913129639935"; return b; }}, /permitted amount is not the swap's/],
    ["a permit for another token", {tamper: (b) => { b.permit2.eip712.message.permitted.token = DAI.toLowerCase(); return b; }}, /permitted token is not the source token/],
    ["a permit to another spender", {tamper: (b) => { b.permit2.eip712.message.spender = OTHER; return b; }}, /spender is not the contract the swap calls/],
    ["a permit on another chain", {tamper: (b) => { b.permit2.eip712.domain.chainId = 1; return b; }}, /domain chainId is not the source chain 8453/],
    ["a permit against another contract", {tamper: (b) => { b.permit2.eip712.domain.verifyingContract = OTHER; return b; }}, /verifying contract is not Permit2/],
    ["a permit that has lapsed", {tamper: (b) => { b.permit2.eip712.message.deadline = String(Math.floor(Date.now() / 1000) - 60); return b; }}, /deadline has passed/],
    ["a permit that lasts a day", {tamper: (b) => { b.permit2.eip712.message.deadline = String(Math.floor(Date.now() / 1000) + 86_400); return b; }}, /deadline is more than 3600 s away/],
    ["a permit about to lapse", {tamper: (b) => { b.permit2.eip712.message.deadline = String(Math.floor(Date.now() / 1000) + 10); b.permit2.hash = null; return b; }}, "the Permit2 deadline is too close to sign against"],
    ["a Permit2 signature request on a native sale", {tamper: (b) => ({...b, permit2: {type: "Permit2", hash: "0x", eip712: {}}})}, "the API asks for a Permit2 signature on a native-coin sale", {sourceToken: "ETH", destToken: USDC}],
    ["less value than the native amount sold", {tamper: (b) => ({...b, transaction: {...b.transaction, value: "1"}})}, "the transaction value is not the amount being sold", {sourceToken: "ETH", destToken: USDC}],
    ["a registry that reports no Settler", {registry: {current: null}}, /reports no taker Settler in force/],
    ["an RPC that does not answer", {rpcDown: true}, /no RPC answered on chain 8453/],
  ];
  for (const [name, o, why, over] of cases) {
    it(`refuses ${name}`, async () => {
      const s = setup(o);
      expect(await s.quote({...live, ...over})).toBeNull();
      expect(s.reasons).toHaveLength(1);
      if (typeof why === "string") expect(s.reasons[0]).toBe(`zeroex: ${why}`);
      else expect(s.reasons[0]).toMatch(why);
    });
  }

  it("refuses calldata that pays someone else, delivers another token or enforces a lower minimum", async () => {
    const rewrite = (wordIndex: number, value: string) => (b: Record<string, any>) => {
      const body = (b.transaction.data as string).slice(10);
      b.transaction.data = `0x1fff991f${body.slice(0, 64 * wordIndex)}${value.padStart(64, "0")}${body.slice(64 * (wordIndex + 1))}`;
      return b;
    };
    const a = setup({tamper: rewrite(0, OTHER.slice(2))});
    expect(await a.quote(live)).toBeNull();
    expect(a.reasons[0]).toMatch(/the swap pays 0x9999999999999999999999999999999999999999, not the recipient of this swap/);
    const b = setup({tamper: rewrite(1, WETH.slice(2))});
    expect(await b.quote(live)).toBeNull();
    expect(b.reasons[0]).toMatch(/not the token asked for/);
    const c = setup({tamper: rewrite(2, (1n).toString(16))});
    expect(await c.quote(live)).toBeNull();
    expect(c.reasons[0]).toMatch(/the swap enforces a minimum of 1, not the quoted 396000000000000/);
  });

  it("a live quote without an RPC for the chain is refused before the API is asked", async () => {
    const s = setup({}, {rpcUrls: {}});
    expect(await s.quote(live)).toBeNull();
    expect(s.reasons[0]).toMatch(/no RPC is configured for chain 8453/);
    expect(s.api()).toHaveLength(0);
  });
});

describe("zeroExProvider — build, preflight, tracking", () => {
  const liveQuote = async (o: ApiStub = {}, over: Record<string, unknown> = {}) => {
    const s = setup(o);
    const quote = (await s.quote({...live, ...over})) as Quote;
    return {...s, quote};
  };

  it("builds exactly the quoted transaction, and nothing from an indicative quote", async () => {
    const {provider, quote, calls} = await liveQuote();
    const before = calls.length;
    const tx = await provider.buildDeposit(quote);
    expect(calls).toHaveLength(before);
    expect(tx).toEqual({chain: "", to: SETTLER, value: "0", data: quote.txRequest!.data, chainId: 8453, gasLimit: "272000", approvalAddress: ZEROEX_PERMIT2, permit2Transfer: quote.txRequest!.permit2Transfer});
    const dry = (await setup().quote())!;
    await expect(provider.buildDeposit(dry)).rejects.toThrow("zeroex: not a live quote — it carries no transaction");
  });

  it("preflight passes the quoted transaction after a fresh registry read", async () => {
    const {provider, quote, rpc} = await liveQuote();
    const tx = await provider.buildDeposit(quote);
    const before = rpc().length;
    await expect(provider.preflightDeposit!(quote, tx)).resolves.toBeUndefined();
    expect(rpc().length).toBe(before + 2);
  });

  it("preflight refuses a transaction that is not the quoted one", async () => {
    const {provider, quote} = await liveQuote();
    const tx = await provider.buildDeposit(quote);
    const changed: Record<string, string | undefined>[] = [{to: OTHER}, {data: `${tx.data}00`}, {value: "1"}, {permit2Transfer: `${tx.permit2Transfer!} `}, {permit2Transfer: undefined}];
    for (const over of changed) {
      await expect(provider.preflightDeposit!(quote, {...tx, ...over} as UnsignedTx)).rejects.toThrow("zeroex: the transaction is not the quoted swap. Nothing was sent; refresh the quote.");
    }
    await expect(provider.preflightDeposit!({...quote, intentId: "zeroex:5:x"}, tx)).rejects.toThrow("zeroex: the quote names no chain this provider serves. Nothing was sent.");
  });

  it("preflight refuses when the Settler left the registry after the quote", async () => {
    const {provider, quote} = await liveQuote({onRegistryRead: (n) => (n === 1 ? {current: SETTLER, prev: PREV_SETTLER} : {current: PREV_SETTLER, prev: OLDER_SETTLER})});
    const tx = await provider.buildDeposit(quote);
    await expect(provider.preflightDeposit!(quote, tx)).rejects.toThrow("zeroex: the quoted 0x Settler is no longer in the on-chain registry. Nothing was sent; refresh the quote.");
  });

  it("preflight refuses when the feature is paused or the chain cannot be read", async () => {
    const paused = await liveQuote({onRegistryRead: (n) => (n === 1 ? {} : {current: null})});
    await expect(paused.provider.preflightDeposit!(paused.quote, await paused.provider.buildDeposit(paused.quote))).rejects.toThrow(/reports no taker Settler in force/);
  });

  it("tracks by receipt: mined and successful = completed, reverted = failed, not mined = pending", async () => {
    const hash = `0x${"ab".repeat(32)}`;
    const ref = (over: Record<string, unknown> = {}) => ({intentId: "zeroex:8453:abc", sourceTxHash: hash, ...over}) as never;
    expect(await setup().provider.trackIntent(ref())).toEqual({state: "completed", destTxHash: hash});
    expect((await setup({receipt: {status: "0x0"}}).provider.trackIntent(ref())).state).toBe("failed");
    expect(await setup({receipt: null}).provider.trackIntent(ref())).toEqual({state: "pending"});
    expect(await setup({rpcDown: true}).provider.trackIntent(ref())).toEqual({state: "pending"});
    const s = setup();
    expect(await s.provider.trackIntent(ref({sourceTxHash: undefined}))).toEqual({state: "pending"});
    expect(await s.provider.trackIntent(ref({sourceTxHash: "0x12"}))).toEqual({state: "pending"});
    expect(await s.provider.trackIntent(ref({intentId: "zeroex:1:abc"}))).toEqual({state: "pending"});
    expect(s.calls).toHaveLength(0);
  });
});
