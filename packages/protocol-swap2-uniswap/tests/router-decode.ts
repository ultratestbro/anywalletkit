import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {UNISWAP_V3} from "../src/addresses.js";

// Who a SwapRouter02 multicall pays, read from its legs: each swap's recipient and each unwrap's
// recipient. A swap may pay the router itself (0x…02) only when its output is the chain's WETH and an
// unwrapWETH9 comes right after it, which forwards that output; anywhere else the router-held output is
// returned as a recipient (so the behaviour suite refuses it: anyone could sweep it). refundETH() pays
// unspent value back to the sender itself and names no recipient. Any other leg is not accepted.
export const ROUTER_ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
  "function refundETH()",
  "function multicall(uint256 deadline, bytes[] data)",
]);
export const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";

/** An exactInput path's output token, walked hop by hop: token (fee token)+, 20 + 23k bytes with k ≥ 1. */
const pathOut = (path: Hex): string => {
  const hex = path.slice(2);
  if (hex.length < 86 || (hex.length - 40) % 46 !== 0) throw new Error(`exactInput path of ${hex.length / 2} bytes is not token (fee token)+`);
  let out = hex.slice(0, 40);
  for (let i = 40; i < hex.length; i += 46) out = hex.slice(i + 6, i + 46);
  return `0x${out}`;
};

/** The decode for a chain whose wrapped native token is `weth`. */
export const decodeFor = (weth: string) => (source: {kind: string; data?: string}): string[] => {
  const m = decodeFunctionData({abi: ROUTER_ABI, data: source.data as Hex});
  if (m.functionName !== "multicall") throw new Error(`not a multicall: ${m.functionName}`);
  const legs = (m.args[1] as Hex[]).flatMap((leg) => {
    const c = decodeFunctionData({abi: ROUTER_ABI, data: leg});
    if (c.functionName === "refundETH") return [];
    if (c.functionName === "unwrapWETH9") return {unwrap: true, recipient: c.args[1], tokenOut: undefined};
    if (c.functionName === "exactInputSingle") return {unwrap: false, recipient: c.args[0].recipient, tokenOut: c.args[0].tokenOut as string};
    if (c.functionName === "exactInput") return {unwrap: false, recipient: c.args[0].recipient, tokenOut: pathOut(c.args[0].path)};
    throw new Error(`unexpected leg ${c.functionName}`);
  });
  const forwarded = (i: number) => legs[i]!.tokenOut?.toLowerCase() === weth.toLowerCase() && legs[i + 1]?.unwrap === true;
  return legs
    .filter((l, i) => l.unwrap || l.recipient.toLowerCase() !== ROUTER_ITSELF || !forwarded(i))
    .map((l) => l.recipient);
};

/** The decode for the Ethereum fixtures. */
export const decode = decodeFor(UNISWAP_V3[1]!.weth);
