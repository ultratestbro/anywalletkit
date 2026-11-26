import {describe, expect, it} from "vitest";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult, encodeFunctionResult, parseAbi, toFunctionSelector, type Hex} from "viem";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {MULTICALL3, V4_UNLISTED_GRID, discoverV4Pools, pairSetOf, type V4EthCall, type V4Pool} from "../src/v4/discover.js";
import {V4_ERRORS, V4_QUOTER_ABI, buildV4Routes, classifyV4QuoteRevert, measureV4Impact, multicallBatch, quoteCallData, quoteV4Routes, v4ProbeImpactBps, v4SpotLossBps, v4SpotOut, type V4CallBatch, type V4Route} from "../src/v4/quote.js";
import {V4_NATIVE as NATIVE_ADDRESS} from "../src/v4/addresses.js";
import {checkedHooklessKey, checkedMaxFeePips, poolIdOf} from "../src/v4/pool.js";
import type {V4ChainPools} from "../src/v4pools/types.js";

const V4_NATIVE: Hex = NATIVE_ADDRESS;

/**
 * Monad (143) recorded at one block (tests/fixtures/v4/monad-discover-quote.json, keys = to|blockTag|sha256(calldata)):
 * discovery through Multicall3 on the pinned StateView, V4Quoter candidates through Multicall3, the probe. The list the
 * recording used is in the fixture, so a later rebuild of src/v4pools does not move these numbers.
 */
interface Fixture {block: number; blockTag: Hex; list: V4ChainPools; calls: Record<string, Hex>}
const fx = JSON.parse(readFileSync(new URL("./fixtures/v4/monad-discover-quote.json", import.meta.url), "utf8")) as Fixture;
const sha = (s: string) => createHash("sha256").update(s.toLowerCase()).digest("hex");
const keyOf = (to: string, tag: string, data: string) => `${to.toLowerCase()}|${tag}|${sha(data)}`;
/** Replays the recording; `edit` may rewrite an answer; every request is logged. */
function replay(edit?: (key: string, answer: Hex, data: Hex) => Hex) {
  const seen: {to: Hex; data: Hex; tag: string}[] = [];
  const ethCall: V4EthCall = async (c, tag) => {
    seen.push({...c, tag});
    const k = keyOf(c.to, tag, c.data);
    const a = fx.calls[k];
    if (!a) throw new Error(`no recorded answer for ${k}`);
    return edit ? edit(k, a, c.data) : a;
  };
  return {ethCall, seen};
}

const SV: Hex = "0x77395F3b2E73aE90843717371294fa97cC419D64";
const QUOTER: Hex = "0xa222Dd357A9076d1091Ed6Aa2e16C9742dD26891";
const WMON: Hex = "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A";
const USDC: Hex = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const USDT0: Hex = "0xe7cd86e13AC4309349F30B3435a9d337750fC82D";
const AUSD: Hex = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const UNLISTED: Hex = "0xdcd8114f42fd40db1914de241c75adc9e3c1722e";
const LOOKALIKE: Hex = "0x530639a4ad89dd2d5ff31ee4a4b5ef01cb8d0656";
const HUBS: Hex[] = [V4_NATIVE, WMON, USDC, USDT0];
const MON = 10n ** 18n;
const DEEP_MON_USDC = "0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954";
const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const RESULTS = [{type: "tuple[]", components: [{name: "success", type: "bool"}, {name: "returnData", type: "bytes"}]}] as const;
/** aggregate3's Result[] answer, decoded / re-encoded. */
const results = (hex: Hex) => [...decodeAbiParameters(RESULTS, hex)[0]] as {success: boolean; returnData: Hex}[];
const answer = (rs: readonly {success: boolean; returnData: Hex}[]) => encodeFunctionResult({abi: MC3, functionName: "aggregate3", result: rs});
const SLOT0 = [{type: "uint160"}, {type: "int24"}, {type: "uint24"}, {type: "uint24"}] as const;

async function quote(currencyIn: Hex, currencyOut: Hex, amountIn: bigint, ethCall: V4EthCall) {
  const d = await discoverV4Pools({stateView: SV, currencyIn, currencyOut, hubs: HUBS, list: fx.list, blockTag: fx.blockTag}, ethCall);
  const routes = buildV4Routes({currencyIn, currencyOut, pools: d.pools, hubs: HUBS});
  const batch = multicallBatch(ethCall, fx.blockTag);
  const q = await quoteV4Routes({quoter: QUOTER, routes, amountIn}, batch);
  const m = q.best ? await measureV4Impact({quoter: QUOTER, route: q.best.route, amountIn, amountOut: q.best.amountOut}, batch) : {};
  return {d, routes, q, m};
}

describe("v4 discovery + quotes, Monad recorded fixture", () => {
  it("62,000 MON → AUSD: one aggregate3 of listed reads at the pinned block; MON → USDC (0.05%/10) → AUSD (0.005%/1) wins at ≈680 AUSD", async () => {
    const {ethCall, seen} = replay();
    const {d, routes, q, m} = await quote(V4_NATIVE, AUSD, 62_000n * MON, ethCall);
    expect(d.requests).toBe(1);
    expect(d.grid).toBe(false);
    expect(d.pools.every((p) => p.source === "listed")).toBe(true);
    expect(d.pools.map((p) => p.id)).toContain(DEEP_MON_USDC); // the pool a 429-shrunk grid lost in the research
    expect(seen.every((s) => s.to.toLowerCase() === MULTICALL3.toLowerCase() && s.tag === fx.blockTag)).toBe(true);
    // 1 discovery + ceil(15 routes / 10 per aggregate) quote batches + 1 probe; no aggregate above the 50M-gas-safe size.
    expect(routes).toHaveLength(15);
    expect(seen).toHaveLength(1 + 2 + 1);
    expect(seen.map((s) => (decodeFunctionData({abi: MC3, data: s.data}).args[0] as readonly unknown[]).length)).toEqual([34, 10, 5, 1]);
    expect(routes.every((r) => r.hops.length <= 2)).toBe(true);
    expect(q.best!.route.label).toMatch(/^v4 via 0x754704Bc059F8C67012fEd69BC8A327a5aafb603 0\.05%\/10 → 0\.005%\/1$/);
    expect(q.best!.route.hops.map((h) => h.pool.id)[0]).toBe(DEEP_MON_USDC);
    expect(q.best!.amountOut).toBe(679_795_032n); // 679.80 AUSD (research: v4 675–684; the v3 module 1.13)
    expect(q.best!.gasEstimate).toBeGreaterThan(20_000n);
    expect(m.probeBps).toBeLessThan(100);
    expect(m.spotBps).toBeLessThan(100);
    expect(m.impactBps).toBe(Math.max(m.probeBps!, m.spotBps!));
  });

  it("100 MON → AUSD: the 9-pip AUSD/USDC pool wins the second leg", async () => {
    const {q} = await quote(V4_NATIVE, AUSD, 100n * MON, replay().ethCall);
    expect(q.best!.route.label).toMatch(/0\.3%\/60 → 0\.0009%\/1$/);
    expect(q.best!.amountOut).toBe(1_098_733n);
  });

  it("1e9 MON: NotEnoughLiquidity (wrapped by the quoter) is a partial fill, and what still fills reads ≈99.7% impact", async () => {
    const {q, m} = await quote(V4_NATIVE, AUSD, 10n ** 27n, replay().ethCall);
    expect(q.partial).toBe(true);
    const partial = q.candidates.filter((c) => c.outcome === "partial");
    expect(partial.length).toBeGreaterThan(0);
    expect(partial.every((c) => c.error === V4_ERRORS.NotEnoughLiquidity)).toBe(true);
    expect(m.impactBps).toBeGreaterThan(9_900);
  });

  it("an unlisted token adds the union grid, only for the pairs that touch it, in a second request for the initialized keys", async () => {
    const {ethCall, seen} = replay();
    const {d, q} = await quote(UNLISTED, USDC, MON, ethCall);
    expect(d.grid).toBe(true);
    expect(d.requests).toBe(2);
    expect(seen).toHaveLength(2 + 1 + 1); // discovery ×2, one quote batch (1 route), the probe
    const pairs = pairSetOf(UNLISTED, USDC, HUBS);
    const touching = [...pairs].filter((p) => p.includes(UNLISTED.toLowerCase())).length;
    expect(d.reads).toBeGreaterThanOrEqual(touching * V4_UNLISTED_GRID.length);
    expect(d.pools.some((p) => p.source === "grid")).toBe(true);
    expect(q.best!.route.label).toBe("v4 direct 0.3%/60");
    const back = await quote(USDC, UNLISTED, 10n ** 6n, replay().ethCall);
    expect(back.q.best!.amountOut).toBe(232_425_776_943_912_086_833n);
  });

  it("a look-alike token with no live hookless pool: the grid runs and nothing qualifies (no route, not a failure)", async () => {
    const {d, routes, q} = await quote(LOOKALIKE, USDC, MON, replay().ethCall);
    expect(d.grid).toBe(true);
    expect(d.requests).toBe(1);
    expect(routes).toHaveLength(0);
    expect(q).toEqual({best: null, partial: false, unexecutable: 0, candidates: []});
  });
});

describe("v4 discovery refuses instead of shrinking the candidate set", () => {
  const discover = (ethCall: V4EthCall, extra: Partial<Parameters<typeof discoverV4Pools>[0]> = {}) =>
    discoverV4Pools({stateView: SV, currencyIn: V4_NATIVE, currencyOut: AUSD, hubs: HUBS, list: fx.list, blockTag: fx.blockTag, ...extra}, ethCall);
  /** Rewrites the recorded discovery answer for MON → AUSD (34 sub-calls). */
  const editDiscovery = (f: (rs: {success: boolean; returnData: Hex}[]) => void) => replay((_k, a) => {
    const rs = results(a);
    if (rs.length !== 34) return a;
    f(rs);
    return answer(rs);
  }).ethCall;

  it("one failed sub-call → upstream_unavailable, never a smaller set", async () => {
    await expect(discover(editDiscovery((rs) => { rs[5] = {success: false, returnData: "0x"}; }))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable" && /refusing rather than quoting from fewer pools/.test(String(e)));
  });
  it("an answer of the wrong size, a wrong count, or another shape → upstream_unavailable", async () => {
    await expect(discover(editDiscovery((rs) => { rs[1] = {success: true, returnData: "0x00"}; }))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    await expect(discover(editDiscovery((rs) => { rs.pop(); }))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    await expect(discover(replay(() => "0x").ethCall)).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
  });
  it("the caller's own classification rides through (a 429 is rate_limited); an unclassified error is upstream_unavailable", async () => {
    const {withReason} = await import("@anywalletkit/protocol-swap2-core/errors");
    await expect(discover(async () => { throw withReason(new Error("HTTP 429"), {reason: "rate_limited", retryAfterMs: 1000}); })).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "rate_limited" && refusalOf(e)?.retryAfterMs === 1000);
    await expect(discover(async () => { throw new Error("socket hang up"); })).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
  });
  it("a pinned pool reading as uninitialized, or with another LP fee, is a wrong read → refused", async () => {
    const zeroSlot0 = encodeAbiParameters(SLOT0, [0n, 0, 0, 0]);
    await expect(discover(editDiscovery((rs) => { rs[0] = {success: true, returnData: zeroSlot0}; }))).rejects.toThrow(/reads as uninitialized/);
    const otherFee = editDiscovery((rs) => {
      const [p, t, pf] = decodeAbiParameters(SLOT0, rs[0]!.returnData);
      rs[0] = {success: true, returnData: encodeAbiParameters(SLOT0, [p, t, pf, 1])};
    });
    await expect(discover(otherFee)).rejects.toThrow(/reads lpFee 1/);
  });
  it("only a successful read of zero liquidity means 'no pool': every pool at L = 0 → an empty set", async () => {
    const zero = encodeAbiParameters([{type: "uint128"}], [0n]);
    const d = await discover(editDiscovery((rs) => { for (let i = 1; i < rs.length; i += 2) rs[i] = {success: true, returnData: zero}; }));
    expect(d.pools).toEqual([]);
  });
  it("the fee cap applies to the list (can be lowered, never raised), hubs are capped", async () => {
    const all = await discover(replay().ethCall);
    expect(all.pools.every((p) => p.key.fee <= 100_000)).toBe(true);
    // A lower cap drops pools before reading them: answer the smaller request from the recorded 34 reads.
    const full = recordedDiscovery();
    const low = await discover(async (c) => {
      const asked = decodeFunctionData({abi: MC3, data: c.data}).args[0] as readonly {callData: Hex}[];
      return answer(asked.map((x) => full.answers[full.callData.indexOf(x.callData)]!));
    }, {maxFeePips: 500});
    expect(low.pools.length).toBeGreaterThan(0);
    expect(low.pools.every((p) => p.key.fee <= 500)).toBe(true);
    expect(low.pools.length).toBeLessThan(all.pools.length);
    expect(() => checkedMaxFeePips(100_001)).toThrow(/1\.\.100000/);
    await expect(discover(replay().ethCall, {maxFeePips: 200_000})).rejects.toThrow(/v4MaxFeePips/);
    await expect(discover(replay().ethCall, {hubs: [USDC, USDT0, WMON, V4_NATIVE, LOOKALIKE, UNLISTED, AUSD]})).rejects.toThrow(/at most 6 hub/);
    await expect(discover(replay().ethCall, {stateView: QUOTER})).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "vault_mismatch");
  });
  it("v4ExtraPools: hookless only (a hooked entry throws), the PoolId is recomputed, an integrator pool that does not exist is skipped", async () => {
    await expect(discover(replay().ethCall, {extraPools: [{currency0: V4_NATIVE, currency1: AUSD, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000080"}]})).rejects.toThrow(/only hookless pools/);
    await expect(discover(replay().ethCall, {extraPools: [{currency0: AUSD, currency1: V4_NATIVE, fee: 3000, tickSpacing: 60}]})).rejects.toThrow(/not in order/);
    // An integrator key that was never initialized reads as zeros: skipped, not refused (it is not a pinned pool).
    const ghost = {currency0: V4_NATIVE, currency1: AUSD, fee: 4242, tickSpacing: 42};
    const full = recordedDiscovery();
    const withGhost = await discover(async () => answer([...full.answers, {success: true, returnData: encodeAbiParameters(SLOT0, [0n, 0, 0, 0])}, {success: true, returnData: encodeAbiParameters([{type: "uint128"}], [0n])}]), {extraPools: [ghost]});
    expect(withGhost.pools.map((p) => p.id)).not.toContain(poolIdOf(ghost));
    expect(withGhost.pools.length).toBe((await discover(replay().ethCall)).pools.length);
    // A live integrator pool joins the set with source "extra".
    const live = await discover(async () => answer([...full.answers, {success: true, returnData: encodeAbiParameters(SLOT0, [1n << 96n, 0, 0, 4242])}, {success: true, returnData: encodeAbiParameters([{type: "uint128"}], [5n])}]), {extraPools: [ghost]});
    expect(live.pools.find((p) => p.id === poolIdOf(ghost))?.source).toBe("extra");
  });
});

/** The recorded MON → AUSD discovery (34 sub-calls): each sub-call's calldata and its recorded answer. */
function recordedDiscovery(): {callData: Hex[]; answers: {success: boolean; returnData: Hex}[]} {
  for (const a of Object.values(fx.calls)) {
    const rs = results(a);
    if (rs.length !== 34) continue;
    // Rebuild the request deterministically (same pools, same order) to pair calldata with answers.
    const ids = fx.list.pools.filter((p) => pairSetOf(V4_NATIVE, AUSD, HUBS).has([p.currency0, p.currency1].map((x) => x.toLowerCase()).join(":")));
    const callData = ids.flatMap((p) => [`0xc815641c${p.id.slice(2)}`, `0xfa6793d5${p.id.slice(2)}`]) as Hex[];
    return {callData, answers: rs};
  }
  throw new Error("no recorded 34-read discovery");
}

describe("v4 quotes: revert classification and strict answers", () => {
  const pool = (o: Partial<V4Pool["state"]> = {}, key = {currency0: V4_NATIVE, currency1: AUSD, fee: 500, tickSpacing: 10}): V4Pool => ({
    key: checkedHooklessKey(key), id: poolIdOf(key), source: "listed", state: {sqrtPriceX96: 1n << 96n, tick: 0, protocolFee: 0, lpFee: key.fee, liquidity: 10n ** 18n, ...o},
  });
  const route = (p = pool()): V4Route => buildV4Routes({currencyIn: V4_NATIVE, currencyOut: AUSD, pools: [p], hubs: []})[0]!;
  const ok = (out: bigint, gas = 50_000n) => ({ok: true as const, data: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [out, gas])});
  const nel = encodeErrorResult({abi: parseAbi(["error NotEnoughLiquidity(bytes32 poolId)"]), errorName: "NotEnoughLiquidity", args: [`0x${"ab".repeat(32)}`]});
  const wrap = (inner: Hex) => encodeErrorResult({abi: parseAbi(["error UnexpectedRevertBytes(bytes revertData)"]), errorName: "UnexpectedRevertBytes", args: [inner]});

  it("the quoter selectors are the deployed ones (research §3.3)", () => {
    expect(toFunctionSelector(V4_QUOTER_ABI.find((x) => x.type === "function" && x.name === "quoteExactInputSingle")!)).toBe("0xaa9d21cb");
    expect(toFunctionSelector(V4_QUOTER_ABI.find((x) => x.type === "function" && x.name === "quoteExactInput")!)).toBe("0xca253dc9");
    expect(nel.slice(0, 10)).toBe(V4_ERRORS.NotEnoughLiquidity);
    expect(wrap(nel).slice(0, 10)).toBe(V4_ERRORS.UnexpectedRevertBytes);
  });
  it("NotEnoughLiquidity raw or wrapped (even twice) is partial; another error drops the candidate; no data is 'empty'", () => {
    expect(classifyV4QuoteRevert(nel).kind).toBe("partial");
    expect(classifyV4QuoteRevert(wrap(nel)).kind).toBe("partial");
    expect(classifyV4QuoteRevert(wrap(wrap(nel))).kind).toBe("partial");
    expect(classifyV4QuoteRevert(V4_ERRORS.PoolNotInitialized)).toEqual({kind: "dropped", selector: V4_ERRORS.PoolNotInitialized});
    expect(classifyV4QuoteRevert(wrap(V4_ERRORS.PriceLimitAlreadyExceeded))).toEqual({kind: "dropped", selector: V4_ERRORS.PriceLimitAlreadyExceeded});
    expect(classifyV4QuoteRevert("0x")).toEqual({kind: "empty"});
    expect(classifyV4QuoteRevert(`${V4_ERRORS.UnexpectedRevertBytes}00` as Hex).kind).toBe("dropped");
  });
  it("picks the best full fill; partial fills are out; a revert without data refuses the quote", async () => {
    const a = pool(), b = pool({}, {currency0: V4_NATIVE, currency1: AUSD, fee: 3000, tickSpacing: 60});
    const routes = buildV4Routes({currencyIn: V4_NATIVE, currencyOut: AUSD, pools: [a, b], hubs: []});
    const fixed = (outs: V4CallBatch extends (...a: never[]) => Promise<infer R> ? R : never): V4CallBatch => async () => outs;
    const best = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, fixed([ok(5n), {ok: false, revert: wrap(nel)}]));
    expect(best.best!.amountOut).toBe(5n);
    expect(best.partial).toBe(true);
    const onlyPartial = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, fixed([{ok: false, revert: nel}, {ok: false, revert: wrap(nel)}]));
    expect(onlyPartial).toMatchObject({best: null, partial: true});
    await expect(quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, fixed([ok(5n), {ok: false, revert: "0x"}]))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    await expect(quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, fixed([ok(5n)]))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    await expect(quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, fixed([ok(5n), {ok: true, data: "0x00"}]))).rejects.toThrow(/not 64/);
    await expect(quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, async () => { throw new Error("ECONNRESET"); })).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    const tie = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON}, fixed([ok(5n), ok(5n)]));
    expect(tie.best!.route.poolFee).toBe("0.05%"); // equal output: the lower fee wins, deterministically
  });
  it("LIVE-1: with the chain's per-transaction gas bound, a call without revert data is read again alone at that bound", async () => {
    const a = pool(), b = pool({}, {currency0: V4_NATIVE, currency1: AUSD, fee: 3000, tickSpacing: 60});
    const routes = buildV4Routes({currencyIn: V4_NATIVE, currencyOut: AUSD, pools: [a, b], hubs: []});
    const fixed = (outs: V4CallBatch extends (...a: never[]) => Promise<infer R> ? R : never): V4CallBatch => async () => outs;
    const asked: {to: Hex; data: Hex}[][] = [];
    const bound = (answer: (c: {to: Hex; data: Hex}) => {ok: true; data: Hex} | {ok: false; revert: Hex}) => ({cap: 30_000_000n, calls: async (cs: readonly {to: Hex; data: Hex}[]) => { asked.push([...cs]); return cs.map(answer); }});
    // Still without data at the bound (the quoter's inner call starved even with every gas a transaction may have): the
    // route can never be mined — out, counted — and the other route wins.
    const gasBomb = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: bound(() => ({ok: false, revert: wrap("0x")}))}, fixed([{ok: false, revert: wrap("0x")}, ok(5n)]));
    expect(gasBomb.best!.amountOut).toBe(5n);
    expect(gasBomb.unexecutable).toBe(1);
    expect(gasBomb.candidates.map((c) => c.outcome)).toEqual(["unexecutable", "quoted"]);
    expect(asked.at(-1)).toEqual([{to: QUOTER, data: quoteCallData(routes[0]!, MON)}]); // only the empty one, straight to the quoter
    // Raw "0x" at the bound too.
    expect((await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: bound(() => ({ok: false, revert: "0x"}))}, fixed([{ok: false, revert: "0x"}, ok(5n)]))).unexecutable).toBe(1);
    // It answers at the bound (it only starved inside the aggregate): a candidate like any other — and it can win.
    const answered = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: bound(() => ok(9n))}, fixed([{ok: false, revert: "0x"}, ok(5n)]));
    expect(answered).toMatchObject({unexecutable: 0, best: {amountOut: 9n}});
    expect(answered.best!.route).toBe(routes[0]);
    // Revert data at the bound: classified as usual (a partial fill here), never "too much gas".
    const partialAgain = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: bound(() => ({ok: false, revert: wrap(nel)}))}, fixed([{ok: false, revert: "0x"}, ok(5n)]));
    expect(partialAgain).toMatchObject({unexecutable: 0, partial: true, best: {amountOut: 5n}});
    // Every route too heavy: no best, and the count says why.
    const none = await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: bound(() => ({ok: false, revert: "0x"}))}, fixed([{ok: false, revert: "0x"}, {ok: false, revert: wrap("0x")}]));
    expect(none).toMatchObject({best: null, partial: false, unexecutable: 2});
    // The node does not answer the read at the bound: refused, never "too much gas".
    const unanswered = {cap: 30_000_000n, calls: async () => { throw new Error("HTTP 503"); }};
    await expect(quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: unanswered}, fixed([{ok: false, revert: "0x"}, ok(5n)]))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    const short = {cap: 30_000_000n, calls: async () => []};
    await expect(quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: short}, fixed([{ok: false, revert: "0x"}, ok(5n)]))).rejects.toSatisfy((e: unknown) => refusalOf(e)?.reason === "upstream_unavailable");
    // Nothing is read again when no call came back empty.
    asked.length = 0;
    await quoteV4Routes({quoter: QUOTER, routes, amountIn: MON, gasBound: bound(() => ok(1n))}, fixed([ok(4n), ok(5n)]));
    expect(asked).toEqual([]);
  });
  it("multicallBatch: an aggregate the node refuses for gas, or one whose sub-calls starved, is split down to single calls — nothing dropped", async () => {
    const calls = Array.from({length: 7}, (_, i) => ({to: QUOTER, data: `0x0000000${i}` as Hex}));
    const sizes: number[] = [];
    const ethCall: V4EthCall = async (c) => {
      const inner = decodeFunctionData({abi: MC3, data: c.data}).args[0] as readonly {callData: Hex}[];
      sizes.push(inner.length);
      if (inner.length > 3) throw new Error("out of gas"); // the node's eth_call cap
      return answer(inner.map((x, j) => (inner.length > 1 && j === inner.length - 1
        ? {success: false, returnData: wrap("0x")} // the quoter's inner call starved: UnexpectedRevertBytes("")
        : {success: true, returnData: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [BigInt(Number.parseInt(x.callData.slice(2), 16) + 1), 1n])})));
    };
    const out = await multicallBatch(ethCall, fx.blockTag, MULTICALL3, 10)(calls);
    expect(out.map((o) => (o.ok ? Number(decodeAbiParameters([{type: "uint256"}], o.data)[0]) : "x"))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sizes[0]).toBe(7);
    expect(Math.min(...sizes)).toBe(1);
    // A single call that still fails without revert data stays a failure: the quote refuses.
    const starved: V4EthCall = async () => answer([{success: false, returnData: "0x"}]);
    const r = buildV4Routes({currencyIn: V4_NATIVE, currencyOut: AUSD, pools: [pool()], hubs: []});
    await expect(quoteV4Routes({quoter: QUOTER, routes: r, amountIn: MON}, multicallBatch(starved, fx.blockTag))).rejects.toThrow(/without revert data/);
    await expect(multicallBatch(async () => { throw new Error("HTTP 503"); }, fx.blockTag)(calls)).rejects.toThrow(/503/);
  });
  it("amounts beyond uint128 are refused before any call", () => {
    expect(() => quoteCallData(route(), 1n << 128n)).toThrow(/uint128/);
    try { quoteCallData(route(), 1n << 128n); } catch (e) { expect(refusalOf(e)?.reason).toBe("amount_too_large"); }
  });
  it("routes: ≤ 2 pools, never through the input or output currency, the deepest pools per pair first", () => {
    const deep = pool({liquidity: 10n ** 20n}, {currency0: V4_NATIVE, currency1: USDC, fee: 500, tickSpacing: 10});
    const thin = pool({liquidity: 1n}, {currency0: V4_NATIVE, currency1: USDC, fee: 100, tickSpacing: 1});
    const leg2 = pool({}, {currency0: AUSD, currency1: USDC, fee: 50, tickSpacing: 1});
    const rs = buildV4Routes({currencyIn: V4_NATIVE, currencyOut: AUSD, pools: [thin, deep, leg2], hubs: [USDC, V4_NATIVE, AUSD, USDC], maxPerLeg: 1});
    expect(rs).toHaveLength(1);
    expect(rs[0]!.hops.map((h) => h.pool.id)).toEqual([deep.id, leg2.id]);
    expect(rs[0]!.hops.map((h) => h.zeroForOne)).toEqual([true, false]);
    const data = quoteCallData(rs[0]!, MON);
    const {args} = decodeFunctionData({abi: V4_QUOTER_ABI, data}) as unknown as {args: [{exactCurrency: Hex; path: {intermediateCurrency: Hex; hooks: Hex; hookData: Hex}[]}]};
    expect(args[0].exactCurrency).toBe(V4_NATIVE);
    expect(args[0].path.map((p) => p.intermediateCurrency)).toEqual([USDC, AUSD]);
    expect(args[0].path.every((p) => p.hooks === V4_NATIVE && p.hookData === "0x")).toBe(true);
  });
  it("spot: the fee-free mid output from sqrtPriceX96 in both directions; the loss includes the fees; the probe needs ≥ 1000 units", async () => {
    // sqrtP = 2^96 × 2 → price 4 currency1 per currency0.
    const p = pool({sqrtPriceX96: 2n << 96n});
    const zf1 = route(p);
    expect(v4SpotOut(zf1, 1000n)).toBe(4000n);
    const back = buildV4Routes({currencyIn: AUSD, currencyOut: V4_NATIVE, pools: [p], hubs: []})[0]!;
    expect(v4SpotOut(back, 4000n)).toBe(1000n);
    expect(v4SpotLossBps(zf1, 1000n, 3980n)).toBe(50);
    expect(v4SpotLossBps(zf1, 1000n, 4100n)).toBe(0);
    expect(v4SpotLossBps(route(pool({sqrtPriceX96: 1n})), 1n, 1n)).toBeUndefined();
    expect(await v4ProbeImpactBps({quoter: QUOTER, route: zf1, amountIn: 999n, amountOut: 1n}, async () => [ok(1n)])).toBeUndefined();
    let calls = 0;
    const flaky: V4CallBatch = async () => { if (calls++ === 0) throw new Error("timeout"); return [ok(4n)]; };
    expect(await v4ProbeImpactBps({quoter: QUOTER, route: zf1, amountIn: 1000n, amountOut: 3000n}, flaky)).toBe(2500);
    expect(await v4ProbeImpactBps({quoter: QUOTER, route: zf1, amountIn: 1000n, amountOut: 3000n}, async () => [{ok: false, revert: nel}])).toBeUndefined();
    const none = await measureV4Impact({quoter: QUOTER, route: route(pool({sqrtPriceX96: 1n})), amountIn: 1n, amountOut: 1n}, async () => []);
    expect(none).toEqual({});
  });
  it("PoolId and key checks: the research vector, order, spacing, dynamic fee, hooks", () => {
    expect(poolIdOf({currency0: V4_NATIVE, currency1: AUSD, fee: 500, tickSpacing: 1})).toBe("0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219");
    expect(() => checkedHooklessKey({currency0: V4_NATIVE, currency1: AUSD, fee: 0x800000, tickSpacing: 1})).toThrow(/static/);
    expect(() => checkedHooklessKey({currency0: V4_NATIVE, currency1: AUSD, fee: 500, tickSpacing: 0})).toThrow(/tickSpacing/);
    expect(() => checkedHooklessKey({currency0: V4_NATIVE, currency1: AUSD, fee: 100_001, tickSpacing: 1})).toThrow(/cap/);
    expect(() => checkedHooklessKey({currency0: V4_NATIVE, currency1: V4_NATIVE, fee: 500, tickSpacing: 1})).toThrow(/order/);
  });
});
