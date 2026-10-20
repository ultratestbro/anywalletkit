import {describeProtocolBehaviour, describeProtocolModule} from "@forgewallet/conformance";
import {ChainflipSwap2Protocol} from "../src/protocol.js";
import {CF_VAULTS} from "../src/config.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@forgewallet/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

// The encoder's real answer for Arbitrum USDC → Tron USDT (refund 0x2222…, destination TNPee…), 2026-10-20.
const encoded = JSON.parse(readFileSync(new URL("../fixtures/encode-2026-10-20.json", import.meta.url), "utf8")).responses.arb_usdc as Record<string, string>;
const ME = "0x2222222222222222222222222222222222222222";
const TRON_ME = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const QUOTE = [{type: "REGULAR", egressAmount: "19300000", depositAmount: "20000000", estimatedDurationSeconds: 150, recommendedSlippageTolerancePercent: 0.5, recommendedLivePriceSlippageTolerancePercent: 1, includedFees: []}];
const stub = (async (url: RequestInfo | URL) => {
  const u = String(url);
  if (u.includes("/v2/quote")) return new Response(JSON.stringify(QUOTE));
  if (u.includes("encodeVaultSwapData")) return new Response(JSON.stringify(encoded));
  return new Response("{}", {status: 404});
}) as typeof fetch;

describeProtocolModule("protocol-swap2-chainflip", {
  type: "swap2",
  activity,
  Protocol: ChainflipSwap2Protocol,
  config: {fromChain: "eip155:42161", skipAccountChainCheck: true},
  samples: {getSupportedChains: []},
});

describeProtocolBehaviour("protocol-swap2-chainflip", {
  type: "swap2",
  Protocol: ChainflipSwap2Protocol,
  config: {fromChain: "eip155:42161", skipAccountChainCheck: true},
  fixtures: [
    {
      name: "Arbitrum USDC → Tron USDT (xSwapToken on the Vault, exact approval to the Vault)",
      options: {fromToken: ARB_USDC, toToken: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", toChain: "tron:728126428", recipient: TRON_ME, fromTokenAmount: 20_000_000n, minAmountOut: 13_999_999n},
      fetch: stub,
      account: {address: ME},
      own: [ME, TRON_ME],
      sourceToken: ARB_USDC,
      spender: CF_VAULTS["eip155:42161"]!,
    },
  ],
});
