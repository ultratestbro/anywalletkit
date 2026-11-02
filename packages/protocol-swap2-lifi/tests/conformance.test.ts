import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {LifiSwap2Protocol} from "../src/protocol.js";
import {decodeFunctionData, type Hex} from "viem";
import {DIAMOND, DIAMOND_ABI, FROM_TOKEN, RECIPIENT, SENDER, TO_TOKEN, response} from "./fixtures.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-lifi", {
  type: "swap2",
  activity,
  Protocol: LifiSwap2Protocol,
  config: {fromChain: "eip155:1", skipAccountChainCheck: true},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// Behavioural conformance on the recorded quote shapes (no slippage sent, as the phone does).
const ZERO = "0x0000000000000000000000000000000000000000";
const reply = (body: unknown) => (async () => new Response(JSON.stringify(body))) as typeof fetch;
const native = response({
  action: {...response().action, fromToken: {address: ZERO, chainId: 1}, fromAmount: "2000000000000000"},
  estimate: {...response().estimate, fromAmount: "2000000000000000"},
  transactionRequest: {...response().transactionRequest, value: "0x71afd498d0000"},
});
// The Diamond pays the swap's `_receiver`, or a bridge's `BridgeData.receiver` (no destination call: that would pay from calldata on the other chain)
// and the facet's refund address (Stargate: LayerZero's unused native fee).
const diamondPays = (source: {kind: string; data?: string}): string[] => {
  const c = decodeFunctionData({abi: DIAMOND_ABI, data: source.data as Hex});
  const args = c.args as readonly unknown[];
  if (c.functionName.startsWith("swapTokens")) return [String(args[3])];
  const bridge = args[0] as {receiver: string; hasDestinationCall: boolean};
  if (bridge.hasDestinationCall) throw new Error("bridge with a destination call");
  if (!/BridgeTokensViaStargate$/.test(c.functionName)) throw new Error(`no refund layout for ${c.functionName}`);
  return [bridge.receiver, (args[args.length - 1] as {refundAddress: string}).refundAddress];
};
describeProtocolBehaviour("protocol-swap2-lifi", {
  type: "swap2",
  Protocol: LifiSwap2Protocol,
  config: {fromChain: "eip155:1"},
  fixtures: [
    {
      name: "USDT Ethereum → Arbitrum (approve zero-first, then calldata)",
      options: {fromToken: "USDT", toToken: TO_TOKEN, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 1_000_000n, minAmountOut: 980_000n},
      fetch: reply(response()), account: {address: SENDER}, own: [RECIPIENT], spender: DIAMOND, sourceToken: FROM_TOKEN, decode: diamondPays,
    },
    {
      name: "ETH Ethereum → Arbitrum (native value, no approval)",
      options: {fromToken: "ETH", toToken: TO_TOKEN, toChain: 42161, recipient: RECIPIENT, fromTokenAmount: 2_000_000_000_000_000n, minAmountOut: 980_000n},
      fetch: reply(native), account: {address: SENDER}, own: [RECIPIENT], callTargets: [DIAMOND], decode: diamondPays,
    },
  ],
});
