import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";
import {SYMBIOSIS_CHAINS} from "../src/config.js";
import {SymbiosisSwap2Protocol} from "../src/protocol.js";
import {EVM, LIMITS, load, open} from "./fixtures.js";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

describeProtocolModule("protocol-swap2-symbiosis", {
  type: "swap2",
  activity,
  Protocol: SymbiosisSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// The API's real answer for Ethereum USDC → Arbitrum USDC (2026-11-10), served to whatever the engine asks.
const recorded = load("eth-usdc-arb-usdc");
const stub = (async (url: RequestInfo | URL) => {
  const u = String(url);
  if (u.includes("/v1/swap-limits")) return new Response(JSON.stringify(LIMITS));
  if (u.includes("/v2/quote")) return new Response(JSON.stringify(recorded.exchanges.at(-1)!.response));
  return new Response("{}", {status: 404});
}) as typeof fetch;
// Who the route pays, read here with the test's own ABI: the host-chain credit, the burn's recipient and the
// address that may revert the burn. (The bridge request's own revert address is Symbiosis' revert service —
// the quote says so in `serviceReverts`; it can only send the funds back to the sender.)
const routePays = (source: {kind: string; data?: string}): string[] => {
  const p = open(source.data!);
  return [p.s.chain2address, p.s.syntCaller, p.burn.chain2address, p.burn.revertableAddress, p.burn.syntCaller];
};
describeProtocolBehaviour("protocol-swap2-symbiosis", {
  type: "swap2",
  Protocol: SymbiosisSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  fixtures: [
    {
      name: "Ethereum USDC → Arbitrum USDC (metaRoute on the MetaRouterGateway, exact approval to it)",
      options: {fromToken: "USDC", toToken: recorded.params.destToken, toChain: 42161, recipient: EVM, fromTokenAmount: 100_000_000n, minAmountOut: 99_197_101n, slippageBps: 100},
      fetch: stub,
      account: {address: EVM},
      own: [EVM],
      sourceToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      spender: SYMBIOSIS_CHAINS["eip155:1"]!.gateway!,
      decode: routePays,
    },
  ],
});
