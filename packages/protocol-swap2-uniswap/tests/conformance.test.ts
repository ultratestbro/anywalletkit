import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-uniswap", {
  type: "swap2",
  activity,
  Protocol: UniswapSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, rpcUrls: RPC},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// Behavioural conformance on stubbed on-chain quotes: only own addresses are paid, the approval is exact.
// Who the SwapRouter02 multicall pays, read from its legs: each swap's recipient (the router itself when an
// unwrap follows) and each unwrap's recipient. Any other leg is not accepted.
const ROUTER = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient)",
  "function multicall(uint256 deadline, bytes[] data)",
]);
const ROUTER_ITSELF = "0x0000000000000000000000000000000000000002";
const decode = (source: {kind: string; data?: string}): string[] => {
  const m = decodeFunctionData({abi: ROUTER, data: source.data as Hex});
  if (m.functionName !== "multicall") throw new Error(`not a multicall: ${m.functionName}`);
  const paid = (m.args[1] as Hex[]).map((leg) => {
    const c = decodeFunctionData({abi: ROUTER, data: leg});
    if (c.functionName === "unwrapWETH9") return c.args[1];
    if (c.functionName === "exactInputSingle" || c.functionName === "exactInput") return c.args[0].recipient;
    throw new Error(`unexpected leg ${c.functionName}`);
  });
  return paid.filter((r, i) => r.toLowerCase() !== ROUTER_ITSELF || i === paid.length - 1);
};
describeProtocolBehaviour("protocol-swap2-uniswap", {
  type: "swap2",
  Protocol: UniswapSwap2Protocol,
  config: {fromChain: "eip155:1", rpcUrls: RPC},
  fixtures: [
    {
      name: "USDC → USDT on Ethereum (exact approve to the router, then multicall)",
      options: {fromToken: "USDC", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000n, minAmountOut: 990_000n},
      fetch: rpcStub(), account: {address: ME}, own: [ME], spender: D.router, sourceToken: USDC, decode,
    },
    {
      name: "ETH → USDC on Ethereum (native value, no approval)",
      options: {fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000_000_000_000n, minAmountOut: 990_000n},
      fetch: rpcStub(), account: {address: ME}, own: [ME], callTargets: [D.router], decode,
    },
  ],
});
