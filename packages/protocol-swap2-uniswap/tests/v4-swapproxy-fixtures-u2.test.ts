// U2 (UNISWAP-V4-RESEARCH §3.7, §5.2 U2, §6.5 S1–S14, §6.6, decisions 3 and 9, §9 U2): token input and native output
// through Uniswap's SwapProxy with v4 "all", replayed offline through the real provider from the recordings made
// read-only at Monad block 125,499,326 and Base block 62,413,790 from a funded holder (fixtures/rpc/*-token.json):
// Monad 700 USDC → AUSD and → MON (eth_simulateV1 is not served there: the allowance slot by stateDiff), Base 1,000
// USDC → ETH (eth_simulateV1). Then the approve + swap check failing every way it can — each refused before any
// approval, never skipped — the SwapProxy deployment check, and the remote corridor.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeErrorResult, getAddress, parseAbi, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UNISWAP_V3, uniswapPins, uniswapV3VerifyQuote, uniswapVerifyQuote} from "../src/addresses.js";
import {SWAP_PROXY_ABI, UNISWAP_V4, V4_SETTLE_ABI, V4_SWAP_INPUT_ABI, V4_TAKE_ABI} from "../src/v4/addresses.js";
import {BASE_TOKEN, HOLDER, MONAD_TOKEN, tokenReplay, type Odd, type SeenRequest, type TokenFixture} from "./v4-token-replay.js";

afterEach(() => vi.unstubAllGlobals());

const NATIVE = "0x0000000000000000000000000000000000000000";
const M_USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const M_AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
const B_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const D143 = UNISWAP_V4[143]!;
const D8453 = UNISWAP_V4[8453]!;
const RPC = {143: ["https://monad.fixture"], 8453: ["https://base.fixture"]};

const params = (chain: number, destToken: string, amountIn: string, extra: Partial<QuoteParams> = {}): QuoteParams => ({
  sourceChain: `eip155:${chain}`, destChain: `eip155:${chain}`, sourceToken: "USDC", destToken, amountIn, destAddress: HOLDER, refundAddress: HOLDER, sender: HOLDER, ...extra,
});
const USDC_AUSD = () => params(143, M_AUSD, "700000000");
const USDC_MON = () => params(143, NATIVE, "700000000");
const USDC_ETH = () => params(8453, NATIVE, "1000000000");

async function quote(fx: TokenFixture, p: QuoteParams, config: Partial<UniswapProviderConfig> = {}, odd?: Odd, provider?: CrossChainProvider) {
  const r = tokenReplay([fx], odd);
  vi.stubGlobal("fetch", r.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const pr = provider ?? uniswapProvider({rpcUrls: RPC, v4: "all", ...config});
  const q = await pr.getQuote({...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, misses: r.misses, seen: r.seen, provider: pr};
}

/** What a SwapProxy call does: its router, token, amount, commands, and the V4 input's SETTLE and TAKE. */
function openProxy(data: string) {
  const d = decodeFunctionData({abi: SWAP_PROXY_ABI, data: data as Hex});
  const [router, token, amount, commands, inputs] = d.args as readonly [string, string, bigint, Hex, readonly Hex[], bigint];
  const [actions, ps] = decodeAbiParameters(V4_SWAP_INPUT_ABI, inputs[0]!) as readonly [Hex, readonly Hex[]];
  const settle = decodeAbiParameters(V4_SETTLE_ABI, ps[1]!);
  const take = decodeAbiParameters(V4_TAKE_ABI, ps[2]!);
  return {router: getAddress(router), token: getAddress(token), amount, commands, actions, settle: {currency: getAddress(settle[0]), amount: settle[1], payerIsUser: settle[2]}, take: {currency: getAddress(take[0]), recipient: getAddress(take[1]), amount: take[2]}};
}
const methods = (seen: readonly SeenRequest[]) => seen.map((s) => s.method);
/** The state override an eth_call carried (third param), if any. */
const overrideOf = (s: SeenRequest) => (s.params[2] && typeof s.params[2] === "object" ? (s.params[2] as Record<string, {stateDiff?: Record<string, string>; code?: string}>) : undefined);

describe("the recordings", () => {
  it("hold no endpoint, and name their block and holder", () => {
    for (const fx of [MONAD_TOKEN, BASE_TOKEN]) {
      expect(JSON.stringify(fx)).not.toMatch(/https?:\/\//);
      expect(getAddress(fx.holder)).toBe(HOLDER);
    }
    expect([MONAD_TOKEN.block.number, BASE_TOKEN.block.number]).toEqual(["125499326", "62413790"]);
  });
});

describe("Monad 700 USDC → AUSD (v3 and v4 ranked): v4 through the SwapProxy, simulated with the allowance set by stateDiff", () => {
  it("v4 wins — 700.075685 AUSD on the hookless AUSD/USDC 0.005%/1 pool — as a SwapProxy call with an exact approval", async () => {
    const {q, heard, misses, seen} = await quote(MONAD_TOKEN, USDC_AUSD());
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "700075685", minDestAmount: "696575306", sourceAmount: "700000000", txRequest: {to: D143.swapProxy, value: "0", approvalAddress: D143.swapProxy, chainId: 143}});
    expect(q!.providerData).toMatchObject({venue: "v4", route: "v4 direct 0.005%/1", router: D143.universalRouter, currencyIn: M_USDC, currencyOut: M_AUSD, amountIn: "700000000", minOut: "696575306", sender: HOLDER, simulated: "approve+swap (allowance override)"});
    const call = openProxy(q!.txRequest!.data!);
    expect(call).toMatchObject({router: getAddress(D143.universalRouter), token: M_USDC, amount: 700_000_000n, commands: "0x10", actions: "0x060b0e"});
    expect(call.settle).toEqual({currency: M_USDC, amount: 700_000_000n, payerIsUser: false});
    expect(call.take).toEqual({currency: M_AUSD, recipient: HOLDER, amount: 0n});
    // The shipped pins accept it: SwapProxy is a call target and a spender there, and the strict check passes.
    expect(uniswapVerifyQuote(USDC_AUSD(), q!)).toBeNull();
    expect(uniswapPins.spenders("eip155:143")).toEqual([UNISWAP_V3[143]!.router, D143.swapProxy]);
    expect(uniswapPins.callTargets("eip155:143")).toEqual([UNISWAP_V3[143]!.router, D143.universalRouter, D143.swapProxy]);
    // …and 0.4.11's v3 check refuses it.
    expect(uniswapV3VerifyQuote(USDC_AUSD(), q!)).toMatch(/not the SwapRouter/);
    void seen;
  });

  it("the check before any approval: balance and allowance read; eth_simulateV1 answered 'not supported'; the slot from the access list, verified by read-back; the exact call from the bare account with that slot set", async () => {
    const {seen} = await quote(MONAD_TOKEN, USDC_AUSD());
    const m = methods(seen);
    expect(m.filter((x) => x === "eth_simulateV1")).toHaveLength(1);
    expect(m.filter((x) => x === "eth_createAccessList")).toHaveLength(1);
    expect(m.indexOf("eth_simulateV1")).toBeLessThan(m.indexOf("eth_createAccessList"));
    const sim = seen.find((s) => s.method === "eth_simulateV1")!;
    const calls = (sim.params[0] as {blockStateCalls: {calls: {from: string; to: string; data: string}[]}[]}).blockStateCalls[0]!.calls;
    expect(calls.map((c) => getAddress(c.to))).toEqual([M_USDC, getAddress(D143.swapProxy)]); // approve(amountIn), swap (no allowance stood: no approve(0))
    expect(calls.every((c) => getAddress(c.from) === HOLDER)).toBe(true);
    const swap = seen.filter((s) => s.method === "eth_call" && getAddress((s.params[0] as {to: string}).to) === getAddress(D143.swapProxy));
    expect(swap).toHaveLength(1);
    const o = overrideOf(swap[0]!)!;
    expect(Object.keys(o).map((a) => getAddress(a))).toEqual([M_USDC]);
    const [slot, word] = Object.entries(o[Object.keys(o)[0]!]!.stateDiff!)[0]!;
    expect(BigInt(word)).toBe(700_000_000n); // the allowance set to exactly the input
    expect(slot).toMatch(/^0x[0-9a-f]{64}$/);
    expect(getAddress((swap[0]!.params[0] as {from: string}).from)).toBe(HOLDER);
    expect(o[Object.keys(o)[0]!]!.code).toBeUndefined(); // the account's own code is kept
  });

  it('a second quote on the same provider goes straight to the fallback (eth_simulateV1 "not served" is remembered)', async () => {
    const {provider} = await quote(MONAD_TOKEN, USDC_AUSD());
    const again = await quote(MONAD_TOKEN, USDC_AUSD(), {}, undefined, provider);
    expect(again.q?.providerData?.simulated).toBe("approve+swap (allowance override)");
    expect(methods(again.seen)).not.toContain("eth_simulateV1");
    expect(methods(again.seen)).not.toContain("eth_createAccessList"); // the verified slot is cached too
  });
});

describe("Monad 700 USDC → MON (native output)", () => {
  it("ranked: v3 pays more at this block (63,720.35 MON) — the v3 quote, as 0.4.x built it", async () => {
    const {q, misses} = await quote(MONAD_TOKEN, USDC_MON());
    expect(misses).toEqual([]);
    expect(q).toMatchObject({destAmount: "63720350211657463338712", txRequest: {to: UNISWAP_V3[143]!.router, approvalAddress: UNISWAP_V3[143]!.router}});
    expect(q!.providerData!.venue).toBeUndefined();
  });

  it("v4 alone (no v3 table): TAKE(address(0), holder, 0) through the SwapProxy — the PoolManager pays MON", async () => {
    const {q, misses, heard} = await quote(MONAD_TOKEN, USDC_MON(), {deployments: {}});
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "63641550880969395582796", minDestAmount: "63323343126564548604882", txRequest: {to: D143.swapProxy, value: "0", approvalAddress: D143.swapProxy}, providerData: {venue: "v4", route: "v4 direct 0.05%/10", currencyOut: NATIVE, simulated: "approve+swap (allowance override)"}});
    expect(openProxy(q!.txRequest!.data!).take).toEqual({currency: NATIVE, recipient: HOLDER, amount: 0n});
    expect(uniswapVerifyQuote(USDC_MON(), q!)).toBeNull();
  });
});

describe("Base 1,000 USDC → ETH (eth_simulateV1 served)", () => {
  it("ranked: v3 pays more (0.592839 ETH) — the v3 quote", async () => {
    const {q, misses} = await quote(BASE_TOKEN, USDC_ETH());
    expect(misses).toEqual([]);
    expect(q).toMatchObject({destAmount: "592839376470210915", txRequest: {to: UNISWAP_V3[8453]!.router}});
  });

  it("v4 alone: the SwapProxy call, simulated as [approve(SwapProxy, 1,000 USDC), swap] in one eth_simulateV1 block", async () => {
    const {q, misses, seen} = await quote(BASE_TOKEN, USDC_ETH(), {deployments: {}});
    expect(misses).toEqual([]);
    expect(q).toMatchObject({destAmount: "592387949236107032", minDestAmount: "589426009489926496", txRequest: {to: D8453.swapProxy, value: "0", approvalAddress: D8453.swapProxy}, providerData: {venue: "v4", route: "v4 direct 0.05%/10", currencyIn: B_USDC, currencyOut: NATIVE, simulated: "approve+swap"}});
    expect(methods(seen)).not.toContain("eth_createAccessList");
    expect(uniswapVerifyQuote(USDC_ETH(), q!)).toBeNull();
    const call = openProxy(q!.txRequest!.data!);
    expect(call).toMatchObject({router: getAddress(D8453.universalRouter), token: B_USDC, amount: 1_000_000_000n});
    expect(call.take).toEqual({currency: NATIVE, recipient: HOLDER, amount: 0n});
  });
});

describe('where token input stays on v3: v4 "native-in", and a quote without a sender', () => {
  it('"native-in": Monad USDC → AUSD is the v3 quote, with no v4 read and no simulation', async () => {
    const {q, seen} = await quote(MONAD_TOKEN, USDC_AUSD(), {v4: "native-in"});
    expect(q?.txRequest?.to).toBe(UNISWAP_V3[143]!.router);
    expect(q?.providerData?.venue).toBeUndefined();
    expect(seen.some((s) => s.method === "eth_getCode" || s.method === "eth_simulateV1" || s.method === "eth_createAccessList")).toBe(false);
  });

  it('"all" without a sender (a price quote, nothing will be approved on it): the SwapProxy quote says simulated "none"', async () => {
    const {sender: _s, ...noSender} = USDC_AUSD();
    const {q, seen} = await quote(MONAD_TOKEN, noSender);
    expect(q).toMatchObject({destAmount: "700075685", providerData: {simulated: "none"}});
    expect(q!.providerData!.sender).toBeUndefined();
    expect(methods(seen)).not.toContain("eth_simulateV1");
  });

  it("an unlisted source token never rides the SwapProxy (catalog tokens only, R2): on a chain without v3 it is refused", async () => {
    const heard: string[] = [];
    vi.stubGlobal("fetch", tokenReplay([MONAD_TOKEN]).fetch);
    const q = await uniswapProvider({rpcUrls: RPC, v4: "all", deployments: {}}).getQuote({...USDC_AUSD(), sourceToken: "0x1111111111111111111111111111111111111111", onRefusal: (t: string) => { heard.push(t); }});
    expect(q).toBeNull();
    expect(heard[0]).toMatch(/unknown source token|catalog tokens only/);
  });
});

// ── The approve + swap check refusing (§6.6; vectors c1 and the token's own failures): before any approval, never skipped ──

const ERR = parseAbi([
  "error ExecutionFailed(uint256 commandIndex, bytes message)",
  "error CurrencyNotSettled()",
  "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)",
  "error Error(string)",
  "error NativeTransferFailed()",
  "error WrappedError(address target, bytes4 selector, bytes reason, bytes details)",
]);
const failed = (inner: Hex) => encodeErrorResult({abi: ERR, errorName: "ExecutionFailed", args: [0n, inner]});
const notSettled = failed(encodeErrorResult({abi: ERR, errorName: "CurrencyNotSettled"}));
const tooLittle = failed(encodeErrorResult({abi: ERR, errorName: "V4TooLittleReceived", args: [589426009489926496n, 1n]}));
const transferFromFailed = encodeErrorResult({abi: ERR, errorName: "Error", args: ["TRANSFER_FROM_FAILED"]});
const isSim = (s: SeenRequest) => s.method === "eth_simulateV1";
/**
 * Base's eth_simulateV1 answer with the swap step replaced — for every v4 candidate the provider builds: the recorded
 * answer for the best route's simulation, and the same shape (approvals succeeding) for a later candidate's, which the
 * recording does not hold. (Review R3-1: a later candidate's simulation left unanswered is a read no endpoint answered,
 * which refuses the quote with the node's reason; these vectors are about how the swap's own revert is classified.)
 */
function simWith(step: Record<string, unknown>): Odd {
  return (s) => {
    if (!isSim(s)) return undefined;
    const rec = BASE_TOKEN.calls[s.key] as {result: [{calls: Record<string, unknown>[]}]} | undefined;
    const sent = (s.params[0] as {blockStateCalls: [{calls: unknown[]}]}).blockStateCalls[0].calls;
    const blocks: [{calls: Record<string, unknown>[]}] = rec ? structuredClone(rec.result) : [{calls: sent.map(() => ({status: "0x1", returnData: `0x${"0".repeat(63)}1`, gasUsed: "0x1", logs: []}) as Record<string, unknown>)}];
    blocks[0].calls[blocks[0].calls.length - 1] = {...blocks[0].calls[blocks[0].calls.length - 1], ...step};
    return {result: blocks};
  };
}
const isProxyCall = (d4: typeof D143) => (s: SeenRequest) => s.method === "eth_call" && getAddress((s.params[0] as {to: string}).to) === getAddress(d4.swapProxy);

describe("the approve + swap check refuses before any approval", () => {
  const v4Only = {deployments: {}};
  it("c1: a partial fill under strict SETTLE (CurrencyNotSettled) → insufficient_liquidity", async () => {
    const {q, heard} = await quote(BASE_TOKEN, USDC_ETH(), v4Only, simWith({status: "0x0", returnData: notSettled, error: {code: 3, message: "execution reverted", data: notSettled}}));
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "insufficient_liquidity"});
    expect(heard[0]![0]).toMatch(/simulated with eth_simulateV1 from 0x[0-9a-fA-F]{40}\)\. Nothing was approved/);
  });
  it("the pool moved under the minimum (V4TooLittleReceived) → price_check_failed", async () => {
    const {q, heard} = await quote(BASE_TOKEN, USDC_ETH(), v4Only, simWith({status: "0x0", returnData: tooLittle}));
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "price_check_failed"});
  });
  it("the token refuses the pull (TRANSFER_FROM_FAILED, Monad's stateDiff path) → simulation_failed, the message named", async () => {
    const pull: Odd = (s) => (isProxyCall(D143)(s) ? {error: {code: 3, message: "execution reverted: TRANSFER_FROM_FAILED", data: transferFromFailed}} : undefined);
    // v4 alone (no v3 table): the quote is refused, the token's own reason named — the v4 quote is never returned.
    const {q, heard} = await quote(MONAD_TOKEN, USDC_AUSD(), {deployments: {}}, pull);
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "simulation_failed"});
    expect(heard[0]![0]).toMatch(/TRANSFER_FROM_FAILED.*with the allowance set by a state override/);
    // Review R2-2: with v3 on the chain the v4 build is set aside (the same refusal, to the operator's onV4Warning) and the
    // pair keeps its v3 quote — v4 being on never costs the v3 route (with v4 off this pair quotes on v3).
    const warned: Array<[string, unknown]> = [];
    const both = await quote(MONAD_TOKEN, USDC_AUSD(), {onV4Warning: (t, i) => { warned.push([t, i]); }}, pull);
    expect(both.heard).toEqual([]);
    expect(both.q).toMatchObject({txRequest: {to: UNISWAP_V3[143]!.router, approvalAddress: UNISWAP_V3[143]!.router}});
    expect(both.q!.providerData!.venue).toBeUndefined();
    expect(uniswapV3VerifyQuote(USDC_AUSD(), both.q!)).toBeNull();
    expect(warned).toEqual([[expect.stringMatching(/best Uniswap v4 route on chain 143 was set aside \(.*TRANSFER_FROM_FAILED.*\) — quoted v3/), {chainId: 143, reason: "simulation_failed"}]]);
  });
  it("the approval step fails in the simulated block → simulation_failed", async () => {
    const odd: Odd = (s) => {
      if (!isSim(s)) return undefined;
      const blocks = structuredClone((BASE_TOKEN.calls[s.key] as {result: [{calls: Record<string, unknown>[]}]}).result);
      blocks[0].calls[0] = {...blocks[0].calls[0], status: "0x0"};
      return {result: blocks};
    };
    const {q, heard} = await quote(BASE_TOKEN, USDC_ETH(), v4Only, odd);
    expect(q).toBeNull();
    expect(heard[0]).toEqual([expect.stringMatching(/approval of the SwapProxy fails in simulation/), {reason: "simulation_failed"}]);
  });
  it("a simulation in another shape (one call missing, an unknown status) → upstream_unavailable, never a pass", async () => {
    const short: Odd = (s) => (isSim(s) ? {result: [{calls: [{status: "0x1"}]}]} : undefined);
    const odd = simWith({status: "0x2"});
    for (const o of [short, odd]) {
      const {q, heard} = await quote(BASE_TOKEN, USDC_ETH(), v4Only, o);
      expect(q).toBeNull();
      expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
    }
  });
  it("the wallet holds less than it sells → simulation_failed before anything is simulated", async () => {
    const isBalance = (s: SeenRequest) => s.method === "eth_call" && String((s.params[0] as {data: string}).data).startsWith("0x70a08231");
    const {q, heard, seen} = await quote(BASE_TOKEN, USDC_ETH(), v4Only, (s) => (isBalance(s) ? {result: `0x${(999_999_999n).toString(16).padStart(64, "0")}`} : undefined));
    expect(q).toBeNull();
    expect(heard[0]).toEqual([expect.stringMatching(/the wallet holds 999999999 of the input, less than the 1000000000 it sells/), {reason: "simulation_failed"}]);
    expect(methods(seen)).not.toContain("eth_simulateV1");
  });
  it("the balance or allowance read unanswered → refused with the node's reason (rate_limited), never skipped", async () => {
    const isAllowance = (s: SeenRequest) => s.method === "eth_call" && String((s.params[0] as {data: string}).data).startsWith("0xdd62ed3e");
    const {q, heard} = await quote(BASE_TOKEN, USDC_ETH(), v4Only, (s) => (isAllowance(s) ? {error: {code: -32007, message: "50/second request limit reached"}} : undefined));
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "rate_limited"});
  }, 15_000);
  it("Monad: no eth_simulateV1, no access list, and the executor's eth_call unanswered → refused (never a silent skip, never the v3 quote)", async () => {
    const unsupported = {error: {code: -32601, message: "the method eth_createAccessList does not exist/is not available"}};
    // The executor's eth_call is not in the recording: the replay answers it -32603 on every attempt — no endpoint answered.
    const noSim: Odd = (s) => (s.method === "eth_createAccessList" ? unsupported : undefined);
    // Review R3-1: with v3 on the chain too, a read of the check that went unanswered refuses the quote with the node's
    // reason — the v3 quote (1.13 AUSD for 700 USDC at the live1 block) is never offered in its place. (Round 2 set the
    // build aside and quoted v3; that is kept for facts about the endpoint, the next test.)
    const warned: Array<[string, unknown]> = [];
    const both = await quote(MONAD_TOKEN, USDC_AUSD(), {onV4Warning: (t, i) => { warned.push([t, i]); }}, noSim);
    expect(both.q).toBeNull();
    expect(both.heard).toEqual([[expect.stringMatching(/^uniswap: no RPC answered on chain 143 \(-32603 not in the recording\)/), {reason: "upstream_unavailable"}]]);
    expect(warned).toEqual([]);
    // v4 alone: refused with the node's reason.
    const {q, heard, seen} = await quote(MONAD_TOKEN, USDC_AUSD(), {deployments: {}}, noSim);
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
    // It tried the executor: an eth_call to the holder itself with the executor installed as its code.
    const exec = seen.find((s) => s.method === "eth_call" && getAddress((s.params[0] as {to: string}).to) === HOLDER);
    expect(exec).toBeDefined();
    expect(overrideOf(exec!)![HOLDER.toLowerCase()] ?? overrideOf(exec!)![HOLDER]).toMatchObject({code: expect.stringMatching(/^0x3615603b57.*ca11bde05977b3631167028862be2a173976ca11.*5b00$/)});
  }, 15_000);
});

describe("review R3-1: a read of the approve + swap check that went unanswered refuses the quote (decision 5), ranked with v3", () => {
  // Monad 700 USDC → AUSD with v3 on the chain: v4 pays 700.075685 AUSD through the SwapProxy. Before, any of these reads
  // answered -32007 on every attempt set the v4 build aside and returned v3's quote; onRefusal heard nothing.
  const limited = {error: {code: -32007, message: "50/second request limit reached"}};
  const dataOf = (s: SeenRequest) => String((s.params[0] as {data?: string}).data ?? "");
  const isProxyCall143 = isProxyCall(D143);
  const reads: [string, (s: SeenRequest) => boolean][] = [
    ["the balance read", (s) => s.method === "eth_call" && dataOf(s).startsWith("0x70a08231")],
    ["the allowance read", (s) => s.method === "eth_call" && dataOf(s).startsWith("0xdd62ed3e") && overrideOf(s) === undefined],
    ["the access list", (s) => s.method === "eth_createAccessList"],
    ["the slot read-back under the override", (s) => s.method === "eth_call" && dataOf(s).startsWith("0xdd62ed3e") && overrideOf(s) !== undefined],
    ["the swap's eth_call with the allowance set by stateDiff", (s) => isProxyCall143(s) && overrideOf(s) !== undefined],
  ];
  for (const [what, match] of reads) {
    it(`${what} rate-limited on every attempt → refused rate_limited, never the v3 quote`, async () => {
      const warned: Array<[string, unknown]> = [];
      const {q, heard} = await quote(MONAD_TOKEN, USDC_AUSD(), {onV4Warning: (t, i) => { warned.push([t, i]); }}, (s) => (match(s) ? limited : undefined));
      expect(q).toBeNull();
      expect(heard).toEqual([[expect.stringMatching(/no RPC answered on chain 143 \(-32007 50\/second request limit reached\)/), {reason: "rate_limited"}]]);
      expect(warned).toEqual([]);
    }, 15_000);
  }
  it("the executor's eth_call rate-limited (no eth_simulateV1, no access list) → refused rate_limited", async () => {
    const unsupported = {error: {code: -32601, message: "the method eth_createAccessList does not exist/is not available"}};
    const isExec = (s: SeenRequest) => s.method === "eth_call" && getAddress((s.params[0] as {to: string}).to) === HOLDER;
    const {q, heard} = await quote(MONAD_TOKEN, USDC_AUSD(), {}, (s) => (s.method === "eth_createAccessList" ? unsupported : isExec(s) ? limited : undefined));
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "rate_limited"});
  }, 15_000);
  it("an HTTP 429 of every endpoint on the swap's eth_call (thrown, not a slot) → refused rate_limited", async () => {
    const r = tokenReplay([MONAD_TOKEN]);
    const proxy = isProxyCall(D143);
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as {method: string; params: unknown[]}[];
      if (batch.some((b) => proxy({method: b.method, params: b.params, key: ""}) && overrideOf({method: b.method, params: b.params, key: ""}) !== undefined)) return new Response("{}", {status: 429});
      return r.fetch(url, init);
    }) as typeof fetch);
    const heard: Array<[string, unknown]> = [];
    const q = await uniswapProvider({rpcUrls: RPC, v4: "all"}).getQuote({...USDC_AUSD(), onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/no RPC answered on chain 143 \(HTTP 429\)/), expect.objectContaining({reason: "rate_limited", httpStatus: 429})]]);
  });
  it("the healthy baseline on the same recording is the v4 quote (so each refusal above is the read's, not the pair's)", async () => {
    const {q, heard} = await quote(MONAD_TOKEN, USDC_AUSD());
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "700075685", txRequest: {to: D143.swapProxy}});
  });
  it("facts about the endpoint still fall back to v3 (review R2-2): the override not run (the executor answers 0x), or refused (-32602)", async () => {
    const unsupported = {error: {code: -32601, message: "the method eth_createAccessList does not exist/is not available"}};
    const isExec = (s: SeenRequest) => s.method === "eth_call" && getAddress((s.params[0] as {to: string}).to) === HOLDER;
    for (const [what, answer, reason] of [
      ["the override ignored", {result: "0x"}, "upstream_unavailable"],
      ["the override refused", {error: {code: -32602, message: "invalid argument 2: json: cannot unmarshal object into Go value of type string"}}, "upstream_unavailable"],
    ] as const) {
      const warned: Array<[string, unknown]> = [];
      const {q, heard} = await quote(MONAD_TOKEN, USDC_AUSD(), {onV4Warning: (t, i) => { warned.push([t, i]); }}, (s) => (s.method === "eth_createAccessList" ? unsupported : isExec(s) ? answer : undefined));
      expect(heard, what).toEqual([]);
      expect(q?.txRequest?.to, what).toBe(UNISWAP_V3[143]!.router);
      expect(uniswapV3VerifyQuote(USDC_AUSD(), q!), what).toBeNull();
      expect(warned, what).toEqual([[expect.stringMatching(/best Uniswap v4 route on chain 143 was set aside .* — quoted v3/), {chainId: 143, reason}]]);
    }
    // An access list the gateway refuses with -32602 is the same fact: the executor runs (here it succeeds: the v4 quote).
    const refused = {error: {code: -32602, message: "invalid params"}};
    const viaExecutor = await quote(MONAD_TOKEN, USDC_AUSD(), {}, (s) => (s.method === "eth_createAccessList" ? refused : isExec(s) ? {result: encodeAbiParameters([{type: "tuple[]", components: [{name: "success", type: "bool"}, {name: "returnData", type: "bytes"}]}], [[{success: true, returnData: "0x"}, {success: true, returnData: "0x"}]])} : undefined));
    expect(viaExecutor.q?.providerData?.simulated).toBe("approve+swap (executor override)");
    expect(viaExecutor.seen.filter((s) => s.method === "eth_createAccessList")).toHaveLength(1); // a fact: not retried
  }, 30_000);
});

describe("the executor fallback (no eth_simulateV1, no allowance slot)", () => {
  const MC3 = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
  const unsupported = (m: string) => ({error: {code: -32601, message: `the method ${m} does not exist/is not available`}});
  const executor = (answer: (calls: readonly {target: string; callData: Hex}[]) => {success: boolean; returnData: Hex}[]): Odd => (s) => {
    if (s.method === "eth_simulateV1" || s.method === "eth_createAccessList") return unsupported(s.method);
    const c = s.params[0] as {to?: string; data?: Hex};
    if (s.method === "eth_call" && c.to && getAddress(c.to) === HOLDER) {
      const [calls] = decodeFunctionData({abi: MC3, data: c.data!}).args as readonly [readonly {target: string; callData: Hex}[]];
      return {result: encodeAbiParameters([{type: "tuple[]", components: [{name: "success", type: "bool"}, {name: "returnData", type: "bytes"}]}], [answer(calls)])};
    }
    return undefined;
  };
  it("runs approve → swap as the account through Multicall3 in one eth_call: simulated \"approve+swap (executor override)\"", async () => {
    let plan: readonly {target: string; callData: Hex}[] = [];
    const {q} = await quote(BASE_TOKEN, USDC_ETH(), {deployments: {}}, executor((calls) => { plan = calls; return calls.map(() => ({success: true, returnData: "0x" as Hex})); }));
    expect(q?.providerData?.simulated).toBe("approve+swap (executor override)");
    expect(plan.map((c) => getAddress(c.target))).toEqual([B_USDC, getAddress(D8453.swapProxy)]);
    expect(plan[0]!.callData.slice(0, 10)).toBe("0x095ea7b3"); // approve(SwapProxy, exactly the input)
    expect(BigInt(`0x${plan[0]!.callData.slice(74)}`)).toBe(1_000_000_000n);
  });
  it("a native output the account cannot take (NativeTransferFailed wrapped by the PoolManager) → recipient_mismatch", async () => {
    const wrapped = encodeErrorResult({abi: ERR, errorName: "WrappedError", args: [HOLDER, "0x00000000", "0x", encodeErrorResult({abi: ERR, errorName: "NativeTransferFailed"})]});
    const {q, heard} = await quote(BASE_TOKEN, USDC_ETH(), {deployments: {}}, executor((calls) => calls.map((_c, i) => (i === calls.length - 1 ? {success: false, returnData: failed(wrapped)} : {success: true, returnData: "0x" as Hex}))));
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "recipient_mismatch"});
    expect(heard[0]![0]).toMatch(/by an executor installed as the account's code/);
  });
});

describe("the SwapProxy deployment check (§6.5 row 15, S1)", () => {
  const isProxyCode = (s: SeenRequest) => s.method === "eth_getCode" && getAddress(String(s.params[0])) === getAddress(D143.swapProxy);
  it("another SwapProxy build turns token input off on the chain: ranked → the v3 quote; v4 alone → refused", async () => {
    const odd: Odd = (s) => (isProxyCode(s) ? {result: "0x6080604052"} : undefined);
    const ranked = await quote(MONAD_TOKEN, USDC_AUSD(), {}, odd);
    expect(ranked.q?.txRequest?.to).toBe(UNISWAP_V3[143]!.router);
    expect(ranked.seen.some((s) => s.method === "eth_simulateV1")).toBe(false);
    const alone = await quote(MONAD_TOKEN, USDC_AUSD(), {deployments: {}}, odd);
    expect(alone.q).toBeNull();
    expect(alone.heard[0]).toEqual(["uniswap: the Uniswap v4 deployment on chain 143 does not match its pins — refusing", {reason: "vault_mismatch"}]);
  });
  it('"native-in" never reads the SwapProxy\'s code (it never calls it)', async () => {
    const {seen} = await quote(MONAD_TOKEN, params(143, M_AUSD, "1", {sourceToken: "MON"}), {v4: "native-in"});
    expect(seen.some(isProxyCode)).toBe(false);
  });
});

// ── The remote corridor (§5.5): a backend with v4 "all", apps on old and new pins ──

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
function backend(config: Partial<UniswapProviderConfig>): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [uniswapProvider({rpcUrls: RPC, ...config})], sealSecret: SECRET, guard: () => {}, subject: () => "app"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "app");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}
const V3_ONLY = (chain: string): readonly string[] => {
  const id = Number(chain.slice(7));
  return Object.prototype.hasOwnProperty.call(UNISWAP_V3, id) ? [UNISWAP_V3[id]!.router] : [];
};
const PINS_0411 = {callTargets: V3_ONLY, spenders: V3_ONLY, verifyQuote: uniswapV3VerifyQuote, reasonOf: uniswapPins.reasonOf!};
async function appQuote(server: Partial<UniswapProviderConfig>, pins: typeof PINS_0411 | typeof uniswapPins): Promise<{q: Quote | null; error?: unknown; stub: CrossChainProvider}> {
  vi.stubGlobal("fetch", tokenReplay([MONAD_TOKEN]).fetch);
  const stub = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server), supportsSameChain: true, ...pins});
  try {
    return {q: await stub.getQuote(USDC_AUSD()), stub};
  } catch (error) {
    return {q: null, error, stub};
  }
}

describe("remote corridor: token input through the SwapProxy", () => {
  it('server v4 "all", app on 0.4.11 pins: the SwapProxy quote is refused (hence the server flag)', async () => {
    const {q, error, stub} = await appQuote({v4: "all"}, PINS_0411);
    expect(q).toBeNull();
    expect(String((error as Error).message)).toMatch(/fails this app's own check — the call targets 0x0000000085E102724e78eCd2F45DC9cA239Affad, not the SwapRouter/);
    expect(stub.spenders!("eip155:143")).not.toContain(D143.swapProxy);
  });
  it('server v4 "native-in", app on 0.4.11 pins: token input stays v3 and keeps working', async () => {
    const {q, error, stub} = await appQuote({v4: "native-in"}, PINS_0411);
    expect(error).toBeUndefined();
    expect(q?.txRequest?.to).toBe(UNISWAP_V3[143]!.router);
    expect(remotePinRefusal(stub, q!, "eip155:143")).toBeNull();
  });
  it('server v4 "all", app on 0.5.0 pins: the SwapProxy quote passes the app\'s strict check, its call targets and its spenders', async () => {
    const {q, error, stub} = await appQuote({v4: "all"}, uniswapPins);
    expect(error).toBeUndefined();
    expect(q).toMatchObject({destAmount: "700075685", txRequest: {to: D143.swapProxy, approvalAddress: D143.swapProxy, value: "0"}, providerData: {venue: "v4", simulated: "approve+swap (allowance override)"}});
    expect(remotePinRefusal(stub, q!, "eip155:143")).toBeNull();
  });
  it("a compromised backend's SwapProxy quote is refused by the app's pins: another router (f5/f6), TAKE to itself (f4), 2 × the amount (f7)", async () => {
    const {q} = await quote(MONAD_TOKEN, USDC_AUSD());
    const data = q!.txRequest!.data!.toLowerCase();
    const ur = D143.universalRouter.slice(2).toLowerCase();
    const evil = "2222222222222222222222222222222222222222";
    const amount = (700_000_000n).toString(16).padStart(64, "0");
    const variants: [string, string, RegExp][] = [
      ["router", data.replace(ur, "fdf682f51fe81aa4898f0ae2163d8a55c127fbc7"), /forwards to 0xfdf682f51fe81aa4898f0ae2163d8a55c127fbc7, not the pinned Universal Router/i],
      ["recipient", data.split(HOLDER.slice(2).toLowerCase()).join(evil), /TAKE pays 0x2222222222222222222222222222222222222222, not the recipient/],
      ["amount", data.replace(amount, (1_400_000_000n).toString(16).padStart(64, "0")), /the SwapProxy pulls another amount than the request's input/],
    ];
    for (const [what, d, re] of variants) {
      expect(d, what).not.toBe(data);
      expect(uniswapVerifyQuote(USDC_AUSD(), {...q!, txRequest: {...q!.txRequest!, data: d}}), what).toMatch(re);
    }
  });
});
