import {describe, expect, it} from "vitest";
import {encodeFunctionData, type Hex} from "viem";
import {ROUTER_ABI, ROUTER_ITSELF, decode} from "./router-decode.js";

// The behaviour fixture's reading of a SwapRouter02 multicall: an output left in the router is a
// recipient unless the very next leg unwraps it to someone.
const ME = "0x1111111111111111111111111111111111111111";
const A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", B = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const swap = (recipient: string, amountIn: bigint) => encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInputSingle",
  args: [{tokenIn: A, tokenOut: B, fee: 500, recipient: recipient as Hex, amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n}]});
const unwrap = (recipient: string) => encodeFunctionData({abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [1n, recipient as Hex]});
const multicall = (legs: Hex[]) => ({kind: "call", data: encodeFunctionData({abi: ROUTER_ABI, functionName: "multicall", args: [9_999_999_999n, legs]})});

describe("uniswap fixture decode: router-held outputs", () => {
  it("a swap to the router followed by another swap names the router (the suite then refuses it)", () => {
    expect(decode(multicall([swap(ROUTER_ITSELF, 1_000_000n), swap(ME, 1n)]))).toEqual([ROUTER_ITSELF, ME]);
    expect(decode(multicall([swap(ROUTER_ITSELF, 1_000_000n), swap(ROUTER_ITSELF, 1n), swap(ME, 1n)]))).toEqual([ROUTER_ITSELF, ROUTER_ITSELF, ME]);
    expect(decode(multicall([swap(ROUTER_ITSELF, 1_000_000n)]))).toEqual([ROUTER_ITSELF]);
    expect(decode(multicall([unwrap(ME), swap(ROUTER_ITSELF, 1n)]))).toEqual([ME, ROUTER_ITSELF]);
  });
  it("control: a swap to the router that the next leg unwraps names only the unwrap's recipient; a direct swap names its recipient", () => {
    expect(decode(multicall([swap(ROUTER_ITSELF, 1_000_000n), unwrap(ME)]))).toEqual([ME]);
    expect(decode(multicall([swap(ME, 1_000_000n)]))).toEqual([ME]);
  });
});
