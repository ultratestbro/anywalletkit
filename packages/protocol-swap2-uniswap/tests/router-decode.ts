import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {UNISWAP_V3} from "../src/addresses.js";

// Who a SwapRouter02 multicall pays, read from its legs: each swap's recipient and each unwrap's
// recipient. A swap may pay the router itself (0x…02) only when its output is the chain's WETH and an
// unwrapWETH9 comes right after it, which forwards that output; anywhere else the router-held output is
// returned as a recipient (so the behaviour suite refuses it: anyone could sweep it). Any other leg is
// not accepted.
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
  "function multicall(uint256 deadline, bytes[] data)",
]);
export const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";

/** The decode for a chain whose wrapped native token is `weth`. */
export const decodeFor = (weth: string) => (source: {kind: string; data?: string}): string[] => {
  const m = decodeFunctionData({abi: ROUTER_ABI, data: source.data as Hex});
  if (m.functionName !== "multicall") throw new Error(`not a multicall: ${m.functionName}`);
  const legs = (m.args[1] as Hex[]).map((leg) => {
    const c = decodeFunctionData({abi: ROUTER_ABI, data: leg});
    if (c.functionName === "unwrapWETH9") return {unwrap: true, recipient: c.args[1], tokenOut: undefined};
    if (c.functionName === "exactInputSingle") return {unwrap: false, recipient: c.args[0].recipient, tokenOut: c.args[0].tokenOut as string};
    // exactInput's output token is the path's last 20 bytes.
    if (c.functionName === "exactInput") return {unwrap: false, recipient: c.args[0].recipient, tokenOut: `0x${c.args[0].path.slice(-40)}`};
    throw new Error(`unexpected leg ${c.functionName}`);
  });
  const forwarded = (i: number) => legs[i]!.tokenOut?.toLowerCase() === weth.toLowerCase() && legs[i + 1]?.unwrap === true;
  return legs
    .filter((l, i) => l.unwrap || l.recipient.toLowerCase() !== ROUTER_ITSELF || !forwarded(i))
    .map((l) => l.recipient);
};

/** The decode for the Ethereum fixtures. */
export const decode = decodeFor(UNISWAP_V3[1]!.weth);
