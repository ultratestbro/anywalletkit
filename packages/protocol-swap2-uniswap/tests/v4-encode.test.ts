// UNISWAP-V4-RESEARCH §3.6–§3.7, §3.10, §5.2 (U1/U2): the encoder, byte-exact against the recorded E1 worked example.
import {describe, expect, it} from "vitest";
import {decodeAbiParameters, decodeFunctionData, getAddress, size, type Hex} from "viem";
import {SWAP_PROXY_ABI, UNISWAP_V4, UR_ABI, V4_SWAP_INPUT_ABI} from "../src/v4/addresses.js";
import {encodeV4Swap, encodeV4SwapInput, v4PathOf, v4PoolsOfPath} from "../src/v4/encode.js";
import {poolIdOf} from "../src/v4/pool.js";
import {decodeV4SwapCall} from "../src/v4/verify.js";
import {AUSD, AUSD_USDC_50_1, D143, E1_DEADLINE, KEM_HOOK, MONAD, MON_AUSD_500_1, MON_USDC_500_10, NATIVE, RECIPIENT, USDC, USDT0, MON_USDT0_500_10, e1} from "./v4-helpers.js";

const E1 = {chainId: MONAD, currencyIn: NATIVE, currencyOut: AUSD, pools: [MON_AUSD_500_1], amountIn: 100n * 10n ** 18n, amountOutMinimum: 1_089_996n, recipient: RECIPIENT, deadline: E1_DEADLINE} as const;

describe("E1 — native MON in, single hookless pool (§3.10)", () => {
  it("encodes byte-for-byte the recorded calldata (1,188 bytes, executed live on UR 2.1.2)", () => {
    expect(BigInt(e1.amountIn)).toBe(E1.amountIn);
    expect(BigInt(e1.minOut)).toBe(E1.amountOutMinimum);
    expect(BigInt(e1.deadline)).toBe(E1.deadline);
    expect(getAddress(e1.recipient)).toBe(RECIPIENT);
    expect(e1.pool).toEqual(MON_AUSD_500_1);
    const enc = encodeV4Swap(E1);
    expect(enc.data).toBe(e1.calldata_2_1_x);
    expect(size(enc.data)).toBe(1188);
    expect(e1.bytes_2_1_x).toBe(1188);
    expect(enc).toMatchObject({flow: "native-in", to: D143.universalRouter, value: E1.amountIn, router: D143.universalRouter});
    expect(enc.approvalAddress).toBeUndefined();
  });

  it("has the §3.10 word map", () => {
    const enc = encodeV4Swap(E1);
    const w = (hex: Hex, i: number) => BigInt(`0x${hex.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
    const body = `0x${enc.data.slice(10)}` as Hex;
    expect([w(body, 0), w(body, 1), w(body, 2), w(body, 3)]).toEqual([0x60n, 0xa0n, E1_DEADLINE, 1n]);
    expect(body.slice(2 + 4 * 64, 2 + 4 * 64 + 2)).toBe("10"); // commands = 0x10
    expect([w(body, 5), w(body, 6), w(body, 7)]).toEqual([1n, 0x20n, 0x3a0n]); // inputs.length, offset, inputs[0].length 928
    const input = enc.v4Input;
    expect(size(input)).toBe(928);
    expect([w(input, 0), w(input, 1), w(input, 2)]).toEqual([0x40n, 0x80n, 3n]);
    expect(input.slice(2 + 3 * 64, 2 + 3 * 64 + 6)).toBe("060b0e");
    expect([w(input, 4), w(input, 5), w(input, 6), w(input, 7), w(input, 8)]).toEqual([3n, 0x60n, 0x200n, 0x280n, 0x180n]);
    // params[0]: 0x20 | c0 | c1 | fee | ts | hooks | zeroForOne | amountIn | min | minHop | offset(hookData) | len
    const p0 = Array.from({length: 12}, (_, i) => w(input, 9 + i));
    expect(p0).toEqual([0x20n, 0n, BigInt(AUSD), 500n, 1n, 0n, 1n, E1.amountIn, E1.amountOutMinimum, 0n, 0x140n, 0n]);
    expect([w(input, 21), w(input, 22), w(input, 23), w(input, 24)]).toEqual([0x60n, 0n, E1.amountIn, 0n]); // SETTLE(0x0, amountIn, false)
    expect([w(input, 25), w(input, 26), w(input, 27), w(input, 28)]).toEqual([0x60n, BigInt(AUSD), BigInt(RECIPIENT), 0n]); // TAKE(AUSD, recipient, 0)
  });

  it("decodes back strictly to the same route", () => {
    const r = decodeV4SwapCall(e1.calldata_2_1_x);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.swap).toMatchObject({flow: "native-in", deadline: E1_DEADLINE, currencyIn: NATIVE, currencyOut: AUSD, pools: [MON_AUSD_500_1], amountIn: E1.amountIn, amountOutMinimum: E1.amountOutMinimum, settle: {currency: NATIVE, amount: E1.amountIn, payerIsUser: false}, take: {currency: AUSD, recipient: RECIPIENT, amount: 0n}});
    expect(poolIdOf(r.swap.pools[0]!)).toBe(e1.poolId);
  });
});

describe("two hops, token input via SwapProxy, native output", () => {
  it("native in, two hops: SWAP_EXACT_IN with the PathKeys of MON →(500/10)→ USDC →(50/1)→ AUSD", () => {
    const enc = encodeV4Swap({...E1, pools: [MON_USDC_500_10, AUSD_USDC_50_1], amountIn: 62_000n * 10n ** 18n, amountOutMinimum: 670_000_000n});
    const r = decodeV4SwapCall(enc.data);
    expect(r.ok && r.swap.intermediates).toEqual([USDC, AUSD]);
    const [actions] = decodeAbiParameters(V4_SWAP_INPUT_ABI, enc.v4Input);
    expect(actions).toBe("0x070b0e");
    expect(v4PathOf(NATIVE, [MON_USDC_500_10, AUSD_USDC_50_1])).toEqual([
      {intermediateCurrency: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE, hookData: "0x"},
      {intermediateCurrency: AUSD, fee: 50, tickSpacing: 1, hooks: NATIVE, hookData: "0x"},
    ]);
    expect(v4PoolsOfPath(NATIVE, v4PathOf(NATIVE, [MON_USDC_500_10, AUSD_USDC_50_1]))).toEqual([MON_USDC_500_10, AUSD_USDC_50_1]);
  });

  it("token in: SwapProxy.execute(pinned UR, tokenIn, amountIn, 0x10, [V4_SWAP], deadline), value 0, approve the SwapProxy", () => {
    const req = {chainId: MONAD, currencyIn: USDC, currencyOut: AUSD, pools: [AUSD_USDC_50_1], amountIn: 700_000_000n, amountOutMinimum: 696_555_000n, recipient: RECIPIENT, deadline: E1_DEADLINE};
    const enc = encodeV4Swap(req);
    expect(enc).toMatchObject({flow: "swap-proxy", to: D143.swapProxy, value: 0n, approvalAddress: D143.swapProxy, router: D143.universalRouter});
    const {args} = decodeFunctionData({abi: SWAP_PROXY_ABI, data: enc.data});
    expect(args).toEqual([D143.universalRouter, USDC, 700_000_000n, "0x10", [enc.v4Input], E1_DEADLINE]);
    // The V4 input is the one a native-in call would carry for the same currencies (only the wrapper differs).
    expect(enc.v4Input).toBe(encodeV4SwapInput(req));
    const r = decodeV4SwapCall(enc.data);
    expect(r.ok && r.swap).toMatchObject({flow: "swap-proxy", proxyRouter: D143.universalRouter, proxyToken: USDC, proxyAmount: 700_000_000n, settle: {currency: USDC, amount: 700_000_000n, payerIsUser: false}, take: {currency: AUSD, recipient: RECIPIENT, amount: 0n}});
    // zeroForOne: USDC is currency1 of AUSD/USDC, so the swap runs one-for-zero.
    expect(r.ok && r.swap.currencyIn).toBe(USDC);
  });

  it("native out: TAKE(address(0), recipient, 0) — the PoolManager pays the recipient directly, no unwrap", () => {
    const enc = encodeV4Swap({chainId: MONAD, currencyIn: USDC, currencyOut: NATIVE, pools: [MON_USDC_500_10], amountIn: 700_000_000n, amountOutMinimum: 1n, recipient: RECIPIENT, deadline: E1_DEADLINE});
    const r = decodeV4SwapCall(enc.data);
    expect(r.ok && r.swap.take).toEqual({currency: NATIVE, recipient: RECIPIENT, amount: 0n});
    expect(r.ok && r.swap.flow).toBe("swap-proxy");
  });

  it("the UR call has one execute overload with a deadline", () => {
    const {functionName, args} = decodeFunctionData({abi: UR_ABI, data: encodeV4Swap(E1).data});
    expect(functionName).toBe("execute");
    expect(args).toHaveLength(3);
  });
});

describe("the encoder refuses what it would never send", () => {
  const bad: [string, Partial<Parameters<typeof encodeV4Swap>[0]>, RegExp][] = [
    ["an unpinned chain", {chainId: 324}, /no pinned deployment/],
    ["a hooked pool", {pools: [{...MON_AUSD_500_1, hooks: KEM_HOOK}]}, /hook/],
    ["a dynamic fee", {pools: [{...MON_AUSD_500_1, fee: 0x800000}]}, /dynamic/],
    ["a fee above 100%", {pools: [{...MON_AUSD_500_1, fee: 1_000_001}]}, /not a valid static fee/],
    ["tick spacing 0", {pools: [{...MON_AUSD_500_1, tickSpacing: 0}]}, /tick spacing/],
    ["currencies out of order", {pools: [{...MON_AUSD_500_1, currency0: AUSD, currency1: NATIVE}]}, /not in order/],
    ["a discontinuous route", {pools: [MON_USDC_500_10, MON_USDT0_500_10]}, /does not hold/],
    ["a route ending elsewhere", {pools: [MON_USDT0_500_10]}, /does not end/],
    ["three pools", {pools: [MON_USDC_500_10, AUSD_USDC_50_1, AUSD_USDC_50_1]}, /1–2 pools/],
    ["no pool", {pools: []}, /1–2 pools/],
    ["native in and out", {currencyOut: NATIVE}, /same currency|not a swap/],
    ["amountIn 0 (OPEN_DELTA)", {amountIn: 0n}, /amountIn/],
    ["amountIn ≥ 2^128", {amountIn: 1n << 128n}, /amountIn/],
    ["minimum 0", {amountOutMinimum: 0n}, /amountOutMinimum/],
    ["recipient MSG_SENDER", {recipient: "0x0000000000000000000000000000000000000001"}, /sentinel/],
    ["recipient ADDRESS_THIS", {recipient: "0x0000000000000000000000000000000000000002"}, /sentinel/],
    ["deadline 0", {deadline: 0n}, /deadline/],
  ];
  for (const [what, o, re] of bad) it(what, () => expect(() => encodeV4Swap({...E1, ...o})).toThrow(re));

  it("native on a chain whose native coin is an ERC-20 (Arc, Celo)", () => {
    const arcUsdc = getAddress("0x3600000000000000000000000000000000000000");
    expect(() => encodeV4Swap({...E1, chainId: 5042, pools: [{currency0: NATIVE, currency1: arcUsdc, fee: 500, tickSpacing: 10, hooks: NATIVE}], currencyOut: arcUsdc})).toThrow(/ERC-20/);
    expect(UNISWAP_V4[42220]!.nativeWrap).toBe(false);
    expect(() => encodeV4Swap({...E1, chainId: 42220, currencyIn: USDT0, currencyOut: NATIVE, pools: [MON_USDT0_500_10]})).toThrow(/ERC-20/);
  });
});
