// checkKyberTransaction: one refused vector per check (KYBER-RESEARCH §5.4 #1–#11, §5.5), each before any approval.
import {describe, expect, it} from "vitest";
import {refusalOf} from "@anywalletkit/protocol-swap2-core/errors";
import type {Quote} from "@anywalletkit/protocol-swap2-core/types";
import {KYBER_CHAINS, KYBER_EXECUTOR, KYBER_NATIVE, KYBER_ROUTER_V2, KYBER_ROUTER_V3, checkKyberTransaction, kyberApiSlippage, kyberMinimum, kyberPins, kyberVerifyQuote, type ExpectedKyberSwap} from "../src/router.js";
import {ATTACKER, ME, USDC, WETH, ZERO, params, swapData, type SwapArgs} from "./helpers.js";

const IN = 1_000_000_000n, MIN = 398_000_000_000_000_000n;
const expected: ExpectedKyberSwap = {chainId: 8453, tokenIn: USDC, tokenOut: WETH, amountIn: IN, receiver: ME, minAmountOut: MIN};
const good: SwapArgs = {srcToken: USDC, dstToken: WETH, dstReceiver: ME, amount: IN, minReturnAmount: MIN};
const tx = (a: Partial<SwapArgs> = {}, over: {to?: string; value?: bigint; data?: string} = {}) => ({to: KYBER_ROUTER_V2, value: 0n, data: swapData({...good, ...a}), ...over});
const refused = (t: ReturnType<typeof tx>, exp: ExpectedKyberSwap = expected) => {
  try {
    checkKyberTransaction(t, exp);
  } catch (e) {
    return {message: (e as Error).message, reason: refusalOf(e)?.reason};
  }
  return null;
};

describe("checkKyberTransaction", () => {
  it("accepts the swap the build endpoint encodes (token in, executor, flags 0x200, no fee)", () => {
    expect(checkKyberTransaction(tx(), expected)).toMatchObject({amount: IN, minReturnAmount: MIN, flags: 0x200n});
  });

  it("accepts a native-coin input: empty split, value equal to the amount", () => {
    const n = {...expected, tokenIn: ZERO};
    expect(refused(tx({srcToken: KYBER_NATIVE, srcReceivers: [], srcAmounts: []}, {value: IN}), n)).toBeNull();
  });

  it("#1 refuses another contract, and router V3 by name", () => {
    expect(refused(tx({}, {to: ATTACKER}))).toMatchObject({reason: "vault_mismatch"});
    expect(refused(tx({}, {to: KYBER_ROUTER_V3}))?.message).toMatch(/V3 not supported yet/);
  });

  it("#2 refuses swapGeneric, swapSimpleMode and any other selector", () => {
    const body = tx().data.slice(10);
    expect(refused(tx({}, {data: `0x59e50fed${body}`}))?.message).toMatch(/swapGeneric/);
    expect(refused(tx({}, {data: `0x8af033fb${body}`}))?.message).toMatch(/swapSimpleMode/);
    expect(refused(tx({}, {data: `0x12345678${body}`}))?.message).toMatch(/not a router swap/);
  });

  it("#3 refuses trailing bytes and a non-canonical encoding", () => {
    expect(refused(tx({}, {data: `${tx().data}00`}))).toMatchObject({reason: "policy_refused"});
    expect(refused(tx({}, {data: `${tx().data}deadbeef`}))?.message).toMatch(/canonical/);
    // The struct's head offset moved one word on: still decodes, but is not the canonical encoding.
    const d = tx().data;
    const moved = `${d.slice(0, 10)}${(0x40).toString(16).padStart(64, "0")}${"0".repeat(64)}${d.slice(74)}`;
    expect(refused(tx({}, {data: moved}))).not.toBeNull();
  });

  it("#3 refuses calldata larger than any routed swap", () => {
    expect(refused(tx({targetData: `0x${"ab".repeat(70_000)}`}))?.message).toMatch(/larger/);
  });

  it("#4 refuses a foreign executor and a router-side approval", () => {
    expect(refused(tx({callTarget: ATTACKER}))).toMatchObject({reason: "vault_mismatch"});
    expect(refused(tx({approveTarget: ATTACKER}))?.message).toMatch(/approve another contract/);
  });

  it("#5 refuses other input token or amount", () => {
    expect(refused(tx({srcToken: WETH}))?.message).toMatch(/other tokens/);
    expect(refused(tx({amount: IN + 1n, srcAmounts: [IN + 1n]}))).toMatchObject({reason: "price_check_failed"});
  });

  it("#6 native: refuses a non-empty split and a wrong value; token: refuses a split that does not add up and any value", () => {
    const n = {...expected, tokenIn: ZERO};
    expect(refused(tx({srcToken: KYBER_NATIVE, srcReceivers: [ATTACKER], srcAmounts: [IN]}, {value: IN}), n)?.message).toMatch(/must not split/);
    expect(refused(tx({srcToken: KYBER_NATIVE, srcReceivers: [], srcAmounts: []}, {value: IN - 1n}), n)?.message).toMatch(/native value/);
    expect(refused(tx({srcAmounts: [IN - 1n]}))?.message).toMatch(/adds up/);
    expect(refused(tx({srcReceivers: [ATTACKER, ATTACKER], srcAmounts: [IN, 1n]}))?.message).toMatch(/adds up/);
    expect(refused(tx({srcReceivers: [ATTACKER], srcAmounts: [IN, 0n]}))).not.toBeNull();
    expect(refused(tx({}, {value: 1n}))?.message).toMatch(/must not send the native coin/);
  });

  it("#7 refuses another output token, another receiver, and no receiver", () => {
    expect(refused(tx({dstToken: USDC}))?.message).toMatch(/other tokens/);
    expect(refused(tx({dstReceiver: ATTACKER}))).toMatchObject({reason: "recipient_mismatch"});
    expect(refused(tx({dstReceiver: ZERO}))).toMatchObject({reason: "recipient_mismatch"});
    expect(refused(tx(), {...expected, receiver: KYBER_EXECUTOR})).toMatchObject({reason: "recipient_mismatch"});
  });

  it("#8 refuses no minimum and a minimum under the quote's", () => {
    expect(refused(tx({minReturnAmount: 0n}))).toMatchObject({reason: "price_check_failed"});
    expect(refused(tx({minReturnAmount: MIN - 1n}))?.message).toMatch(/under the quoted minimum/);
    expect(refused(tx({minReturnAmount: MIN + 1n}))).toBeNull();
  });

  it("#9 refuses the injected 30 bps fee (KYBER-RESEARCH §3.4) and any fee entry", () => {
    expect(refused(tx({feeReceivers: [ATTACKER], feeAmounts: [30n], flags: 0x2c0n}))).toMatchObject({reason: "policy_refused"});
    expect(refused(tx({feeReceivers: [ATTACKER], feeAmounts: [30n]}))?.message).toMatch(/fee receiver/);
    expect(refused(tx({feeReceivers: [], feeAmounts: [1n]}))?.message).toMatch(/fee receiver/);
  });

  it("#10 accepts only flag 0x200", () => {
    for (const f of [0x01n, 0x02n, 0x04n, 0x08n, 0x10n, 0x20n, 0x40n, 0x80n, 0x100n, 0x400n, 1n << 200n]) {
      expect(refused(tx({flags: 0x200n | f}))?.message, f.toString(16)).toMatch(/flags/);
    }
    expect(refused(tx({flags: 0n}))).toBeNull();
  });

  it("#11 refuses a permit", () => {
    expect(refused(tx({permit: "0x1234"}))?.message).toMatch(/permit/);
  });

  it("refuses an unpinned chain, the same token in and out, and the native coin where the catalog has none (Arc)", () => {
    expect(refused(tx(), {...expected, chainId: 324})).toMatchObject({reason: "unsupported_pair"});
    expect(refused(tx({dstToken: USDC}), {...expected, tokenOut: USDC})?.message).toMatch(/same token/);
    expect(refused(tx({srcToken: KYBER_NATIVE, srcReceivers: [], srcAmounts: []}, {value: IN}), {...expected, chainId: 5042, tokenIn: ZERO})?.message).toMatch(/native coin on Arc/);
  });
});

describe("kyberMinimum", () => {
  it("is one unit under floor(amountOut × (1 − bps)) — what the build endpoint encodes", () => {
    // Live 2026-11-24, Arc USDC → EURC: amountOut 18237451 at 50 bps → 18146262 in the calldata.
    expect(kyberMinimum(18_237_451n, 50)).toBe(18_146_262n);
    expect(kyberMinimum(10_000n, 50)).toBe(9_949n);
    expect(kyberMinimum(1n, 50)).toBe(0n);
  });
});

describe("kyberApiSlippage", () => {
  const engineFloor = (out: bigint, bps: number) => (out * BigInt(10_000 - bps)) / 10_000n;
  it("asks 1 bps less for an ordinary output, so KyberSwap's minimum meets the engine's floor", () => {
    expect(kyberApiSlippage(18_237_451n, 50)).toBe(49);
    expect(kyberMinimum(18_237_451n, 49)).toBeGreaterThanOrEqual(engineFloor(18_237_451n, 50));
  });
  it("asks more for a tiny output (test run 2026-11-24: $1 of WBTC, 1666 units at 100 bps was refused by the engine)", () => {
    const b = kyberApiSlippage(1666n, 100)!;
    expect(b).toBeLessThan(99);
    expect(kyberMinimum(1666n, b)).toBeGreaterThanOrEqual(engineFloor(1666n, 100));
    for (const out of [1n, 7n, 100n, 1666n, 10n ** 6n, 10n ** 24n]) for (const bps of [1, 10, 50, 100, 1999]) {
      const x = kyberApiSlippage(out, bps);
      if (x !== null) expect(kyberMinimum(out, x)).toBeGreaterThanOrEqual(engineFloor(out, bps));
    }
  });
  it("is null when no positive slippage leaves a minimum", () => {
    expect(kyberApiSlippage(1n, 50)).toBeNull();
    expect(kyberApiSlippage(100n, 1)).toBeNull();
  });
});

describe("kyberVerifyQuote", () => {
  const dryQuote = (over: Partial<Quote> = {}): Quote => ({provider: "kyberswap", intentId: "kyberswap:8453", depositAddress: "", depositMemo: null, sourceAmount: "1000000000", destAmount: "400000000000000000", minDestAmount: kyberMinimum(400_000_000_000_000_000n, 50).toString(), feeUsd: 0, etaSeconds: 15, reliability: 0.95, validUntilMs: Date.now() + 30_000, ...over});
  const execQuote = (a: Partial<SwapArgs> = {}, over: Partial<Quote> = {}) => {
    const min = kyberMinimum(400_000_000_000_000_000n, 50);
    return dryQuote({txRequest: {to: KYBER_ROUTER_V2, data: swapData({...good, minReturnAmount: min, ...a}), value: "0", chainId: 8453, approvalAddress: KYBER_ROUTER_V2}, ...over});
  };

  it("passes a dry quote without a transaction, and an execution quote whose calldata matches the request", () => {
    expect(kyberVerifyQuote(params(), dryQuote())).toBeNull();
    expect(kyberVerifyQuote(params({dry: false}), execQuote())).toBeNull();
  });

  it("refuses an execution request answered without a transaction", () => {
    expect(kyberVerifyQuote(params({dry: false}), dryQuote())).toMatch(/no router transaction/);
  });

  it("refuses a minimum above the output, under the floor, or with more slippage than asked", () => {
    expect(kyberVerifyQuote(params(), dryQuote({minDestAmount: "400000000000000001"}))).toMatch(/invalid quote amounts/);
    expect(kyberVerifyQuote(params({minAmountOut: "399000000000000000"}), dryQuote())).toMatch(/under the floor/);
    expect(kyberVerifyQuote(params({slippageBps: 10}), dryQuote())).toMatch(/more slippage/);
  });

  it("refuses another amount, a cross-chain request and an unpinned chain", () => {
    expect(kyberVerifyQuote(params(), dryQuote({sourceAmount: "1"}))).toMatch(/another amount/);
    expect(kyberVerifyQuote(params({destChain: "eip155:1"}), dryQuote())).toMatch(/same-chain/);
    expect(kyberVerifyQuote(params({sourceChain: "eip155:324", destChain: "eip155:324"}), dryQuote())).toMatch(/no pinned/);
  });

  it("refuses a transaction paying someone else or a foreign spender, with a reason the stub can carry", () => {
    const text = kyberVerifyQuote(params({dry: false}), execQuote({dstReceiver: ATTACKER}));
    expect(text).toMatch(/pays/);
    expect(kyberPins.reasonOf?.(text!)).toMatchObject({reason: "recipient_mismatch"});
    expect(kyberVerifyQuote(params({dry: false}), execQuote({}, {txRequest: {...execQuote().txRequest!, approvalAddress: ATTACKER}}))).toMatch(/another spender/);
  });

  it("pins the router as the only call target and spender, on Kyber chains only", () => {
    expect(kyberPins.callTargets!("eip155:8453")).toEqual([KYBER_ROUTER_V2]);
    expect(kyberPins.spenders!("eip155:999")).toEqual([KYBER_ROUTER_V2]);
    expect(kyberPins.spenders!("eip155:324")).toEqual([]);
    expect(Object.keys(KYBER_CHAINS)).toHaveLength(18);
  });
});
