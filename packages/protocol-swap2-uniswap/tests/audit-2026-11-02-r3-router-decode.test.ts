import {describe, expect, it} from "vitest";
import {encodeFunctionData, encodePacked, type Hex} from "viem";
import {ROUTER_ABI, ROUTER_ITSELF, decode, decodeFor} from "./router-decode.js";
import {UNISWAP_V3} from "../src/addresses.js";

// An unwrapWETH9 forwards only the router's WETH: a swap leaving another token in the router is a
// router-held output (a recipient the suite refuses) even when an unwrap follows it.
const ME = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const WETH = UNISWAP_V3[1]!.weth, BASE_WETH = UNISWAP_V3[8453]!.weth;
const single = (tokenOut: string) => encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInputSingle",
  args: [{tokenIn: USDC, tokenOut: tokenOut as Hex, fee: 500, recipient: ROUTER_ITSELF, amountIn: 1_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n}]});
const path = (out: string) => encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInput",
  args: [{path: encodePacked(["address", "uint24", "address", "uint24", "address"], [USDC, 500, USDT, 500, out as Hex]), recipient: ROUTER_ITSELF, amountIn: 1_000_000n, amountOutMinimum: 0n}]});
const unwrap = encodeFunctionData({abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [1n, ME]});
const multicall = (legs: Hex[]) => ({kind: "call", data: encodeFunctionData({abi: ROUTER_ABI, functionName: "multicall", args: [9_999_999_999n, legs]})});

describe("uniswap fixture decode: an unwrap forwards WETH only", () => {
  it("a router-held output that is not WETH stays a recipient even with an unwrap after it", () => {
    expect(decode(multicall([single(USDT), unwrap]))).toEqual([ROUTER_ITSELF, ME]);
    expect(decode(multicall([path(USDT), unwrap]))).toEqual([ROUTER_ITSELF, ME]);
    // Another chain's wrapped token is not this chain's WETH.
    expect(decode(multicall([single(BASE_WETH), unwrap]))).toEqual([ROUTER_ITSELF, ME]);
  });
  it("control: a WETH output the next leg unwraps names only the unwrap's recipient, per chain", () => {
    expect(decode(multicall([single(WETH), unwrap]))).toEqual([ME]);
    expect(decode(multicall([path(WETH.toLowerCase()), unwrap]))).toEqual([ME]);
    expect(decodeFor(BASE_WETH)(multicall([single(BASE_WETH), unwrap]))).toEqual([ME]);
  });
});
