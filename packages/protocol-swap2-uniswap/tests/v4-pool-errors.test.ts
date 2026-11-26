// UNISWAP-V4-RESEARCH §3.1 (PoolKey, PoolId, hook bits, fees) and §3.9 (the error map), on recorded Monad data.
import {describe, expect, it} from "vitest";
import {encodeErrorResult, toFunctionSelector, type Hex} from "viem";
import {
  V4_ALL_HOOK_FLAGS, V4_DYNAMIC_FEE_FLAG, V4_HOOK_FLAGS, hasSwapHooks, hookFlagsOf, isDynamicFee, isHookless, isValidStaticFee, poolIdOf, sortCurrencies, v4PoolKeyProblem,
} from "../src/v4/pool.js";
import {V4_ERRORS_ABI, classifyV4Revert, decodeV4Revert, notEnoughLiquidityPoolId} from "../src/v4/errors.js";
import {AUSD, AUSD_USDC_50_1, KEM_HOOK, MON_AUSD_10000_200, MON_AUSD_500_1, MON_USDC_500_10, NATIVE, USDC, fixture} from "./v4-helpers.js";

const reverts = fixture<{poolId: Hex; wrapped: Hex; raw: Hex; swapAmountCannotBeZero: Hex; priceLimitAlreadyExceeded: Hex}>("monad-reverts.json");

describe("PoolId = keccak256(abi.encode(PoolKey))", () => {
  it("Monad NATIVE/AUSD 500/1 is 0xadaf3077…d8219 (the E1 pool)", () => {
    expect(poolIdOf(MON_AUSD_500_1)).toBe("0xadaf30776f551bccdfb307c3fd8cdec198ca9a852434c8022ee32d1ccedd8219");
  });
  it("the other recorded Monad pools", () => {
    expect(poolIdOf(MON_USDC_500_10)).toBe("0x18a9fc874581f3ba12b7898f80a683c66fd5877fd74b26a85ba9a3a79c549954");
    expect(poolIdOf(AUSD_USDC_50_1)).toBe("0x092b650478145f0aee73a1b400b342b9c6314db2e07aeb91faf7e75e8159ce72");
    expect(poolIdOf(MON_AUSD_10000_200)).toBe(reverts.poolId);
  });
  it("is case-insensitive in the addresses and sensitive to every field", () => {
    const lower = {...MON_AUSD_500_1, currency1: AUSD.toLowerCase() as `0x${string}`};
    expect(poolIdOf(lower)).toBe(poolIdOf(MON_AUSD_500_1));
    for (const k of [{fee: 501}, {tickSpacing: 2}, {hooks: KEM_HOOK}] as const) expect(poolIdOf({...MON_AUSD_500_1, ...k})).not.toBe(poolIdOf(MON_AUSD_500_1));
  });
});

describe("currencies, hooks and fees", () => {
  it("sorts by numeric address, native first", () => {
    expect(sortCurrencies(AUSD, NATIVE)).toEqual([NATIVE, AUSD]);
    expect(sortCurrencies(USDC, AUSD)).toEqual([AUSD, USDC]);
    expect(() => sortCurrencies(USDC, USDC.toLowerCase())).toThrow();
  });
  it("hook permissions are the low 14 bits of the address", () => {
    expect(hookFlagsOf(NATIVE)).toBe(0);
    expect(isHookless(NATIVE)).toBe(true);
    // The Kyber KEM hook: beforeSwap, afterSwap, afterSwapReturnDelta (§6.1).
    expect(hookFlagsOf(KEM_HOOK)).toBe(V4_HOOK_FLAGS.BEFORE_SWAP | V4_HOOK_FLAGS.AFTER_SWAP | V4_HOOK_FLAGS.AFTER_SWAP_RETURNS_DELTA);
    expect(hasSwapHooks(KEM_HOOK)).toBe(true);
    expect(isHookless(KEM_HOOK)).toBe(false);
    expect(hookFlagsOf("0x000000000000000000000000000000000000ffff")).toBe(V4_ALL_HOOK_FLAGS);
    expect(hasSwapHooks("0x0000000000000000000000000000000000003f00")).toBe(false); // liquidity/initialize bits only
    expect(() => hookFlagsOf("0x1234")).toThrow();
  });
  it("dynamic fee = exactly the flag; static fee ≤ 100%", () => {
    expect(isDynamicFee(V4_DYNAMIC_FEE_FLAG)).toBe(true);
    expect(isDynamicFee(V4_DYNAMIC_FEE_FLAG | 1)).toBe(false);
    expect([0, 1, 500, 1_000_000].every(isValidStaticFee)).toBe(true);
    expect([-1, 1_000_001, 0.5, V4_DYNAMIC_FEE_FLAG].some(isValidStaticFee)).toBe(false);
  });
  it("v4PoolKeyProblem: hookless, static, under the cap, tick spacing in range, ordered", () => {
    expect(v4PoolKeyProblem(MON_AUSD_500_1)).toBeNull();
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, hooks: KEM_HOOK})).toMatch(/hook/);
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, fee: V4_DYNAMIC_FEE_FLAG})).toMatch(/dynamic/);
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, fee: 120_000})).toMatch(/above the 10% cap/); // Linea's 12% pools
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, fee: 120_000}, 200_000)).toBeNull();
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, fee: 991_000}, 1_000_000)).toBeNull(); // 99.1% is valid on chain…
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, fee: 991_000})).toMatch(/cap/); // …and refused by default
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, tickSpacing: 0})).toMatch(/tick spacing/);
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, tickSpacing: 32_768})).toMatch(/tick spacing/);
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, currency0: AUSD, currency1: NATIVE})).toMatch(/order/);
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, currency1: NATIVE})).toMatch(/order/);
    expect(v4PoolKeyProblem({...MON_AUSD_500_1, currency1: "0x1234" as `0x${string}`})).toMatch(/20-byte/);
  });
});

describe("revert decoding (§3.9)", () => {
  it("selectors", () => {
    const sel = (sig: string) => toFunctionSelector(`function ${sig}`);
    expect(sel("UnexpectedRevertBytes(bytes)")).toBe("0x6190b2b0");
    expect(sel("NotEnoughLiquidity(bytes32)")).toBe("0x7a5ed734");
    expect(sel("PoolNotInitialized()")).toBe("0x486aa307");
    expect(sel("PriceLimitAlreadyExceeded(uint160,uint160)")).toBe("0x7c9c6e8f");
    expect(sel("SwapAmountCannotBeZero()")).toBe("0xbe8b8507");
    expect(sel("WrappedError(address,bytes4,bytes,bytes)")).toBe("0x90bfb865");
    expect(sel("CurrencyNotSettled()")).toBe("0x5212cba1");
    expect(sel("ExecutionFailed(uint256,bytes)")).toBe("0x2c4029e9");
    expect(sel("NativeTransferFailed()")).toBe("0xf4b3b1bc");
    expect(sel("UnsupportedProtocolError()")).toBe("0xea3559ef");
    expect(sel("SliceOutOfBounds()")).toBe("0x3b99b53d");
    expect(sel("V4TooLittleReceived(uint256,uint256)")).toBe("0x8b063d73");
  });

  it("NotEnoughLiquidity, raw (the quoter's inner error)", () => {
    expect(notEnoughLiquidityPoolId(reverts.raw)).toBe(reverts.poolId);
    expect(classifyV4Revert(reverts.raw)).toMatchObject({reason: "insufficient_liquidity", poolId: reverts.poolId, error: "NotEnoughLiquidity"});
  });

  it("NotEnoughLiquidity, wrapped in UnexpectedRevertBytes (as the RPC returned it)", () => {
    const r = decodeV4Revert(reverts.wrapped);
    expect(r.name).toBe("UnexpectedRevertBytes");
    expect(r.inner?.name).toBe("NotEnoughLiquidity");
    expect(notEnoughLiquidityPoolId(reverts.wrapped)).toBe(reverts.poolId);
    expect(classifyV4Revert(reverts.wrapped)).toMatchObject({reason: "insufficient_liquidity", poolId: reverts.poolId});
  });

  it("other recorded quoter reverts are not a partial fill", () => {
    expect(notEnoughLiquidityPoolId(reverts.swapAmountCannotBeZero)).toBeNull();
    expect(classifyV4Revert(reverts.swapAmountCannotBeZero)).toMatchObject({reason: "amount_too_small", error: "SwapAmountCannotBeZero"});
    expect(classifyV4Revert(reverts.priceLimitAlreadyExceeded)).toMatchObject({reason: "insufficient_liquidity", error: "PriceLimitAlreadyExceeded"});
  });

  it("router reverts: wrapped in ExecutionFailed, and the PoolManager's WrappedError", () => {
    const enc = (errorName: string, args?: readonly unknown[]) => encodeErrorResult({abi: V4_ERRORS_ABI, errorName: errorName as never, args: args as never});
    const exec = (inner: Hex) => enc("ExecutionFailed", [0n, inner]);
    expect(classifyV4Revert(exec(enc("CurrencyNotSettled")))).toMatchObject({reason: "insufficient_liquidity", error: "CurrencyNotSettled"});
    const tlr = classifyV4Revert(exec(enc("V4TooLittleReceived", [1_095_475n, 1_095_474n])));
    expect(tlr).toMatchObject({reason: "price_check_failed"});
    expect(tlr.text).toContain("1095474");
    const native = enc("WrappedError", ["0x0000000085E102724e78eCd2F45DC9cA239Affad", "0x00000000", "0x", enc("NativeTransferFailed")]);
    expect(classifyV4Revert(exec(native))).toMatchObject({reason: "recipient_mismatch", error: "NativeTransferFailed"});
    expect(classifyV4Revert(enc("TransactionDeadlinePassed"))).toMatchObject({reason: "quote_expired"});
    expect(classifyV4Revert(enc("UnsupportedProtocolError"))).toMatchObject({reason: "vault_mismatch"});
    expect(classifyV4Revert(enc("PoolNotInitialized"))).toMatchObject({reason: "no_route"});
  });

  it("unknown, empty and malformed data are a simulation failure, never a pass", () => {
    expect(classifyV4Revert("0x")).toMatchObject({reason: "simulation_failed", error: "empty"});
    expect(classifyV4Revert("0xdeadbeef")).toMatchObject({reason: "simulation_failed", error: "unknown"});
    expect(classifyV4Revert(undefined)).toMatchObject({reason: "simulation_failed"});
    expect(classifyV4Revert("not hex")).toMatchObject({reason: "simulation_failed"});
    expect(notEnoughLiquidityPoolId("0x7a5ed734")).toBeNull();
  });
});
