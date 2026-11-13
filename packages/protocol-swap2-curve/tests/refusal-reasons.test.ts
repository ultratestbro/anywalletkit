// Refusal reasons: every refusal keeps its text, byte for byte, and carries a stable `reason` next to it — on the
// provider's onRefusal, on what preflightDeposit / buildDeposit throw, and on what the pins' verify functions return
// (`reasonOf`). Driven through the real provider and the real JSON-RPC client over a stubbed global fetch.
import {afterEach, describe, expect, it, vi} from "vitest";
import {refusalOf, type Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {getAddress, type Hex} from "viem";
import {decodeExchange, encodeExchange, type RouterArgs} from "../src/abi.js";
import {ZERO_ADDRESS, type CurveDeployment} from "../src/deployments.js";
import {curveProvider} from "../src/provider.js";
import {RPC_RATE_LIMIT_PAUSE_MS, ethCall, rpcClient} from "../src/rpc.js";
import {curvePins, curveQuoteCheck, curveRemotePins} from "../src/verify.js";
import {D1, FAKE_USDT, FAKE_USDT_POOL, ME, OTHER, RPC, TABLES, TRIPOOL, UNLISTED_POOL, USDC, USDT, WETH, rpcStub} from "./fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const lc = (a: string) => a.toLowerCase();
const AMOUNT = 1_000_000_000n;
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
const make = (over: Record<string, unknown> = {}) => curveProvider({rpcUrls: RPC, ...TABLES, onWarning: () => {}, ...over});
const p1 = (over: Partial<QuoteParams> = {}): QuoteParams => ({...base, sourceToken: "USDC", destToken: USDT, amountIn: AMOUNT.toString(), ...over});

interface Heard {text: string; info: Swap2RefusalInfo | undefined; args: number}
/** The one refusal a getQuote made: its exact text, its classification, and how many arguments onRefusal got. */
async function refusal(params: Partial<QuoteParams>, provider = make(), signal?: AbortSignal): Promise<Heard> {
  const heard: Heard[] = [];
  const q = await provider.getQuote({...p1(), ...params, onRefusal: (...a: [string, Swap2RefusalInfo?]) => { heard.push({text: a[0], info: a[1], args: a.length}); }}, signal);
  expect(q).toBeNull();
  expect(heard).toHaveLength(1);
  return heard[0]!;
}
const thrown = async (p: Promise<unknown>): Promise<Error> => {
  try { await p; } catch (e) { return e as Error; }
  throw new Error("did not throw");
};

/** A global fetch answering every request with this status (and headers), or failing with this error. */
function answer(status: number | Error, headers: Record<string, string> = {}, body = "{}"): void {
  vi.stubGlobal("fetch", (async () => {
    if (status instanceof Error) throw status;
    return new Response(body, {status, headers});
  }) as typeof fetch);
}

describe("getQuote: the provider's own refusals", () => {
  const cases: [string, Partial<QuoteParams>, string, Swap2RefusalInfo["reason"]][] = [
    ["flexible deposits", {flex: true}, "curve: amount-flexible deposits are not supported", "unsupported_pair"],
    ["cross-chain", {destChain: "eip155:8453"}, "curve: same-chain swaps only", "unsupported_pair"],
    ["a chain without router, allowlist or RPC", {sourceChain: "eip155:8453", destChain: "eip155:8453"}, "curve: no Curve router, pool allowlist or RPC for eip155:8453", "unsupported_pair"],
    ["an unknown source token", {sourceToken: "NOPE"}, "curve: unknown source token NOPE", "unsupported_pair"],
    ["a non-EVM destination token", {destToken: "USDT"}, "curve: destination token must be an EVM address", "unsupported_pair"],
    ["a non-EVM recipient", {destAddress: "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI"}, "curve: recipient must be an EVM address", "recipient_mismatch"],
    ["a zero amount", {amountIn: "0"}, "curve: amount must be positive", "amount_too_small"],
    ["the router's sentinel as the output", {destToken: D1.eth}, "curve: name a native output with the zero address, not the router's 0xEeee sentinel", "unsupported_pair"],
    ["the same token", {destToken: USDC}, "curve: same token in and out", "unsupported_pair"],
    ["a wrap", {sourceToken: "ETH", destToken: WETH}, "curve: that is a wrap/unwrap, not a swap", "unsupported_pair"],
    ["no allowlisted route", {destToken: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", amountIn: "1000000"}, "curve: no allowlisted Curve pool route for this pair", "no_route"],
    ["a route through a denied pool only", {destToken: FAKE_USDT}, "curve: no allowlisted Curve pool route for this pair", "no_route"],
    ["no pool quotes the amount", {amountIn: "1", slippageBps: 10}, "curve: no allowlisted Curve pool quotes this pair and amount", "no_route"],
    ["a minimum that rounds to zero", {amountIn: "100", slippageBps: 9_999}, "curve: the minimum rounds to zero for this amount", "amount_too_small"],
    ["the caller's floor", {slippageBps: 10, minAmountOut: "999000000"}, "curve: floor breach (min=998000999 < floor=999000000)", "price_check_failed"],
  ];
  for (const [name, params, text, reason] of cases) {
    it(`${name} → ${reason}`, async () => {
      vi.stubGlobal("fetch", rpcStub());
      expect(await refusal(params)).toEqual({text, info: {reason}, args: 2});
    });
  }
  it("the router off its pin (code or version) → vault_mismatch", async () => {
    vi.stubGlobal("fetch", rpcStub({badRouterCode: true}));
    expect(await refusal({amountIn: "1000000"})).toEqual({text: "curve: the router on chain 1 is not the pinned code (code hash mismatch) — refusing", info: {reason: "vault_mismatch"}, args: 2});
    vi.stubGlobal("fetch", rpcStub({version: "1.1.0"}));
    expect(await refusal({amountIn: "1000000"})).toEqual({text: "curve: the router on chain 1 reports version 1.1.0, not 1.2.0 — refusing", info: {reason: "vault_mismatch"}, args: 2});
  });
  it("an invalid argument from the developer stays unclassified", async () => {
    vi.stubGlobal("fetch", rpcStub());
    expect(await refusal({amountIn: "1.5"})).toEqual({text: "curve: amount is not an integer", info: undefined, args: 1});
    expect(await refusal({slippageBps: 10_000})).toEqual({text: "curve: slippage must be 0..9999 bps", info: undefined, args: 1});
  });
});

describe("getQuote: RPC failures, through the real JSON-RPC client", () => {
  it("HTTP 5xx on every endpoint → upstream_unavailable with the status", async () => {
    vi.stubGlobal("fetch", rpcStub({down: ["https://rpc.test"]}));
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (HTTP 502)", info: {reason: "upstream_unavailable", httpStatus: 502}, args: 2});
  });
  it("HTTP 429 with Retry-After → rate_limited with the wait (after the one paused retry)", async () => {
    vi.useFakeTimers();
    answer(429, {"retry-after": "3"});
    const pending = refusal({});
    await vi.advanceTimersByTimeAsync(RPC_RATE_LIMIT_PAUSE_MS);
    expect(await pending).toEqual({text: "curve: no RPC answered on chain 1 (HTTP 429)", info: {reason: "rate_limited", retryAfterMs: 3_000, httpStatus: 429}, args: 2});
  });
  it("a rate-limit error inside an HTTP-200 batch (QuickNode -32007) → rate_limited", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", rpcStub({limited: ["https://rpc.test"]}));
    const pending = refusal({});
    await vi.advanceTimersByTimeAsync(RPC_RATE_LIMIT_PAUSE_MS);
    expect(await pending).toEqual({
      text: "curve: no RPC answered on chain 1 (50/second request limit reached - reduce calls per second or upgrade your account at quicknode.com)",
      info: {reason: "rate_limited"}, args: 2,
    });
  });
  it("HTTP 401 / 403 → key_rejected", async () => {
    answer(401);
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (HTTP 401)", info: {reason: "key_rejected", httpStatus: 401}, args: 2});
    answer(403);
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (HTTP 403)", info: {reason: "key_rejected", httpStatus: 403}, args: 2});
  });
  it("a network failure, the module's own timeout, or an answer that is not JSON → upstream_unavailable", async () => {
    answer(new TypeError("fetch failed"));
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (fetch failed)", info: {reason: "upstream_unavailable"}, args: 2});
    answer(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (The operation was aborted due to timeout)", info: {reason: "upstream_unavailable"}, args: 2});
    answer(200, {}, "<html>");
    let parse = "";
    try { JSON.parse("<html>"); } catch (e) { parse = (e as Error).message; }
    expect(await refusal({})).toEqual({text: `curve: no RPC answered on chain 1 (${parse})`, info: {reason: "upstream_unavailable"}, args: 2});
  });
  it("one JSON-RPC error as the whole body (no batch) naming a limit → rate_limited (after the one paused retry)", async () => {
    vi.useFakeTimers();
    answer(200, {}, JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32005, message: "limit exceeded"}}));
    const pending = refusal({});
    await vi.advanceTimersByTimeAsync(RPC_RATE_LIMIT_PAUSE_MS);
    expect(await pending).toEqual({text: "curve: no RPC answered on chain 1 (limit exceeded)", info: {reason: "rate_limited"}, args: 2});
  });
  it("one JSON-RPC error as the whole body that names no limit, or a body that is no batch at all → upstream_unavailable", async () => {
    answer(200, {}, JSON.stringify({jsonrpc: "2.0", id: null, error: {code: -32600, message: "boom"}}));
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (boom)", info: {reason: "upstream_unavailable"}, args: 2});
    answer(200, {}, JSON.stringify({jsonrpc: "2.0"}));
    expect(await refusal({})).toEqual({text: "curve: no RPC answered on chain 1 (batch refused)", info: {reason: "upstream_unavailable"}, args: 2});
  });
  it("rpcClient: a batch that leaves a call unanswered → upstream_unavailable", async () => {
    vi.stubGlobal("fetch", (async () => new Response(JSON.stringify([{jsonrpc: "2.0", id: 0, result: "0x"}]))) as typeof fetch);
    const e = await thrown(rpcClient({1: ["https://rpc.test"]})(1, [ethCall(TRIPOOL, "0x"), ethCall(TRIPOOL, "0x")]));
    expect(e.message).toBe("curve: no RPC answered on chain 1 (answered 1 of 2 calls)");
    expect(refusalOf(e)).toEqual({reason: "upstream_unavailable"});
  });
  it("the caller's own abort is not upstream_unavailable: the refusal stays unclassified", async () => {
    const inner = rpcStub();
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw init.signal.reason;
      return inner(input, init);
    }) as typeof fetch);
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await refusal({}, make(), ctrl.signal);
    expect(r).toEqual({text: `curve: no RPC answered on chain 1 (${(ctrl.signal.reason as Error).message})`, info: undefined, args: 1});
  });
  it("rpcClient: a chain with no endpoint is a configuration gap, unclassified", async () => {
    const e = await thrown(rpcClient({})(5, [ethCall(TRIPOOL, "0x")]));
    expect(e.message).toBe("curve: no RPC answered on chain 5 (undefined)");
    expect(refusalOf(e)).toBeUndefined();
  });
});

describe("preflightDeposit and buildDeposit throw classified errors, their texts as before", () => {
  async function sealed() {
    vi.stubGlobal("fetch", rpcStub());
    const p = make();
    const q = (await p.getQuote(p1({slippageBps: 10})))!;
    return {p, q, tx: await p.buildDeposit(q)};
  }
  const suffix = ". Nothing was sent; refresh the quote.";
  it("the sealed call: bytes, value, chain → policy_refused; the approval → vault_mismatch", async () => {
    const {p, q, tx} = await sealed();
    const cases: [Partial<typeof tx>, string, Swap2RefusalInfo["reason"]][] = [
      [{data: `${tx.data!.slice(0, -2)}00`}, "the transaction is not the quoted router call", "policy_refused"],
      [{value: "1"}, "the transaction's value is not the quote's", "policy_refused"],
      [{chainId: 10}, "the transaction is not for chain 1", "policy_refused"],
      [{approvalAddress: OTHER}, "the transaction's approval is not the quote's", "vault_mismatch"],
      [{to: OTHER}, `the transaction calls ${OTHER}, not the Curve router`, "vault_mismatch"],
    ];
    for (const [edit, text, reason] of cases) {
      const e = await thrown(p.preflightDeposit!(q, {...tx, ...edit}));
      expect(e.message).toBe(`curve: ${text}${suffix}`);
      expect(refusalOf(e), text).toEqual({reason});
      expect(e.constructor).toBe(Error);
    }
  });
  it("on chain: the price moved → price_check_failed; get_dy reverts → simulation_failed; a pool off its pin → vault_mismatch; an unreadable pool → upstream_unavailable", async () => {
    const {p, q, tx} = await sealed();
    const cases: [Parameters<typeof rpcStub>[0], string, Swap2RefusalInfo["reason"]][] = [
      [{rateBps: {[lc(TRIPOOL)]: 9_000}}, "price moved — the pools now pay 899999999, under your minimum 998000999", "price_check_failed"],
      [{revert: [TRIPOOL]}, "the router no longer quotes this route", "simulation_failed"],
      [{badPoolCode: [TRIPOOL]}, `pool 3pool (${TRIPOOL}) is not the pinned code`, "vault_mismatch"],
      [{coins: {[lc(TRIPOOL)]: {2: FAKE_USDT}}}, `pool 3pool now reports coin 2 = ${lc(FAKE_USDT)}, not the pinned ${USDT}`, "vault_mismatch"],
      [{noCode: [TRIPOOL]}, `could not read pool 3pool (${TRIPOOL}) over RPC`, "upstream_unavailable"],
    ];
    for (const [stub, text, reason] of cases) {
      vi.stubGlobal("fetch", rpcStub(stub));
      const e = await thrown(p.preflightDeposit!(q, tx));
      expect(e.message).toBe(`curve: ${text}${suffix}`);
      expect(refusalOf(e), text).toEqual({reason});
    }
  });
  it("an RPC failure in preflight surfaces as the client threw it, classified", async () => {
    const {p, q, tx} = await sealed();
    vi.stubGlobal("fetch", rpcStub({down: ["https://rpc.test"]}));
    const e = await thrown(p.preflightDeposit!(q, tx));
    expect(e.message).toBe("curve: no RPC answered on chain 1 (HTTP 502)");
    expect(refusalOf(e)).toEqual({reason: "upstream_unavailable", httpStatus: 502});
  });
  it("buildDeposit of a quote without its transaction → policy_refused", async () => {
    const {p, q} = await sealed();
    const {txRequest: _, ...bare} = q;
    const e = await thrown(p.buildDeposit(bare as Quote));
    expect(e.message).toBe("swap2: Curve quote has no transaction request");
    expect(refusalOf(e)).toEqual({reason: "policy_refused"});
  });
});

// ── The pins ──
function args(steps: readonly [string, string, string, readonly bigint[]][]): RouterArgs {
  const route: Hex[] = [getAddress(steps[0]![0]) as Hex];
  const params: bigint[][] = [];
  for (const [, swap, out, row] of steps) { route.push(getAddress(swap) as Hex, getAddress(out) as Hex); params.push([...row]); }
  while (route.length < 11) route.push(ZERO_ADDRESS);
  while (params.length < 5) params.push([0n, 0n, 0n, 0n, 0n]);
  return {route, params};
}
function quoteFor(d: CurveDeployment, a: RouterArgs, o: {min?: bigint; receiver?: string; to?: string; approval?: string} = {}): Quote {
  const min = o.min ?? 990_000_000n;
  return {
    provider: "curve", intentId: "curve:1:00000000000000aa", depositAddress: "", depositMemo: null,
    txRequest: {to: o.to ?? d.router, data: encodeExchange(d.family, a, AMOUNT, min, getAddress(o.receiver ?? ME) as Hex), value: "0", approvalAddress: o.approval ?? d.router},
    sourceAmount: AMOUNT.toString(), destAmount: "999000000", minDestAmount: min.toString(),
    feeUsd: 0, etaSeconds: 15, reliability: 0.97, validUntilMs: Date.now() + 60_000,
  };
}
const USDC_USDT = args([[USDC, TRIPOOL, USDT, [1n, 2n, 1n, 1n, 3n]]]);

describe("the pins: reasonOf classifies every text verifyQuote / verifyBuild return", () => {
  it("curvePins.verifyQuote texts, unchanged, with their reasons", () => {
    const verify = curveQuoteCheck(TABLES);
    const cases: [string | null, string, Swap2RefusalInfo["reason"]][] = [
      [curvePins.verifyQuote!(p1(), quoteFor(D1, USDC_USDT, {to: OTHER, approval: OTHER})), `the call targets ${OTHER}, not the Curve router`, "vault_mismatch"],
      [verify(p1(), quoteFor(D1, USDC_USDT, {receiver: OTHER})), `the swap pays ${OTHER}, not the recipient`, "recipient_mismatch"],
      [verify(p1(), quoteFor(D1, USDC_USDT, {min: 0n})), "the swap has no minimum (min_dy 0)", "price_check_failed"],
      [verify(p1({destChain: "eip155:8453"}), quoteFor(D1, USDC_USDT)), "not a same-chain swap on a pinned Curve router", "unsupported_pair"],
      [verify(p1({sourceToken: "NOPE"}), quoteFor(D1, USDC_USDT)), "unknown source token NOPE", "unsupported_pair"],
      [verify(p1(), {...quoteFor(D1, USDC_USDT), intentId: "curve:10:00000000000000aa"}), "the quote names curve:10:00000000000000aa, not a curve:1 swap", "policy_refused"],
      [verify(p1(), quoteFor(D1, args([[USDC, UNLISTED_POOL, USDT, [1n, 2n, 1n, 1n, 3n]]]))), `step 1 crosses ${getAddress(UNLISTED_POOL)}, which is not in the pool allowlist`, "vault_mismatch"],
      [verify(p1(), quoteFor(D1, args([[USDT, FAKE_USDT_POOL, FAKE_USDT, [1n, 0n, 1n, 10n, 2n]]]))), "the route starts at 0xdAC17F958D2ee523a2206206994597C13D831ec7, not the source token", "policy_refused"],
      [verify(p1({sourceToken: "USDT", destToken: FAKE_USDT}), quoteFor(D1, args([[USDT, FAKE_USDT_POOL, FAKE_USDT, [1n, 0n, 1n, 10n, 2n]]]))), `step 1 crosses ${getAddress(FAKE_USDT_POOL)}, a pool this module refuses (fake coin, drained in 2023, or over a dead venue)`, "vault_mismatch"],
      [verify(p1({destToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F"}), quoteFor(D1, USDC_USDT)), `the route ends at ${getAddress(USDT)}, not the destination token`, "price_check_failed"],
      [verify(p1(), quoteFor(D1, args([[USDC, TRIPOOL, USDT, [1n, 2n, 7n, 1n, 3n]]]))), "step 1 uses swap_type 7, which this module never builds", "policy_refused"],
    ];
    for (const [got, text, reason] of cases) {
      expect(got).toBe(text);
      expect(curvePins.reasonOf!(got!), text).toEqual({reason});
    }
    expect(curvePins.reasonOf!("a text no check returned")).toBeUndefined();
  });

  it("curveRemotePins.verifyBuild texts — on chain, over the app's RPCs — with their reasons", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const pins = curveRemotePins({rpcUrls: RPC, ...TABLES, onWarning: () => {}});
    const q = (await make().getQuote(p1()))!;
    const tx = {chain: "eip155:1", to: q.txRequest!.to!, data: q.txRequest!.data!, value: "0", approvalAddress: q.txRequest!.approvalAddress!};
    // The honest quote re-sealed by a hostile backend with a minimum of 1.
    const call = decodeExchange(D1.family, q.txRequest!.data!)!;
    const data = encodeExchange(D1.family, {route: call.route, params: call.params}, call.amount, 1n, getAddress(ME) as Hex);
    const low: Quote = {...q, minDestAmount: "1", providerData: {...q.providerData, minOut: "1"}, txRequest: {...q.txRequest!, data}};
    const cases: [string | null, string, Swap2RefusalInfo][] = [
      [await pins.verifyBuild(q, tx), "the request this quote answered is unknown", {reason: "policy_refused"}],
      [await pins.verifyBuild(q, {...tx, data: tx.data.replace(/.{2}$/, "ff")}, p1()), "the transaction is not the quoted router call", {reason: "policy_refused"}],
      [await pins.verifyBuild(low, {...tx, data}, p1()), "the swap's minimum 1 is more than 15 bps under the 998999999 the pools pay now", {reason: "price_check_failed"}],
    ];
    vi.stubGlobal("fetch", rpcStub({badRouterCode: true}));
    cases.push([await curveRemotePins({rpcUrls: RPC, ...TABLES, onWarning: () => {}}).verifyBuild(q, tx, p1()), "the router on chain 1 is not the pinned code (code hash mismatch) — refusing", {reason: "vault_mismatch"}]);
    vi.stubGlobal("fetch", rpcStub({down: ["https://rpc.test"]}));
    cases.push([await curveRemotePins({rpcUrls: RPC, ...TABLES, onWarning: () => {}}).verifyBuild(q, tx, p1()), "no RPC answered on chain 1 (HTTP 502)", {reason: "upstream_unavailable", httpStatus: 502}]);
    for (const [got, text, info] of cases) {
      expect(got).toBe(text);
      expect(pins.reasonOf!(got!), text).toEqual(info);
    }
  });

  it("through remoteProvider: the stub's refusal carries the reason the pins give its text", async () => {
    const hostile = quoteFor(D1, USDC_USDT, {receiver: OTHER});
    const fetchImpl = (async () => new Response(JSON.stringify(hostile))) as unknown as typeof fetch;
    const remote = remoteProvider({name: "curve", baseUrl: "https://swap.test", fetchImpl, ...curvePins});
    const e = await thrown(remote.getQuote(p1()));
    expect(e.message).toBe(`curve: the quote fails this app's own check — the swap pays ${OTHER}, not the recipient`);
    expect(refusalOf(e)).toEqual({reason: "recipient_mismatch"});
  });
});

describe("configuration errors are not refusals", () => {
  it("a bad option throws unclassified", () => {
    for (const build of [() => curveProvider({rpcUrls: RPC, defaultSlippageBps: 0}), () => curveRemotePins({rpcUrls: RPC, defaultSlippageBps: 5_000})]) {
      let e: unknown;
      try { build(); } catch (x) { e = x; }
      expect((e as Error).message).toBe("curve: defaultSlippageBps must be 1..4999");
      expect(refusalOf(e)).toBeUndefined();
    }
  });
});
