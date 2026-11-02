import {describe, expect, it} from "vitest";
import {concat, encodeFunctionData, encodePacked, type Hex} from "viem";
import {ROUTER_ABI, ROUTER_ITSELF, decode} from "./router-decode.js";
import {UNISWAP_V3} from "../src/addresses.js";

// An exactInput path is token (fee token)+: 20 + 23k bytes with k ≥ 1. Its output token is the last hop's,
// so bytes trailing a well-formed path cannot pose as a WETH output the next unwrap forwards.
const ME = "0x1111111111111111111111111111111111111111";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const WETH = UNISWAP_V3[1]!.weth;
const exactInput = (path: Hex) => encodeFunctionData({abi: ROUTER_ABI, functionName: "exactInput",
  args: [{path, recipient: ROUTER_ITSELF, amountIn: 1_000_000n, amountOutMinimum: 0n}]});
const unwrap = encodeFunctionData({abi: ROUTER_ABI, functionName: "unwrapWETH9", args: [1n, ME]});
const multicall = (legs: Hex[]) => ({kind: "call", data: encodeFunctionData({abi: ROUTER_ABI, functionName: "multicall", args: [9_999_999_999n, legs]})});

describe("uniswap fixture decode: an exactInput path is read hop by hop", () => {
  it("a path with bytes past its last hop is not accepted (USDC|500|USDT + WETH's 20 bytes)", () => {
    const usdcUsdt = encodePacked(["address", "uint24", "address"], [USDC, 500, USDT]);
    expect(() => decode(multicall([exactInput(concat([usdcUsdt, WETH as Hex])), unwrap]))).toThrow(/path/);
    // Shorter than one hop, or a fee with no token after it.
    expect(() => decode(multicall([exactInput(USDC as Hex), unwrap]))).toThrow(/path/);
    expect(() => decode(multicall([exactInput(encodePacked(["address", "uint24"], [USDC, 500])), unwrap]))).toThrow(/path/);
  });
  it("control: one- and two-hop paths ending in WETH name only the unwrap's recipient; ending in USDT, the router too", () => {
    expect(decode(multicall([exactInput(encodePacked(["address", "uint24", "address"], [USDC, 500, WETH as Hex])), unwrap]))).toEqual([ME]);
    expect(decode(multicall([exactInput(encodePacked(["address", "uint24", "address", "uint24", "address"], [USDC, 500, USDT, 500, WETH as Hex])), unwrap]))).toEqual([ME]);
    expect(decode(multicall([exactInput(encodePacked(["address", "uint24", "address"], [USDC, 500, USDT])), unwrap]))).toEqual([ROUTER_ITSELF, ME]);
  });
});
