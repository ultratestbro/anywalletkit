import {describe, expect, it} from "vitest";
import {encodeFunctionData, getAddress} from "viem";
import {FYND_CHAINS, FyndTransactionError, ROUTER_NATIVE, TYCHO_ROUTER_ABI, TYCHO_ROUTER_SELECTORS, checkFyndTransaction} from "../src/router.js";

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const USER = "0x1111111111111111111111111111111111111111";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;

const expected = {chainId: 8453, tokenIn: USDC, tokenOut: WETH, amountIn: 1_000_000_000n, receiver: USER, expectedAmountOut: 250_000_000_000_000_000n, minAmountOut: 248_750_000_000_000_000n};

function single(over: Partial<{amountIn: bigint; tokenIn: string; tokenOut: string; expected: bigint; min: bigint; receiver: string; fee: typeof NO_FEE | Record<string, unknown>; swaps: `0x${string}`}> = {}) {
  return encodeFunctionData({
    abi: TYCHO_ROUTER_ABI,
    functionName: "singleSwap",
    args: [over.amountIn ?? expected.amountIn, (over.tokenIn ?? USDC) as `0x${string}`, (over.tokenOut ?? WETH) as `0x${string}`, over.expected ?? expected.expectedAmountOut, over.min ?? expected.minAmountOut, (over.receiver ?? USER) as `0x${string}`, (over.fee ?? NO_FEE) as never, over.swaps ?? "0xdeadbeef"],
  });
}

describe("checkFyndTransaction", () => {
  it("accepts the exact swap: pinned router, requested tokens, amount, receiver, quote amounts, no client fee", () => {
    expect(checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, expected)).toEqual({method: "singleSwap"});
  });

  it("accepts split and sequential routes, and native input with the router's native sentinel", () => {
    const split = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "splitSwap", args: [expected.amountIn, USDC, WETH, expected.expectedAmountOut, expected.minAmountOut, 3n, USER, NO_FEE as never, "0xbeef"]});
    expect(checkFyndTransaction({to: ROUTER, value: 0n, data: split}, expected).method).toBe("splitSwap");
    const native = single({tokenIn: ROUTER_NATIVE});
    expect(checkFyndTransaction({to: ROUTER, value: expected.amountIn, data: native}, {...expected, tokenIn: ZERO}).method).toBe("singleSwap");
  });

  const refusals: [string, () => unknown, RegExp][] = [
    ["another contract", () => checkFyndTransaction({to: "0x2222222222222222222222222222222222222222", value: 0n, data: single()}, expected), /not the Tycho router/],
    ["another receiver", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({receiver: "0x3333333333333333333333333333333333333333"})}, expected), /pays 0x3333/],
    ["a bigger spend", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({amountIn: expected.amountIn + 1n})}, expected), /spends/],
    ["other tokens", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({tokenOut: USDC})}, expected), /other tokens/],
    ["a lower minimum than quoted", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({min: 1n})}, expected), /do not match the quote/],
    ["a client fee", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({fee: {...NO_FEE, clientFeeBps: 50, clientFeeReceiver: "0x4444444444444444444444444444444444444444"}})}, expected), /client-fee/],
    ["a client-fee receiver without bps (a signed deadline path this module does not sign)", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({fee: {...NO_FEE, clientFeeReceiver: USER, deadline: 1n}})}, expected), /client-fee/],
    ["native value on an ERC-20 swap", () => checkFyndTransaction({to: ROUTER, value: 1n, data: single()}, expected), /native value/],
    ["an empty route", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single({swaps: "0x"})}, expected), /empty or invalid route/],
    ["a Permit2 variant", () => checkFyndTransaction({to: ROUTER, value: 0n, data: "0x12345678" + single().slice(10)}, expected), /not a plain/],
    ["an unpinned chain", () => checkFyndTransaction({to: ROUTER, value: 0n, data: single()}, {...expected, chainId: 10}), /no pinned Tycho router/],
  ];
  for (const [name, run, msg] of refusals) {
    it(`refuses ${name}`, () => {
      expect(run).toThrow(FyndTransactionError);
      expect(run).toThrow(msg);
    });
  }

  it("knows all nine swap entry points for history", () => {
    expect(TYCHO_ROUTER_SELECTORS.size).toBe(9);
    expect(getAddress(ROUTER)).toBe("0xAbA5B53b03eAfaD1C5fc8BD5Fc765fC85Bb3de67");
  });
});
