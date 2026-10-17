import {describeProtocolBehaviour, describeProtocolModule} from "@forgewallet/conformance";
import {NearIntentsSwap2Protocol} from "../src/protocol.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@forgewallet/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-near-intents", {
  type: "swap2",
  activity,
  Protocol: NearIntentsSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

// Behavioural conformance: a 1Click deposit-address quote (same shape as provider.test.ts).
// Destination is Arbitrum USDC: TON is a hand-suspended corridor (config.ts) and is refused up front.
const SENDER = "0x4444444444444444444444444444444444444444";
const DEPOSIT = "0x5555555555555555555555555555555555555555";
const RECIPIENT = "0x6666666666666666666666666666666666666666";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const oneClick = (amountIn: string) => (async (url: string) => new Response(JSON.stringify(String(url).endsWith("/quote")
  ? {quote: {depositAddress: DEPOSIT, amountIn, amountOut: "990000", minAmountOut: "980000", deadline: new Date(Date.now() + 60_000).toISOString()}}
  : {}))) as unknown as typeof fetch;
const toArb = {toToken: ARB_USDC, toChain: "eip155:42161", recipient: RECIPIENT, minAmountOut: 980_000n};
describeProtocolBehaviour("protocol-swap2-near-intents", {
  type: "swap2",
  Protocol: NearIntentsSwap2Protocol,
  config: {fromChain: "eip155:1", apiUrl: "https://near.invalid"},
  fixtures: [
    {
      name: "USDT Ethereum → Arbitrum USDC (ERC-20 transfer to the deposit address)",
      options: {...toArb, fromToken: "USDT", fromTokenAmount: 1_000_000n},
      fetch: oneClick("1000000"), account: {address: SENDER}, own: [RECIPIENT], depositAddress: DEPOSIT,
      sourceToken: "0xdAC17F958D2ee523A2206206994597C13D831ec7",
    },
    {
      name: "ETH Ethereum → Arbitrum USDC (native send to the deposit address)",
      options: {...toArb, fromToken: "ETH", fromTokenAmount: 1_000_000_000_000_000n},
      fetch: oneClick("1000000000000000"), account: {address: SENDER}, own: [RECIPIENT], depositAddress: DEPOSIT,
    },
  ],
});
