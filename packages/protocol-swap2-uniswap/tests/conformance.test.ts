import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";
import {decode} from "./router-decode.js";
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, getAddress, type Hex} from "viem";
import {SWAP_PROXY_ABI, UNISWAP_V4, V4_SWAP_INPUT_ABI, V4_TAKE_ABI} from "../src/v4/addresses.js";
import {BASE_TOKEN, HOLDER, tokenReplay} from "./v4-token-replay.js";

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
// Who the SwapRouter02 multicall pays: see router-decode.ts.
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

// U2: the SwapProxy flow (token input, v4 "all") through the same, unchanged behaviour suite — the approval's spender is
// the chain's pinned SwapProxy, the call goes to it, and who it pays is read from the V4_SWAP input's TAKE. The network is
// the Base recording at block 62,413,790 (fixtures/rpc/base-62413790-token.json; the account is the holder it was made
// from), plus the two reads of the preflight right before signing: the V4Quoter re-quote and the exact call from the
// account, both answering as the chain did for the quote.
const D8453 = UNISWAP_V4[8453]!;
const B_USDC = getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
const baseNode = tokenReplay([BASE_TOKEN], (s) => {
  if (s.method !== "eth_call" || s.params[2] !== undefined) return undefined;
  const c = s.params[0] as {to: string; from?: string; data: string};
  if (getAddress(c.to) === getAddress(D8453.quoter) && c.from === undefined && /^0x(aa9d21cb|ca253dc9)/.test(c.data)) {
    return {result: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [592_387_949_236_107_032n, 38_972n])};
  }
  if (getAddress(c.to) === getAddress(D8453.swapProxy) && c.from && getAddress(c.from) === HOLDER) return {result: "0x"};
  return undefined;
}).fetch;
/** Who a SwapProxy call pays: the TAKE recipient of its one V4_SWAP input (the module's own check pins the rest). */
const decodeSwapProxy = (source: {kind: string; data?: string}): string[] => {
  const [, , , , inputs] = decodeFunctionData({abi: SWAP_PROXY_ABI, data: source.data as Hex}).args as readonly [string, string, bigint, Hex, readonly Hex[], bigint];
  return inputs.map((input) => {
    const [actions, params] = decodeAbiParameters(V4_SWAP_INPUT_ABI, input) as readonly [Hex, readonly Hex[]];
    const take = actions.slice(2).match(/../g)!.indexOf("0e");
    if (take < 0) throw new Error("the V4_SWAP input has no TAKE");
    return decodeAbiParameters(V4_TAKE_ABI, params[take]!)[1];
  });
};
describeProtocolBehaviour("protocol-swap2-uniswap (v4 SwapProxy)", {
  type: "swap2",
  Protocol: UniswapSwap2Protocol,
  config: {fromChain: "eip155:8453", rpcUrls: {8453: ["https://base.fixture"]}, v4: "all", deployments: {}},
  fixtures: [
    {
      name: "1,000 USDC → ETH on Base through the SwapProxy (exact approve to the SwapProxy, then SwapProxy.execute)",
      options: {fromToken: "USDC", toToken: "ETH", toChain: 8453, recipient: HOLDER, fromTokenAmount: 1_000_000_000n, minAmountOut: 1n},
      fetch: baseNode, account: {chain: "eip155:8453", address: HOLDER}, own: [HOLDER], spender: D8453.swapProxy, callTargets: [D8453.swapProxy], sourceToken: B_USDC, decode: decodeSwapProxy,
    },
  ],
});
