import {afterEach, vi} from "vitest";
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";
import {decodeEthFlowCall} from "../src/ethflow.js";
import {CowSwap2Protocol} from "../src/protocol.js";
import {D1, ME, RPC, USDC, stub, world} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

// Recorded transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

/** Who the eth-flow order pays: the receiver written into `createOrder` (the module never builds one without it). */
const decode = (source: {kind: string; data?: string}): string[] => {
  const call = decodeEthFlowCall(source.data ?? "");
  if (!call || call.method !== "createOrder") throw new Error("not an eth-flow createOrder");
  return [call.order.receiver];
};

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-cow", {
  type: "swap2",
  activity,
  Protocol: CowSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true, enabled: true, rpcUrls: RPC},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// Behavioural conformance on a stubbed orderbook. The suite's account sends transactions and signs no typed data,
// so it runs the native-coin path (one createOrder transaction); the signed-order path is covered in engine.test.ts.
describeProtocolBehaviour("protocol-swap2-cow", {
  type: "swap2",
  Protocol: CowSwap2Protocol,
  config: {fromChain: "eip155:1", enabled: true, rpcUrls: RPC},
  fixtures: [
    {
      name: "ETH → USDC on Ethereum (eth-flow createOrder with the input as its value, no approval)",
      options: {fromToken: "ETH", toToken: USDC, toChain: 1, recipient: ME, fromTokenAmount: 10_000_000_000_000_000n, minAmountOut: 1n},
      fetch: stub(world()), account: {address: ME}, own: [ME], callTargets: [D1.ethFlow], decode,
    },
  ],
});
