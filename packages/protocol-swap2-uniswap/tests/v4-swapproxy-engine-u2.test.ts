// U2 (UNISWAP-V4-RESEARCH §6.4, §6.5 S1–S14, §9 U2 acceptance): the token-in-path matrix of gaps/token-in-path §3.2
// (f1–f15, c1–c8, d1–d4) refused before any approval — by the shipped pins (`uniswapPins.verifyQuote`, dispatched on
// `tx.to`), and through a remote stub driven by the real engine, which then sends nothing — while the honest SwapProxy
// flow goes through the engine as exactly approve(SwapProxy, amountIn) → SwapProxy.execute, and a failure after the
// approval revokes it. Then the token preflight right before signing.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeAbiParameters, encodeErrorResult, getAddress, parseAbi, parseAbiParameters, type Hex} from "viem";
import {createMockAccount} from "@anywalletkit/conformance";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {uniswapPins} from "../src/addresses.js";
import {uniswapProvider} from "../src/provider.js";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {PERMIT2_ADDRESS, UNISWAP_V4, V4_ACTION_CONSTANTS} from "../src/v4/addresses.js";
import {UNISWAP_V4_POOL_KEYS} from "../src/v4/listed.js";
import {uniswapV4ReasonOf, uniswapV4VerifyQuote} from "../src/v4/verify.js";
import {
  ATTACKER, AUSD, AUSD_USDC_50_1, D143, MON_AUSD_10000_200, MON_USDC_500_10, NATIVE, NOW_MS, RECIPIENT, UR211_143, USDC, USER, e1, makeCase, nativeInputOf, proxyExecute, settle, single, take, urExecute, v4Input, withTx, type Case,
} from "./v4-helpers.js";
import {BASE_TOKEN, HOLDER, tokenReplay, type Odd, type SeenRequest} from "./v4-token-replay.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ── The matrix (the same vectors as v4-verify.test.ts, here through the shipped pins and the engine) ──

const AMOUNT = 100n * 10n ** 18n;
const usdcToAusd = (): Case => makeCase({currencyIn: USDC, currencyOut: AUSD, pools: [AUSD_USDC_50_1], amountIn: 700_000_000n, amountOutMinimum: 696_555_000n});
const usdcToMon = (): Case => makeCase({currencyIn: USDC, currencyOut: NATIVE, pools: [MON_USDC_500_10], amountIn: 700_000_000n, amountOutMinimum: 60_000n * 10n ** 18n});
const tokenWith = (data: Hex, tx: Partial<NonNullable<Quote["txRequest"]>> = {}): [QuoteParams, Quote] => {
  const c = usdcToAusd();
  return [c.params, withTx(c, {data, ...tx})];
};
const nativeWith = (data: Hex, tx: Partial<NonNullable<Quote["txRequest"]>> = {}): [QuoteParams, Quote] => {
  const c = makeCase();
  return [c.params, withTx(c, {data, ...tx})];
};
const tokenInput = (o: {take?: Hex; settle?: Hex; swap?: Hex; actions?: number[]} = {}): Hex =>
  v4Input(o.actions ?? [0x06, 0x0b, 0x0e], [
    o.swap ?? single({poolKey: AUSD_USDC_50_1, zeroForOne: false, amountIn: 700_000_000n, amountOutMinimum: 696_555_000n}),
    o.settle ?? settle(USDC, 700_000_000n),
    o.take ?? take(AUSD, RECIPIENT),
  ]);
const sweepIn = (token: `0x${string}`, to: `0x${string}`) => encodeAbiParameters(parseAbiParameters("address token, address recipient, uint256 amountMin"), [token, to, 0n]);
const allInput = (min: bigint, currency: `0x${string}` = AUSD) => encodeAbiParameters(parseAbiParameters("address, uint256"), [currency, min]);
const monSwap = single({poolKey: MON_USDC_500_10, zeroForOne: false, amountIn: 700_000_000n, amountOutMinimum: 60_000n * 10n ** 18n});
const proxy = (input: Hex, o: {router?: `0x${string}`; amount?: bigint; commands?: Hex; inputs?: Hex[]; deadline?: bigint} = {}) =>
  proxyExecute(o.router ?? D143.universalRouter, USDC, o.amount ?? 700_000_000n, o.commands ?? "0x10", o.inputs ?? [input], o.deadline);
const nowS = BigInt(NOW_MS / 1000);
const monWith = (data: Hex): [QuoteParams, Quote] => { const c = usdcToMon(); return [c.params, withTx(c, {data})]; };
const VECTORS: [string, () => [QuoteParams, Quote]][] = [
  ["f1 TAKE_ALL(AUSD)", () => tokenWith(proxy(tokenInput({actions: [0x06, 0x0b, 0x0f], take: allInput(696_555_000n)})))],
  ["f2 TAKE(AUSD, MSG_SENDER)", () => tokenWith(proxy(tokenInput({take: take(AUSD, V4_ACTION_CONSTANTS.MSG_SENDER)})))],
  ["f3 TAKE(AUSD, ADDRESS_THIS)", () => tokenWith(proxy(tokenInput({take: take(AUSD, V4_ACTION_CONSTANTS.ADDRESS_THIS)})))],
  ["f4 TAKE(AUSD, attacker)", () => tokenWith(proxy(tokenInput({take: take(AUSD, ATTACKER)})))],
  ["f5 router = UR 2.1.1", () => tokenWith(proxy(tokenInput(), {router: UR211_143}))],
  ["f6 router = EVIL_ROUTER", () => tokenWith(proxy(tokenInput(), {router: ATTACKER}))],
  ["f7 amount = 2 × amountIn", () => tokenWith(proxy(tokenInput(), {amount: 1_400_000_000n}))],
  ["f8 0x10 0x04 with SWEEP(USDC, attacker), amount 2 ×", () => tokenWith(proxy(tokenInput(), {amount: 1_400_000_000n, commands: "0x1004", inputs: [tokenInput(), sweepIn(USDC, ATTACKER)]}))],
  ["f9 SETTLE payerIsUser = true", () => tokenWith(proxy(tokenInput({settle: settle(USDC, 700_000_000n, true)})))],
  ["f10 command byte 0x90", () => tokenWith(proxy(tokenInput(), {commands: "0x90"}))],
  ["f11 deadline = now − 1", () => tokenWith(proxy(tokenInput(), {deadline: nowS - 1n}))],
  ["f12 USDC → MON, TAKE_ALL(native)", () => monWith(proxy(v4Input([0x06, 0x0b, 0x0f], [monSwap, settle(USDC, 700_000_000n), allInput(1n, NATIVE)])))],
  ["f13 USDC → MON, TAKE(native, MSG_SENDER)", () => monWith(proxy(v4Input([0x06, 0x0b, 0x0e], [monSwap, settle(USDC, 700_000_000n), take(NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER)])))],
  ["f14 USDC → MON, TAKE(native, ADDRESS_THIS)", () => monWith(proxy(v4Input([0x06, 0x0b, 0x0e], [monSwap, settle(USDC, 700_000_000n), take(NATIVE, V4_ACTION_CONSTANTS.ADDRESS_THIS)])))],
  ["f15 TAKE(AUSD, user, amount = min)", () => tokenWith(proxy(tokenInput({take: take(AUSD, RECIPIENT, 696_555_000n)})))],
  ["c2 SETTLE(OPEN_DELTA)", () => tokenWith(proxy(tokenInput({settle: settle(USDC, 0n)})))],
  ["c3 SETTLE_ALL under the SwapProxy", () => tokenWith(proxy(tokenInput({actions: [0x06, 0x0c, 0x0e], settle: allInput(700_000_000n, USDC)})))],
  ["c4 SETTLE_ALL via Permit2", () => tokenWith(urExecute("0x10", [tokenInput({actions: [0x06, 0x0c, 0x0e], settle: allInput(700_000_000n, USDC)})]), {to: D143.universalRouter, approvalAddress: PERMIT2_ADDRESS})],
  ["c5 strict SETTLE payerIsUser via Permit2", () => tokenWith(urExecute("0x10", [tokenInput({settle: settle(USDC, 700_000_000n, true)})]), {to: D143.universalRouter, approvalAddress: PERMIT2_ADDRESS})],
  ["c6 SETTLE(CONTRACT_BALANCE)", () => tokenWith(proxy(tokenInput({settle: settle(USDC, V4_ACTION_CONSTANTS.CONTRACT_BALANCE)})))],
  ["c7 SETTLE(OPEN_DELTA) + TAKE + SWEEP(AUSD, user)", () => tokenWith(proxy(tokenInput({settle: settle(USDC, 0n)}), {commands: "0x1004", inputs: [tokenInput({settle: settle(USDC, 0n)}), sweepIn(AUSD, RECIPIENT)]}))],
  ["c8 … + SWEEP(AUSD, MSG_SENDER)", () => tokenWith(proxy(tokenInput(), {commands: "0x1004", inputs: [tokenInput(), sweepIn(AUSD, V4_ACTION_CONSTANTS.MSG_SENDER)]}))],
  ["d1 SwapProxy.execute with value 1 wei", () => tokenWith(usdcToAusd().quote.txRequest!.data! as Hex, {value: "1"})],
  ["d2 native 100 MON, value × 1.01", () => nativeWith(e1.calldata_2_1_x, {value: ((AMOUNT * 101n) / 100n).toString()})],
  ["d3 overpay, SETTLE_ALL + TAKE + SWEEP(native, MSG_SENDER)", () => nativeWith(urExecute("0x1004", [nativeInputOf({actions: [0x06, 0x0c, 0x0e], settle: allInput(AMOUNT, NATIVE)}), sweepIn(NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER)]), {value: ((AMOUNT * 101n) / 100n).toString()})],
  ["d4 Permit2 flow with a stray value", () => tokenWith(urExecute("0x10", [tokenInput({settle: settle(USDC, 700_000_000n, true)})]), {to: D143.universalRouter, approvalAddress: PERMIT2_ADDRESS, value: "1000000000000000"})],
];
/** c1 is a well-formed call (strict SETTLE on the thin pool): no calldata check can refuse it; the simulation does. */
const c1 = () => makeCase({currencyIn: AUSD, currencyOut: NATIVE, pools: [MON_AUSD_10000_200], amountIn: 1_000_000_000n, amountOutMinimum: 1n, sourceToken: "AUSD"});

describe("the matrix through the shipped pins (uniswapPins.verifyQuote: tx.to → the v4 check, shipped pool list, real clock)", () => {
  it("the Monad pools the vectors use are in the shipped list (so a refusal is the vector's, not provenance)", () => {
    const ids = UNISWAP_V4_POOL_KEYS[143]!;
    for (const k of [AUSD_USDC_50_1, MON_USDC_500_10, MON_AUSD_10000_200]) expect(ids.some((x) => x.currency0 === getAddress(k.currency0) && x.currency1 === getAddress(k.currency1) && x.fee === k.fee && x.tickSpacing === k.tickSpacing)).toBe(true);
  });
  for (const [name, mk] of VECTORS) {
    it(`${name}: refused, with a reason, for the same reason the v4 check gives it`, () => {
      vi.useFakeTimers({toFake: ["Date"]});
      vi.setSystemTime(NOW_MS);
      const [p, q] = mk();
      const text = uniswapPins.verifyQuote!(p, q);
      expect(text).not.toBeNull();
      expect(uniswapPins.reasonOf!(text!)?.reason).toBeDefined();
      expect(text).toBe(uniswapV4VerifyQuote(p, q, {pools: UNISWAP_V4_POOL_KEYS}));
    });
  }
  it("the honest counterparts pass the shipped pins (a1 USDC → AUSD, b1 USDC → MON, c1's well-formed call)", () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(NOW_MS);
    for (const c of [usdcToAusd(), usdcToMon(), c1()]) expect(uniswapPins.verifyQuote!(c.params, c.quote)).toBeNull();
    expect(uniswapPins.spenders("eip155:143")).toContain(D143.swapProxy);
    expect(uniswapPins.spenders("eip155:143")).not.toContain(D143.universalRouter);
    expect(uniswapPins.spenders("eip155:143")).not.toContain(PERMIT2_ADDRESS);
  });
});

// ── Through the engine: a remote stub (the app's pins) in front of a backend that returns the vector ──

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
/** A backend whose provider answers every quote with `quote` (a compromised or buggy server). */
function hostileBackend(quote: () => Quote): typeof fetch {
  const evil: CrossChainProvider = {
    name: "uniswap",
    supportsSameChain: true,
    enabled: () => true,
    supportsChain: () => true,
    supportsChainPair: () => true,
    supportsRoute: () => true,
    getQuote: async () => quote(),
    buildDeposit: async (q: Quote): Promise<UnsignedTx> => ({chain: "", to: q.txRequest!.to!, data: q.txRequest!.data!, value: q.txRequest!.value ?? "0", ...(q.txRequest!.chainId !== undefined ? {chainId: q.txRequest!.chainId} : {}), ...(q.txRequest!.approvalAddress ? {approvalAddress: q.txRequest!.approvalAddress} : {})}),
    preflightDeposit: async () => {},
    trackIntent: async () => ({state: "pending"}),
  };
  const handle = createSwap2Handler<string>({providers: [evil], sealSecret: SECRET, guard: () => {}, subject: () => "app"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "app");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}
class RemoteUniswap extends SingleProviderSwap2 {
  protected readonly provider: CrossChainProvider;
  constructor(account: unknown, config: Record<string, unknown>, stub: CrossChainProvider) {
    super(account as never, config as never);
    this.provider = stub;
  }
  protected override chainSupported(caip2: string): boolean { return caip2 === "eip155:143"; }
  protected override pairSupported(a: string, b: string): boolean { return a === b && this.chainSupported(a); }
}
/** The engine (USER's account) swapping 700 USDC → AUSD for RECIPIENT through the stub, against a backend answering `quote`. */
async function engineRun(quote: () => Quote, review?: (plan: unknown) => void) {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(NOW_MS);
  const stub = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: hostileBackend(quote), supportsSameChain: true, ...uniswapPins});
  const account = createMockAccount({chain: "eip155:143", address: USER, balance: 10n ** 30n});
  const p = new RemoteUniswap(account, {fromChain: "eip155:143", ...(review ? {reviewExecution: review} : {})}, stub);
  const error = await p.swap2({fromToken: "USDC", toToken: AUSD, toChain: 143, recipient: RECIPIENT, fromTokenAmount: 700_000_000n, minAmountOut: 1n}).then(() => undefined, (e: unknown) => e);
  return {account, error};
}

describe("the matrix through the engine: refused before any approval — nothing is signed or sent", () => {
  const tokenVectors = VECTORS.filter(([n]) => !n.startsWith("d2") && !n.startsWith("d3")); // the engine swaps USDC here; d2/d3 are native-input vectors
  for (const [name, mk] of tokenVectors) {
    it(name, async () => {
      const {account, error} = await engineRun(() => mk()[1]);
      expect(error).toBeInstanceOf(Error);
      expect(refusalOf(error)?.reason ?? (error as {reason?: string}).reason).toBeDefined();
      expect(account.sent).toHaveLength(0);
      expect(account.calls.filter((c) => /^sign/.test(c.method))).toHaveLength(0);
    });
  }
  it("the honest a1 quote does reach the review, with exactly one approval: the SwapProxy, for exactly the input", async () => {
    class Halt extends Error {}
    let plan: {approvals: {token: string; spender: string; amount: bigint}[]; source: {to?: string; value?: bigint}} | undefined;
    const {account, error} = await engineRun(() => usdcToAusd().quote, (x) => { plan = x as typeof plan; throw new Halt("captured"); });
    expect(error).toBeInstanceOf(Halt);
    expect(plan!.approvals.map((a) => ({token: getAddress(a.token), spender: getAddress(a.spender), amount: a.amount}))).toEqual([{token: USDC, spender: getAddress(D143.swapProxy), amount: 700_000_000n}]);
    expect(plan!.source).toMatchObject({to: D143.swapProxy, value: 0n});
    expect(account.sent).toHaveLength(0);
  });
});

// ── The honest flow end to end on the Base recording (v4 alone): approve → execute; a failure after approval revokes ──

const B_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const D8453 = UNISWAP_V4[8453]!;
const ERR = parseAbi(["error ExecutionFailed(uint256 commandIndex, bytes message)", "error V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)", "error Error(string)"]);
const quoted = (out: bigint) => ({result: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [out, 38_972n])});
/** The preflight's two reads (not in the getQuote recording): the V4Quoter re-quote, and the exact call from the holder. */
function preflightNode(requote: {result?: unknown; error?: unknown}, dry: {result?: unknown; error?: unknown}): {odd: Odd; dryRuns: SeenRequest[]} {
  const dryRuns: SeenRequest[] = [];
  const odd: Odd = (s) => {
    if (s.method !== "eth_call" || s.params[2] !== undefined) return undefined;
    const c = s.params[0] as {to: string; from?: string; data: string};
    const quoteSelector = /^0x(aa9d21cb|ca253dc9)/.test(c.data); // quoteExactInputSingle / quoteExactInput, not the linkage read
    if (getAddress(c.to) === getAddress(D8453.quoter) && c.from === undefined && quoteSelector) return requote;
    if (getAddress(c.to) === getAddress(D8453.swapProxy) && c.from && getAddress(c.from) === HOLDER) { dryRuns.push(s); return dry; }
    return undefined;
  };
  return {odd, dryRuns};
}
const approveData = (spender: string, amount: bigint) => `0x095ea7b3${spender.slice(2).toLowerCase().padStart(64, "0")}${amount.toString(16).padStart(64, "0")}`;
const baseSale = {fromToken: "USDC", toToken: "ETH", toChain: 8453, recipient: HOLDER, fromTokenAmount: 1_000_000_000n, minAmountOut: 1n};
const baseConfig = {fromChain: "eip155:8453", rpcUrls: {8453: ["https://base.fixture"]}, v4: "all" as const, deployments: {}};

describe("the engine on the SwapProxy flow (Base recording, v4 alone)", () => {
  it("sends exactly approve(SwapProxy, 1,000 USDC) then SwapProxy.execute — no revoke after a swap that spent the allowance", async () => {
    const node = preflightNode(quoted(592_387_949_236_107_032n), {result: "0x"});
    const r = tokenReplay([BASE_TOKEN], node.odd);
    vi.stubGlobal("fetch", r.fetch);
    const account = createMockAccount({chain: "eip155:8453", address: HOLDER, balance: 10n ** 30n});
    await new UniswapSwap2Protocol(account as never, baseConfig).swap2(baseSale);
    expect(r.misses).toEqual([]);
    const sent = account.sent as {to?: string; data?: string; value?: bigint}[];
    expect(sent).toHaveLength(2);
    expect({to: getAddress(sent[0]!.to!), data: sent[0]!.data!.toLowerCase()}).toEqual({to: B_USDC, data: approveData(D8453.swapProxy, 1_000_000_000n)});
    expect(getAddress(sent[1]!.to!)).toBe(getAddress(D8453.swapProxy));
    expect(sent[1]!.data!.slice(0, 10)).toBe("0x2894adf9");
    expect(sent[1]!.value ?? 0n).toBe(0n);
    expect(node.dryRuns).toHaveLength(1); // the preflight dry-ran the exact call from the account after the approval
    expect((node.dryRuns[0]!.params[0] as {data: string}).data).toBe(sent[1]!.data);
  });

  it("a preflight revert after the approval (V4TooLittleReceived) refuses the swap and revokes: approve(SwapProxy, 0)", async () => {
    const revert = encodeErrorResult({abi: ERR, errorName: "ExecutionFailed", args: [0n, encodeErrorResult({abi: ERR, errorName: "V4TooLittleReceived", args: [589_426_009_489_926_496n, 1n]})]});
    const node = preflightNode(quoted(592_387_949_236_107_032n), {error: {code: 3, message: "execution reverted", data: revert}});
    vi.stubGlobal("fetch", tokenReplay([BASE_TOKEN], node.odd).fetch);
    const account = createMockAccount({chain: "eip155:8453", address: HOLDER, balance: 10n ** 30n});
    const err = await new UniswapSwap2Protocol(account as never, baseConfig).swap2(baseSale).catch((e: unknown) => e);
    expect(refusalOf(err)?.reason).toBe("price_check_failed");
    const sent = account.sent as {to?: string; data?: string}[];
    expect(sent.map((t) => t.data!.toLowerCase())).toEqual([approveData(D8453.swapProxy, 1_000_000_000n), approveData(D8453.swapProxy, 0n)]);
    expect(sent.every((t) => getAddress(t.to!) === B_USDC)).toBe(true);
  });
});

// ── preflightDeposit on a token-input quote (§6.5 row 16): re-quote, then the exact call from the sender ──

describe("v4 preflight of a SwapProxy quote", () => {
  async function v4Quote(): Promise<{q: Quote; provider: CrossChainProvider}> {
    vi.stubGlobal("fetch", tokenReplay([BASE_TOKEN]).fetch);
    const provider = uniswapProvider({rpcUrls: {8453: ["https://base.fixture"]}, v4: "all", deployments: {}});
    const q = await provider.getQuote({sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: "USDC", destToken: NATIVE, amountIn: "1000000000", destAddress: HOLDER, refundAddress: HOLDER, sender: HOLDER});
    return {q: q!, provider};
  }
  it("re-quotes the route from the token and dry-runs the exact SwapProxy call from the sender; TRANSFER_FROM_FAILED → simulation_failed", async () => {
    const {q, provider} = await v4Quote();
    const tx = await provider.buildDeposit(q);
    expect(tx).toMatchObject({to: D8453.swapProxy, value: "0", approvalAddress: D8453.swapProxy});
    const ok = preflightNode(quoted(592_387_949_236_107_032n), {result: "0x"});
    vi.stubGlobal("fetch", tokenReplay([BASE_TOKEN], ok.odd).fetch);
    await expect(provider.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    expect(ok.dryRuns).toHaveLength(1);
    const pull = preflightNode(quoted(592_387_949_236_107_032n), {error: {code: 3, message: "execution reverted: TRANSFER_FROM_FAILED", data: encodeErrorResult({abi: ERR, errorName: "Error", args: ["TRANSFER_FROM_FAILED"]})}});
    vi.stubGlobal("fetch", tokenReplay([BASE_TOKEN], pull.odd).fetch);
    await expect(provider.preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "simulation_failed", message: expect.stringMatching(/TRANSFER_FROM_FAILED/)});
  });
  it("refuses a token quote whose target is not the pinned SwapProxy, a quote without its input currency, and a provider whose v4 token input is off", async () => {
    const {q, provider} = await v4Quote();
    const tx = await provider.buildDeposit(q);
    vi.stubGlobal("fetch", tokenReplay([BASE_TOKEN], preflightNode(quoted(1n), {result: "0x"}).odd).fetch);
    await expect(provider.preflightDeposit!(q, {...tx, to: D8453.universalRouter})).rejects.toMatchObject({reason: "vault_mismatch", message: expect.stringMatching(/not the pinned SwapProxy/)});
    const {currencyIn: _c, ...noCurrency} = q.providerData!;
    await expect(provider.preflightDeposit!({...q, providerData: noCurrency}, tx)).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/names no input currency/)});
    await expect(uniswapProvider({rpcUrls: {8453: ["https://base.fixture"]}, v4: "native-in"}).preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/token input is off here/)});
    // The re-quote answering under the signed minimum: price_check_failed before anything is dry-run.
    await expect(provider.preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "price_check_failed"});
  });
});

// The texts this file's refusals carry are classified by the pins (a remote stub's refusal keeps its reason).
describe("reasons", () => {
  it("every pins refusal in the matrix has a reason", () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(NOW_MS);
    for (const [, mk] of VECTORS) expect(uniswapV4ReasonOf(uniswapPins.verifyQuote!(...mk())!)).toBeDefined();
  });
});
