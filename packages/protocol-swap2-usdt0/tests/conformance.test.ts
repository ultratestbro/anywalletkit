import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {decodeFunctionData, encodeFunctionResult, getAddress, pad, parseAbi, toHex, type Hex} from "viem";
import {Usdt0Swap2Protocol} from "../src/protocol.js";
import {USDT0_BY_EID, USDT0_CHAINS} from "../src/config.js";

import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import type {ActivityFixtureJson} from "@anywalletkit/conformance";

// Recorded real transactions (fixtures/activity/*.json); `negative-*` must come back null.
const fixturesDir = fileURLToPath(new URL("../fixtures/activity/", import.meta.url));
const loadFixtures = (pick: (file: string) => boolean): ActivityFixtureJson[] =>
  readdirSync(fixturesDir).filter((f) => f.endsWith(".json") && pick(f)).sort().map((f) => JSON.parse(readFileSync(fixturesDir + f, "utf8")) as ActivityFixtureJson);
const activity = {fixtures: loadFixtures((f) => !f.startsWith("negative-")), negatives: loadFixtures((f) => f.startsWith("negative-"))};

const ARB = USDT0_CHAINS["eip155:42161"]!;
const HYPE = USDT0_CHAINS["eip155:999"]!;
const ME = "0x4444444444444444444444444444444444444444";
const RPC = {"eip155:42161": "http://rpc.arb"};
const FEE = 6_248_183_276_938n;

const OFT_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }",
  "struct OFTFeeDetail { int256 feeAmountLD; string description; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "function quoteSend(SendParam s, bool payInLzToken) view returns (MessagingFee)",
  "function quoteOFT(SendParam s) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)",
  "function token() view returns (address)",
  "function approvalRequired() view returns (bool)",
  "function peers(uint32 eid) view returns (bytes32)",
]);

/** The Arbitrum OFT as the live one answered on 2026-10-20 (token, no approval, peer wired, no dust, fee 6.25e12 wei). */
const stub = (async (_url: RequestInfo | URL, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]};
  const reply = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, result}));
  if (body.method === "eth_chainId") return reply(toHex(42161));
  if (body.method !== "eth_call") return new Response(JSON.stringify({jsonrpc: "2.0", id: body.id, error: {code: -32601, message: body.method}}));
  const {data} = (body.params as [{to: string; data: Hex}])[0];
  const {functionName, args} = decodeFunctionData({abi: OFT_ABI, data});
  const enc = (result: unknown) => reply(encodeFunctionResult({abi: OFT_ABI, functionName, result} as never));
  if (functionName === "token") return enc(ARB.token);
  if (functionName === "approvalRequired") return enc(false);
  if (functionName === "peers") return enc(pad(getAddress(USDT0_BY_EID[Number((args as [number])[0])]!.oft), {size: 32}));
  const sp = (args as unknown as [{amountLD: bigint}])[0];
  if (functionName === "quoteOFT") return enc([{minAmountLD: 0n, maxAmountLD: 2n ** 64n - 1n}, [], {amountSentLD: sp.amountLD, amountReceivedLD: sp.amountLD}]);
  return enc({nativeFee: FEE, lzTokenFee: 0n});
}) as typeof fetch;

describeProtocolModule("protocol-swap2-usdt0", {
  type: "swap2",
  activity,
  Protocol: Usdt0Swap2Protocol,
  config: {fromChain: "eip155:42161", rpcUrls: RPC, skipAccountChainCheck: true},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

describeProtocolBehaviour("protocol-swap2-usdt0", {
  type: "swap2",
  Protocol: Usdt0Swap2Protocol,
  config: {fromChain: "eip155:42161", rpcUrls: RPC, skipAccountChainCheck: true},
  fixtures: [
    {
      name: "USDT0 Arbitrum → HyperEVM (send on the OFT, fee as value, no approval)",
      options: {fromToken: "USDT0", toToken: HYPE.token, toChain: 999, recipient: ME, fromTokenAmount: 10_000_000n, minAmountOut: 10_000_000n},
      fetch: stub,
      account: {address: ME},
      own: [ME],
      sourceToken: ARB.token,
    },
  ],
});
