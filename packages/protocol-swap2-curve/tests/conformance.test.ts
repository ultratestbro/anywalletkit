import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {CurveSwap2Protocol} from "../src/protocol.js";
import {decodeExchange} from "../src/abi.js";
import {D1, ME, RPC, TABLES, USDC, USDT, rpcStub} from "./fixtures.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

/** Who the router call pays: its explicit `_receiver` (the module never builds a call without one). */
const decode = (source: {kind: string; data?: string}): string[] => {
  const call = decodeExchange("ng5", source.data ?? "");
  if (!call?.receiver) throw new Error("not an explicit-receiver Router NG exchange");
  return [call.receiver];
};

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-curve", {
  type: "swap2",
  activity,
  Protocol: CurveSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, rpcUrls: RPC, ...TABLES},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// Behavioural conformance on stubbed on-chain quotes: only own addresses are paid, the approval is exact.
describeProtocolBehaviour("protocol-swap2-curve", {
  type: "swap2",
  Protocol: CurveSwap2Protocol,
  config: {fromChain: "eip155:1", rpcUrls: RPC, ...TABLES, onWarning: () => {}},
  fixtures: [
    {
      name: "USDC → USDT on Ethereum (exact approve to the router, then exchange with the receiver)",
      options: {fromToken: "USDC", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000n, minAmountOut: 990_000n},
      fetch: rpcStub(), account: {address: ME}, own: [ME], spender: D1.router, sourceToken: USDC, decode,
    },
    {
      name: "ETH → USDT on Ethereum (native value, router wraps through the pinned WETH, no approval)",
      options: {fromToken: "ETH", toToken: USDT, toChain: 1, recipient: ME, fromTokenAmount: 1_000_000_000_000_000_000n, minAmountOut: 1n},
      fetch: rpcStub(), account: {address: ME}, own: [ME], callTargets: [D1.router], decode,
    },
  ],
});
