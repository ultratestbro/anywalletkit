// UNISWAP-V4-RESEARCH §6.5: the on-device check list, one hostile vector (at least) per row, S1–S14 for the SwapProxy
// flow, every refused command and action, and the old 0.4.11 pins against a v4 quote. Every refusal must also carry a
// reason (`uniswapV4ReasonOf`), so a remote stub's refusal is classified.
import {describe, expect, it} from "vitest";
import {encodeAbiParameters, encodeFunctionData, getAddress, keccak256, parseAbi, parseAbiParameters, type Hex} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import {UNISWAP_V3, uniswapPins, uniswapV3VerifyQuote} from "../src/addresses.js";
import {PERMIT2_ADDRESS, UNISWAP_V4, UR_COMMANDS, V4_ACTION_CONSTANTS, V4_ACTIONS} from "../src/v4/addresses.js";
import {poolIdOf, type V4PoolKey} from "../src/v4/pool.js";
import {
  V4_CLOCK_SKEW_SECONDS, erc20AllowanceSlot, uniswapV4ReasonOf, uniswapV4VerifyQuote, v4DeploymentProblem, v4DeploymentReads, v4HopTokens, v4PreflightCall, v4StorageOverride,
  type UniswapV4VerifyOptions,
} from "../src/v4/verify.js";
import {
  ATTACKER, AUSD, AUSD_USDC_50_1, D143, E1_DEADLINE, KEM_HOOK, MONAD, MON_AUSD_10000_200, MON_AUSD_500_1, MON_USDC_500_10, MON_USDT0_500_10, NATIVE, NOW_MS, POOLS, RECIPIENT,
  UR20_143, UR211_143, USDC, USDT0, USER, WMON, WMON_AUSD_500_1, e1, makeCase, now, pathSwap, proxyExecute, settle, single, take, urExecute, v4Input, withTx, type Case,
} from "./v4-helpers.js";

const OPTS: UniswapV4VerifyOptions = {pools: POOLS, now};
const verify = (params: QuoteParams, quote: Quote, o: UniswapV4VerifyOptions = {}) => uniswapV4VerifyQuote(params, quote, {...OPTS, ...o});
const AMOUNT = 100n * 10n ** 18n;
const MIN = 1_089_996n;

/** The refusal text and its reason; fails the test when the quote passes or the text has no reason. */
function refusal(params: QuoteParams, quote: Quote, o: UniswapV4VerifyOptions = {}): {text: string; reason: string | undefined} {
  const text = verify(params, quote, o);
  expect(text, "refused").not.toBeNull();
  const reason = uniswapV4ReasonOf(text!)?.reason;
  expect(reason, `"${text}" carries a reason`).toBeDefined();
  return {text: text!, reason};
}
function expectRefused(params: QuoteParams, quote: Quote, re: RegExp, reason: string, o: UniswapV4VerifyOptions = {}) {
  const r = refusal(params, quote, o);
  expect(r.text).toMatch(re);
  expect(r.reason).toBe(reason);
}

const e1Case = (): Case => makeCase();
/** A native-in quote whose call is `data` (everything else honest). */
const nativeWith = (data: Hex, tx: Partial<NonNullable<Quote["txRequest"]>> = {}): [QuoteParams, Quote] => {
  const c = e1Case();
  return [c.params, withTx(c, {data, ...tx})];
};
const usdcToAusd = (): Case => makeCase({currencyIn: USDC, currencyOut: AUSD, pools: [AUSD_USDC_50_1], amountIn: 700_000_000n, amountOutMinimum: 696_555_000n});
const tokenWith = (data: Hex, tx: Partial<NonNullable<Quote["txRequest"]>> = {}): [QuoteParams, Quote] => {
  const c = usdcToAusd();
  return [c.params, withTx(c, {data, ...tx})];
};
/** The honest token-in V4 input (USDC → AUSD 50/1), for SwapProxy wrapper vectors. */
const tokenInput = (o: {take?: Hex; settle?: Hex; swap?: Hex; actions?: number[]} = {}): Hex =>
  v4Input(o.actions ?? [0x06, 0x0b, 0x0e], [
    o.swap ?? single({poolKey: AUSD_USDC_50_1, zeroForOne: false, amountIn: 700_000_000n, amountOutMinimum: 696_555_000n}),
    o.settle ?? settle(USDC, 700_000_000n),
    o.take ?? take(AUSD, RECIPIENT),
  ]);
const nativeInput = (o: {take?: Hex; settle?: Hex; swap?: Hex; actions?: number[]} = {}): Hex =>
  v4Input(o.actions ?? [0x06, 0x0b, 0x0e], [o.swap ?? single(), o.settle ?? settle(), o.take ?? take()]);

describe("honest quotes pass", () => {
  it("the builders reproduce E1 (sanity for every vector below)", () => {
    expect(urExecute("0x10", [nativeInput()])).toBe(e1.calldata_2_1_x);
    expect(proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [tokenInput()])).toBe(usdcToAusd().quote.txRequest!.data);
  });
  const good: [string, () => Case][] = [
    ["E1: 100 MON → AUSD, NATIVE/AUSD 500/1 (native in, single)", e1Case],
    ["62,000 MON → USDC (500/10) → AUSD (50/1) (native in, two hops)", () => makeCase({pools: [MON_USDC_500_10, AUSD_USDC_50_1], amountIn: 62_000n * 10n ** 18n, amountOutMinimum: 672_000_000n})],
    ["700 USDC → AUSD (50/1) via SwapProxy (token in)", usdcToAusd],
    ["700 USDC → MON via SwapProxy (token in, native out)", () => makeCase({currencyIn: USDC, currencyOut: NATIVE, pools: [MON_USDC_500_10], amountIn: 700_000_000n, amountOutMinimum: 60_000n * 10n ** 18n})],
    ["1,000 AUSD → USDC → MON via SwapProxy (token in, two hops, native out)", () => makeCase({currencyIn: AUSD, currencyOut: NATIVE, pools: [AUSD_USDC_50_1, MON_USDC_500_10], amountIn: 1_000_000_000n, amountOutMinimum: 1n})],
  ];
  for (const [what, mk] of good) it(what, () => {
    const c = mk();
    expect(verify(c.params, c.quote)).toBeNull();
  });
  it("the recorded E1 calldata itself", () => {
    const [p, q] = nativeWith(e1.calldata_2_1_x);
    expect(verify(p, q)).toBeNull();
  });
  it("an integrator pool (extraPools) that the shipped list lacks", () => {
    const k: V4PoolKey = {currency0: NATIVE, currency1: AUSD, fee: 3000, tickSpacing: 60, hooks: NATIVE};
    const c = makeCase({pools: [k]});
    expectRefused(c.params, c.quote, /not in the pinned pool list/, "policy_refused");
    expect(verify(c.params, c.quote, {extraPools: {[MONAD]: [k]}})).toBeNull();
  });
});

describe("row 1 / S1 — chain, target, mode", () => {
  it("another router build or contract at tx.to → vault_mismatch", () => {
    for (const to of [UR20_143, UR211_143, D143.poolManager, D143.positionManager, D143.quoter, UNISWAP_V3[143]!.router, D143.swapProxy, KEM_HOOK]) {
      const c = e1Case();
      expectRefused(c.params, withTx(c, {to}), /not the pinned Universal Router 2\.1\.2/, "vault_mismatch");
    }
  });
  it("token input sent to the router directly (the Permit2 flow), or to another SwapProxy address", () => {
    for (const to of [D143.universalRouter, "0x02E5be68D46DAc0B524905bfF209cf47EE6dB2a9", PERMIT2_ADDRESS]) {
      const c = usdcToAusd();
      expectRefused(c.params, withTx(c, {to}), /not the pinned SwapProxy/, "vault_mismatch");
    }
  });
  it("an unpinned chain, a cross-chain request, HyperEVM (not quoted), v4 off, token input under native-in", () => {
    const c = e1Case();
    expectRefused({...c.params, sourceChain: "eip155:324", destChain: "eip155:324"}, c.quote, /pinned Uniswap v4 deployment/, "unsupported_pair");
    expectRefused({...c.params, destChain: "eip155:1"}, c.quote, /same-chain/, "unsupported_pair");
    expectRefused({...c.params, sourceChain: "eip155:999", destChain: "eip155:999", sourceToken: "HYPE"}, c.quote, /not quoted on chain 999/, "unsupported_pair");
    expectRefused(c.params, c.quote, /v4 is off/, "policy_refused", {v4: "off"});
    expect(verify(c.params, c.quote, {v4: "native-in"})).toBeNull();
    const t = usdcToAusd();
    expectRefused(t.params, t.quote, /token input is off/, "policy_refused", {v4: "native-in"});
  });
  it("a deployment override whose router is not the 2.1.2 build", () => {
    const c = e1Case();
    const deployments = {...UNISWAP_V4, [MONAD]: {...D143, routerBuild: "2.0" as unknown as "2.1.2"}};
    expectRefused(c.params, c.quote, /not 2\.1\.2/, "vault_mismatch", {deployments});
  });
  it("native in/out on a chain whose native coin is an ERC-20 (Arc, Celo)", () => {
    for (const id of [42220, 5042]) {
      const c = e1Case();
      expectRefused({...c.params, sourceChain: `eip155:${id}`, destChain: `eip155:${id}`, sourceToken: "USDC", destToken: NATIVE}, withTx(c, {chainId: id}), /native coin is an ERC-20/, "unsupported_pair");
    }
  });
});

describe("row 2 — selector", () => {
  it("execute(bytes,bytes[]) without a deadline", () => {
    const data = encodeFunctionData({abi: parseAbi(["function execute(bytes commands, bytes[] inputs) payable"]), functionName: "execute", args: ["0x10", [nativeInput()]]});
    expectRefused(...nativeWith(data), /without a deadline/, "policy_refused");
  });
  it("executeSigned", () => expectRefused(...nativeWith(`0x44684dc3${"00".repeat(64)}`), /executeSigned/, "policy_refused"));
  it("any other selector, and empty calldata", () => {
    expectRefused(...nativeWith(`0x12345678${"00".repeat(32)}`), /selector 0x12345678/, "policy_refused");
    expectRefused(...nativeWith("0x"), /no calldata/, "policy_refused");
  });
  it("a UR call under a SwapProxy target, and a SwapProxy call under a router target", () => {
    expectRefused(...tokenWith(urExecute("0x10", [tokenInput()])), /goes through SwapProxy\.execute/, "policy_refused");
    expectRefused(...nativeWith(proxyExecute(D143.universalRouter, NATIVE, AMOUNT, "0x10", [nativeInput()])), /calls the router directly/, "policy_refused");
  });
});

describe("row 3 / S3–S5 — SwapProxy arguments", () => {
  it("f5: router = UR 2.1.1 (accepted on chain, refused here); f6: router = an attacker contract", () => {
    for (const router of [UR211_143, ATTACKER, UR20_143]) expectRefused(...tokenWith(proxyExecute(router, USDC, 700_000_000n, "0x10", [tokenInput()])), /not the pinned Universal Router 2\.1\.2/, "vault_mismatch");
  });
  it("S4: another token, or address(0)", () => {
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, AUSD, 700_000_000n, "0x10", [tokenInput()])), /pulls another token/, "policy_refused");
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, NATIVE, 700_000_000n, "0x10", [tokenInput()])), /pulls another token/, "policy_refused");
  });
  it("f7: amount = 2 × amountIn (the extra is swept); f8: the same with a SWEEP inside", () => {
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, USDC, 1_400_000_000n, "0x10", [tokenInput()])), /pulls another amount/, "policy_refused");
    const sweep = encodeAbiParameters(parseAbiParameters("address token, address recipient, uint256 amountMin"), [USDC, ATTACKER, 0n]);
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, USDC, 1_400_000_000n, "0x1004", [tokenInput(), sweep])), /SWEEP is not allowed/, "policy_refused");
  });
  it("S4: an unlisted source token (callback tokens could re-enter the unlocked router)", () => {
    const c = usdcToAusd();
    expectRefused({...c.params, sourceToken: "0x9999999999999999999999999999999999999999", sourceDecimals: 6}, c.quote, /catalog tokens only/, "unsupported_pair");
  });
});

describe("row 4 / S2 — strict decode, byte equality at every level", () => {
  const strip = (h: Hex) => h.slice(2);
  it("a trailing byte on the router call and on the SwapProxy call", () => {
    expectRefused(...nativeWith(`${e1.calldata_2_1_x}00`), /not canonically encoded/, "policy_refused");
    const t = usdcToAusd();
    expectRefused(t.params, withTx(t, {data: `${t.quote.txRequest!.data}00`}), /not canonically encoded/, "policy_refused");
  });
  it("the 2.0 layout — refused although it executes on UR 2.1.2", () => {
    expectRefused(...nativeWith(e1.calldata_2_0), /not the UR 2\.1\.x layout/, "policy_refused");
  });
  it("a non-canonical outer offset (inputs moved one word later)", () => {
    const body = strip(e1.calldata_2_1_x).slice(8);
    const w = (i: number) => body.slice(i * 64, (i + 1) * 64);
    // [0x60, 0xa0, deadline, len, cmds, inputs…] → [0x60, 0xc0, deadline, len, cmds, 0, inputs…]
    const moved = `0x3593564c${w(0)}${"c0".padStart(64, "0")}${w(2)}${w(3)}${w(4)}${"0".repeat(64)}${body.slice(5 * 64)}` as Hex;
    expectRefused(...nativeWith(moved), /not canonically encoded/, "policy_refused");
  });
  it("a non-canonical hookData offset inside ExactInputSingleParams", () => {
    const p = strip(single());
    const words = Array.from({length: p.length / 64}, (_, i) => p.slice(i * 64, (i + 1) * 64));
    words[10] = "160".padStart(64, "0");
    const shifted = `0x${words.join("")}${"0".repeat(64)}` as Hex;
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: shifted})])), /SWAP_EXACT_IN_SINGLE params are not the UR 2\.1\.x layout/, "policy_refused");
  });
  it("dirty padding: a TAKE recipient with high bytes set, a zeroForOne of 2, a SETTLE with a trailing word", () => {
    const t = strip(take());
    const dirty = `0x${t.slice(0, 64)}${"ff".repeat(12)}${t.slice(64 + 24)}` as Hex;
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({take: dirty})])), /TAKE params are not canonically encoded/, "policy_refused");
    const p = strip(single());
    const two = `0x${p.slice(0, 6 * 64)}${"2".padStart(64, "0")}${p.slice(7 * 64)}` as Hex;
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: two})])), /not the UR 2\.1\.x layout/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({settle: `${settle()}${"0".repeat(64)}`})])), /SETTLE params are not canonically encoded/, "policy_refused");
  });
  it("a non-canonical V4_SWAP input (the actions/params pair)", () => {
    expectRefused(...nativeWith(urExecute("0x10", [`${nativeInput()}${"0".repeat(64)}`])), /V4_SWAP input is not canonically encoded/, "policy_refused");
  });
  it("a one-hop SWAP_EXACT_IN for a single pool (valid on chain, not this module's canonical form)", () => {
    const data = urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: pathSwap({pools: [MON_AUSD_500_1]})})]);
    expectRefused(...nativeWith(data), /not this module's canonical encoding/, "policy_refused");
  });
});

describe("row 5 / S6–S7 — commands", () => {
  it("f10: the allow-revert bit (0x90), and the third-party bit (0x50)", () => {
    expectRefused(...nativeWith(urExecute("0x90", [nativeInput()])), /allow-revert/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x50", [nativeInput()])), /allow-revert \(0x80\) or third-party \(0x40\)/, "policy_refused");
  });
  it("EXECUTE_SUB_PLAN wrapping a valid V4_SWAP", () => {
    const sub = encodeAbiParameters(parseAbiParameters("bytes commands, bytes[] inputs"), ["0x10", [nativeInput()]]);
    expectRefused(...nativeWith(urExecute("0x21", [sub])), /EXECUTE_SUB_PLAN is not allowed/, "policy_refused");
  });
  it("every other command, alone and after V4_SWAP", () => {
    const others = Object.values(UR_COMMANDS).filter((c) => c !== UR_COMMANDS.V4_SWAP);
    expect(others).toHaveLength(21);
    for (const c of others) {
      const hex = `0x${c.toString(16).padStart(2, "0")}` as Hex;
      const r1 = refusal(...nativeWith(urExecute(hex, [nativeInput()])));
      expect(r1.reason, hex).toBe("policy_refused");
      const r2 = refusal(...nativeWith(urExecute(`0x10${hex.slice(2)}`, [nativeInput(), nativeInput()])));
      expect(r2.reason, hex).toBe("policy_refused");
    }
  });
  it("commands/inputs length mismatch, two V4_SWAPs, no command", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput(), nativeInput()])), /2 inputs for one command/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x1010", [nativeInput(), nativeInput()])), /2 commands/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x", [])), /0 commands/, "policy_refused");
  });
});

describe("row 6 / S11 — deadline", () => {
  const nowS = BigInt(NOW_MS / 1000);
  it("f11: passed (now − 1, now) → quote_expired", () => {
    for (const deadline of [nowS - 1n, nowS]) expectRefused(...nativeWith(urExecute("0x10", [nativeInput()], deadline)), /deadline has passed/, "quote_expired");
  });
  it("too far ahead → refused; the edge (deadlineSeconds + clock skew) passes", () => {
    const edge = nowS + 600n + BigInt(V4_CLOCK_SKEW_SECONDS);
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput()], edge + 1n)), /more than 600 s ahead/, "policy_refused");
    expect(verify(...nativeWith(urExecute("0x10", [nativeInput()], edge)))).toBeNull();
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput()], nowS + 400n)), /more than 300 s ahead/, "policy_refused", {deadlineSeconds: 300, now: () => NOW_MS});
  });
});

describe("row 7 / S7 — actions", () => {
  it("c3/e3/e4: SETTLE_ALL; f1/f12: TAKE_ALL; TAKE_PORTION; SWEEP; exact-out", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x06, 0x0c, 0x0e], settle: encodeAbiParameters(parseAbiParameters("address, uint256"), [NATIVE, AMOUNT])})])), /SETTLE_ALL is not allowed/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x06, 0x0b, 0x0f], take: encodeAbiParameters(parseAbiParameters("address, uint256"), [AUSD, MIN])})])), /TAKE_ALL is not allowed/, "policy_refused");
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [tokenInput({actions: [0x06, 0x0b, 0x0f], take: encodeAbiParameters(parseAbiParameters("address, uint256"), [AUSD, 1n])})])), /TAKE_ALL/, "policy_refused");
    const portion = encodeAbiParameters(parseAbiParameters("address, address, uint256"), [AUSD, ATTACKER, 25n]);
    const fourActions = v4Input([0x06, 0x0b, 0x0e, 0x10], [single(), settle(), take(), portion]);
    expectRefused(...nativeWith(urExecute("0x10", [fourActions])), /TAKE_PORTION is not allowed/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x06, 0x0b, 0x14]})])), /SWEEP is not allowed/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x08, 0x0b, 0x0e]})])), /SWAP_EXACT_OUT_SINGLE is not allowed/, "policy_refused");
  });
  it("every other action byte in the swap slot", () => {
    const others = Object.values(V4_ACTIONS).filter((a) => a !== V4_ACTIONS.SWAP_EXACT_IN_SINGLE && a !== V4_ACTIONS.SWAP_EXACT_IN);
    for (const a of others) expect(refusal(...nativeWith(urExecute("0x10", [nativeInput({actions: [a, 0x0b, 0x0e]})]))).reason, actionName(a)).toBe("policy_refused");
    for (const a of [0x19, 0x20, 0xff]) expect(refusal(...nativeWith(urExecute("0x10", [nativeInput({actions: [a, 0x0b, 0x0e]})]))).reason).toBe("policy_refused");
  });
  it("two swaps, SETTLE first, a missing TAKE, actions/params length mismatch", () => {
    expectRefused(...nativeWith(urExecute("0x10", [v4Input([0x06, 0x06, 0x0b, 0x0e], [single(), single(), settle(), take()])])), /are not \[SWAP_EXACT_IN\(_SINGLE\), SETTLE, TAKE\]/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [v4Input([0x0b, 0x06, 0x0e], [settle(), single(), take()])])), /are not/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [v4Input([0x06, 0x0b], [single(), settle()])])), /are not/, "policy_refused");
    const mismatch = encodeAbiParameters(parseAbiParameters("bytes actions, bytes[] params"), ["0x060b0e", [single(), settle()]]);
    expectRefused(...nativeWith(urExecute("0x10", [mismatch])), /differ in length/, "policy_refused");
  });
});

function actionName(a: number) {
  return Object.entries(V4_ACTIONS).find(([, v]) => v === a)?.[0] ?? String(a);
}

describe("row 8 — the route's currencies", () => {
  it("WMON in place of native (input), and in place of native output", () => {
    const data = urExecute("0x10", [nativeInput({swap: single({poolKey: WMON_AUSD_500_1, zeroForOne: false}), settle: settle(WMON)})]);
    expectRefused(...nativeWith(data), /never the wrapped token in its place/, "policy_refused");
    const c = makeCase({currencyIn: USDC, currencyOut: NATIVE, pools: [MON_USDC_500_10], amountIn: 700_000_000n, amountOutMinimum: 1n});
    const wmonOut = proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [v4Input([0x06, 0x0b, 0x0e], [
      single({poolKey: {currency0: USDC, currency1: WMON, fee: 500, tickSpacing: 10, hooks: NATIVE}, zeroForOne: true, amountIn: 700_000_000n, amountOutMinimum: 1n}), settle(USDC, 700_000_000n), take(WMON, RECIPIENT),
    ])]);
    expectRefused(c.params, withTx(c, {data: wmonOut}), /never the wrapped token in its place/, "policy_refused");
  });
  it("swapped currencies (currency0 > currency1) and a wrong zeroForOne", () => {
    const swapped = urExecute("0x10", [nativeInput({swap: single({poolKey: {...MON_AUSD_500_1, currency0: AUSD, currency1: NATIVE}, zeroForOne: false})})]);
    expectRefused(...nativeWith(swapped), /PoolKey order/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({zeroForOne: false})})])), /sells another currency/, "policy_refused");
  });
  it("a single pool of another pair", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({poolKey: MON_USDC_500_10})})])), /buys another currency/, "policy_refused");
  });
  it("a 3-hop path, a cyclic path, a path that ends elsewhere, a path from another currency", () => {
    const three = pathSwap({path: [
      {intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x"},
      {intermediateCurrency: USDT0, fee: 100, tickSpacing: 1, hooks: NATIVE, hookData: "0x"},
      {intermediateCurrency: AUSD, fee: 100, tickSpacing: 1, hooks: NATIVE, hookData: "0x"},
    ]});
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: three})])), /crosses 3 pools/, "policy_refused");
    const cyclic = pathSwap({path: [
      {intermediateCurrency: NATIVE, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x"},
      {intermediateCurrency: AUSD, fee: 500, tickSpacing: 1, hooks: NATIVE, hookData: "0x"},
    ]});
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: cyclic})])), /cycle/, "policy_refused");
    const elsewhere = pathSwap({pools: [MON_USDC_500_10, {currency0: USDT0, currency1: USDC, fee: 100, tickSpacing: 1, hooks: NATIVE}]});
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: elsewhere})])), /buys another currency/, "policy_refused");
    const fromUsdc = pathSwap({currencyIn: USDC, pools: [AUSD_USDC_50_1, MON_AUSD_500_1]});
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: fromUsdc})])), /sells another currency/, "policy_refused");
  });
  it("an intermediate outside the pinned hop set (MON → AUSD → USDC)", () => {
    const c = makeCase({currencyOut: USDC, pools: [MON_AUSD_500_1, AUSD_USDC_50_1]});
    expectRefused(c.params, c.quote, /not a pinned hop currency/, "policy_refused");
    expect(v4HopTokens(MONAD, D143).has(AUSD)).toBe(false);
    expect([...v4HopTokens(MONAD, D143)].sort()).toEqual([NATIVE, WMON, USDC, USDT0].map((a) => getAddress(a)).sort());
    expect(verify(c.params, c.quote, {hopTokens: {[MONAD]: [AUSD]}})).toBeNull();
  });
});

describe("row 9 — pools: hookless, fee cap, tick spacing, provenance", () => {
  it("a hook (the Kyber KEM hook), even when the list carries its key", () => {
    const hooked: V4PoolKey = {...AUSD_USDC_50_1, fee: 1, hooks: KEM_HOOK};
    const data = proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [tokenInput({swap: single({poolKey: hooked, zeroForOne: false, amountIn: 700_000_000n, amountOutMinimum: 696_555_000n})})]);
    expectRefused(...tokenWith(data), /has a hook/, "policy_refused", {pools: {[MONAD]: [...POOLS[MONAD], hooked]}});
  });
  it("hookData on a single pool and on a hop", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({hookData: "0x01"})})])), /carries hookData/, "policy_refused");
    const path = pathSwap({path: [
      {intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x"},
      {intermediateCurrency: AUSD, fee: 50, tickSpacing: 1, hooks: NATIVE, hookData: `0x${"00".repeat(32)}`},
    ]});
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: path})])), /a hop carries hookData/, "policy_refused");
  });
  it("the dynamic-fee flag, a fee above the cap, tick spacing outside [1, 32767]", () => {
    for (const [poolKey, re] of [[{...MON_AUSD_500_1, fee: 0x800000}, /dynamic/], [{...MON_AUSD_500_1, fee: 120_000}, /above the 10% cap/], [{...MON_AUSD_500_1, tickSpacing: 0}, /tick spacing/], [{...MON_AUSD_500_1, tickSpacing: 32_768}, /tick spacing/]] as const) {
      expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({poolKey})})])), re, "policy_refused", {pools: {[MONAD]: [...POOLS[MONAD], poolKey]}});
    }
    // A higher cap set by the app admits the 12% pool.
    const k12 = {...MON_AUSD_500_1, fee: 120_000};
    expect(verify(...nativeWith(urExecute("0x10", [nativeInput({swap: single({poolKey: k12})})])), {pools: {[MONAD]: [k12]}, maxFeePips: 200_000})).toBeNull();
  });
  it("a pool outside the list (a server-supplied key alone is no provenance), and no list at all", () => {
    const k: V4PoolKey = {...MON_AUSD_500_1, fee: 3000, tickSpacing: 60};
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({poolKey: k})})])), new RegExp(`${poolIdOf(k)} is not in the pinned pool list`), "policy_refused");
    const c = e1Case();
    expectRefused(c.params, c.quote, /no pinned Uniswap v4 pool list for chain 143/, "policy_refused", {pools: {}});
    expectRefused(c.params, c.quote, /no pinned Uniswap v4 pool list/, "policy_refused", {pools: {1: [MON_AUSD_500_1]}});
  });
  it("the thin pool is listed and the check passes it: liquidity is the quoter's and the preflight's job, not the build check's", () => {
    const c = makeCase({pools: [MON_AUSD_10000_200]});
    expect(verify(c.params, c.quote)).toBeNull();
  });
});

describe("row 10 — amounts", () => {
  it("the swap's amountIn is not the request's; amountIn = 0 (OPEN_DELTA)", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({amountIn: AMOUNT - 1n})})])), /swap's input is not the request's/, "price_check_failed");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({amountIn: 0n})})])), /swap's input is not the request's/, "price_check_failed");
    const c = e1Case();
    expectRefused({...c.params, amountIn: "0"}, {...c.quote, sourceAmount: "0"}, /input amount is zero/, "policy_refused");
  });
  it("amountOutMinimum ≠ minDestAmount, a zero minimum, a minimum under the requested floor", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({amountOutMinimum: MIN - 1n})})])), /swap's minimum is not the quote's/, "price_check_failed");
    const c = e1Case();
    expectRefused(c.params, {...c.quote, minDestAmount: "0"}, /minimum output is zero/, "price_check_failed");
    expectRefused({...c.params, minAmountOut: (MIN + 1n).toString()}, c.quote, /under the requested floor/, "price_check_failed");
    expect(verify({...c.params, minAmountOut: MIN.toString()}, c.quote)).toBeNull();
  });
  it("a per-hop minimum price (single and path)", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({swap: single({minHopPriceX36: 1n})})])), /minHopPriceX36 must be 0/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({actions: [0x07, 0x0b, 0x0e], swap: pathSwap({minHopPriceX36: [0n, 0n]})})])), /minHopPriceX36 must be empty/, "policy_refused");
  });
  it("the quote's source amount is not the request's input (the approval amount, S5/S13)", () => {
    const c = e1Case();
    expectRefused(c.params, {...c.quote, sourceAmount: (AMOUNT * 2n).toString()}, /another amount than the request's input/, "policy_refused");
  });
});

describe("row 11 / S8 — exact SETTLE", () => {
  it("c2: OPEN_DELTA; c6: CONTRACT_BALANCE; 2 × amountIn", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({settle: settle(NATIVE, V4_ACTION_CONSTANTS.OPEN_DELTA)})])), /SETTLE pays OPEN_DELTA/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({settle: settle(NATIVE, V4_ACTION_CONSTANTS.CONTRACT_BALANCE)})])), /SETTLE pays CONTRACT_BALANCE/, "policy_refused");
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [tokenInput({settle: settle(USDC, 1_400_000_000n)})])), /not exactly the input/, "policy_refused");
  });
  it("f9: payerIsUser = true; another currency", () => {
    expectRefused(...tokenWith(proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [tokenInput({settle: settle(USDC, 700_000_000n, true)})])), /payerIsUser must be false/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({settle: settle(WMON)})])), /SETTLE pays another currency/, "policy_refused");
  });
});

describe("row 12 / S9 — TAKE the whole output to the explicit recipient", () => {
  it("f2/f13 MSG_SENDER, f3/f14 ADDRESS_THIS, f4 an attacker, the SwapProxy, the router, the PoolManager", () => {
    for (const r of [V4_ACTION_CONSTANTS.MSG_SENDER, V4_ACTION_CONSTANTS.ADDRESS_THIS, ATTACKER, D143.swapProxy, D143.universalRouter, D143.poolManager] as `0x${string}`[]) {
      expectRefused(...nativeWith(urExecute("0x10", [nativeInput({take: take(AUSD, r)})])), /TAKE pays/, "recipient_mismatch");
      expectRefused(...tokenWith(proxyExecute(D143.universalRouter, USDC, 700_000_000n, "0x10", [tokenInput({take: take(AUSD, r)})])), /TAKE pays/, "recipient_mismatch");
    }
  });
  it("f15: an explicit amount; another currency", () => {
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({take: take(AUSD, RECIPIENT, MIN)})])), /TAKE names an amount/, "policy_refused");
    expectRefused(...nativeWith(urExecute("0x10", [nativeInput({take: take(USDC, RECIPIENT)})])), /TAKE takes another currency/, "policy_refused");
  });
  it("a request whose recipient is a sentinel or a pinned contract (output would be stranded)", () => {
    for (const to of [NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER, V4_ACTION_CONSTANTS.ADDRESS_THIS, D143.universalRouter, D143.swapProxy, D143.poolManager, PERMIT2_ADDRESS]) {
      const c = e1Case();
      expectRefused({...c.params, destAddress: to}, c.quote, /router sentinel or a pinned Uniswap contract/, "recipient_mismatch");
    }
    const c = e1Case();
    expectRefused({...c.params, destAddress: "0x1234"}, c.quote, /recipient must be an EVM address/, "recipient_mismatch");
  });
});

describe("rows 13–14 / S12–S13 — value and approval", () => {
  it("d2: native overpay 1%; underpay; no value", () => {
    for (const value of [((AMOUNT * 101n) / 100n).toString(), (AMOUNT - 1n).toString(), undefined, "0"]) {
      const c = e1Case();
      const q = withTx(c, {});
      if (value === undefined) delete q.txRequest!.value; else q.txRequest!.value = value;
      expectRefused(c.params, q, /exactly the input in value/, "policy_refused");
    }
  });
  it("d1: token input with 1 wei of value (SwapProxy is non-payable; a stray value would stay in the router)", () => {
    const c = usdcToAusd();
    expectRefused(c.params, withTx(c, {value: "1"}), /attaches no value/, "policy_refused");
    expectRefused(c.params, withTx(c, {value: "0x1"}), /not an integer/, "policy_refused");
  });
  it("approvals: none for native; only the SwapProxy for a token — never the router, Permit2, the PoolManager", () => {
    const n = e1Case();
    expectRefused(n.params, withTx(n, {approvalAddress: D143.swapProxy}), /with no approval/, "policy_refused");
    for (const approvalAddress of [D143.universalRouter, PERMIT2_ADDRESS, D143.poolManager, D143.positionManager, ATTACKER]) {
      const t = usdcToAusd();
      expectRefused(t.params, withTx(t, {approvalAddress}), /approves the SwapProxy only/, "policy_refused");
    }
    const t = usdcToAusd();
    const q = withTx(t, {});
    delete q.txRequest!.approvalAddress;
    expectRefused(t.params, q, /approves the SwapProxy only/, "policy_refused");
  });
});

describe("rows 15–18 — deployment check, preflight, gas, impact", () => {
  const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  it("row 15: linkage and codehashes, fail closed on any missing or wrong answer", () => {
    const reads = v4DeploymentReads(D143);
    expect(reads.map((r) => r.method)).toEqual(["eth_call", "eth_call", "eth_call", "eth_getCode", "eth_getCode"]);
    expect(reads.map((r) => (r.method === "eth_call" ? (r.params[0] as {to: string}).to : r.params[0]))).toEqual([D143.universalRouter, D143.quoter, D143.stateView, D143.universalRouter, D143.swapProxy]);
    // Stand-in codes, with a deployment override pinned to their keccak.
    const urCode = "0x6001600101";
    const spCode = "0x6002600201";
    const good = {...D143, routerCodehash: keccak256(urCode), swapProxyCodehash: keccak256(spCode)};
    const pm = word(D143.poolManager);
    expect(v4DeploymentProblem(good, [pm, pm, pm, urCode, spCode])).toBeNull();
    expect(v4DeploymentProblem(D143, [pm, pm, pm, urCode, spCode])).toMatch(/Universal Router's code is not the pinned 2\.1\.2 build/);
    expect(v4DeploymentProblem(good, [word(ATTACKER), pm, pm, urCode, spCode])).toMatch(/Universal Router does not report/);
    expect(v4DeploymentProblem(good, [pm, word(ATTACKER), pm, urCode, spCode])).toMatch(/V4Quoter does not report/);
    expect(v4DeploymentProblem(good, [pm, pm, null, urCode, spCode])).toMatch(/StateView/);
    expect(v4DeploymentProblem(good, [pm, pm, pm, "0x", spCode])).toMatch(/Universal Router's code/);
    expect(v4DeploymentProblem(good, [pm, pm, pm, urCode, urCode])).toMatch(/SwapProxy's code/);
    expect(v4DeploymentProblem(good, [pm, pm, pm, urCode])).toMatch(/no answer/);
  });
  it("row 16: the preflight eth_call of the exact transaction from its sender", () => {
    const c = e1Case();
    const call = v4PreflightCall(c.quote.txRequest as {to: string; data: string; value: string}, "0x1111111111111111111111111111111111111111");
    expect(call).toEqual({method: "eth_call", params: [{from: "0x1111111111111111111111111111111111111111", to: D143.universalRouter, data: e1.calldata_2_1_x, value: "0x56bc75e2d63100000"}, "latest"]});
    // Token input on Monad (no eth_simulateV1): the allowance slot by stateDiff, from the bare account.
    const t = usdcToAusd();
    const slot = erc20AllowanceSlot(USER, D143.swapProxy, 10n);
    const override = v4StorageOverride(USDC, slot, 700_000_000n);
    expect(override).toEqual({[USDC]: {stateDiff: {[slot]: `0x${(700_000_000n).toString(16).padStart(64, "0")}`}}});
    const est = v4PreflightCall(t.quote.txRequest as {to: string; data: string; value: string}, USER, {stateOverride: override, method: "eth_estimateGas"});
    expect(est.method).toBe("eth_estimateGas");
    expect(est.params).toEqual([{from: USER, to: D143.swapProxy, data: t.quote.txRequest!.data, value: "0x0"}, "latest", override]);
    // Solidity mapping layout: keccak(spender . keccak(owner . slot)).
    const inner = keccak256(encodeAbiParameters(parseAbiParameters("address, uint256"), [USER, 10n]));
    expect(slot).toBe(keccak256(encodeAbiParameters(parseAbiParameters("address, bytes32"), [D143.swapProxy, inner])));
  });
  it("row 17: a gas limit above the chain's per-transaction cap can never be mined", () => {
    const c = e1Case();
    expect(verify(c.params, withTx(c, {gasLimit: "216036"}))).toBeNull();
    expect(verify(c.params, withTx(c, {gasLimit: "30000000"}))).toBeNull();
    expectRefused(c.params, withTx(c, {gasLimit: "30000001"}), /above the chain's per-transaction cap 30000000/, "policy_refused");
    expectRefused(c.params, withTx(c, {gasLimit: "0"}), /not a positive integer/, "policy_refused");
    // Ethereum: EIP-7825's 2^24.
    const eth = UNISWAP_V4[1]!;
    const usdcEth = getAddress("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
    const k: V4PoolKey = {currency0: NATIVE, currency1: usdcEth, fee: 500, tickSpacing: 10, hooks: NATIVE};
    const e = makeCase({chainId: 1, pools: [k], currencyOut: usdcEth, amountIn: 10n ** 18n, amountOutMinimum: 1_000_000n});
    expect(e.quote.txRequest!.to).toBe(eth.universalRouter);
    expect(verify(e.params, withTx(e, {gasLimit: "16777216"}), {pools: {1: [k]}})).toBeNull();
    expectRefused(e.params, withTx(e, {gasLimit: "16777217"}), /cap 16777216/, "policy_refused", {pools: {1: [k]}});
  });
  it("row 18: impact is information unless the app sets maxPriceImpactBps", () => {
    const c = e1Case();
    const q = (bps?: string): Quote => ({...c.quote, providerData: bps === undefined ? {} : {priceImpactBps: bps}});
    expect(verify(c.params, q("9981"))).toBeNull();
    expect(verify(c.params, q())).toBeNull();
    expect(verify(c.params, q("17"), {maxPriceImpactBps: 500})).toBeNull();
    expectRefused(c.params, q("500"), /loses 5\.00% of the value to price impact/, "insufficient_liquidity", {maxPriceImpactBps: 500});
    expectRefused(c.params, q("9981"), /loses 99\.81%/, "insufficient_liquidity", {maxPriceImpactBps: 500});
    expectRefused(c.params, q(), /no price-impact measure/, "upstream_unavailable", {maxPriceImpactBps: 500});
    expectRefused(c.params, q("-1"), /no price-impact measure/, "upstream_unavailable", {maxPriceImpactBps: 500});
    expectRefused(c.params, q("17"), /maxPriceImpactBps must be/, "policy_refused", {maxPriceImpactBps: 0});
  });
});

describe("transaction shape", () => {
  it("a serialized transaction, a Permit2 transfer, a native fee, another chain id, no call", () => {
    const c = e1Case();
    expectRefused(c.params, withTx(c, {serializedTx: "AAAA"}), /no router call/, "policy_refused");
    expectRefused(c.params, withTx(c, {permit2Transfer: "{}"}), /signs no Permit2 transfer/, "policy_refused");
    expectRefused(c.params, withTx(c, {nativeFee: "1"}), /no native fee/, "policy_refused");
    expect(verify(c.params, withTx(c, {nativeFee: "0"}))).toBeNull();
    expectRefused(c.params, withTx(c, {chainId: 1}), /for chain 1, not 143/, "policy_refused");
    const {txRequest: _drop, ...noTx} = c.quote;
    void _drop;
    expectRefused(c.params, noTx as Quote, /no router call/, "policy_refused");
  });
  it("never throws on garbage, and refuses it", () => {
    const c = e1Case();
    for (const data of ["0x3593564c", `0x3593564c${"ff".repeat(200)}`, "zz", `0x2894adf9${"00".repeat(3)}`]) {
      expect(() => verify(c.params, withTx(c, {data}))).not.toThrow();
      expect(verify(c.params, withTx(c, {data}))).not.toBeNull();
    }
    expect(verify({...c.params, amountIn: "1e18"}, c.quote)).not.toBeNull();
    expect(verify(c.params, {...c.quote, minDestAmount: "-1"})).not.toBeNull();
    expect(verify(c.params, c.quote, {maxFeePips: 0})).toMatch(/v4MaxFeePips/);
    expect(verify(c.params, c.quote, {deadlineSeconds: -1})).toMatch(/deadlineSeconds/);
  });
});

/** The pins a 0.4.11 app ships: SwapRouter02 as the only call target and spender, and the v3 check alone (U1 moved both
 *  into `uniswapV3VerifyQuote` / the SwapRouter half of `uniswapPins`, so they are rebuilt here as 0.4.11 had them). */
const V3_ONLY = (chain: string): readonly string[] => {
  const id = Number(chain.slice(7));
  return Object.prototype.hasOwnProperty.call(UNISWAP_V3, id) ? [UNISWAP_V3[id]!.router] : [];
};
const PINS_0411 = {callTargets: V3_ONLY, spenders: V3_ONLY, verifyQuote: uniswapV3VerifyQuote};

describe("old 0.4.11 pins against a v4 quote", () => {
  it("the v3 verifier refuses it, and the v3 pins do not list the router or the SwapProxy", () => {
    const c = e1Case();
    expect(PINS_0411.verifyQuote(c.params, c.quote)).toMatch(/not the SwapRouter/);
    expect(uniswapPins.reasonOf!(PINS_0411.verifyQuote(c.params, c.quote)!)).toEqual({reason: "vault_mismatch"});
    expect(PINS_0411.callTargets("eip155:143")).not.toContain(D143.universalRouter);
    expect(PINS_0411.callTargets("eip155:143")).not.toContain(D143.swapProxy);
    const stub = {name: "uniswap", remote: true, callTargets: PINS_0411.callTargets, spenders: PINS_0411.spenders, verifiesQuotes: true};
    expect(remotePinRefusal(stub, c.quote, "eip155:143")).toMatch(/did not pin as a call target/);
    const t = usdcToAusd();
    expect(remotePinRefusal(stub, t.quote, "eip155:143")).toMatch(/did not pin as a spender/);
  });
  it("and the v4 verifier refuses a v3 SwapRouter02 quote", () => {
    const v3Call = encodeFunctionData({abi: parseAbi(["function multicall(uint256 deadline, bytes[] data) payable returns (bytes[])"]), functionName: "multicall", args: [E1_DEADLINE, []]});
    const c = e1Case();
    expectRefused(c.params, withTx(c, {to: UNISWAP_V3[143]!.router, data: v3Call}), /not the pinned Universal Router/, "vault_mismatch");
  });
});

describe("the remaining refusal paths are classified", () => {
  it("unknown source token, a non-address destination, same token in and out", () => {
    const c = e1Case();
    expectRefused({...c.params, sourceToken: "NOPE"}, c.quote, /unknown source token/, "unsupported_pair");
    expectRefused({...c.params, destToken: "AUSD"}, c.quote, /destination token must be an EVM address/, "unsupported_pair");
    const t = usdcToAusd();
    expectRefused({...t.params, destToken: USDC}, t.quote, /same token in and out/, "unsupported_pair");
    expectRefused({...c.params, destToken: NATIVE}, c.quote, /native in and out/, "unsupported_pair");
  });
  it("a request's amounts that are not integers", () => {
    const c = e1Case();
    expectRefused(c.params, {...c.quote, sourceAmount: "1.5"}, /integer amounts/, "policy_refused");
  });
  it("a hop through MON_USDT0 is fine where USDT0 is a hop currency", () => {
    const c = makeCase({currencyIn: USDC, currencyOut: USDT0, pools: [MON_USDC_500_10, MON_USDT0_500_10], amountIn: 700_000_000n, amountOutMinimum: 1n});
    expect(verify(c.params, c.quote)).toBeNull();
  });
});

// The live simulation matrix of the token-in-path lane (UNISWAP-V4-RESEARCH data, gaps/token-in-path §3.2): every
// case that executed a loss or a revert on chain, rebuilt as the quote a hostile server would send — all refused.
describe("token-in-path matrix: f1–f15, c1–c8, d1–d4 are refused before any approval", () => {
  const sweepIn = (token: `0x${string}`, to: `0x${string}`) => encodeAbiParameters(parseAbiParameters("address token, address recipient, uint256 amountMin"), [token, to, 0n]);
  const allInput = (min: bigint, currency: `0x${string}` = AUSD) => encodeAbiParameters(parseAbiParameters("address, uint256"), [currency, min]);
  const usdcToMon = () => makeCase({currencyIn: USDC, currencyOut: NATIVE, pools: [MON_USDC_500_10], amountIn: 700_000_000n, amountOutMinimum: 60_000n * 10n ** 18n});
  const monSwap = single({poolKey: MON_USDC_500_10, zeroForOne: false, amountIn: 700_000_000n, amountOutMinimum: 60_000n * 10n ** 18n});
  const proxy = (input: Hex, o: {router?: `0x${string}`; amount?: bigint; commands?: Hex; inputs?: Hex[]; deadline?: bigint} = {}) =>
    proxyExecute(o.router ?? D143.universalRouter, USDC, o.amount ?? 700_000_000n, o.commands ?? "0x10", o.inputs ?? [input], o.deadline);
  const nowS = BigInt(NOW_MS / 1000);
  const vectors: [string, () => [QuoteParams, Quote]][] = [
    ["f1 TAKE_ALL(AUSD) strands the output on the SwapProxy", () => tokenWith(proxy(tokenInput({actions: [0x06, 0x0b, 0x0f], take: allInput(696_555_000n)})))],
    ["f2 TAKE(AUSD, MSG_SENDER)", () => tokenWith(proxy(tokenInput({take: take(AUSD, V4_ACTION_CONSTANTS.MSG_SENDER)})))],
    ["f3 TAKE(AUSD, ADDRESS_THIS) then a sweep", () => tokenWith(proxy(tokenInput({take: take(AUSD, V4_ACTION_CONSTANTS.ADDRESS_THIS)})))],
    ["f4 TAKE(AUSD, attacker)", () => tokenWith(proxy(tokenInput({take: take(AUSD, ATTACKER)})))],
    ["f5 router = UR 2.1.1", () => tokenWith(proxy(tokenInput(), {router: UR211_143}))],
    ["f6 router = EVIL_ROUTER", () => tokenWith(proxy(tokenInput(), {router: ATTACKER}))],
    ["f7 amount = 2 × amountIn", () => tokenWith(proxy(tokenInput(), {amount: 1_400_000_000n}))],
    ["f8 0x10 0x04 with SWEEP(USDC, attacker), amount 2 ×", () => tokenWith(proxy(tokenInput(), {amount: 1_400_000_000n, commands: "0x1004", inputs: [tokenInput(), sweepIn(USDC, ATTACKER)]}))],
    ["f9 SETTLE payerIsUser = true", () => tokenWith(proxy(tokenInput({settle: settle(USDC, 700_000_000n, true)})))],
    ["f10 command byte 0x90", () => tokenWith(proxy(tokenInput(), {commands: "0x90"}))],
    ["f11 deadline = now − 1", () => tokenWith(proxy(tokenInput(), {deadline: nowS - 1n}))],
    ["f12 USDC → MON, TAKE_ALL(native)", () => { const c = usdcToMon(); return [c.params, withTx(c, {data: proxy(v4Input([0x06, 0x0b, 0x0f], [monSwap, settle(USDC, 700_000_000n), allInput(1n, NATIVE)]))})]; }],
    ["f13 USDC → MON, TAKE(native, MSG_SENDER)", () => { const c = usdcToMon(); return [c.params, withTx(c, {data: proxy(v4Input([0x06, 0x0b, 0x0e], [monSwap, settle(USDC, 700_000_000n), take(NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER)]))})]; }],
    ["f14 USDC → MON, TAKE(native, ADDRESS_THIS)", () => { const c = usdcToMon(); return [c.params, withTx(c, {data: proxy(v4Input([0x06, 0x0b, 0x0e], [monSwap, settle(USDC, 700_000_000n), take(NATIVE, V4_ACTION_CONSTANTS.ADDRESS_THIS)]))})]; }],
    ["f15 TAKE(AUSD, user, amount = min)", () => tokenWith(proxy(tokenInput({take: take(AUSD, RECIPIENT, 696_555_000n)})))],
    ["c2 SETTLE(OPEN_DELTA)", () => tokenWith(proxy(tokenInput({settle: settle(USDC, 0n)})))],
    ["c3 SETTLE_ALL under the SwapProxy", () => tokenWith(proxy(tokenInput({actions: [0x06, 0x0c, 0x0e], settle: allInput(700_000_000n, USDC)})))],
    ["c4 SETTLE_ALL via Permit2 (router called directly, Permit2 approved)", () => tokenWith(urExecute("0x10", [tokenInput({actions: [0x06, 0x0c, 0x0e], settle: allInput(700_000_000n, USDC)})]), {to: D143.universalRouter, approvalAddress: PERMIT2_ADDRESS})],
    ["c5 strict SETTLE payerIsUser via Permit2", () => tokenWith(urExecute("0x10", [tokenInput({settle: settle(USDC, 700_000_000n, true)})]), {to: D143.universalRouter, approvalAddress: PERMIT2_ADDRESS})],
    ["c6 SETTLE(CONTRACT_BALANCE)", () => tokenWith(proxy(tokenInput({settle: settle(USDC, V4_ACTION_CONSTANTS.CONTRACT_BALANCE)})))],
    ["c7 SETTLE(OPEN_DELTA) + TAKE + SWEEP(AUSD, user)", () => tokenWith(proxy(tokenInput({settle: settle(USDC, 0n)}), {commands: "0x1004", inputs: [tokenInput({settle: settle(USDC, 0n)}), sweepIn(AUSD, RECIPIENT)]}))],
    ["c8 … + SWEEP(AUSD, MSG_SENDER)", () => tokenWith(proxy(tokenInput(), {commands: "0x1004", inputs: [tokenInput(), sweepIn(AUSD, V4_ACTION_CONSTANTS.MSG_SENDER)]}))],
    ["d1 SwapProxy.execute with value 1 wei", () => tokenWith(usdcToAusd().quote.txRequest!.data! as Hex, {value: "1"})],
    ["d2 native 100 MON, value × 1.01", () => nativeWith(e1.calldata_2_1_x, {value: ((AMOUNT * 101n) / 100n).toString()})],
    ["d3 overpay, SETTLE_ALL + TAKE + SWEEP(native, MSG_SENDER)", () => nativeWith(urExecute("0x1004", [nativeInput({actions: [0x06, 0x0c, 0x0e], settle: allInput(AMOUNT, NATIVE)}), sweepIn(NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER)]), {value: ((AMOUNT * 101n) / 100n).toString()})],
    ["d4 Permit2 flow with a stray value", () => tokenWith(urExecute("0x10", [tokenInput({settle: settle(USDC, 700_000_000n, true)})]), {to: D143.universalRouter, approvalAddress: PERMIT2_ADDRESS, value: "1000000000000000"})],
    ["e1 the docs plan SETTLE_ALL + TAKE + SWEEP on native input", () => nativeWith(urExecute("0x1004", [nativeInput({actions: [0x06, 0x0c, 0x0e], settle: allInput(AMOUNT, NATIVE)}), sweepIn(NATIVE, V4_ACTION_CONSTANTS.MSG_SENDER)]))],
    ["e4 the docs plan SETTLE_ALL + TAKE_ALL (left 61,999.997 MON in the router)", () => nativeWith(urExecute("0x10", [nativeInput({actions: [0x06, 0x0c, 0x0f], settle: allInput(AMOUNT, NATIVE), take: allInput(1n)})]))],
  ];
  for (const [name, mk] of vectors) it(name, () => { refusal(...mk()); });
  it("the honest counterparts pass (a1 USDC → AUSD, b1 USDC → MON, e5 deep 62,000 MON)", () => {
    for (const c of [usdcToAusd(), usdcToMon(), makeCase({pools: [MON_USDC_500_10, AUSD_USDC_50_1], amountIn: 62_000n * 10n ** 18n, amountOutMinimum: 672_000_000n})]) expect(verify(c.params, c.quote)).toBeNull();
  });
});
