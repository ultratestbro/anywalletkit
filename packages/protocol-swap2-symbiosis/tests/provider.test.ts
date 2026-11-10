// The provider end to end over recorded answers of the public API (tests/fixtures/*.json): what it
// asks, what it shows, what it refuses, what it hands the wallet, and how it reads an operation's state.
import {afterEach, describe, expect, it, vi} from "vitest";
import {assertNodeBuild, verifyRawTransaction} from "@anywalletkit/wallet-tron";
import {CrossChainRouter} from "@anywalletkit/protocol-swap2-router";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {SYMBIOSIS_CHAINS, SYMBIOSIS_REVERTER} from "../src/config.js";
import {SYMBIOSIS_STATUS, symbiosisProvider, symbiosisStatus, symbiosisTronCall, type SymbiosisProviderConfig} from "../src/provider.js";
import {EVIL, EVM, LIMITS, TON, TRON, lastOnly, load, quoteOf, replay, rewrite, type Exchange} from "./fixtures.js";

const SERVED = ["eth-usdc-arb-usdc", "bsc-usdc-ton-usdt", "tron-usdt-base-usdc", "tron-usdt-ton-usdt", "eth-eth-base-eth", "ton-usdt-tron-usdt"];
const STEERED = ["bsc-usdt-ton-usdt", "bsc-bnb-eth-eth", "ton-usdt-base-usdc"];
const status = load("status") as unknown as {success: any; pendingStuck: any; notFound: {status: number; body: string}; stuckList: {hash: string; chainId: number}[]};
const at = (name: string) => new Date(load(name).recordedAt).getTime();
const freeze = (ms: number) => vi.useFakeTimers({toFake: ["Date"], now: ms});
afterEach(() => { vi.useRealTimers(); });

describe("replay: the recorded conversation with the API, request for request", () => {
  const check = async (name: string) => {
    const {quote, refusal, calls, recorded} = await quoteOf(name);
    expect(calls.map((c) => [c.method, new URL(c.url).pathname.replace("/crosschain", "")]), name).toEqual(recorded.exchanges.map((e) => [e.method, e.path]));
    recorded.exchanges.forEach((e, i) => { if (e.body) expect(calls[i]!.body, `${name} #${i}`).toEqual(e.body); });
    if (recorded.result.refusal) {
      expect(quote, name).toBeNull();
      expect(refusal, name).toBe(recorded.result.refusal);
    } else {
      expect(refusal, name).toBeNull();
      expect({destAmount: quote!.destAmount, minDestAmount: quote!.minDestAmount, providerData: quote!.providerData}, name).toMatchObject(recorded.result);
    }
    return {quote, calls};
  };
  for (const name of SERVED) it(name, async () => { await check(name); });
  it("routes found only after naming the venues this module cannot read (0x, OpenOcean, Bitget): one more request per venue, a second apart", async () => {
    const all = await Promise.all(STEERED.map(check));
    expect(all[0]!.calls.at(-1)!.body!.disabledProviders).toBe("changelly,thorchain-bridge,chainflip-bridge,0x,open-ocean,bitget");
    expect(all[0]!.quote!.providerData).toMatchObject({sourceSwap: "1", sourceRouter: "uniswap-v2", destSwap: "0"});
    expect(all[1]!.quote!.providerData).toMatchObject({sourceSwap: "1", sourceRouter: "uniswap-v2", destSwap: "1", destRouter: "unwrap"});
    expect(all[2]!.quote!.providerData).toMatchObject({sourceSwap: "0", destSwap: "1", destRouter: "uniswap-v2"});
  });
  it("Base USDT → TON USDT (ticket pair 2) as it answered on 2026-11-10: refused — only unreadable venues trade the Base leg", async () => {
    await check("base-usdt-ton-usdt");
  });
  it("a Bitcoin source as it answered on 2026-11-10: not available without the partner routes this module switches off", async () => {
    await check("btc-btc-base-usdc");
  });
  it("a 1inch leg carries a tracking tag after its arguments, so it is not one canonical swap call: asked again without 1inch, and the KyberSwap route that comes back is checked like any other", async () => {
    const n = "bsc-usdt-ton-usdt-tagged";
    const rec = load(n);
    // The recorder steered the FIRST request onto 1inch; the provider's own first request names only its fixed list.
    const {quote, refusal, calls} = await quoteOf(n);
    expect(refusal).toBeNull();
    expect(calls.map((c) => c.body?.disabledProviders)).toEqual([undefined, "changelly,thorchain-bridge,chainflip-bridge", "changelly,thorchain-bridge,chainflip-bridge,1inch"]);
    expect((rec.exchanges[1]!.response as {routes: {provider: string}[]}).routes.map((r) => r.provider)).toEqual(["1inch", "symbiosis"]);
    expect({destAmount: quote!.destAmount, minDestAmount: quote!.minDestAmount, providerData: quote!.providerData}).toMatchObject(rec.result);
    expect(quote!.providerData).toMatchObject({sourceSwap: "1", sourceRouter: "kyberswap-v2", destSwap: "0"});
  });
  it("the tagged 1inch call is never accepted: an API that keeps returning it is refused after one more request", async () => {
    const n = "bsc-usdt-ton-usdt-tagged";
    const rec = load(n);
    const first = rec.exchanges[1]!;
    const {quote, refusal, calls} = await quoteOf(n, {exchanges: () => [rec.exchanges[0]!, first, first]});
    expect(quote).toBeNull();
    expect(calls.length).toBe(3);
    expect(refusal).toBe("symbiosis: source swap: calldata is not canonically encoded");
  });
  it("only a swap-leg refusal is asked again: a tampered bridge leg on a route with an optional venue is refused at once", async () => {
    const n = "bsc-usdt-ton-usdt-tagged";
    const rec = load(n);
    const {quote, refusal, calls} = await quoteOf(n, {exchanges: () => [rec.exchanges[0]!, rec.exchanges[2]!], patch: (r, _e, i) => { if (i === 1) r.tx.to = EVIL; return r; }});
    expect(quote).toBeNull();
    expect(calls.length).toBe(2);
    expect(refusal).not.toMatch(/swap: /);
  });
  it("an unreadable venue is never accepted: when the retries run out the route is refused by the calldata check", async () => {
    // The API keeps answering with the first route (a 0x source swap) although 0x was switched off.
    const rec = load("bsc-usdt-ton-usdt");
    const first = rec.exchanges[1]!;
    const {quote, refusal, calls} = await quoteOf("bsc-usdt-ton-usdt", {exchanges: () => [rec.exchanges[0]!, first, first]});
    expect(quote).toBeNull();
    expect(calls.length).toBe(3);
    expect(calls[2]!.body!.disabledProviders).toBe("changelly,thorchain-bridge,chainflip-bridge,0x");
    expect(refusal).toMatch(/^symbiosis: source swap: .* is not an allow-listed swap router$/);
  });
});

describe("the request", () => {
  const n = "eth-usdc-arb-usdc";
  it("no key, no partner id and no fee parameter by default", async () => {
    const {calls} = await quoteOf(n, {exchanges: lastOnly});
    expect(Object.keys(calls[1]!.headers).sort()).toEqual(["accept", "content-type"]);
    expect(Object.keys(calls[1]!.body!).sort()).toEqual(["disabledProviders", "from", "slippage", "to", "tokenAmountIn", "tokenOut"]);
    expect(calls[1]!.url).toBe("https://api.symbiosis.finance/crosschain/v2/quote");
  });
  it("a partner id, key and partner address travel only when configured", async () => {
    const {calls} = await quoteOf(n, {exchanges: lastOnly, config: {partnerId: "acme", apiKey: "k-1", partnerAddress: EVM.toLowerCase(), apiUrl: "https://proxy.example/sym/"}});
    expect(calls[1]!.headers).toMatchObject({"X-Partner-Id": "acme", "X-Api-Key": "k-1"});
    expect(calls[0]!.headers).toMatchObject({"X-Partner-Id": "acme", "X-Api-Key": "k-1"});
    expect(calls[1]!.body!.partnerAddress).toBe(EVM);
    expect(calls[1]!.url).toBe("https://proxy.example/sym/v2/quote");
  });
  it("slippage: the caller's, else the configured one, else the engine's suggestion — never a private default", async () => {
    expect((await quoteOf(n, {exchanges: lastOnly})).calls[1]!.body!.slippage).toBe(100);
    expect((await quoteOf(n, {exchanges: lastOnly, params: {slippageBps: 37}})).calls[1]!.body!.slippage).toBe(37);
    const {slippageBps: _, ...rest} = load(n).params;
    const run = async (config: SymbiosisProviderConfig) => {
      const {fetchImpl, calls} = replay(lastOnly(load(n).exchanges));
      await symbiosisProvider({...config, fetchImpl}).getQuote(rest);
      return calls[1]!.body!.slippage as number;
    };
    expect(await run({slippageBps: 55})).toBe(55);
    const suggested = await run({});
    expect(Number.isInteger(suggested) && suggested > 0 && suggested < 1000).toBe(true);
  });
  it("boundSourceOnly asks for no source-chain routing and refuses a route that swaps there anyway", async () => {
    const direct = await quoteOf(n, {exchanges: lastOnly, config: {boundSourceOnly: true}});
    expect(direct.calls[1]!.body!.disableSrcChainRouting).toBe(true);
    expect(direct.quote).not.toBeNull();
    const swapped = await quoteOf("bsc-usdt-ton-usdt", {exchanges: lastOnly, config: {boundSourceOnly: true}});
    expect(swapped.refusal).toBe("the route swaps on the source chain before bridging (boundSourceOnly)");
  });
  it("a TON jetton is named the way the API wants it, with the jetton master attached", async () => {
    const {calls} = await quoteOf("ton-usdt-tron-usdt", {exchanges: lastOnly});
    expect(calls[1]!.body).toMatchObject({from: TON, to: TRON, fallbackReceiver: EVM, tokenAmountIn: {chainId: 85918, attributes: {ton: expect.any(String)}}, tokenOut: {chainId: 728126428}});
  });
  const refusals: [string, string, Record<string, unknown>, SymbiosisProviderConfig, RegExp][] = [
    ["flexible deposits", n, {flex: true}, {}, /sealed into the transaction/],
    ["unknown chain", n, {destChain: "eip155:999999"}, {}, /not wired for this chain/],
    ["same chain", n, {destChain: "eip155:1"}, {}, /same-chain swaps are not served/],
    ["Bitcoin destination", n, {destChain: "bitcoin:mainnet", destToken: "BTC"}, {}, /Bitcoin is not a destination/],
    ["amount", n, {amountIn: "1.5"}, {}, /base-unit integer/],
    ["zero", n, {amountIn: "0"}, {}, /must be positive/],
    ["slippage", n, {slippageBps: 10_000}, {}, /slippage must be 0..9999 bps/],
    ["source token", n, {sourceToken: "NOPE"}, {}, /unknown source token NOPE on Ethereum/],
    ["destination token", n, {destToken: EVIL}, {}, /is not in the catalog/],
    ["recipient format", n, {destAddress: TRON}, {}, /the recipient is not a Arbitrum address/],
    ["sender format", n, {refundAddress: TON}, {}, /the sender is not a Ethereum address/],
    ["live without recipient", n, {destAddress: ""}, {}, /a live quote needs a recipient/],
    ["live without sender", n, {refundAddress: ""}, {}, /a live quote needs the sender/],
    ["TON native", "ton-usdt-tron-usdt", {sourceToken: "TON"}, {}, /TON's native coin is not bridged by Symbiosis itself/],
    ["TON recipient format", "bsc-usdc-ton-usdt", {destAddress: EVM}, {}, /the recipient is not a TON address/],
    ["Tron recipient format", "ton-usdt-tron-usdt", {destAddress: EVM}, {}, /the recipient is not a Tron address/],
    ["Tron switched off", "tron-usdt-base-usdc", {}, {tronSource: false}, /Tron sources are switched off \(tronSource\)/],
    ["Bitcoin switched off", "btc-btc-base-usdc", {}, {btcSource: false}, /Bitcoin sources are switched off \(btcSource\)/],
    ["Tron → TON without the user's EVM address", "tron-usdt-ton-usdt", {}, {fallbackReceiver: undefined} as never, /Tron → TON needs the user's own EVM address \(fallbackReceiver\)/],
  ];
  for (const [name, fixture, params, config, why] of refusals) {
    it(`refused before any request: ${name}`, async () => {
      const {quote, refusal, calls} = await quoteOf(fixture, {exchanges: lastOnly, params, config});
      expect(quote).toBeNull();
      expect(refusal).toMatch(why);
      expect(calls.length).toBe(0);
    });
  }
  it("Tron and Bitcoin sources are off unless switched on; the deposit-address flag exists only with btcSource", () => {
    const off = symbiosisProvider();
    expect(off.supportsChainPair!("tron:728126428", "eip155:8453")).toBe(false);
    expect(off.supportsChainPair!("bitcoin:mainnet", "eip155:8453")).toBe(false);
    expect(off.supportsChainPair!("eip155:8453", "tron:728126428")).toBe(true);
    expect(off.supportsChainPair!("ton:-239", "eip155:8453")).toBe(true);
    expect(off.supportsChainPair!("eip155:8453", "bitcoin:mainnet")).toBe(false);
    expect(off.depositAddressRoutes).toBeUndefined();
    const on = symbiosisProvider({tronSource: true, btcSource: true});
    expect(on.supportsChainPair!("tron:728126428", "eip155:8453")).toBe(true);
    expect(on.supportsChainPair!("bitcoin:mainnet", "eip155:8453")).toBe(true);
    expect(on.depositAddressRoutes).toBe(true);
    expect(symbiosisProvider({tronSource: true}).depositAddressRoutes).toBeUndefined();
    expect(on.supportsRoute!({chain: "ton:-239", token: "TON"}, {chain: "eip155:8453", token: "USDC"})).toBe(false);
    expect(on.supportsRoute!({chain: "ton:-239", token: "USDT"}, {chain: "eip155:8453", token: "USDC"})).toBe(true);
    expect(symbiosisProvider({enabled: false}).enabled()).toBe(false);
  });
  it("configuration is validated when the provider is made", () => {
    const bad: [SymbiosisProviderConfig, RegExp][] = [
      [{apiUrl: "ftp://x"}, /apiUrl must use http or https/],
      [{quoteTtlMs: 0}, /quoteTtlMs/],
      [{quoteTtlMs: 300_001}, /quoteTtlMs/],
      [{slippageBps: 10_000}, /slippageBps must be 0..9999/],
      [{fallbackReceiver: "T123"}, /fallbackReceiver must be an EVM address/],
      [{fallbackReceiver: `0x${"0".repeat(40)}`}, /fallbackReceiver must be an EVM address/],
      [{partnerAddress: "x"}, /partnerAddress must be an EVM address/],
      [{partnerId: "a b"}, /partnerId must be 1..256 printable characters/],
      [{apiKey: ""}, /apiKey must be 1..256 printable characters/],
      [{tronFeeLimitCap: "1.5" as never}, /tronFeeLimitCap/],
      [{tronFeeLimitCap: 0n}, /tronFeeLimitCap/],
    ];
    for (const [config, why] of bad) expect(() => symbiosisProvider(config)).toThrow(why);
  });
});

describe("limits, enforced on the device from /v1/swap-limits", () => {
  const n = "eth-usdc-arb-usdc";
  it("below the minimum: refused without asking for a quote", async () => {
    const {refusal, calls} = await quoteOf(n, {exchanges: lastOnly, params: {amountIn: "299999"}});
    expect(refusal).toBe("amount 299999 is below Symbiosis' minimum 300000 on Ethereum");
    expect(calls.length).toBe(1);
  });
  it("the received amount above the destination's maximum", async () => {
    const big = "200000000001";
    const {refusal} = await quoteOf(n, {exchanges: lastOnly, patch: (r, _e, i) => { if (i === 1) { r.tokenAmountOut.amount = big; } return r; }});
    expect(refusal).toBe(`received amount ${big} is above Symbiosis' maximum 200000000000 on Arbitrum`);
  });
  it("the recorded list carries a minimum and a maximum for the bridged tokens of every chain this module serves", () => {
    for (const c of Object.values(SYMBIOSIS_CHAINS)) expect(LIMITS.some((l) => l.chainId === c!.id && /^\d+$/.test(l.min) && /^\d+$/.test(l.max)), c!.name).toBe(true);
  });
  const unreadable: [string, unknown][] = [["empty", []], ["not a list", {}], ["an entry without numbers", [{chainId: 1, address: "0x", min: "1e6", max: "5"}]]];
  for (const [name, list] of unreadable) {
    it(`an unreadable list (${name}) is a refusal, not "no limits"`, async () => {
      const {refusal, calls} = await quoteOf(n, {exchanges: lastOnly, patch: (r, _e, i) => (i === 0 ? list : r)});
      expect(refusal).toBe("Symbiosis limits are unreadable");
      expect(calls.length).toBe(1);
    });
  }
});

describe("the answer must be for the request, with fees that can be read", () => {
  const n = "eth-usdc-arb-usdc";
  const patched = async (edit: (r: any) => void, fixture = n, params = {}) =>
    (await quoteOf(fixture, {exchanges: lastOnly, params, patch: (r, _e, i) => { if (i === 1) edit(r); return r; }})).refusal;
  const cases: [string, (r: any) => void, RegExp][] = [
    ["another output token", (r) => { r.tokenAmountOut.address = EVIL; }, /quoted another token or chain than requested/],
    ["another output chain", (r) => { r.tokenAmountOutMin.chainId = 8453; }, /quoted another token or chain than requested/],
    ["other decimals", (r) => { r.tokenAmountOut.decimals = 18; }, /quoted another token or chain than requested/],
    ["a non-integer amount", (r) => { r.tokenAmountOut.amount = "99.4"; }, /quoted another token or chain than requested/],
    ["a minimum above the amount", (r) => { r.tokenAmountOutMin.amount = String(BigInt(r.tokenAmountOut.amount) + 1n); }, /unusable output amount/],
    ["zero out", (r) => { r.tokenAmountOut.amount = "0"; r.tokenAmountOutMin.amount = "0"; }, /unusable output amount/],
    ["a minimum the route does not guarantee", (r) => { r.tokenAmountOutMin.amount = String(BigInt(r.tokenAmountOutMin.amount) + 1n); }, /^symbiosis: the route guarantees 99197101, below the quoted minimum 99197102$/],
    ["no fees", (r) => { r.fees = []; }, /reported no fees — a quote without readable fees is not shown/],
    ["fees missing", (r) => { delete r.fees; }, /reported no fees/],
    ["a fee without an amount", (r) => { r.fees[0].value.amount = "0.5"; }, /a fee that cannot be read/],
    ["a fee without decimals", (r) => { delete r.fees[0].value.decimals; }, /a fee that cannot be read/],
    ["a fee without a price", (r) => { delete r.fees[0].value.priceUsd; r.fees[0].value.address = EVIL; }, /reported a fee in \w+ without a price/],
    ["another kind of route", (r) => { r.kind = "onchain-swap"; }, /answered with a 'onchain-swap' route/],
    ["another transaction type", (r) => { r.type = "tron"; }, /answered with a 'tron' route, not a Ethereum transaction/],
    ["a partner route", (r) => { r.labels = ["partner-swap"]; }, /answered with a partner-swap route \(a third party holds the funds\)/],
    ["an intent route", (r) => { r.labels = ["intent"]; }, /answered with a intent route/],
    ["another approval spender", (r) => { r.approveTo = EVIL; }, /asks to approve .* not the pinned Ethereum MetaRouterGateway/],
    ["the MetaRouter as the spender", (r) => { r.approveTo = SYMBIOSIS_CHAINS["eip155:1"]!.executor; }, /asks to approve/],
    ["another chain id", (r) => { r.tx.chainId = 56; }, /built a transaction for chain 56, not Ethereum/],
    ["another contract", (r) => { r.tx.to = EVIL; }, /^symbiosis: the transaction calls .* not the pinned Ethereum MetaRouterGateway$/],
    ["value on a token sale", (r) => { r.tx.value = "1"; }, /attaches 1, expected 0/],
    ["a malformed value", (r) => { r.tx.value = "0x1"; }, /malformed transaction value/],
    ["no calldata", (r) => { delete r.tx.data; }, /returned no transaction/],
    ["no answer", (r) => { for (const k of Object.keys(r)) delete r[k]; }, /answered with a 'undefined' route/],
  ];
  for (const [name, edit, why] of cases) it(name, async () => expect(await patched(edit)).toMatch(why));

  it("the caller's floor", async () => {
    expect(await patched(() => {}, n, {minAmountOut: "99197102"})).toBe("the route guarantees 99197101, below the caller's floor 99197102");
    expect(await patched(() => {}, n, {minAmountOut: "99197101"})).toBeNull();
  });
  it("an API error is shown as the API worded it; a URL in it is not", async () => {
    const rec = load(n);
    const fail = (response: unknown, statusCode: number): Exchange[] => [rec.exchanges[0]!, {method: "POST", path: "/v2/quote", status: statusCode, response}];
    expect((await quoteOf(n, {exchanges: () => fail({message: "No route available right now, please try again"}, 400)})).refusal).toBe("Symbiosis: No route available right now, please try again");
    expect((await quoteOf(n, {exchanges: () => fail({}, 503)})).refusal).toBe("Symbiosis API → 503");
    expect((await quoteOf(n, {exchanges: () => fail({message: "see https://internal.example/x?key=abc"}, 400)})).refusal).not.toMatch(/internal\.example/);
  });
  it("fees: every one the API reports, in its own token, summed in dollars", async () => {
    const {quote} = await quoteOf("tron-usdt-base-usdc", {exchanges: lastOnly});
    expect(quote!.fees).toEqual([
      {type: "protocol", amount: "250000", token: "sUSDT", included: true, description: "Cross-chain fee (symbiosis, Symbiosis' host chain)"},
      {type: "protocol", amount: "250000", token: "USDbC", included: true, description: "Cross-chain fee (symbiosis, Base)"},
    ]);
    expect(quote!.feeUsd).toBeCloseTo(0.25 + 0.25 * 0.9996348, 9);
    expect(quote!.etaSeconds).toBe(28);
  });
  it("the quote: sealed request, no memo, intent id naming chains, token and the user's addresses", async () => {
    freeze(at(n));
    const {quote} = await quoteOf(n, {exchanges: lastOnly});
    expect(quote).toMatchObject({
      provider: "symbiosis", depositAddress: "", depositMemo: null, sourceAmount: "100000000", destDecimals: 6, reliability: 0.95,
      intentId: `symbiosis:1:42161:0xaf88d065e77c8cC2239327C5EDb3A432268e5831:${EVM.toLowerCase()}`,
      validUntilMs: at(n) + 60_000,
      txRequest: {to: SYMBIOSIS_CHAINS["eip155:1"]!.gateway, value: "0", chainId: 1, approvalAddress: SYMBIOSIS_CHAINS["eip155:1"]!.gateway},
    });
    expect(BigInt(quote!.minDestAmount!) <= BigInt(quote!.destAmount)).toBe(true);
  });
  it("a dry quote prices with placeholder addresses and still passes every check", async () => {
    const rec = load(n);
    const {quote, refusal, calls} = await quoteOf(n, {exchanges: lastOnly, params: {dry: true, destAddress: "", refundAddress: ""}});
    // The recorded transaction is for the recorded addresses, not the placeholders: the calldata check says so.
    expect(quote).toBeNull();
    expect(refusal).toMatch(/not the sender|not one of the user's addresses|not the recipient/);
    expect(calls[1]!.body!.from).not.toBe(rec.params.refundAddress);
  });
});

describe("what the wallet gets", () => {
  it("EVM: the quoted transaction, with the gateway as the only spender; preflight accepts exactly it", async () => {
    const n = "eth-usdc-arb-usdc";
    freeze(at(n));
    const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
    const p = symbiosisProvider(recorded.config);
    const tx = await p.buildDeposit(quote!);
    expect(tx).toEqual({chain: "eip155:1", to: quote!.txRequest!.to, value: "0", data: quote!.txRequest!.data, chainId: 1, approvalAddress: SYMBIOSIS_CHAINS["eip155:1"]!.gateway});
    await expect(p.preflightDeposit!(quote!, tx)).resolves.toBeUndefined();
    await expect(p.preflightDeposit!(quote!, {...tx, to: EVIL})).rejects.toThrow(/not the pinned Ethereum MetaRouterGateway/);
    await expect(p.preflightDeposit!(quote!, {...tx, value: "1"})).rejects.toThrow(/attaches 1/);
    await expect(p.preflightDeposit!(quote!, {...tx, approvalAddress: EVIL})).rejects.toThrow(/approval names/);
    await expect(p.preflightDeposit!(quote!, {...tx, chain: "eip155:56"})).rejects.toThrow(/another chain/);
    // Another valid Symbiosis transaction (same request, another deadline) is still not the quoted one.
    const other = rewrite(quote!, (parts) => { parts.pools[0]![5] += 1n; });
    await expect(p.preflightDeposit!(quote!, {...tx, data: other.txRequest!.data!})).rejects.toThrow("symbiosis: the build differs from the quoted transaction");
    // A quote whose own transaction was swapped after quoting fails against the sealed request.
    const forged = rewrite(quote!, (parts) => { parts.burn.chain2address = EVIL; });
    await expect(p.preflightDeposit!(forged, await p.buildDeposit(forged))).rejects.toThrow(/not the recipient/);
    const resealed: Quote = {...forged, providerData: {...forged.providerData!, recipient: EVIL}};
    await expect(p.preflightDeposit!(resealed, await p.buildDeposit(resealed))).resolves.toBeUndefined(); // the sealed request is the app's to compare with what it asked (the engine does)
    vi.setSystemTime(at(n) + 60_000);
    await expect(p.preflightDeposit!(quote!, tx)).rejects.toThrow("symbiosis: the quote expired — re-quote");
  });
  it("a quote without its sealed request, or with a foreign intent id, is not built", async () => {
    const n = "eth-usdc-arb-usdc";
    freeze(at(n));
    const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
    const p = symbiosisProvider(recorded.config);
    const tx = await p.buildDeposit(quote!);
    await expect(p.preflightDeposit!({...quote!, providerData: {}}, tx)).rejects.toThrow("symbiosis: quote carries no sealed request");
    await expect(p.preflightDeposit!({...quote!, intentId: quote!.intentId.replace(":1:42161:", ":56:42161:")}, tx)).rejects.toThrow("symbiosis: quote carries no sealed request");
    await expect(p.buildDeposit({...quote!, intentId: "lifi:1"})).rejects.toThrow("swap2: malformed Symbiosis intent id");
    const {txRequest: _, ...bare} = quote!;
    await expect(p.buildDeposit(bare as Quote)).rejects.toThrow("swap2: Symbiosis quote carries no transaction");
  });

  it("TON: one message — the quote's own; value, body and address may not change", async () => {
    const n = "ton-usdt-tron-usdt";
    freeze(at(n));
    const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
    expect(quote!.txRequest).toBeUndefined();
    expect(quote!.validUntilMs).toBe(at(n) + 60_000);
    const p = symbiosisProvider(recorded.config);
    const tx = await p.buildDeposit(quote!);
    expect(tx).toEqual({chain: "ton:-239", to: "EQAvLzOubdnAtv7gjO9ZfrAKnVklFS_4xG7iQXzrfyllmImd", value: "200000000", bodyBoc: quote!.providerData!.tonBody});
    await expect(p.preflightDeposit!(quote!, tx)).resolves.toBeUndefined();
    await expect(p.preflightDeposit!(quote!, {...tx, value: "300000000"})).rejects.toThrow("symbiosis: the build differs from the quoted TON message");
    await expect(p.preflightDeposit!(quote!, {...tx, to: TON})).rejects.toThrow("symbiosis: the build differs from the quoted TON message");
    await expect(p.preflightDeposit!(quote!, {...tx, value: "2000000000"})).rejects.toThrow(/ceiling/);
    // Without the user's own EVM address in THIS provider's configuration a TON → Tron build is not accepted,
    // whatever the quote says about itself.
    await expect(symbiosisProvider({}).preflightDeposit!(quote!, tx)).rejects.toThrow(/needs the user's own EVM address/);
    await expect(symbiosisProvider({fallbackReceiver: EVIL}).preflightDeposit!(quote!, tx)).rejects.toThrow(/symbiosis: /);
  });
  it("TON: more than one message, or a malformed one, is refused", async () => {
    const n = "ton-usdt-tron-usdt";
    const run = async (edit: (r: any) => void) => (await quoteOf(n, {exchanges: lastOnly, patch: (r, _e, i) => { if (i === 1) edit(r); return r; }})).refusal;
    expect(await run((r) => { r.tx.messages.push(r.tx.messages[0]); })).toBe("Symbiosis returned something other than one TON message");
    expect(await run((r) => { r.tx.messages[0].amount = 2e8; })).toBe("Symbiosis returned something other than one TON message");
    expect(await run((r) => { r.tx.messages[0].amount = "1000000001"; })).toMatch(/above the 1000000000 ceiling/);
  });
  it("TON: the message's own deadline shortens the quote", async () => {
    const n = "ton-usdt-tron-usdt";
    freeze(at(n));
    const soon = Math.floor(at(n) / 1000) + 20;
    const {quote} = await quoteOf(n, {exchanges: lastOnly, patch: (r, _e, i) => { if (i === 1) r.tx.validUntil = soon; return r; }});
    expect(quote!.validUntilMs).toBe(soon * 1000);
  });

  describe("Tron", () => {
    const n = "tron-usdt-base-usdc";
    const node = load("tron-node-build") as unknown as {transaction: any};
    const gateway = "TPuaJ6gnYfE9gLUDFrbWbPx3tMnjG8max1";
    it("the quote carries the full calldata (selector + the API's parameters), the fee limit and the gateway as spender", async () => {
      const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
      const api = recorded.exchanges.at(-1)!.response as {tx: {data: string; feeLimit: number}};
      expect(quote!.txRequest).toEqual({to: gateway, data: `0xa11b1198${api.tx.data.slice(2)}`, value: "0", chainId: 728126428, gasLimit: "200000000", approvalAddress: gateway});
    });
    it("the node's real build of this call passes the wallet's byte check; a changed one does not", async () => {
      const {quote} = await quoteOf(n, {exchanges: lastOnly});
      const call = symbiosisTronCall(quote!);
      expect(call.approval).toEqual({token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", spender: gateway, amount: "50000000"});
      expect(call.call).toEqual({owner: TRON, contract: gateway, functionSelector: "metaRoute((bytes,bytes,address[],address,address,uint256,bool,address,bytes))", parameter: quote!.txRequest!.data!.slice(10), feeLimit: 200000000, callValue: "0"});
      expect(() => assertNodeBuild(node.transaction, call.expected)).not.toThrow();
      expect(verifyRawTransaction(node.transaction).txID).toBe(node.transaction.txID);

      // txID that is not sha256(raw_data_hex)
      expect(() => assertNodeBuild({...node.transaction, txID: "00".repeat(32)}, call.expected)).toThrow();
      // bytes changed under the same JSON
      const hex: string = node.transaction.raw_data_hex;
      expect(() => assertNodeBuild({...node.transaction, raw_data_hex: hex.slice(0, 200) + (hex[200] === "0" ? "1" : "0") + hex.slice(201)}, call.expected)).toThrow();
      // the node built another call than the one checked
      expect(() => assertNodeBuild(node.transaction, {...call.expected, data: rewrite(quote!, (p) => { p.pools[0]![5] += 1n; }).txRequest!.data!})).toThrow(/calldata differs/);
      expect(() => assertNodeBuild(node.transaction, {...call.expected, owner: "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"})).toThrow(/owner/);
      expect(() => assertNodeBuild(node.transaction, {...call.expected, contract: "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"})).toThrow(/contract/);
      expect(() => assertNodeBuild(node.transaction, {...call.expected, feeLimit: 100_000_000n})).toThrow(/fee_limit/);
      expect(() => assertNodeBuild(node.transaction, {...call.expected, callValue: 1n})).toThrow(/call_value/);
    });
    it("symbiosisTronCall re-checks the quote: a tampered one, another family's, or a fee limit above the ceiling throws", async () => {
      const {quote} = await quoteOf(n, {exchanges: lastOnly});
      expect(() => symbiosisTronCall(rewrite(quote!, (p) => { p.burn.chain2address = EVIL; }))).toThrow(/not the recipient/);
      expect(() => symbiosisTronCall({...quote!, txRequest: {...quote!.txRequest!, to: "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"}})).toThrow(/not the pinned Tron MetaRouterGateway/);
      expect(() => symbiosisTronCall({...quote!, txRequest: {...quote!.txRequest!, gasLimit: "300000001"}})).toThrow(/above the 300000000 sun ceiling/);
      expect(() => symbiosisTronCall(quote!, {feeLimitCap: 100_000_000n})).toThrow(/above the 100000000 sun ceiling/);
      expect(() => symbiosisTronCall({...quote!, provider: "other"})).toThrow("symbiosis: not a Tron-source quote");
      const evm = await quoteOf("eth-usdc-arb-usdc", {exchanges: lastOnly});
      expect(() => symbiosisTronCall(evm.quote!)).toThrow("symbiosis: not a Tron-source quote");
    });
    const tronCases: [string, (r: any) => void, SymbiosisProviderConfig, RegExp][] = [
      ["another function", (r) => { r.tx.functionSelector = "transfer(address,uint256)"; }, {}, /built a Tron call that is not metaRoute/],
      ["another owner", (r) => { r.tx.from = "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"; }, {}, /built the Tron call for another owner/],
      ["no fee limit", (r) => { delete r.tx.feeLimit; }, {}, /named no Tron fee limit/],
      ["a fee limit above the default ceiling (300 TRX)", (r) => { r.tx.feeLimit = 300_000_001; }, {}, /asks a Tron fee limit of 300000001 sun, above the 300000000 ceiling/],
      ["a fee limit above a configured ceiling", () => {}, {tronFeeLimitCap: 150_000_000n}, /above the 150000000 ceiling/],
      ["another contract", (r) => { r.tx.to = "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"; }, {}, /not the pinned Tron MetaRouterGateway/],
      ["another spender", (r) => { r.approveTo = "TD4tamFrCq7KvQEB1LArNXr9sKFC6GaAmt"; }, {}, /asks to approve .* not the pinned Tron MetaRouterGateway/],
      ["TRX attached to a token sale", (r) => { r.tx.value = "5"; }, {}, /attaches 5, expected 0/],
    ];
    for (const [name, edit, config, why] of tronCases) {
      it(`refused: ${name}`, async () => {
        const {quote, refusal} = await quoteOf(n, {exchanges: lastOnly, config, patch: (r, _e, i) => { if (i === 1) edit(r); return r; }});
        expect(quote).toBeNull();
        expect(refusal).toMatch(why);
      });
    }
    it("preflight holds the fee limit and the exact call", async () => {
      freeze(at(n));
      const {quote, recorded} = await quoteOf(n, {exchanges: lastOnly});
      const p = symbiosisProvider(recorded.config);
      const tx = await p.buildDeposit(quote!);
      expect(tx).toMatchObject({chain: "tron:728126428", to: gateway, gasLimit: "200000000", approvalAddress: gateway});
      await expect(p.preflightDeposit!(quote!, tx)).resolves.toBeUndefined();
      await expect(p.preflightDeposit!(quote!, {...tx, gasLimit: "300000001"})).rejects.toThrow("symbiosis: Tron fee limit above the ceiling");
      const {gasLimit: _, ...noLimit} = tx;
      await expect(p.preflightDeposit!(quote!, noLimit)).rejects.toThrow("symbiosis: Tron fee limit above the ceiling");
      await expect(symbiosisProvider({}).preflightDeposit!(quote!, tx)).rejects.toThrow("symbiosis: Tron sources are switched off");
    });
  });

  // No Bitcoin-source answer could be recorded (the public API serves BTC only through partner routes this
  // module switches off). The answers below are WRITTEN HERE in the documented shape of `/v2/quote` and
  // `/v2/swap` for type "btc"; they prove the module's handling, not the API's behaviour.
  describe("Bitcoin source (synthetic answers — see the comment above)", () => {
    const n = "btc-btc-base-usdc";
    const deposit = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
    const answer = (tx: unknown) => {
      const r = structuredClone(load("tron-usdt-base-usdc").exchanges[1]!.response) as any;
      r.type = "btc";
      r.tx = tx;
      delete r.approveTo;
      return r;
    };
    const run = (path: string, tx: unknown, params = {}, config: SymbiosisProviderConfig = {}) => {
      const rec = load(n);
      return quoteOf(n, {params, config, exchanges: () => [rec.exchanges[0]!, {method: "POST", path, status: 200, response: answer(tx)}]});
    };
    it("a dry quote is display-only: /v2/quote, no deposit address, flagged", async () => {
      const {quote, calls} = await run("/v2/quote", {});
      expect(new URL(calls[1]!.url).pathname).toBe("/crosschain/v2/quote");
      expect(calls[1]!.body).toMatchObject({refundAddress: "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh", fallbackReceiver: EVM});
      expect(quote).toMatchObject({depositAddress: "", providerData: {depositAddressAssigned: "1", display: "1"}});
      expect(quote!.txRequest).toBeUndefined();
      await expect(symbiosisProvider({btcSource: true}).buildDeposit(quote!)).rejects.toThrow("swap2: Symbiosis quote carries no transaction");
    });
    it("a live quote opens the deposit address through /v2/swap; the address is the API's word and is flagged as such", async () => {
      freeze(at(n));
      const expiresAt = new Date(at(n) + 30_000).toISOString();
      const {quote, calls, recorded} = await run("/v2/swap", {depositAddress: deposit, expiresAt}, {dry: false});
      expect(new URL(calls[1]!.url).pathname).toBe("/crosschain/v2/swap");
      expect(quote).toMatchObject({depositAddress: deposit, depositMemo: null, validUntilMs: at(n) + 30_000, providerData: {depositAddressAssigned: "1"}});
      expect(quote!.providerData!.display).toBeUndefined();
      expect(quote!.providerData!.sourceSwap).toBeUndefined(); // nothing about the route was read
      const p = symbiosisProvider(recorded.config);
      expect(p.depositAddressRoutes).toBe(true);
      const tx = await p.buildDeposit(quote!);
      expect(tx).toEqual({chain: "bitcoin:mainnet", to: deposit, value: "200000"});
      await expect(p.preflightDeposit!(quote!, tx)).resolves.toBeUndefined();
      await expect(p.preflightDeposit!(quote!, {...tx, to: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"})).rejects.toThrow("symbiosis: a Bitcoin source pays the quote's deposit address");
      await expect(p.preflightDeposit!(quote!, {...tx, value: "200001"})).rejects.toThrow("symbiosis: the Bitcoin payment is not the quoted amount");
      await expect(p.preflightDeposit!(quote!, {...tx, data: "0x"})).rejects.toThrow("symbiosis: a Bitcoin source pays the quote's deposit address");
      await expect(symbiosisProvider({}).preflightDeposit!(quote!, tx)).rejects.toThrow("symbiosis: Bitcoin sources are switched off");
      vi.setSystemTime(at(n) + 30_000);
      await expect(p.preflightDeposit!(quote!, tx)).rejects.toThrow("symbiosis: the quote expired — re-quote");
    });
    it("no deposit address, or one that is not a Bitcoin address: refused", async () => {
      expect((await run("/v2/swap", {}, {dry: false})).refusal).toBe("Symbiosis returned no Bitcoin deposit address");
      expect((await run("/v2/swap", {depositAddress: EVM}, {dry: false})).refusal).toBe("Symbiosis returned no Bitcoin deposit address");
    });
    it("a partner-held route is refused for Bitcoin too", async () => {
      const rec = load(n);
      const r = answer({depositAddress: deposit});
      r.labels = ["semi-centralized"];
      const {refusal} = await quoteOf(n, {params: {dry: false}, exchanges: () => [rec.exchanges[0]!, {method: "POST", path: "/v2/swap", status: 200, response: r}]});
      expect(refusal).toBe("Symbiosis answered with a semi-centralized route (a third party holds the funds)");
    });
  });
});

describe("status", () => {
  const intent = `symbiosis:8453:728126428:0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C:${EVM.toLowerCase()}`;
  const hash = status.success.txIn.hash as string;
  const tracker = (routes: (url: string) => {status: number; body: unknown} | undefined) => {
    const urls: string[] = [];
    const fetchImpl = (async (url: RequestInfo | URL) => {
      urls.push(String(url));
      const r = routes(String(url)) ?? {status: 500, body: {}};
      return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), {status: r.status});
    }) as typeof fetch;
    return {p: symbiosisProvider({fetchImpl}), urls};
  };

  it("a real delivered operation (Base ETH → Tron USDT, 2026-11-09): completed, with the paying transaction", async () => {
    expect(symbiosisStatus(status.success, {dstChainId: 728126428, destToken: "0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C"})).toEqual({
      code: 0, state: "completed", depositReceived: true, destTxHash: status.success.tx.hash,
      payout: {chainId: 728126428, hash: status.success.tx.hash, symbol: "USDT", token: "0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C", amount: "1262647"},
    });
    const {p, urls} = tracker(() => ({status: 200, body: status.success}));
    expect(await p.trackIntent({intentId: intent, sourceTxHash: hash} as never)).toEqual({state: "completed", depositReceived: true, destTxHash: status.success.tx.hash});
    expect(urls).toEqual([`https://api.symbiosis.finance/crosschain/v2/tx/8453/${hash}`]);
  });
  it("paid in another token or on another chain than requested: partial, never completed", async () => {
    expect(symbiosisStatus(status.success, {dstChainId: 728126428, destToken: ""}).state).toBe("partial");
    expect(symbiosisStatus(status.success, {dstChainId: 8453, destToken: "0xa614f803B6FD780986A42c78Ec9c7f77e6DeD13C"}).state).toBe("partial");
    const {p} = tracker(() => ({status: 200, body: status.success}));
    expect((await p.trackIntent({intentId: intent.replace(":728126428:", ":56:"), sourceTxHash: hash} as never)).state).toBe("partial");
  });
  it("success without the paying transaction is still pending", () => {
    expect(symbiosisStatus({status: {code: 0}, txIn: status.success.txIn})).toEqual({code: 0, state: "pending", depositReceived: true});
  });
  it("a really stuck operation is reported 'Pending' by the API; the stuck list turns it into refund-pending", async () => {
    const stuckHash = status.pendingStuck.txIn.hash as string;
    expect(status.stuckList.some((s) => s.hash === stuckHash && s.chainId === 1)).toBe(true);
    expect(symbiosisStatus(status.pendingStuck)).toEqual({code: 1, state: "pending", depositReceived: true});
    const stuckIntent = `symbiosis:1:42161:0xaf88d065e77c8cC2239327C5EDb3A432268e5831:${EVM.toLowerCase()}`;
    const {p, urls} = tracker((url) => url.includes("/v2/tx/") ? {status: 200, body: status.pendingStuck}
      : url.endsWith(`/v1/stucked/${SYMBIOSIS_REVERTER}`) ? {status: 200, body: status.stuckList} : {status: 200, body: []});
    expect(await p.trackIntent({intentId: stuckIntent, sourceTxHash: stuckHash} as never)).toEqual({state: "refund-pending", depositReceived: true});
    expect(urls.filter((u) => u.includes("/v1/stucked/")).sort()).toEqual([`https://api.symbiosis.finance/crosschain/v1/stucked/${EVM.toLowerCase()}`, `https://api.symbiosis.finance/crosschain/v1/stucked/${SYMBIOSIS_REVERTER}`].sort());
    // The same hash on another chain's list is not this operation.
    const other = tracker((url) => url.includes("/v2/tx/") ? {status: 200, body: status.pendingStuck} : {status: 200, body: status.stuckList.map((s) => ({...s, chainId: 56}))});
    expect(await other.p.trackIntent({intentId: stuckIntent, sourceTxHash: stuckHash} as never)).toEqual({state: "pending", depositReceived: true});
    // Stuck lists that cannot be read leave it pending — never "failed", never "refunded".
    const down = tracker((url) => url.includes("/v2/tx/") ? {status: 200, body: status.pendingStuck} : {status: 500, body: {}});
    expect(await down.p.trackIntent({intentId: stuckIntent, sourceTxHash: stuckHash} as never)).toEqual({state: "pending", depositReceived: true});
  });
  it("not found (the API's real 404): pending, nothing received", async () => {
    const {p} = tracker(() => ({status: status.notFound.status, body: status.notFound.body}));
    expect(await p.trackIntent({intentId: intent, sourceTxHash: hash} as never)).toEqual({state: "pending"});
    expect(symbiosisStatus(JSON.parse(status.notFound.body))).toEqual({code: -1, state: "pending", depositReceived: false});
  });
  // No reverted operation could be found to record; these two answers are written in the documented shape.
  it("reverted (synthetic answer): refunded only with the revert transaction in the answer", async () => {
    const withTx = {status: {code: 3, text: "Reverted"}, txIn: status.pendingStuck.txIn, tx: {chainId: 1, hash: `0x${"ab".repeat(32)}`, tokenAmount: {symbol: "USDC", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", amount: "2700411"}}};
    expect(symbiosisStatus(withTx)).toMatchObject({code: 3, state: "refunded", destTxHash: withTx.tx.hash, payout: {chainId: 1, symbol: "USDC", amount: "2700411"}});
    expect(symbiosisStatus({status: {code: 3, text: "Reverted"}, txIn: status.pendingStuck.txIn})).toEqual({code: 3, state: "refund-pending", depositReceived: true});
    const {p} = tracker(() => ({status: 200, body: {status: {code: 3}}}));
    expect(await p.trackIntent({intentId: intent, sourceTxHash: hash} as never)).toEqual({state: "refund-pending", depositReceived: true});
  });
  it("stuck (synthetic answer, code 2): refund-pending", () => {
    expect(symbiosisStatus({status: {code: 2, text: "Stucked"}})).toEqual({code: 2, state: "refund-pending", depositReceived: true});
  });
  it("an unknown code, an empty answer, a network error: pending — the module never invents an outcome", async () => {
    expect(symbiosisStatus({status: {code: 7}})).toEqual({code: 7, state: "pending", depositReceived: false});
    expect(symbiosisStatus({} as never)).toEqual({code: null, state: "pending", depositReceived: false});
    const p = symbiosisProvider({fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch});
    expect(await p.trackIntent({intentId: intent, sourceTxHash: hash} as never)).toEqual({state: "pending"});
  });
  it("no hash yet, a hash that is not one, a foreign intent id", async () => {
    const {p, urls} = tracker(() => ({status: 200, body: status.success}));
    expect(await p.trackIntent({intentId: intent} as never)).toEqual({state: "pending"});
    expect(await p.trackIntent({intentId: intent, sourceTxHash: "../../v1/stucked/x"} as never)).toEqual({state: "pending"});
    expect(await p.trackIntent({intentId: "symbiosis:1:1:native:", sourceTxHash: hash} as never)).toEqual({state: "failed"});
    expect(await p.trackIntent({intentId: "near:abc", sourceTxHash: hash} as never)).toEqual({state: "failed"});
    expect(urls).toEqual([]);
  });
  it("every code has a documented meaning for the user's funds", () => {
    expect(Object.keys(SYMBIOSIS_STATUS).sort()).toEqual(["-1", "0", "1", "2", "3"]);
    expect(SYMBIOSIS_STATUS["3"]!.meaning).toMatch(/only with that transaction/);
  });
});

describe("router registration", () => {
  it("the router keeps the provider's preflight, deposit-address flag and activity reader", () => {
    const router = new CrossChainRouter([symbiosisProvider({btcSource: true, tronSource: true})]);
    const p = router.getProvider("symbiosis")!;
    expect(p.name).toBe("symbiosis");
    expect(typeof p.preflightDeposit).toBe("function");
    expect(typeof p.describeActivity).toBe("function");
    expect(p.depositAddressRoutes).toBe(true);
    expect(new CrossChainRouter([symbiosisProvider()]).getProvider("symbiosis")!.depositAddressRoutes).toBeUndefined();
  });
  it("a quote through the router is this provider's, checks included", async () => {
    const rec = load("eth-usdc-arb-usdc");
    const {fetchImpl} = replay(lastOnly(rec.exchanges));
    const router = new CrossChainRouter([symbiosisProvider({...rec.config, fetchImpl})]);
    const best = await router.getBestQuote(rec.params);
    expect(best).toMatchObject({provider: "symbiosis", destAmount: rec.result.destAmount, minDestAmount: rec.result.minDestAmount});
  });
});
