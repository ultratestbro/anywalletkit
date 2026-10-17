import {describeProtocolBehaviour, describeProtocolModule} from "@forgewallet/conformance";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@forgewallet/conformance";

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
  samples: {getSupportedChains: []},
});

// Behavioural conformance on stubbed on-chain quotes: only own addresses are paid, the approval is exact.
describeProtocolBehaviour("protocol-swap2-uniswap", {
  type: "swap2",
  Protocol: UniswapSwap2Protocol,
  config: {fromChain: "eip155:1", rpcUrls: RPC},
  fixtures: [
    {
      name: "USDC → USDT on Ethereum (exact approve to the router, then multicall)",
      options: {fromToken: "USDC", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000n, minAmountOut: 990_000n},
      fetch: rpcStub(), account: {address: ME}, own: [ME], spender: D.router, sourceToken: USDC,
    },
    {
      name: "ETH → USDC on Ethereum (native value, no approval)",
      options: {fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000_000_000_000n, minAmountOut: 990_000n},
      fetch: rpcStub(), account: {address: ME}, own: [ME],
    },
  ],
});
