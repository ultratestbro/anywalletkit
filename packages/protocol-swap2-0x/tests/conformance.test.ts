import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";
import {ZEROEX_PERMIT2} from "../src/chains.js";
import {ZeroExSwap2Protocol} from "../src/protocol.js";
import {decodeSettlerExecute} from "../src/settler.js";
import {DAI, ME, RPC, SETTLER, USDC, getKey, stub} from "./fixtures.js";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

/** Who the Settler call pays: the recipient of its slippage check. */
const decode = (source: {kind: string; data?: string}): string[] => [decodeSettlerExecute(source.data ?? "").recipient];

// Shared swap2 conformance: full surface, read-only account refuses writes, reads never broadcast.
describeProtocolModule("protocol-swap2-0x", {
  type: "swap2",
  activity,
  Protocol: ZeroExSwap2Protocol,
  config: {fromChain: "eip155:8453", skipAccountChainCheck: true, apiKey: getKey, rpcUrls: RPC},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

// Behavioural conformance on stubbed API answers in the shape of the real ones (fixtures/quotes): native sales, and a
// Permit2 token sale — the suite checks the permit is Permit2's transfer of exactly the input to the declared Settler,
// that exactly it is signed once, and that the call goes out as the reviewed calldata with that signature appended.
describeProtocolBehaviour("protocol-swap2-0x", {
  type: "swap2",
  Protocol: ZeroExSwap2Protocol,
  config: {fromChain: "eip155:8453", apiKey: getKey, rpcUrls: RPC, onWarning: () => {}},
  fixtures: [
    {
      name: "ETH → USDC on Base (native value to the registry's Settler, no approval, no signature)",
      options: {fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: 1_000_000_000_000_000n, minAmountOut: 2_487_500n},
      fetch: stub({out: 2_500_000n}), account: {address: ME, chain: "eip155:8453"}, own: [ME], callTargets: [SETTLER], decode,
    },
    {
      name: "ETH → DAI on Base (native value, the minimum and recipient sit in the Settler's slippage check)",
      options: {fromToken: "ETH", toToken: DAI, toChain: 8453, recipient: ME, fromTokenAmount: 2_000_000_000_000_000n, minAmountOut: 4_975_000_000_000_000_000n},
      fetch: stub({out: 5_000_000_000_000_000_000n}), account: {address: ME, chain: "eip155:8453"}, own: [ME], callTargets: [SETTLER], decode,
    },
    {
      name: "USDC → ETH on Base (Permit2 token sale: exact approval to Permit2, one EIP-712 permit for the Settler, signature appended)",
      options: {fromToken: "USDC", toToken: "0x0000000000000000000000000000000000000000", toChain: 8453, recipient: ME, fromTokenAmount: 1_000_000n, minAmountOut: 398_000_000_000_000n},
      fetch: stub(), account: {address: ME, chain: "eip155:8453", signTypedData: true}, own: [ME], callTargets: [SETTLER], spender: ZEROEX_PERMIT2, sourceToken: USDC, decode,
    },
  ],
});
