import {decodeFunctionData, parseAbi, type Hex} from "viem";

// Who a SwapRouter02 multicall pays, read from its legs: each swap's recipient and each unwrap's
// recipient. A swap may pay the router itself (0x…02) only when an unwrapWETH9 comes right after it,
// which forwards that output; anywhere else the router-held output is returned as a recipient (so the
// behaviour suite refuses it: anyone could sweep it). Any other leg is not accepted.
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
  "function multicall(uint256 deadline, bytes[] data)",
]);
export const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";

export const decode = (source: {kind: string; data?: string}): string[] => {
  const m = decodeFunctionData({abi: ROUTER_ABI, data: source.data as Hex});
  if (m.functionName !== "multicall") throw new Error(`not a multicall: ${m.functionName}`);
  const legs = (m.args[1] as Hex[]).map((leg) => {
    const c = decodeFunctionData({abi: ROUTER_ABI, data: leg});
    if (c.functionName === "unwrapWETH9") return {unwrap: true, recipient: c.args[1]};
    if (c.functionName === "exactInputSingle" || c.functionName === "exactInput") return {unwrap: false, recipient: c.args[0].recipient};
    throw new Error(`unexpected leg ${c.functionName}`);
  });
  return legs
    .filter((l, i) => l.unwrap || l.recipient.toLowerCase() !== ROUTER_ITSELF || !legs[i + 1]?.unwrap)
    .map((l) => l.recipient);
};
